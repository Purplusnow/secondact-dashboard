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
        "value", "currency", "product_id", "gems", "reason", "balance", "cost",
        "placement", "result", "secs_since_install", "session", "world", "nw_band",
        "overtake_pct", "beat", "beat_total", "engagement_time_msec"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True, help="화면에 보이는 6자 유저 꼬리표")
    ap.add_argument("--day", help="YYYYMMDD. 주면 그 하루만 스캔")
    ap.add_argument("--limit", type=int, default=400, help="찍을 이벤트 줄 수")
    a = ap.parse_args()

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
