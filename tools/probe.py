#!/usr/bin/env python3
"""유저 한 명의 이벤트 로그를 들여다본다 — 진단 전용, 파일로 남기지 않는다.

목록에서 이상한 줄을 하나 집었을 때 "무슨 짓을 한 건가"를 보려고 쓴다.
출력은 Actions 로그로만 간다(공개 리포라 원본 식별자·IP·기기정보는 찍지 않는다).

  python3 probe.py --tag 8bc9b8 [--day 20260927] [--limit 400]

--day 를 주면 그 하루만 스캔한다(수십 MB). 안 주면 전 기간을 훑는다(1.5GB).
tag 는 화면에 보이는 6자 해시 — SUBSTR(TO_HEX(MD5(user_pseudo_id)),1,6) 이라
BigQuery 에서 같은 식으로 맞춰 찾는다.
"""
import argparse
import os
import sys

import realtime as rt

# 눈여겨볼 파라미터만 꺼낸다. 전부 펼치면 줄이 길어져서 흐름이 안 보인다.
KEYS = ["step", "step_idx", "pct", "deci", "level", "rebirth", "class", "stage",
        "kind", "granted", "order_id",   # purchase_anomaly 진단용
        "value", "currency", "product_id", "gems", "reason", "balance", "cost",
        "placement", "result", "secs_since_install", "session", "world", "nw_band",
        "overtake_pct", "beat", "beat_total", "engagement_time_msec"]


def scan(day: str | None) -> int:
    """시계 조작 탐지 — secs_since_install 이 벽시계보다 빨리 흐른 유저를 찾는다.

    게임은 이벤트마다 secs_since_install(기기 시계로 잰 설치 후 경과)을 같이 보낸다.
    GA4 의 event_timestamp 는 업로드 때 서버 기준으로 보정된다. 정상 플레이면 두 값의
    증가폭이 같다(실측: 8bc9b8 은 7.03시간 대 7.02시간으로 일치).

    기기 시계를 앞으로 돌리면 secs_since_install 만 뛴다. 방치보상이 '비운 시간'으로
    계산되므로 그게 그대로 돈이 된다 — save_system.gd 는 온라인일 때만 서버 시각으로
    캡을 걸고, 비행기모드면 무캡으로 지급한다(의도된 fail-open).

    드리프트 = secs 증가폭 − 벽시계 증가폭. 양수로 크면 시계를 앞당긴 것이다.
    """
    where = (f"_TABLE_SUFFIX = '{day}'" if day else "_TABLE_SUFFIX NOT LIKE 'intraday%'")
    rows = rt.q(f"""
      WITH e AS (
        SELECT user_pseudo_id AS uid, event_timestamp AS ts,
          (SELECT value.int_value FROM UNNEST(event_params)
           WHERE key='secs_since_install') AS secs
        FROM {rt.TABLE}
        WHERE {where}
          AND (SELECT value.int_value FROM UNNEST(event_params)
               WHERE key='secs_since_install') IS NOT NULL
      )
      SELECT SUBSTR(TO_HEX(MD5(uid)), 1, 6) AS tag,
        COUNT(*) AS n,
        (MAX(secs) - MIN(secs)) AS secs_span,
        CAST((MAX(ts) - MIN(ts)) / 1000000 AS INT64) AS wall_span,
        (MAX(secs) - MIN(secs)) - CAST((MAX(ts) - MIN(ts)) / 1000000 AS INT64) AS drift,
        FORMAT_TIMESTAMP('%m-%d %H:%M', TIMESTAMP_MICROS(MIN(ts)), 'Asia/Seoul') AS first_at,
        FORMAT_TIMESTAMP('%m-%d %H:%M', TIMESTAMP_MICROS(MAX(ts)), 'Asia/Seoul') AS last_at
      FROM e
      GROUP BY uid
      HAVING n >= 5 AND drift > 3600
      ORDER BY drift DESC
      LIMIT 60
    """)
    if not rows:
        print("시계가 앞당겨진 유저를 찾지 못했습니다(드리프트 1시간 초과 없음).")
        return 0
    print(f"=== 시계 드리프트 1시간 초과: {len(rows)}명 ===")
    print(f"{'유저':<9}{'드리프트':>12}{'기기경과':>11}{'실경과':>10}{'건수':>6}  구간")
    for r in rows:
        d, se, wa = int(r["drift"]), int(r["secs_span"]), int(r["wall_span"])
        print(f"{r['tag']:<9}{d/3600:>10.1f}h{se/3600:>10.1f}h{wa/3600:>9.1f}h"
              f"{r['n']:>6}  {r['first_at']} ~ {r['last_at']}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="", help="화면에 보이는 6자 유저 꼬리표")
    ap.add_argument("--day", help="YYYYMMDD. 주면 그 하루만 스캔")
    ap.add_argument("--limit", type=int, default=400, help="찍을 이벤트 줄 수")
    ap.add_argument("--scan", action="store_true", help="tag 대신 시계조작 의심 유저를 훑는다")
    a = ap.parse_args()

    if a.scan:
        return scan(a.day)

    where = (f"_TABLE_SUFFIX = '{a.day}'" if a.day else "_TABLE_SUFFIX NOT LIKE 'intraday%'")
    tag = "".join(c for c in a.tag.lower() if c in "0123456789abcdef")[:6]
    if len(tag) != 6:
        print("tag 는 16진수 6자여야 합니다.", file=sys.stderr)
        return 2

    params = ",\n          ".join(
        f"(SELECT CAST(COALESCE(CAST(value.int_value AS STRING), value.string_value,"
        f" CAST(value.double_value AS STRING)) AS STRING)"
        f" FROM UNNEST(event_params) WHERE key='{k}') AS p_{k}" for k in KEYS)

    rows = rt.q(f"""
      SELECT
        FORMAT_TIMESTAMP('%m-%d %H:%M:%S', TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul') AS t,
        event_timestamp AS ts,
        event_name AS ev,
        {params}
      FROM {rt.TABLE}
      WHERE {where}
        AND SUBSTR(TO_HEX(MD5(user_pseudo_id)), 1, 6) = '{tag}'
      ORDER BY event_timestamp
    """)
    if not rows:
        print(f"'{tag}' 에 해당하는 이벤트가 없습니다. --day 를 확인하세요.")
        return 0

    # 1) 이벤트 종류별 건수 — 전체 모양을 먼저 본다
    from collections import Counter
    cnt = Counter(r["ev"] for r in rows)
    span = (rows[-1]["ts"] - rows[0]["ts"]) / 1e6
    print(f"=== {tag} · 이벤트 {len(rows)}건 · {rows[0]['t']} ~ {rows[-1]['t']}"
          f" ({span/60:.1f}분) ===")
    print("종류별:", " · ".join(f"{k} {v}" for k, v in cnt.most_common()))
    print()

    # 2) 시간 흐름 — 직전 이벤트와의 간격을 같이 찍는다.
    #    치트·시계조작은 '간격'에서 드러난다(한 초에 수십 건, 또는 시간이 거꾸로 감).
    print(f"{'시각':<16}{'+초':>8}  이벤트")
    prev = None
    shown = 0
    for r in rows:
        gap = "" if prev is None else f"{(r['ts'] - prev) / 1e6:+.1f}"
        prev = r["ts"]
        bits = [f"{k[2:]}={r[k]}" for k in r if k.startswith("p_") and r[k] is not None]
        if shown < a.limit:
            print(f"{r['t']:<16}{gap:>8}  {r['ev']:<22} {' '.join(bits)}")
            shown += 1
    if len(rows) > a.limit:
        print(f"... {len(rows) - a.limit}건 더 (--limit 로 늘리세요)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
