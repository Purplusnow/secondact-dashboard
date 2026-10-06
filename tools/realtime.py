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
import re
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
# 지역이 안 잡히는 줄은 사람이 아니다. 빌드를 올릴 때마다 Play 사전 출시 보고서가 실기기에서
# 앱을 몇 분씩 돌리는데 전부 여기로 들어온다(10/03 실측 385명 중 25명). 퍼널뿐 아니라
# 활동유저·결제·광고 집계에서도 빼야 숫자가 맞는다.
HAS_GEO = "geo.country IS NOT NULL AND geo.country != ''"
INTRADAY = INTRADAY_ANY   # main() 에서 최신 테이블 하루로 교체한다
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "realtime.json")
# 가입자 목록은 최근 24시간 전부를 담는다(인원 상한 없음). 하루 1만 명이면 JSON 2MB 쯤인데
# 전송은 gzip 으로 400KB 라 괜찮다 — 문제는 화면 쪽이라 realtime.js 가 나눠 그린다.

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


def load_tiers() -> dict[str, str]:
    """국가 → 티어. config.json 의 country_tiers 를 뒤집어 쓴다. 목록에 없으면 T3."""
    path = os.path.join(os.path.dirname(OUT), "config.json")
    try:
        with open(path, encoding="utf-8") as f:
            ct = json.load(f).get("country_tiers", {})
    except (OSError, json.JSONDecodeError):
        return {}
    out = {}
    for t in ("T1", "T2"):
        for c in ct.get(t, []):
            out[c] = t
    return out


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
      FROM {TABLE} WHERE {INTRADAY} AND {HAS_GEO} AND event_name='ad_impression'
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

    # 가입자 목록만 '최근 24시간'으로 본다(타일·퍼널·광고는 그대로 오늘 하루).
    # 새벽에는 '오늘'이 몇 시간뿐이라 목록이 거의 비는데, 목록은 한 명씩 들여다보는 화면이라
    # 자정에 리셋되면 못 쓴다. 어제치는 테이블이 확정됐으면 events_YYYYMMDD, 아직이면
    # events_intraday_YYYYMMDD 에 있다 — 날짜마다 하나만 골라야 중복되지 않는다.
    yday = (datetime.strptime(day, "%Y%m%d") - timedelta(days=1)).strftime("%Y%m%d")
    have = {r["s"] for r in q(f"""
      SELECT DISTINCT _TABLE_SUFFIX AS s FROM {TABLE}
      WHERE _TABLE_SUFFIX IN ('{yday}', 'intraday_{yday}')
    """)}
    win = [f"intraday_{day}"] + ([yday] if yday in have else
                                 [f"intraday_{yday}"] if f"intraday_{yday}" in have else [])
    WINDOW = "_TABLE_SUFFIX IN (" + ", ".join(f"'{x}'" for x in win) + ")"

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
      FROM {TABLE} WHERE {INTRADAY} AND {HAS_GEO}
    """)[0]

    flags = ",\n        ".join(
        f"MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='{k}',1,0)) AS s_{k}"
        for k, _ in STAGES + [(k, lab) for k, lab in EXTRA])
    flags += ",\n        " + ",\n        ".join(
        f"MAX(IF(event_name='class_up' AND (SELECT value.int_value FROM UNNEST(event_params) WHERE key='level')>={lv},1,0)) AS c{lv}"
        for lv, _ in CLASS_STAGES)

    # 최근 24시간에 '처음 연' 사람 — 판정은 first_open 이벤트로 한다.
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
        FORMAT_TIMESTAMP('%Y%m%d', TIMESTAMP_MICROS(MIN(event_timestamp)), 'Asia/Seoul') AS joined_day,
        FORMAT_TIMESTAMP('%H:%M', TIMESTAMP_MICROS(MAX(event_timestamp)), 'Asia/Seoul') AS last_seen,
        TIMESTAMP_DIFF(TIMESTAMP_MICROS(MAX(event_timestamp)),
                       TIMESTAMP_MICROS(MIN(event_timestamp)), MINUTE) AS span_min,
        -- 실제 체류. MAX-MIN 은 '첫 이벤트와 마지막 이벤트 간격'이라 중간에 앱을 꺼도 계속 흐른다
        -- (5분 하고 닫았다가 10시간 뒤 한 번 더 열면 10시간으로 잡힌다). GA4 SDK 가 이벤트마다
        -- 붙이는 engagement_time_msec 을 더해야 '화면을 보고 있던 시간'이 된다.
        SUM((SELECT value.int_value FROM UNNEST(event_params)
             WHERE key='engagement_time_msec')) AS eng_ms,
        COUNT(DISTINCT (SELECT value.int_value FROM UNNEST(event_params)
                        WHERE key='ga_session_id')) AS sessions,
        COUNT(*) AS events,
        ANY_VALUE(app_info.version) AS ver,
        ANY_VALUE(geo.country) AS country,
        COUNTIF(event_name='first_open') AS fo,
        -- 방치 보상 수령. 0원 수령은 애초에 없다 — main.gd _maybe_show_offline 이
        -- offline_reward <= 0 이면 팝업을 안 띄우고, 수령은 그 팝업에서만 일어난다.
        -- method 는 base(×1) / ad(×2) / gem(×3). 배수를 쓴 쪽을 따로 세 두면
        -- '방치를 돌리는 사람'과 '방치에 돈·시간을 더 쓰는 사람'이 갈린다.
        COUNTIF(event_name='mon_offline_claim') AS off_n,
        COUNTIF(event_name='mon_offline_claim' AND (SELECT value.string_value
                FROM UNNEST(event_params) WHERE key='method') IN ('ad','gem')) AS off_boost,
        -- 추월% 두 눈금. progress_pct 는 정수 1~100, progress_deci 는 0.1% 단위 1~32
        -- (32 = 3.2% = 첫 환생 경계). 초반엔 정수 pct 가 한참 0 에 머물러서 deci 가 아니면
        -- '얼마나 왔나'가 안 보인다. 둘 중 큰 쪽이 그 유저의 진행률이다.
        MAX(IF(event_name='progress_pct',
               (SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct'), 0)) AS pct,
        MAX(IF(event_name='progress_deci',
               (SELECT value.int_value FROM UNNEST(event_params) WHERE key='deci'), 0)) AS deci,
        {flags}
      FROM {TABLE}
      WHERE {WINDOW}
        AND TIMESTAMP_MICROS(event_timestamp) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
      GROUP BY user_pseudo_id
      HAVING COUNTIF(event_name='first_open') > 0
      ORDER BY MIN(event_timestamp) DESC
    """)

    # 라이브 빌드 판정. 하루에도 빌드를 십수 개 올리는 날이 있고(10/03: v954~v965),
    # 그 기기들은 지역이 잡히는데도 체류 0분·단계 0 이라 지역 필터로는 안 걸린다.
    # 실제로 배포된 빌드는 금세 수십 명이 붙고 테스트 빌드는 한두 명에 머문다 — 그 차이로 가른다.
    # 단계 롤아웃이 커지면 자연히 문턱을 넘어 코호트에 합류한다(영영 숨기지 않는다).
    from collections import Counter
    vcount = Counter((r["ver"] or "?") for r in rows if (r["country"] or "").strip())
    floor = max(10, int(0.03 * sum(vcount.values())))
    LIVE = {v for v, c in vcount.items() if c >= floor}

    users, funnel, rec, stay60 = [], [0] * len(ORDER), [0] * len(ORDER), 0
    nogeo = 0
    testbuild = 0
    by_ver: dict[str, int] = {}
    for r in rows:
        # 국가가 비어 있는 줄은 코호트에서 뺀다. 빌드를 올릴 때마다 Play 사전 출시 보고서가
        # 실기기 여러 대에서 앱을 몇 분씩 돌리는데, 그게 전부 '지역 없음 · 체류 0분 · 첫 단계 정지'로
        # 들어와 퍼널을 통째로 끌어내린다(실측 10/03: 385명 중 25명, 인트로 이탈이 -3% → -12%).
        # 사람이 아니라 로봇이므로 세면 안 된다. 몇 명을 뺐는지는 화면에 적는다 — 조용히 지우면
        # 어느 날 진짜 유저의 지역이 안 잡히기 시작해도 모르게 된다.
        if not (r["country"] or "").strip():
            nogeo += 1
            continue
        ver = r["ver"] or "?"
        by_ver[ver] = by_ver.get(ver, 0) + 1
        if ver not in LIVE:
            testbuild += 1
            continue
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
            # 창이 자정을 걸치므로 어제 들어온 줄에는 날짜를 붙인다 — 05:55 가 오늘인지 어제인지
            # 구분이 안 되면 목록 순서가 거꾸로 보인다.
            "tag": r["tag"],
            "joined": (r["joined"] if r["joined_day"] == day
                       else f"{r['joined_day'][4:6]}/{r['joined_day'][6:8]} {r['joined']}"),
            "last_seen": r["last_seen"],
            "mins": round(float(r["eng_ms"] or 0) / 60000.0, 1),   # 체류(분)
            "span": int(r["span_min"] or 0),                        # 첫~마지막 간격(분)
            "sessions": int(r["sessions"] or 0),
            "off": int(r["off_n"] or 0),            # 방치 보상 수령 횟수(0원 건은 존재하지 않음)
            "off_boost": int(r["off_boost"] or 0),  # 그중 광고×2·보석×3 로 받은 횟수
            # 0 이면 '진행 없음'이 아니라 '0.1% 미만' — deci 1 이 가장 고운 눈금이라 그 아래는 못 잰다.
            "prog": max(float(r["pct"] or 0), int(r["deci"] or 0) / 10.0),
            "events": int(r["events"] or 0),
            "ver": r["ver"], "country": r["country"],
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
    out["excluded_nogeo"] = nogeo
    out["excluded_build"] = testbuild
    # 가장 최근 라이브 빌드 — 목록에서 '새 빌드로 들어온 사람'을 눈에 띄게 하는 기준.
    # 롤아웃이 끝나면 자연히 이쪽이 다수가 되고 옛 빌드가 눌리므로 규칙을 안 고쳐도 된다.
    def _bn(v: str) -> int:
        m = re.search(r"v(\d+)", v or "")
        return int(m.group(1)) if m else -1
    out["newest_build"] = max(LIVE, key=_bn, default=None)
    out["versions"] = {
        "live": sorted(LIVE),
        "rows": sorted(({"ver": v, "n": c, "live": v in LIVE} for v, c in by_ver.items()),
                       key=lambda x: (-x["n"], x["ver"])),
    }

    # ── 국가별 ─────────────────────────────────────────────────
    # 마케팅은 국가 단위로 돌리는데 퍼널은 전체 하나뿐이라 "어느 시장 설치가 값을 하나"를
    # 볼 데가 없었다. 같은 코호트를 나라로 쪼갠다 — 추가 쿼리 없이 이미 받은 줄로 센다.
    # 눈금은 퍼널에서 벽으로 확인된 칸들: 인트로(초반 이탈), 부동산2(최대 단일 낙폭),
    # 은퇴(중반 통과), 첫환생(끝까지).
    # 한 명짜리 나라도 따로 둔다 — 묶어 버리면 새로 들어오기 시작한 시장이 안 보인다.
    # 표본이 작으면 비율이 한 칸에 수십 %p 씩 움직이므로, 화면에서 흐리게 눌러 표시한다.
    MARKS = [("intro_done", "인트로"), ("property_2", "부동산2"),
             ("game_sale", "은퇴"), ("first_rebirth", "첫환생")]
    idx_of = {k: i for i, (k, _, _) in enumerate(ORDER)}

    def blank(name: str) -> dict:
        return {"country": name, "n": 0, "mins": [], **{k: 0 for k, _ in MARKS}}

    buckets: dict[str, dict] = {}
    for u in users:
        b = buckets.setdefault(u["country"] or "(미상)", blank(u["country"] or "(미상)"))
        b["n"] += 1
        b["mins"].append(u["mins"])
        for k, _ in MARKS:
            # 척추는 far 까지 밟은 것으로 본다(퍼널과 같은 규칙) — 안 그러면 여기만 숫자가 다르다
            i = idx_of[k]
            if u["reached"][i] or (i < len(_SPINE) and i <= u["far"]):
                b[k] += 1

    def finish(b: dict) -> dict:
        ms = sorted(b.pop("mins"))
        b["med_min"] = ms[len(ms) // 2] if ms else 0
        for k, _ in MARKS:
            b[k + "_pct"] = round(100 * b[k] / b["n"], 1) if b["n"] else 0
        return b

    # ⚠ 티어 합산을 먼저 한다 — finish() 가 버킷의 체류 목록을 소모하므로, 나라별을 마무리한
    #   뒤에 합치면 체류가 전부 0 이 된다(실제로 한 번 그렇게 냈다).
    # 티어는 시장 단가 기준(T1=미국·일본·독일…)이지 우리 성과 기준이 아니다. 그 어긋남이
    # 핵심이다 — 미국은 T1 인데 우리 지표로는 최하위다. 묶으면 그게 한 줄로 드러난다.
    tiers = load_tiers()
    tbuck = {t: blank(t) for t in ("T1", "T2", "T3")}
    for b in buckets.values():
        tb = tbuck[tiers.get(b["country"], "T3")]
        tb["n"] += b["n"]
        tb["mins"] += b["mins"]
        for k, _ in MARKS:
            tb[k] += b[k]
    tier_rows = [finish(tbuck[t]) for t in ("T1", "T2", "T3") if tbuck[t]["n"]]

    rows_c = sorted((finish(b) for b in buckets.values()),
                    key=lambda x: (-x["n"], x["country"]))
    out["by_country"] = {
        "marks": [{"key": k, "label": lab} for k, lab in MARKS],
        "rows": rows_c,
        "tiers": tier_rows,
    }

    # ── APK 서명 인증서 (v971~) ────────────────────────────────
    # ⚠ 이건 intraday 로 봐야 한다. anomaly.py 쪽은 확정 일별 테이블이라 오늘치가 내일
    #   오후에야 보이는데, 차단 롤아웃 감시는 시간 단위여야 한다 — 오탐이 나면 Play 자동환불
    #   전에 롤백해야 하고(실질 데드라인 3일), 그 사이에 돈 낸 사람이 물건을 못 받는다.
    # 오탐 판별: 인증서에만 걸렸고 다른 위조 이력이 없으며 정상 결제 이력이 있는 사람.
    rsn = "(SELECT value.string_value FROM UNNEST(event_params) WHERE key='reason')"
    crt = "(SELECT value.string_value FROM UNNEST(user_properties) WHERE key='apk_cert')"
    cert_row = q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid,
          COUNTIF(event_name='purchase_anomaly' AND {rsn}='bad_apk_cert') AS cert_bad,
          COUNTIF(event_name='purchase_anomaly' AND {rsn} IN ('bad_orderid','dup_orderid')) AS id_bad,
          COUNTIF(event_name='purchase_anomaly' AND {rsn}='no_price') AS noprice,
          COUNTIF(event_name='purchase') AS ok
        FROM {TABLE} WHERE {INTRADAY} GROUP BY uid
      )
      SELECT SUM(cert_bad) AS events, COUNTIF(cert_bad > 0) AS users,
             COUNTIF(cert_bad > 0 AND id_bad = 0 AND noprice = 0 AND ok > 0) AS false_pos,
             COUNTIF(cert_bad > 0 AND id_bad = 0 AND noprice = 0 AND ok = 0) AS unknown,
             COUNTIF(cert_bad > 0 AND (id_bad > 0 OR noprice > 0)) AS known_bad
      FROM u
    """)[0]
    cert_dist = q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid,
          ARRAY_AGG({crt} IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS cert
        FROM {TABLE} WHERE {INTRADAY} GROUP BY uid
      )
      SELECT IFNULL(cert, '(미기록)') AS cert, COUNT(*) AS users
      FROM u GROUP BY cert ORDER BY users DESC LIMIT 10
    """)
    # 차단된 유저는 손에 꼽을 테니 꼬리표를 같이 내보낸다 — 오탐 의심이 뜨면 즉시 그 사람의
    # 로그를 까야 하는데, 태그가 없으면 찾는 데만 한 바퀴를 더 돈다.
    blocked = q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid,
          COUNTIF(event_name='purchase_anomaly' AND {rsn}='bad_apk_cert') AS cert_bad,
          COUNTIF(event_name='purchase_anomaly' AND {rsn} IN ('bad_orderid','dup_orderid')) AS id_bad,
          COUNTIF(event_name='purchase_anomaly' AND {rsn}='no_price') AS noprice,
          COUNTIF(event_name='purchase') AS ok,
          ARRAY_AGG({crt} IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS cert,
          ANY_VALUE(geo.country) AS country,
          ARRAY_AGG(app_info.version IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS ver,
          FORMAT_TIMESTAMP('%H:%M', TIMESTAMP_MICROS(MIN(event_timestamp)), 'Asia/Seoul') AS seen
        FROM {TABLE} WHERE {INTRADAY} GROUP BY uid
      )
      SELECT SUBSTR(TO_HEX(MD5(uid)), 1, 6) AS tag, cert_bad, id_bad, noprice, ok,
             IFNULL(cert, '') AS cert, IFNULL(country, '') AS country,
             IFNULL(ver, '') AS ver, seen
      FROM u WHERE cert_bad > 0 ORDER BY cert_bad DESC LIMIT 50
    """)
    GOOD_CERT = os.environ.get("APK_CERT", "dc0a72d0f17e769e")
    out["apk_cert"] = {
        "good": GOOD_CERT,
        "events": int(cert_row["events"] or 0),
        "users": int(cert_row["users"] or 0),
        "false_pos": int(cert_row["false_pos"] or 0),
        "unknown": int(cert_row["unknown"] or 0),
        "known_bad": int(cert_row["known_bad"] or 0),
        "dist": [{"cert": x["cert"], "users": int(x["users"]),
                  "ok": x["cert"] in (GOOD_CERT, "(미기록)")} for x in cert_dist],
        "blocked": [{"tag": b["tag"], "events": int(b["cert_bad"]), "cert": b["cert"],
                     "country": b["country"], "ver": b["ver"], "seen": b["seen"],
                     # 오탐: 인증서에만 걸렸고 정상 결제 이력이 있음 / 보류: 결제 이력도 없음
                     "kind": ("오탐 의심" if (b["id_bad"] == 0 and b["noprice"] == 0 and b["ok"] > 0)
                              else "위조 이력" if (b["id_bad"] or b["noprice"]) else "판단 보류")}
                    for b in blocked],
    }

    # ── 2부(도시) ──────────────────────────────────────────────
    # 2부 활동은 확정 테이블보다 intraday 에 먼저 들어온다. 출시 직후라 하루 단위로는
    # 아직 0 으로 보이는데, 여기서는 오늘 누가 들어왔고 어디까지 갔는지가 바로 보인다.
    # 가입 코호트와 무관하다 — 2부는 오래 플레이한 사람만 닿으므로 '오늘 가입자' 안에 없다.
    CITY_STEPS = [("first_conquer", "첫 인수"), ("first_upgrade", "첫 업그레이드"),
                  ("first_rent", "첫 월세"), ("first_event", "첫 라이브이벤트")]
    cstep = "(SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')"
    csel = ",\n        ".join(
        f"COUNT(DISTINCT IF(event_name='city_onb_step' AND {cstep}='{k}',"
        f" user_pseudo_id, NULL)) AS s_{k}"
        for k, _ in CITY_STEPS)
    crow = q(f"""
      SELECT
        COUNT(DISTINCT user_pseudo_id) AS users,
        COUNTIF(event_name='city_enter') AS enters,
        {csel},
        COUNT(DISTINCT IF(event_name='city_complete', user_pseudo_id, NULL)) AS done
      FROM {TABLE} WHERE {INTRADAY} AND {HAS_GEO} AND STARTS_WITH(event_name, 'city_')
    """)[0]
    cn = int(crow["users"] or 0)
    out["city"] = {
        "users": cn,
        "enters": int(crow["enters"] or 0),
        "done": int(crow["done"] or 0),
        "steps": [{"key": k, "label": lab, "n": int(crow[f"s_{k}"] or 0),
                   "pct": round(100 * int(crow[f"s_{k}"] or 0) / cn, 1) if cn else 0}
                  for k, lab in CITY_STEPS],
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
      FROM {TABLE} WHERE {INTRADAY} AND {HAS_GEO} AND event_name='ad_impression'
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
