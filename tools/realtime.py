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
# 스트리밍 테이블을 훑는 범위. 기본은 '전부'지만, 실제 쿼리는 아래에서 '가장 최근 하루'로 좁힌다.
# GA4 는 일별 테이블이 확정되기 전까지 어제치 events_intraday_* 를 그대로 남겨 둔다. 그래서
# 아침에는 어제·오늘 두 장이 동시에 존재하고, LIKE 'intraday%' 로 받으면 이틀치가 합산된다
# (실측: 10/02 05:10 수집에서 '오늘 가입'이 206명 — 10/01 분이 통째로 섞인 값이었다).
INTRADAY_ANY = "_TABLE_SUFFIX LIKE 'intraday%'"
INTRADAY = INTRADAY_ANY   # main() 에서 최신 테이블 하루로 교체한다
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

# 곁가지 — 앞단계가 뒷단계를 함의하지 않는 칸. 나머지는 척추(앞을 밟아야 뒤가 온다).
#   척추 근거: 개발 6단계는 _check_dev_milestones 의 while 루프가 넘긴 단계마다 순서대로 쏘고,
#   부동산1~5 는 holding_count, 신분2~7 은 class_level 사다리라 건너뛸 수 없다.
#   곁가지 근거: 첫매니저는 슬롯·비용만 맞으면 아무 때나 사고(unlock_class 는 가격 앵커로만 쓴다),
#   첫금융도 금융상품을 사는 순간 찍힌다. 둘 다 '어디까지 갔나'와 인과가 없어서
#   직전 칸 대비 낙폭을 재면 거짓말이 된다 → 척추 줄 사이에 끼우지 않고 뒤로 모아 따로 그린다.
SIDE = {"first_manager", "first_finance"}

# 표시 순서 — 척추(첫후원 뒤에 신분2~7 삽입) 전부를 세운 뒤 곁가지를 맨 뒤에 붙인다.
# 척추 사이에 곁가지가 끼면 "여기서 몇 % 빠졌다"는 시선이 끊긴다. 뒤로 몰면 줄이 끊기지 않는다.
_SPINE, _SIDE_ROWS = [], []
for _k, _lab in STAGES:
    (_SIDE_ROWS if _k in SIDE else _SPINE).append((_k, _lab, "s_" + _k))
    if _k == "first_donate":
        for _lv, _clab in CLASS_STAGES:
            _SPINE.append((f"class{_lv}", _clab, f"c{_lv}"))
ORDER = _SPINE + _SIDE_ROWS

client = bigquery.Client(project=PROJECT, location=LOCATION)
_billed = 0


def q(sql: str) -> list[dict]:
    global _billed
    job = client.query(sql)
    rows = [dict(r) for r in job.result()]
    _billed += job.total_bytes_billed or 0
    return rows


def ad_country() -> list[dict]:
    """광고 결과를 국가별로. fill rate 는 지역마다 크게 갈려서(eCPM 낮은 시장일수록 재고가 얇다)
    전체 평균 하나로는 어디를 손봐야 할지 안 보인다. 완주율도 같이 본다 — 보상 매력도·
    네트워크 사정이 지역마다 다르다.

    표본이 적은 국가는 비율이 요동치므로 요청 10회 미만은 '기타'로 묶는다.
    """
    res = "(SELECT value.string_value FROM UNNEST(event_params) WHERE key='result')"
    rows = q(f"""
      SELECT geo.country AS country,
        COUNT(*) AS total,
        COUNTIF({res} = 'earned')    AS earned,
        COUNTIF({res} = 'dismissed') AS dismissed,
        COUNTIF({res} = 'no_ad')     AS no_ad,
        COUNTIF({res} = 'failed')    AS failed,
        COUNT(DISTINCT user_pseudo_id) AS users
      FROM {TABLE} WHERE {INTRADAY} AND event_name='ad_impression'
      GROUP BY country
    """)
    MIN_N = 10
    out, rest = [], {"country": "기타(요청 10회 미만)", "total": 0, "earned": 0,
                     "dismissed": 0, "no_ad": 0, "failed": 0, "users": 0, "lumped": 0}
    for r in rows:
        d = {k: int(r[k] or 0) for k in ("total", "earned", "dismissed", "no_ad", "failed", "users")}
        if d["total"] < MIN_N:
            for k in d:
                rest[k] += d[k]
            rest["lumped"] += 1
            continue
        out.append({"country": r["country"] or "(미상)", **d})

    def rates(d: dict) -> dict:
        shown = d["earned"] + d["dismissed"]
        bad = d["no_ad"] + d["failed"]
        d["finish_pct"] = round(100 * d["earned"] / shown, 1) if shown else None
        d["supply_pct"] = round(100 * bad / d["total"], 1) if d["total"] else None
        return d

    out = [rates(d) for d in out]
    out.sort(key=lambda d: -d["total"])
    if rest["total"]:
        out.append(rates(rest))
    return out


def main() -> None:
    out = {"updated": datetime.now(KST).strftime("%Y-%m-%d %H:%M") + " KST",
           "stage_labels": [{"key": k, "label": lab,
                             "kind": "side" if k in SIDE else "spine"}
                            for k, lab, _ in ORDER]}

    out["tables"] = q(f"""
      SELECT REPLACE(_TABLE_SUFFIX, 'intraday_', '') AS d,
             COUNT(DISTINCT user_pseudo_id) AS users, COUNT(*) AS events
      FROM {TABLE} WHERE {INTRADAY_ANY} GROUP BY d ORDER BY d
    """)
    if not out["tables"]:
        save(out)
        return

    # 가장 최근 하루만 본다 — 어제 테이블이 아직 안 지워졌어도 섞이지 않게.
    # (자정 직후 오늘 테이블이 아직 없으면 자연히 어제가 잡힌다 — 빈 화면보다 낫다.)
    global INTRADAY
    day = max(t["d"] for t in out["tables"])
    INTRADAY = f"_TABLE_SUFFIX = 'intraday_{day}'"
    out["tables"] = [t for t in out["tables"] if t["d"] == day]
    out["day"] = day

    out["summary"] = q(f"""
      SELECT
        COUNT(DISTINCT user_pseudo_id) AS users,
        COUNT(DISTINCT IF(event_name='first_open', user_pseudo_id, NULL)) AS new_users,
        -- 참고값: intraday 의 user_first_touch_timestamp 기준. 후처리 전이라 '스트리밍에 오늘 처음
        -- 등장'까지 묶여 부풀어 오른다 — 가입 판정엔 안 쓰고 벌어지는 폭만 본다.
        COUNT(DISTINCT IF(DATE(TIMESTAMP_MICROS(user_first_touch_timestamp), 'Asia/Seoul')
                          = CURRENT_DATE('Asia/Seoul'), user_pseudo_id, NULL)) AS first_touch_today,
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

    # 오늘 '처음 연' 사람만 — 판정은 first_open 이벤트로 한다.
    # user_first_touch_timestamp 로 바꿔 봤다가 되돌렸다: intraday 는 후처리 전이라 유저 범위
    # 필드가 아직 안 채워져 있고, 실측에서 그 기준이 54명(= 스트리밍에 오늘 처음 잡힌 사람)으로
    # 부풀었다. 같은 시각 first_open 기준은 13명. 54 쪽은 '설치'가 아니라 '스트리밍 첫 등장'이다.
    # 둘 다 summary 에 남겨 두니 벌어지면 눈에 보인다(new_users vs first_open_users).
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
        -- 추월% 두 눈금. progress_pct 는 정수 1~100, progress_deci 는 0.1% 단위 1~32
        -- (첫 환생 경계 3.2%까지). 초반엔 정수 pct 가 한참 0 에 머물러서 deci 가 아니면
        -- '얼마나 왔나'가 안 보인다. 둘 중 큰 쪽을 그 유저의 진행률로 쓴다.
        MAX(IF(event_name='progress_pct',
               (SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct'), 0)) AS pct,
        MAX(IF(event_name='progress_deci',
               (SELECT value.int_value FROM UNNEST(event_params) WHERE key='deci'), 0)) AS deci,
        {flags}
      FROM {TABLE} WHERE {INTRADAY}
      GROUP BY user_pseudo_id
      HAVING COUNTIF(event_name='first_open') > 0
      ORDER BY MIN(event_timestamp) DESC
      LIMIT {MAX_USERS}
    """)

    users, funnel, rec, stay60 = [], [0] * len(ORDER), [0] * len(ORDER), 0
    for r in rows:
        reached = [int(r.get(col) or 0) for _, _, col in ORDER]
        stay60 += 1 if r.get("s_" + EXTRA[0][0]) else 0
        # 마지막으로 '도달한' 단계. 중간을 건너뛴 기록이 있어도 가장 멀리 간 지점을 쓴다.
        # 곁가지(목록 꼬리)는 제외 — 매니저 하나 샀다고 '멀리 갔다'가 되면 안 된다.
        far = max([i for i, v in enumerate(reached) if v and i < len(_SPINE)], default=-1)
        # 척추는 앞을 밟아야 뒤가 오므로 far 까지 앞칸을 채워서 센다.
        # 비어 있는 앞칸은 '안 밟았다'가 아니라 '기록이 없다'이고, 원인은 둘이다:
        #  (1) 계측이 '현재값'만 찍는 칸 — analytics.gd _on_owned() 은 holding_count 를 그대로 보고
        #      _onb(9+n) 을 찍는다. 세이브를 복원해 3채로 시작하면 부동산3만 찍히고 1·2 는 영영 안 찍힌다
        #      (tick_vacancy 가 매 정산마다 owned_changed 를 쏘므로 첫 정산에서 바로 발생).
        #      개발 6단계는 반대로 while 루프가 넘긴 단계마다 쏘므로 이런 구멍이 안 생긴다.
        #  (2) intraday 후처리 전 유실.
        # 어느 쪽이든 'far 까지는 갔다'는 참이라 채워 세는 게 맞다. 날것은 users[].reached 에 남는다.
        # ⚠ 채운 건 측정이 아니라 추론이다. 추론분이 몇 명인지 반드시 같이 내보낸다(n - rec) —
        #   한 칸의 계측이 통째로 죽어도 채우기가 덮어버리면 영영 모르게 되기 때문이다.
        for i in range(len(ORDER)):
            if reached[i]:
                funnel[i] += 1
                rec[i] += 1
            elif i < len(_SPINE) and i <= far:
                funnel[i] += 1
        users.append({
            "tag": r["tag"], "joined": r["joined"], "last_seen": r["last_seen"],
            "mins": int(r["mins"] or 0), "events": int(r["events"] or 0),
            "ver": r["ver"], "country": r["country"],
            "prog": max(float(r["pct"] or 0), (int(r["deci"] or 0)) / 10.0),
            "reached": reached, "far": far,
            "far_label": ORDER[far][1] if far >= 0 else "—",
        })

    n = len(users)
    out["users"] = users
    out["stay60"] = stay60
    out["funnel"] = [{"key": k, "label": lab, "n": funnel[i], "rec": rec[i],
                      "pct": round(100 * funnel[i] / n, 1) if n else 0,
                      "kind": "side" if k in SIDE else "spine"}
                     for i, (k, lab, _) in enumerate(ORDER)]
    out["cohort_n"] = n

    # ── 추월% 진행 ─────────────────────────────────────────────
    # 퍼널은 '어느 단계를 밟았나'만 말한다. 같은 단계 안에서 얼마나 멀리 갔는지는 추월%가 말한다.
    # 임계값별 '이상 도달' 수로 낸다 — 구간별로 나누면 경계에서 숫자가 튀고 단조성도 깨진다.
    # 눈금은 게임의 마디에 맞춘다: 3.2%는 첫 환생 경계(progress_deci 가 거기까지만 찍힌다).
    progs = sorted((u["prog"] for u in users), reverse=True)
    MARKS = [0.1, 0.5, 1, 2, 3.2, 5, 10, 25, 50, 100]
    out["progress"] = {
        "median": progs[len(progs) // 2] if progs else 0,
        "max": progs[0] if progs else 0,
        "zero": sum(1 for p in progs if p <= 0),
        "marks": [{"at": m, "n": sum(1 for p in progs if p >= m),
                   "pct": round(100 * sum(1 for p in progs if p >= m) / n, 1) if n else 0}
                  for m in MARKS],
    }

    # ── 리워드 광고 ────────────────────────────────────────────────
    # ads.gd 가 결과를 네 갈래로 쏜다(rewarded_result): earned/dismissed/failed/no_ad.
    #   earned    = 완주 → 보상 지급
    #   dismissed = 유저가 중간에 닫음        → '유저 쪽' 마찰
    #   no_ad     = 띄울 광고가 없음          → '공급' 문제. 보상은 못 주고 매출도 0
    #   failed    = 표시 실패(무상 지급)      → 공급·SDK 문제. 보상만 나가고 매출 0
    # 공급 실패(no_ad+failed)는 매출이 그대로 증발하는 구간이라 완주율과 따로 봐야 한다.
    ad_rows = q(f"""
      SELECT
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key='placement') AS placement,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key='result') AS result,
        COUNT(*) AS n,
        COUNT(DISTINCT user_pseudo_id) AS users
      FROM {TABLE} WHERE {INTRADAY} AND event_name='ad_impression'
      GROUP BY placement, result
    """)
    RESULTS = ["earned", "dismissed", "no_ad", "failed"]
    by_res = {k: 0 for k in RESULTS}
    by_pl: dict[str, dict] = {}
    for r in ad_rows:
        res = r["result"] or "?"
        pl = r["placement"] or "(미지정)"
        by_res[res] = by_res.get(res, 0) + int(r["n"] or 0)
        slot = by_pl.setdefault(pl, {k: 0 for k in RESULTS} | {"total": 0})
        slot[res] = slot.get(res, 0) + int(r["n"] or 0)
        slot["total"] += int(r["n"] or 0)
    total = sum(by_res.values())
    shown = by_res["earned"] + by_res["dismissed"]     # 실제로 화면에 뜬 것만
    supply_bad = by_res["no_ad"] + by_res["failed"]
    out["ads"] = {
        "total": total,
        "by_result": [{"result": k, "n": by_res.get(k, 0)} for k in RESULTS],
        # 완주율은 '뜬 광고' 기준 — no_ad 를 분모에 넣으면 유저 행동과 공급 문제가 섞인다.
        "finish_pct": round(100 * by_res["earned"] / shown, 1) if shown else None,
        "supply_pct": round(100 * supply_bad / total, 1) if total else None,
        "by_country": ad_country(),
        "viewers": max((int(r["users"] or 0) for r in ad_rows), default=0),
        "by_placement": sorted(
            ({"placement": p, **v} for p, v in by_pl.items()),
            key=lambda x: -x["total"]),
    }
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
