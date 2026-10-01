#!/usr/bin/env python3
"""실시간(스트리밍) 신규 유저 추적 — BigQuery events_intraday_* → docs/data/realtime.json.

보는 것은 하나다: **오늘 깔아본 사람들이 어디까지 갔는가.**
가입자 한 명 한 명을 줄로 세우고, 각자 퍼널의 어느 단계에서 멈췄는지 표시한다.
집계된 이탈률은 인게임 뷰(완결 데이터)가 맡고, 여기서는 '지금 들어온 사람'을 본다.

ingame.py 와 **의도적으로 완전히 분리**돼 있다 — 파일도 워크플로도 뷰도 따로다.
intraday 는 후처리 전이고 '하루가 덜 찬' 값이라 완결 지표(리텐션·코호트)에 섞으면 왜곡된다.

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
MAX_USERS = 300          # 화면에 줄 세울 최대 인원(최근 가입 순)

# ⚠ 퍼널 정의는 tools/ingame.py 의 STAGES / CLASS_STAGES 와 **같아야 한다**.
#   두 뷰가 다른 퍼널을 말하면 비교 자체가 불가능해진다. 한쪽을 고치면 반드시 양쪽을 고칠 것.
STAGES = [
    ("new_game", "새게임"), ("intro_done", "인트로"), ("dev_concept", "기획"),
    ("dev_design", "디자인"), ("dev_prototype", "프로토"), ("dev_alpha", "알파"),
    ("dev_beta", "베타"), ("dev_launch", "출시"), ("first_ops", "첫운영"),
    ("property_1", "부동산1"), ("property_2", "부동산2"), ("property_3", "부동산3"),
    ("property_4", "부동산4"), ("property_5", "부동산5"), ("game_sale", "은퇴"),
    ("first_manager", "첫매니저"), ("first_donate", "첫후원"), ("first_settle", "첫정산"),
    ("first_finance", "첫금융"), ("first_rebirth", "첫환생"),
]
CLASS_STAGES = [(2, "신분2"), (3, "신분3"), (4, "신분4"), (5, "신분5"), (6, "신분6"), (7, "신분7")]

# 표시 순서 — 첫후원 뒤에 신분2~7을 끼운다(ingame.py 의 ORDER 와 동일).
ORDER = []
for _k, _lab in STAGES:
    ORDER.append((_k, _lab, "s_" + _k))
    if _k == "first_donate":
        for _lv, _clab in CLASS_STAGES:
            ORDER.append((f"class{_lv}", _clab, f"c{_lv}"))

client = bigquery.Client(project=PROJECT, location=LOCATION)
_billed = 0


def q(sql: str) -> list[dict]:
    global _billed
    job = client.query(sql)
    rows = [dict(r) for r in job.result()]
    _billed += job.total_bytes_billed or 0
    return rows


def main() -> None:
    out = {"updated": datetime.now(KST).strftime("%Y-%m-%d %H:%M") + " KST",
           "stage_labels": [{"key": k, "label": lab} for k, lab, _ in ORDER]}

    out["tables"] = q(f"""
      SELECT REPLACE(_TABLE_SUFFIX, 'intraday_', '') AS d,
             COUNT(DISTINCT user_pseudo_id) AS users, COUNT(*) AS events
      FROM {TABLE} WHERE {INTRADAY} GROUP BY d ORDER BY d
    """)
    if not out["tables"]:
        save(out)
        return

    out["summary"] = q(f"""
      SELECT
        COUNT(DISTINCT user_pseudo_id) AS users,
        COUNT(DISTINCT IF(event_name='first_open', user_pseudo_id, NULL)) AS new_users,
        COUNTIF(event_name='purchase') AS purchases,
        COUNTIF(event_name='app_exception') AS exceptions,
        FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MIN(TIMESTAMP_MICROS(event_timestamp)), 'Asia/Seoul') AS first_at,
        FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MAX(TIMESTAMP_MICROS(event_timestamp)), 'Asia/Seoul') AS last_at
      FROM {TABLE} WHERE {INTRADAY}
    """)[0]

    flags = ",\n        ".join(
        f"MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='{k}',1,0)) AS s_{k}"
        for k, _ in STAGES)
    flags += ",\n        " + ",\n        ".join(
        f"MAX(IF(event_name='class_up' AND (SELECT value.int_value FROM UNNEST(event_params) WHERE key='level')>={lv},1,0)) AS c{lv}"
        for lv, _ in CLASS_STAGES)

    # 오늘 '처음 연' 사람만. first_open 이 intraday 안에 있어야 당일 가입자다.
    rows = q(f"""
      SELECT user_pseudo_id AS uid,
        FORMAT_TIMESTAMP('%H:%M', TIMESTAMP_MICROS(MIN(event_timestamp)), 'Asia/Seoul') AS joined,
        FORMAT_TIMESTAMP('%H:%M', TIMESTAMP_MICROS(MAX(event_timestamp)), 'Asia/Seoul') AS last_seen,
        TIMESTAMP_DIFF(TIMESTAMP_MICROS(MAX(event_timestamp)),
                       TIMESTAMP_MICROS(MIN(event_timestamp)), MINUTE) AS mins,
        COUNT(*) AS events,
        ANY_VALUE(app_info.version) AS ver,
        ANY_VALUE(geo.country) AS country,
        {flags}
      FROM {TABLE} WHERE {INTRADAY}
      GROUP BY uid
      HAVING COUNTIF(event_name='first_open') > 0
      ORDER BY MIN(event_timestamp) DESC
      LIMIT {MAX_USERS}
    """)

    users, funnel = [], [0] * len(ORDER)
    for r in rows:
        reached = [int(r.get(col) or 0) for _, _, col in ORDER]
        # 마지막으로 '도달한' 단계. 중간을 건너뛴 기록이 있어도 가장 멀리 간 지점을 쓴다.
        far = max([i for i, v in enumerate(reached) if v], default=-1)
        for i, v in enumerate(reached):
            if v:
                funnel[i] += 1
        users.append({
            "uid": r["uid"][-6:], "joined": r["joined"], "last_seen": r["last_seen"],
            "mins": int(r["mins"] or 0), "events": int(r["events"] or 0),
            "ver": r["ver"], "country": r["country"],
            "reached": reached, "far": far,
            "far_label": ORDER[far][1] if far >= 0 else "—",
        })

    n = len(users)
    out["users"] = users
    out["funnel"] = [{"key": k, "label": lab, "n": funnel[i],
                      "pct": round(100 * funnel[i] / n, 1) if n else 0}
                     for i, (k, lab, _) in enumerate(ORDER)]
    out["cohort_n"] = n
    save(out)


def save(out: dict) -> None:
    mb = _billed / 1024 / 1024
    out["scan_mb"] = round(mb, 2)
    out["scan_note"] = (f"이번 실행 스캔 {mb:.1f}MB. 매시간(24회/일)이면 월 "
                        f"{mb * 24 * 30 / 1024:.2f}GB — 무료 구간은 월 1,024GB.")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("당일 가입자:", out.get("cohort_n", 0), "명 /", out["scan_note"])


if __name__ == "__main__":
    main()
