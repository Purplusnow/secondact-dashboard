#!/usr/bin/env python3
"""실시간(스트리밍) 현황 수집 — BigQuery events_intraday_* → docs/data/realtime.json.

ingame.py 와 **의도적으로 완전히 분리**돼 있다. 파일도 워크플로도 뷰도 따로다.

왜 섞지 않는가:
  intraday 는 GA4 후처리 전 데이터다. 일부 속성이 비어 있거나 나중에 값이 달라지고,
  무엇보다 '하루가 덜 찬' 값이다. 완결된 일별 지표(리텐션·코호트)에 섞으면 그대로 왜곡된다.
  그래서 여기 숫자는 어떤 경우에도 ingame.json 쪽 수치와 합산하지 않는다.

쓰임새는 '배포 직후 확인' 하나다 — 이벤트가 찍히는지, 새 버전이 깔리는지, 크래시가 터지는지.
평소 추세는 인게임 뷰(완결 데이터)로 본다. 그래서 예약 실행 없이 수동으로만 돈다.

인증: 환경변수 GOOGLE_APPLICATION_CREDENTIALS. 데이터셋 위치=asia-northeast3.
"""
import json
import os
from datetime import datetime, timedelta, timezone

from google.cloud import bigquery

KST = timezone(timedelta(hours=9))
PROJECT = os.environ.get("BQ_PROJECT", "second-act-life")
DATASET = os.environ.get("BQ_DATASET", "analytics_544010325")
LOCATION = os.environ.get("BQ_LOCATION", "asia-northeast3")
TABLE = f"`{PROJECT}.{DATASET}.events_*`"
INTRADAY = "_TABLE_SUFFIX LIKE 'intraday%'"
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "realtime.json")

client = bigquery.Client(project=PROJECT, location=LOCATION)

# 스캔량을 직접 재둔다 — 주기를 '아마 괜찮겠지'로 정하지 않기 위해.
# BigQuery 무료 구간은 월 1TB 쿼리 처리량이라, 실측값 × 실행횟수로 바로 환산된다.
_billed = 0


def q(sql: str) -> list[dict]:
    global _billed
    job = client.query(sql)
    rows = [dict(r) for r in job.result()]
    _billed += job.total_bytes_billed or 0
    return rows

KST_TS = "TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul'"


def main() -> None:
    out = {"updated": datetime.now(KST).strftime("%Y-%m-%d %H:%M") + " KST"}

    # 어떤 intraday 테이블이 있는지부터. 비어 있으면 스트리밍이 꺼져 있거나 아직 안 들어온 것.
    out["tables"] = q(f"""
      SELECT REPLACE(_TABLE_SUFFIX, 'intraday_', '') AS d,
             COUNT(DISTINCT user_pseudo_id) AS users, COUNT(*) AS events
      FROM {TABLE} WHERE {INTRADAY} GROUP BY d ORDER BY d
    """)
    if not out["tables"]:
        save(out)
        return

    # 요약 — 데이터가 실제로 덮는 '시각 범위'를 같이 둔다. 스트리밍을 켠 시점부터만 쌓이므로
    # DAU 를 완결된 날의 DAU 와 비교하면 안 된다는 걸 화면에서 알 수 있어야 한다.
    out["summary"] = q(f"""
      SELECT
        COUNT(DISTINCT user_pseudo_id) AS users,
        COUNT(*) AS events,
        COUNT(DISTINCT IF(event_name='first_open', user_pseudo_id, NULL)) AS new_users,
        COUNTIF(event_name='purchase') AS purchases,
        COUNTIF(event_name='app_exception') AS exceptions,
        FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MIN({KST_TS})) AS first_at,
        FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MAX({KST_TS})) AS last_at
      FROM {TABLE} WHERE {INTRADAY}
    """)[0]

    # 시간대별 — 배포 직후 뚝 끊기는 구간이 있는지 보는 용도
    out["hourly"] = q(f"""
      SELECT FORMAT_TIMESTAMP('%m-%d %H', {KST_TS}) AS h,
             COUNT(DISTINCT user_pseudo_id) AS users, COUNT(*) AS events
      FROM {TABLE} WHERE {INTRADAY} GROUP BY h ORDER BY h
    """)

    # 이벤트명별 — 새로 넣은 이벤트가 실제로 찍히는지 확인하는 핵심 표
    out["events"] = q(f"""
      SELECT event_name AS name,
             COUNT(*) AS n, COUNT(DISTINCT user_pseudo_id) AS users
      FROM {TABLE} WHERE {INTRADAY}
      GROUP BY name ORDER BY n DESC LIMIT 40
    """)

    # 앱 버전별 — 새 빌드가 실제로 퍼지는지, 구버전이 얼마나 남았는지
    out["versions"] = q(f"""
      SELECT IFNULL(app_info.version, '(없음)') AS v,
             COUNT(DISTINCT user_pseudo_id) AS users, COUNT(*) AS events
      FROM {TABLE} WHERE {INTRADAY}
      GROUP BY v ORDER BY users DESC LIMIT 15
    """)

    out["countries"] = q(f"""
      SELECT IFNULL(geo.country, '(없음)') AS c, COUNT(DISTINCT user_pseudo_id) AS users
      FROM {TABLE} WHERE {INTRADAY}
      GROUP BY c ORDER BY users DESC LIMIT 12
    """)

    save(out)


def save(out: dict) -> None:
    mb = _billed / 1024 / 1024
    out["scan_mb"] = round(mb, 2)
    out["scan_note"] = (f"이번 실행 스캔 {mb:.1f}MB. 매시간(24회/일)이면 월 "
                        f"{mb * 24 * 30 / 1024:.1f}GB — 무료 구간은 월 1,024GB.")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    t = out.get("tables") or []
    print("intraday 테이블:", ", ".join(f"{r['d']}({r['users']}명/{r['events']}건)" for r in t) or "없음")
    print(out["scan_note"])


if __name__ == "__main__":
    main()
