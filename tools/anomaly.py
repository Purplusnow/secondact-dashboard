#!/usr/bin/env python3
"""위험 신호 감시 — BigQuery(GA4 확정 일별) → docs/data/anomaly.json.

지금 잡는 건 둘이다. 둘 다 2026-10-02 에 실제 사례를 확인하고 넣었다.

1) 시계 앞당김(clock_drift)
   게임은 이벤트마다 secs_since_install(기기 시계로 잰 값)을 보내고, GA4 의
   event_timestamp 는 업로드 때 서버 기준으로 보정된다. 정상이면 두 값의 증가폭이 같다
   (실측: 정상 유저 8bc9b8 은 7.03시간 대 7.02시간). 기기 시계를 앞당기면 앞쪽만 뛴다.
   방치보상이 '비운 시간'으로 계산되므로 그게 그대로 돈이 된다 —
   save_system.gd 는 온라인일 때만 서버 시각으로 캡을 걸고 비행기모드면 무캡 지급한다.

2) 즉시 고진행(fast_progress)
   설치 1시간 안에 추월 10% 이상. 정상 플레이로는 불가능하다 — 100% 달성자들도
   18~37일이 걸렸다. 세이브를 바꿔 끼운 흔적이다(실측 e45d95: 설치 32분 만에 25%).
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
DAILY = "_TABLE_SUFFIX NOT LIKE 'intraday%'"

WINDOW = 7          # '최근'의 기준(일)
DRIFT_SEC = 3600    # 이만큼 넘게 벌어지면 시계를 건드린 것으로 본다
FAST_SEC = 3600     # 설치 후 이 시간 안에
FAST_PCT = 10       # 추월 이만큼 넘으면 비정상

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
               {secs} AS secs, {pct} AS pct
        FROM {rt.TABLE} WHERE {DAILY}
      ),
      u AS (
        SELECT uid,
          FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_MICROS(MIN(ts)), 'Asia/Seoul') AS first_day,
          -- 시계 드리프트: 기기가 주장한 경과 − 실제 경과
          MAX(IF(secs IS NULL, NULL, secs)) - MIN(IF(secs IS NULL, NULL, secs))
            - CAST((MAX(IF(secs IS NULL, NULL, ts)) - MIN(IF(secs IS NULL, NULL, ts))) / 1000000 AS INT64)
            AS drift,
          COUNTIF(secs IS NOT NULL) AS secs_n,
          -- 설치 1시간 안에 찍힌 추월% 의 최고치
          MAX(IF(ev = 'progress_pct' AND secs < {FAST_SEC}, pct, 0)) AS early_pct,
          MAX(IF(ev = 'progress_pct', pct, 0)) AS max_pct
        FROM e GROUP BY uid
      )
      SELECT SUBSTR(TO_HEX(MD5(uid)), 1, 6) AS tag, first_day,
             IFNULL(drift, 0) AS drift, IFNULL(early_pct, 0) AS early_pct,
             IFNULL(max_pct, 0) AS max_pct
      FROM u
      WHERE (secs_n >= 5 AND drift > {DRIFT_SEC}) OR early_pct >= {FAST_PCT}
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
        if int(r["early_pct"] or 0) >= FAST_PCT:
            kinds.append("fast_progress")
        u = {"tag": r["tag"], "day": r["first_day"], "kinds": kinds,
             "drift_h": round(int(r["drift"] or 0) / 3600, 1),
             "early_pct": int(r["early_pct"] or 0), "max_pct": int(r["max_pct"] or 0)}
        users.append(u)
        d = daily.setdefault(r["first_day"], {"date": r["first_day"], "n": 0,
                                              "clock_drift": 0, "fast_progress": 0})
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
            {"key": "fast_progress", "label": "즉시 고진행",
             "desc": f"설치 {FAST_SEC // 60}분 안에 추월 {FAST_PCT}% 이상. 정상 플레이로는 "
                     "불가능합니다(100% 달성자도 18~37일 걸립니다) — 세이브 교체 흔적입니다.",
             "total": sum(1 for u in users if "fast_progress" in u["kinds"]),
             "recent": sum(1 for u in recent if "fast_progress" in u["kinds"])},
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
