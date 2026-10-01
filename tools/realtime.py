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
MAX_USERS = 1000         # 화면에 줄 세울 최대 인원(최근 가입 순). 쿼리 스캔량과는 무관 — 자르기만 한다.

# ⚠ 퍼널 정의는 tools/ingame.py 의 STAGES / CLASS_STAGES 와 **같아야 한다**.
#   두 뷰가 다른 퍼널을 말하면 비교 자체가 불가능해진다. 한쪽을 고치면 반드시 양쪽을 고칠 것.
# ⚠ first_settle(step_idx 18, '첫정산')은 퍼널에서 뺐다 — 단계가 아니라 타이머다.
#   time_system.gd: day % 30 == 0 이면 month_settled 발화, config 의 real_seconds_per_day=2.0.
#   즉 게임 화면이 60초 떠 있으면 부동산·출시·자산과 무관하게 누구나 찍힌다(인트로 중에도 시계는 돈다).
#   analytics.gd _on_settle() 은 조건 없이 _onb(18) 을 찍으므로 '진행'을 전혀 뜻하지 않는다.
#   퍼널 어디에 끼워도 앞뒤 단계와 인과가 없어 낙폭 해석이 깨진다 → 아래 EXTRA 로 빼서 타일로만 쓴다.
#   출시 이후의 진짜 정산 게이트는 first_ops(idx 9, _launched 조건부)가 따로 맡는다.
STAGES = [
    ("new_game", "새게임"), ("intro_done", "인트로"), ("dev_concept", "기획"),
    ("dev_design", "디자인"), ("dev_prototype", "프로토"), ("dev_alpha", "알파"),
    ("dev_beta", "베타"), ("dev_launch", "출시"), ("first_ops", "첫운영"),
    ("property_1", "부동산1"), ("property_2", "부동산2"), ("property_3", "부동산3"),
    ("property_4", "부동산4"), ("property_5", "부동산5"), ("game_sale", "은퇴"),
    ("first_manager", "첫매니저"), ("first_donate", "첫후원"),
    ("first_finance", "첫금융"), ("first_rebirth", "첫환생"),
]
CLASS_STAGES = [(2, "신분2"), (3, "신분3"), (4, "신분4"), (5, "신분5"), (6, "신분6"), (7, "신분7")]

# 퍼널 밖에서 따로 세는 플래그 — 단계가 아니라 '얼마나 버텼나'를 재는 값.
EXTRA = [("first_settle", "stay60")]

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
        COUNT(DISTINCT IF(DATE(TIMESTAMP_MICROS(user_first_touch_timestamp), 'Asia/Seoul')
                          = CURRENT_DATE('Asia/Seoul'), user_pseudo_id, NULL)) AS new_users,
        COUNT(DISTINCT IF(event_name='first_open', user_pseudo_id, NULL)) AS first_open_users,
        COUNTIF(event_name='purchase') AS purchases,
        COUNTIF(event_name='app_exception') AS exceptions,
        FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MIN(TIMESTAMP_MICROS(event_timestamp)), 'Asia/Seoul') AS first_at,
        FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MAX(TIMESTAMP_MICROS(event_timestamp)), 'Asia/Seoul') AS last_at
      FROM {TABLE} WHERE {INTRADAY}
    """)[0]

    flags = ",\n        ".join(
        f"MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='{k}',1,0)) AS s_{k}"
        for k, _ in STAGES + [(k, lab) for k, lab in EXTRA])
    flags += ",\n        " + ",\n        ".join(
        f"MAX(IF(event_name='class_up' AND (SELECT value.int_value FROM UNNEST(event_params) WHERE key='level')>={lv},1,0)) AS c{lv}"
        for lv, _ in CLASS_STAGES)

    # 오늘 '처음 연' 사람만. 판정 기준은 first_open 이벤트가 아니라 user_first_touch_timestamp 다 —
    # first_open 은 첫 세션에 업로드 못 하면(오프라인·강제종료) 다음 세션에 밀려 올라와서,
    # 어제 설치한 사람이 오늘 가입자로 섞인다. 그러면 "새게임은 없는데 뒷단계는 있는" 유령 줄이 생긴다.
    # first_touch 는 유저 속성이라 밀리지 않는다.
    # tag = 가명 ID 를 한 번 더 해시한 6자. 원본 ID 는 BigQuery 밖으로 안 나간다(리포가 공개라서).
    # 한 사람은 늘 같은 tag 라 새로고침 사이에 "아까 그 줄"을 짚을 수 있고,
    # 더 캐야 하면 BigQuery 에서 같은 식으로 해시해 맞춰보면 된다.
    rows = q(f"""
      SELECT ANY_VALUE(SUBSTR(TO_HEX(MD5(user_pseudo_id)), 1, 6)) AS tag,
        FORMAT_TIMESTAMP('%H:%M', TIMESTAMP_MICROS(MIN(event_timestamp)), 'Asia/Seoul') AS joined,
        FORMAT_TIMESTAMP('%H:%M', TIMESTAMP_MICROS(MAX(event_timestamp)), 'Asia/Seoul') AS last_seen,
        TIMESTAMP_DIFF(TIMESTAMP_MICROS(MAX(event_timestamp)),
                       TIMESTAMP_MICROS(MIN(event_timestamp)), MINUTE) AS mins,
        COUNT(*) AS events,
        ANY_VALUE(app_info.version) AS ver,
        ANY_VALUE(geo.country) AS country,
        COUNTIF(event_name='first_open') AS fo,
        {flags}
      FROM {TABLE} WHERE {INTRADAY}
      GROUP BY user_pseudo_id
      HAVING DATE(TIMESTAMP_MICROS(MIN(user_first_touch_timestamp)), 'Asia/Seoul')
             = CURRENT_DATE('Asia/Seoul')
      ORDER BY MIN(event_timestamp) DESC
      LIMIT {MAX_USERS}
    """)

    users, funnel, stay60 = [], [0] * len(ORDER), 0
    for r in rows:
        reached = [int(r.get(col) or 0) for _, _, col in ORDER]
        stay60 += 1 if r.get("s_" + EXTRA[0][0]) else 0
        # 마지막으로 '도달한' 단계. 중간을 건너뛴 기록이 있어도 가장 멀리 간 지점을 쓴다.
        far = max([i for i, v in enumerate(reached) if v], default=-1)
        for i, v in enumerate(reached):
            if v:
                funnel[i] += 1
        users.append({
            "tag": r["tag"], "joined": r["joined"], "last_seen": r["last_seen"],
            "mins": int(r["mins"] or 0), "events": int(r["events"] or 0),
            "ver": r["ver"], "country": r["country"],
            "reached": reached, "far": far,
            "far_label": ORDER[far][1] if far >= 0 else "—",
        })

    n = len(users)
    out["users"] = users
    out["stay60"] = stay60
    # 가입 판정이 first_open 하나였을 때의 숫자. 둘이 벌어지면 업로드가 밀린 게 섞였다는 뜻.
    out["summary"]["first_open_rows"] = sum(1 for r in rows if r.get("fo"))
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
