#!/usr/bin/env python3
"""위험 신호 감시 — BigQuery(GA4 확정 일별) → docs/data/anomaly.json.

지금 잡는 건 둘이다. 둘 다 2026-10-02 에 실제 사례를 확인하고 넣었다.

1) 시계 앞당김(clock_drift)
   게임은 이벤트마다 secs_since_install(기기 시계로 잰 값)을 보내고, GA4 의
   event_timestamp 는 업로드 때 서버 기준으로 보정된다. 정상이면 두 값의 증가폭이 같다
   (실측: 정상 유저 8bc9b8 은 7.03시간 대 7.02시간). 기기 시계를 앞당기면 앞쪽만 뛴다.
   방치보상이 '비운 시간'으로 계산되므로 그게 그대로 돈이 된다 —
   save_system.gd 는 온라인일 때만 서버 시각으로 캡을 걸고 비행기모드면 무캡 지급한다.

2) 결제 위조(fake_purchase)
   게임이 purchase_anomaly 를 쏜 유저. 그중 granted=true 가 문제다 — analytics.gd 는
   bad_orderid·dup_orderid·no_price 를 '이미 지급된 뒤' 기록한다. 탐지는 했는데 **못 막은**
   건이다(실제 차단은 bad_signature·no_billing 뿐). 실측 002131: 설치 30~59초 사이에
   스타터팩 6종을 전부 bad_orderid 로 받고 보석 잔고 101,335. 진행 조작과 달리 이건
   유료 상품이 공짜로 나가는 거라 매출에 직접 닿는다 — 유일하게 돈이 걸린 신호다.

3) 추월% 폭주(pct_burst)
   progress_pct 가 같은 1초에 BURST_N 개 이상 몰려 찍힌다.

   ⚠ 처음엔 '설치 1시간 안에 추월 10%'로 잡았다가 버렸다 — 오탐이었다. 초반 추월%는
   원래 빠르게 오른다(정상 유저 b00b85 는 33분에 22%). 그 기준이면 빠른 정상 유저가
   52명이나 걸렸다. 문제는 '빠른 것'이 아니라 '한 순간에 건너뛴 것'이다.

   게임의 _progress_check 는 크로싱한 정수%마다 하나씩 쏜다. 정상 플레이면 몇 분에 걸쳐
   하나씩 올라간다. 세이브를 바꿔 끼우면 analytics.json 의 _last_pct(0)와 게임 상태가
   어긋나 따라잡기 루프가 한 번에 수십 개를 쏜다 — 실측 e45d95 는 1초에 25개였다.
   시계를 안 건드려도 잡히므로 1)과 독립이다.

날짜별로 세어 둔다. 지금은 1.6만 명 중 3명이라 영향이 없지만, 중요한 건 '퍼지는지'다.

인증: 환경변수 GOOGLE_APPLICATION_CREDENTIALS. 데이터셋 위치=asia-northeast3.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import realtime as rt

KST = timezone(timedelta(hours=9))
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "anomaly.json")
# 지역이 안 잡히는 줄은 사람이 아니다 — 빌드를 올릴 때마다 Play 사전 출시 보고서가 실기기에서
# 앱을 몇 분씩 돌리는데 전부 거기로 들어온다(10/03 실측: 실시간 385명 중 25명). 전부 체류 0분·
# 첫 단계 정지라 리텐션·퍼널·도달률을 통째로 희석한다. BigQuery 에서 NULL != '' 은 TRUE 가
# 아니므로 이 한 줄로 NULL 과 빈 문자열이 같이 걸러진다.
DAILY = "_TABLE_SUFFIX NOT LIKE 'intraday%' AND IFNULL(geo.country,'') != ''"

WINDOW = 7          # '최근'의 기준(일)
DRIFT_SEC = 3600    # 이만큼 넘게 벌어지면 시계를 건드린 것으로 본다
BURST_N = 10        # progress_pct 가 같은 1초에 이만큼 몰리면 건너뛴 것
FAKE_N = 1          # 결제 위조는 한 건만 나와도 신호 — 정상 결제에선 안 나오는 이벤트다

# 경고 단계 — 비율과 절대수 중 하나라도 넘으면 올라간다.
# 비율만 보면 유입이 적은 날 한 명에 요동치고, 절대수만 보면 커진 뒤 둔감해진다.
WARN_RATE, ALERT_RATE = 0.001, 0.005     # 최근 신규 대비 0.1% / 0.5%
WARN_N, ALERT_N = 5, 20                  # 또는 최근 WINDOW 일 누적 인원


def fetch() -> list[dict]:
    secs = ("(SELECT value.int_value FROM UNNEST(event_params) WHERE key='secs_since_install')")
    pct = ("(SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct')")
    return rt.q(f"""
      WITH e AS (
        SELECT user_pseudo_id AS uid, event_timestamp AS ts, event_name AS ev,
               {secs} AS secs, {pct} AS pct,
               (SELECT COALESCE(value.string_value, CAST(value.int_value AS STRING))
                FROM UNNEST(event_params) WHERE key='granted') AS granted
        FROM {rt.TABLE} WHERE {DAILY}
      ),
      -- 같은 1초에 progress_pct 가 몇 개 몰렸나
      b AS (
        SELECT uid, MAX(c) AS burst FROM (
          SELECT uid, DIV(ts, 1000000) AS sec, COUNT(*) AS c
          FROM e WHERE ev = 'progress_pct' GROUP BY uid, sec
        ) GROUP BY uid
      ),
      u AS (
        SELECT uid,
          FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_MICROS(MIN(ts)), 'Asia/Seoul') AS first_day,
          -- 시계 드리프트: 기기가 주장한 경과 − 실제 경과
          MAX(IF(secs IS NULL, NULL, secs)) - MIN(IF(secs IS NULL, NULL, secs))
            - CAST((MAX(IF(secs IS NULL, NULL, ts)) - MIN(IF(secs IS NULL, NULL, ts))) / 1000000 AS INT64)
            AS drift,
          COUNTIF(secs IS NOT NULL) AS secs_n,
          MAX(IF(ev = 'progress_pct', pct, 0)) AS max_pct,
          COUNTIF(ev = 'purchase_anomaly') AS fake,
          -- granted=true 는 '탐지했지만 이미 지급된' 건. 막힌 시도와 갈라야 피해 규모가 보인다.
          COUNTIF(ev = 'purchase_anomaly' AND granted = 'true') AS fake_granted
        FROM e GROUP BY uid
      )
      SELECT SUBSTR(TO_HEX(MD5(u.uid)), 1, 6) AS tag, first_day,
             IFNULL(drift, 0) AS drift, IFNULL(b.burst, 0) AS burst,
             IFNULL(max_pct, 0) AS max_pct,
             IFNULL(fake, 0) AS fake, IFNULL(fake_granted, 0) AS fake_granted
      FROM u LEFT JOIN b USING (uid)
      WHERE (secs_n >= 5 AND drift > {DRIFT_SEC})
         OR b.burst >= {BURST_N}
         OR u.fake >= {FAKE_N}
      ORDER BY first_day DESC
    """)


def new_by_day() -> dict[str, int]:
    """날짜별 신규 가입자 수 — 비율의 분모. users.py 가 만든 index 를 그대로 쓴다."""
    path = os.path.join(os.path.dirname(OUT), "users", "index.json")
    try:
        with open(path, encoding="utf-8") as f:
            return {d["date"]: d["n"] for d in json.load(f)["days"]}
    except (OSError, KeyError, json.JSONDecodeError):
        return {}


def main() -> int:
    rows = fetch()
    newd = new_by_day()
    today = datetime.now(KST).date()
    since = (today - timedelta(days=WINDOW)).isoformat()

    users, daily = [], {}
    for r in rows:
        kinds = []
        if int(r["drift"] or 0) > DRIFT_SEC:
            kinds.append("clock_drift")
        if int(r["burst"] or 0) >= BURST_N:
            kinds.append("pct_burst")
        if int(r["fake"] or 0) >= FAKE_N:
            kinds.append("fake_purchase")
        u = {"tag": r["tag"], "day": r["first_day"], "kinds": kinds,
             "drift_h": round(int(r["drift"] or 0) / 3600, 1),
             "burst": int(r["burst"] or 0), "max_pct": int(r["max_pct"] or 0),
             "fake": int(r["fake"] or 0), "fake_granted": int(r["fake_granted"] or 0)}
        users.append(u)
        d = daily.setdefault(r["first_day"], {"date": r["first_day"], "n": 0,
                                              "clock_drift": 0, "pct_burst": 0,
                                              "fake_purchase": 0})
        d["n"] += 1
        for k in kinds:
            d[k] += 1

    recent = [u for u in users if u["day"] >= since]
    base = sum(n for d, n in newd.items() if d >= since)
    rate = (len(recent) / base) if base else 0.0

    if len(recent) >= ALERT_N or rate >= ALERT_RATE:
        level = "alert"
    elif len(recent) >= WARN_N or rate >= WARN_RATE:
        level = "warn"
    else:
        level = "ok"

    out = {
        "updated": datetime.now(KST).strftime("%Y-%m-%d %H:%M") + " KST",
        "level": level,
        "window_days": WINDOW,
        "total": len(users),
        "recent": len(recent),
        "recent_base": base,
        "recent_rate": round(100 * rate, 3),
        "thresholds": {"warn_n": WARN_N, "alert_n": ALERT_N,
                       "warn_rate": WARN_RATE * 100, "alert_rate": ALERT_RATE * 100},
        "signals": [
            {"key": "clock_drift", "label": "시계 앞당김",
             "desc": "기기가 주장한 경과 시간이 실제보다 1시간 넘게 깁니다. "
                     "방치보상이 '비운 시간'으로 계산되므로 그대로 돈이 됩니다.",
             "total": sum(1 for u in users if "clock_drift" in u["kinds"]),
             "recent": sum(1 for u in recent if "clock_drift" in u["kinds"])},
            {"key": "fake_purchase", "label": "결제 위조",
             "desc": "게임이 purchase_anomaly 를 쏜 유저입니다. 주문ID 형식이 깨졌거나 재사용됐는데 "
                     "보상은 이미 지급된 건이 대부분입니다 — 탐지는 했지만 막지는 못한 것이라 "
                     "유료 상품이 공짜로 나갑니다. 유일하게 돈이 걸린 신호입니다.",
             "total": sum(1 for u in users if "fake_purchase" in u["kinds"]),
             "recent": sum(1 for u in recent if "fake_purchase" in u["kinds"]),
             "granted": sum(u["fake_granted"] for u in users)},
            {"key": "pct_burst", "label": "추월% 폭주",
             "desc": f"추월%가 같은 1초에 {BURST_N}칸 이상 건너뜁니다. 정상 플레이면 몇 분에 "
                     "걸쳐 하나씩 오릅니다 — 세이브를 바꿔 끼워 진행도가 어긋난 흔적입니다.",
             "total": sum(1 for u in users if "pct_burst" in u["kinds"]),
             "recent": sum(1 for u in recent if "pct_burst" in u["kinds"])},
        ],
        "daily": sorted(daily.values(), key=lambda d: d["date"], reverse=True),
        "users": users[:200],
        "scan_mb": round(rt._billed / 1024 / 1024, 1),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"[{level}] 누적 {len(users)}명 · 최근 {WINDOW}일 {len(recent)}명 "
          f"/ 신규 {base}명 ({out['recent_rate']}%) · 스캔 {out['scan_mb']}MB")
    for s in out["signals"]:
        print(f"  {s['label']}: 누적 {s['total']} · 최근 {s['recent']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
