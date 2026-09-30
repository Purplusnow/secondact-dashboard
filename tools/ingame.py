#!/usr/bin/env python3
"""인게임 분석 데이터 수집 — BigQuery(GA4 export) → docs/data/ingame.json.

GitHub Action(ingame.yml)이 하루 1회 실행. 브라우저는 BigQuery를 직접 못 하므로
여기서 쿼리를 돌려 JSON 한 장으로 떨궈두고, 정적 페이지(ingame.js)가 그걸 읽는다.

숫자 파라미터(level/deci/class/…)는 GA4 UI 측정기준엔 빈값이지만 BigQuery raw엔
value.int_value 로 정상 존재 → 여기서 직접 읽는다.

인증: 환경변수 GOOGLE_APPLICATION_CREDENTIALS(서비스계정 JSON 경로). 데이터셋 위치=asia-northeast3.
"""
import json
import os
from datetime import date, datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))   # 수집 스케줄이 KST라 갱신 표기도 KST로

from google.cloud import bigquery

PROJECT = os.environ.get("BQ_PROJECT", "second-act-life")
DATASET = os.environ.get("BQ_DATASET", "analytics_544010325")
LOCATION = os.environ.get("BQ_LOCATION", "asia-northeast3")
TABLE = f"`{PROJECT}.{DATASET}.events_*`"
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "ingame.json")

# v819 진단이벤트 배포일 — 환생/deci 퍼널은 이 이후만 유효.
DIAG_START = "20260923"
# 온보딩·페이싱은 더 길게(신규 유입 충분히).
WINDOW_DAYS = 45

client = bigquery.Client(project=PROJECT, location=LOCATION)


def q(sql: str) -> list[dict]:
    return [dict(r) for r in client.query(sql).result()]


def suffix_daily(cond: str) -> str:
    """_TABLE_SUFFIX 조건 + intraday 제외 헬퍼."""
    return f"({cond}) AND _TABLE_SUFFIX NOT LIKE 'intraday%'"


def main() -> None:
    end = date.today() - timedelta(days=1)          # 마지막으로 landing됐을 법한 날
    win_start = (end - timedelta(days=WINDOW_DAYS)).strftime("%Y%m%d")
    end_s = end.strftime("%Y%m%d")

    out: dict = {"updated": datetime.now(KST).strftime("%Y-%m-%d %H:%M") + " KST", "window_days": WINDOW_DAYS,
                 "diag_start": f"{DIAG_START[:4]}-{DIAG_START[4:6]}-{DIAG_START[6:]}"}

    # ── KPI: DAU·WAU·신규(7일)·누적·D1/D7 리텐션 ───────────────────────
    # (기존 '신규/활성 45일'은 게임 나이와 겹쳐 신규≈활성≈전체로 오해 유발 → 실질 지표로 교체)
    last_t = q(f"SELECT MAX(_TABLE_SUFFIX) AS t FROM {TABLE} WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'")[0]["t"]
    out["last_table"] = last_t
    _last = datetime.strptime(last_t, "%Y%m%d").date()
    d7 = (_last - timedelta(days=6)).strftime("%Y%m%d")     # 최근 7일(마지막일 포함)
    k = q(f"""
      SELECT
        COUNT(DISTINCT IF(_TABLE_SUFFIX='{last_t}', user_pseudo_id, NULL)) AS dau,
        COUNT(DISTINCT user_pseudo_id) AS wau,
        COUNT(DISTINCT IF(event_name='first_open', user_pseudo_id, NULL)) AS new_7d
      FROM {TABLE}
      WHERE {suffix_daily(f"_TABLE_SUFFIX BETWEEN '{d7}' AND '{last_t}'")}
    """)[0]
    cum = q(f"SELECT COUNT(DISTINCT user_pseudo_id) AS n FROM {TABLE} WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'")[0]["n"]
    # D1/D7 리텐션 — 설치일(d0) 대비 d0+1 / d0+7 복귀. 분모=관측 가능한 코호트(마지막 테이블일 기준).
    ld = _last.isoformat()
    ret = q(f"""
      WITH inst AS (
        SELECT user_pseudo_id, MIN(PARSE_DATE('%Y%m%d', _TABLE_SUFFIX)) AS d0
        FROM {TABLE} WHERE event_name='first_open' AND _TABLE_SUFFIX NOT LIKE 'intraday%'
        GROUP BY user_pseudo_id
      ),
      act AS (
        SELECT DISTINCT user_pseudo_id, PARSE_DATE('%Y%m%d', _TABLE_SUFFIX) AS d
        FROM {TABLE} WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
      )
      SELECT
        COUNTIF(i.d0 <= DATE_SUB(DATE '{ld}', INTERVAL 1 DAY)) AS d1_base,
        COUNTIF(i.d0 <= DATE_SUB(DATE '{ld}', INTERVAL 1 DAY) AND a1.user_pseudo_id IS NOT NULL) AS d1_ret,
        COUNTIF(i.d0 <= DATE_SUB(DATE '{ld}', INTERVAL 7 DAY)) AS d7_base,
        COUNTIF(i.d0 <= DATE_SUB(DATE '{ld}', INTERVAL 7 DAY) AND a7.user_pseudo_id IS NOT NULL) AS d7_ret
      FROM inst i
      LEFT JOIN act a1 ON a1.user_pseudo_id=i.user_pseudo_id AND a1.d=DATE_ADD(i.d0, INTERVAL 1 DAY)
      LEFT JOIN act a7 ON a7.user_pseudo_id=i.user_pseudo_id AND a7.d=DATE_ADD(i.d0, INTERVAL 7 DAY)
    """)[0]
    def _rp(a, b): return round(100 * int(a or 0) / int(b), 1) if int(b or 0) else None
    out["kpi"] = {
        "dau": int(k["dau"] or 0), "wau": int(k["wau"] or 0),
        "new_7d": int(k["new_7d"] or 0), "cumulative": int(cum or 0),
        "d1": _rp(ret["d1_ret"], ret["d1_base"]), "d1_base": int(ret["d1_base"] or 0),
        "d7": _rp(ret["d7_ret"], ret["d7_base"]), "d7_base": int(ret["d7_base"] or 0),
    }

    # ── 새게임→은퇴→첫환생 퍼널 (진단이벤트 기간, 신뢰 가능한 onb_step만) ──────────────────
    # 은퇴 이전 모수(새게임=전체 시작)를 함께 보여 은퇴/환생을 맥락 속에서 읽는다.
    # ⚠ 구 중간2단계(rebirth_available/screen_view)는 과소기록으로 퍼널 역전이라 제외(원인분할도 제거).
    def _stp(v): return f"(SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='{v}'"
    fr = q(f"""
      SELECT
        COUNT(DISTINCT IF(event_name='onb_step' AND {_stp('new_game')}, user_pseudo_id, NULL)) AS started,
        COUNT(DISTINCT IF(event_name='onb_step' AND {_stp('game_sale')}, user_pseudo_id, NULL)) AS retired,
        COUNT(DISTINCT IF(event_name='onb_step' AND {_stp('first_rebirth')}, user_pseudo_id, NULL)) AS rebirthed
      FROM {TABLE}
      WHERE {suffix_daily(f"_TABLE_SUFFIX >= '{DIAG_START}'")}
    """)[0]
    r = {k: int(v or 0) for k, v in fr.items()}
    out["rebirth_funnel"] = [
        {"stage": "새게임", "users": r["started"]},
        {"stage": "은퇴", "users": r["retired"]},
        {"stage": "첫환생", "users": r["rebirthed"]},
    ]

    # ── 0~3.2% deci 이탈곡선 (진단이벤트 기간) ────────────────────────
    deci = q(f"""
      WITH d AS (
        SELECT
          (SELECT value.int_value FROM UNNEST(event_params) WHERE key='deci') AS deci,
          user_pseudo_id,
          MIN((SELECT value.int_value FROM UNNEST(event_params) WHERE key='secs_since_install')) AS secs,
          MAX((SELECT value.int_value FROM UNNEST(event_params) WHERE key='class')) AS class
        FROM {TABLE}
        WHERE event_name='progress_deci' AND {suffix_daily(f"_TABLE_SUFFIX >= '{DIAG_START}'")}
        GROUP BY deci, user_pseudo_id
      ),
      agg AS (
        SELECT deci,
          COUNT(DISTINCT user_pseudo_id) AS users,
          APPROX_QUANTILES(secs,2)[OFFSET(1)] AS median_secs,
          APPROX_QUANTILES(class,2)[OFFSET(1)] AS median_class
        FROM d WHERE deci BETWEEN 1 AND 32 GROUP BY deci
      )
      SELECT deci, users, median_secs, median_class FROM agg ORDER BY deci
    """)
    # ★모수 = 은퇴(game_sale) 유저 = 추월(신분등반) 0% 시작점. deci는 0.1% 크로싱만 찍혀
    #   0%→0.1% 이탈이 안 보이던 문제 → deci=0(은퇴수)을 baseline으로 넣어 첫 드롭까지 드러낸다.
    base = q(f"""
      SELECT COUNT(DISTINCT user_pseudo_id) AS n FROM {TABLE}
      WHERE event_name='onb_step'
        AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='game_sale'
        AND {suffix_daily(f"_TABLE_SUFFIX >= '{DIAG_START}'")}
    """)[0]["n"] or 0
    series = [{"deci": 0, "pct": 0.0, "users": int(base), "median_secs": 0, "median_class": None}]
    for x in deci:
        series.append({"deci": int(x["deci"]), "pct": round(int(x["deci"]) / 10.0, 1),
                       "users": int(x["users"]), "median_secs": x["median_secs"], "median_class": x["median_class"]})
    start = int(base) or (series[1]["users"] if len(series) > 1 else 1) or 1
    out["deci_baseline"] = int(base)
    out["deci_curve"] = []
    prev = None
    for s in series:
        drop = (round(100 * (prev - s["users"]) / prev, 1) if (prev and prev > 0) else None)
        out["deci_curve"].append({
            "deci": s["deci"], "pct": s["pct"], "users": s["users"],
            "pct_of_start": round(100 * s["users"] / start, 1),
            "step_drop_pct": drop,
            "median_hours": (round(int(s["median_secs"]) / 3600.0, 1) if s["median_secs"] else None),
            "median_class": (int(s["median_class"]) if s["median_class"] is not None else None),
        })
        prev = s["users"]

    # ── 은퇴→진입 세부 퍼널 (0%→0.1% 구간을 class_up·first_donate로 세분) ──────
    # 은퇴자의 73% 이탈이 0%→0.1%에 몰려 있어, 그 안을 후원·신분2/3/4로 쪼갠다.
    ef = q(f"""
      WITH u AS (
        SELECT user_pseudo_id,
          MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='game_sale',1,0))    AS retired,
          MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='first_donate',1,0)) AS donated,
          MAX(IF(event_name='class_up' AND (SELECT value.int_value FROM UNNEST(event_params) WHERE key='level')>=2,1,0)) AS c2,
          MAX(IF(event_name='class_up' AND (SELECT value.int_value FROM UNNEST(event_params) WHERE key='level')>=3,1,0)) AS c3,
          MAX(IF(event_name='class_up' AND (SELECT value.int_value FROM UNNEST(event_params) WHERE key='level')>=4,1,0)) AS c4,
          MAX(IF(event_name='progress_deci',1,0)) AS d1
        FROM {TABLE}
        WHERE {suffix_daily(f"_TABLE_SUFFIX >= '{DIAG_START}'")}
        GROUP BY user_pseudo_id
      )
      SELECT SUM(retired) AS retired,
        SUM(IF(retired=1 AND donated=1,1,0)) AS donated,
        SUM(IF(retired=1 AND c2=1,1,0)) AS c2,
        SUM(IF(retired=1 AND c3=1,1,0)) AS c3,
        SUM(IF(retired=1 AND c4=1,1,0)) AS c4,
        SUM(IF(retired=1 AND d1=1,1,0)) AS d1
      FROM u WHERE retired=1
    """)[0]
    ef = {k: int(v or 0) for k, v in ef.items()}
    out["entry_funnel"] = [
        {"stage": "은퇴", "users": ef["retired"]},
        {"stage": "첫 후원", "users": ef["donated"]},
        {"stage": "신분2", "users": ef["c2"]},
        {"stage": "신분3", "users": ef["c3"]},
        {"stage": "신분4", "users": ef["c4"]},
        {"stage": "추월 0.1%", "users": ef["d1"]},
    ]

    # ── 온보딩 퍼널 (20스텝, distinct users) ──────────────────────────
    onb = q(f"""
      SELECT
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key='step_idx') AS idx,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')  AS step,
        COUNT(DISTINCT user_pseudo_id) AS users
      FROM {TABLE}
      WHERE event_name='onb_step'
        AND {suffix_daily(f"_TABLE_SUFFIX BETWEEN '{win_start}' AND '{end_s}'")}
      GROUP BY idx, step HAVING idx IS NOT NULL ORDER BY idx
    """)
    out["onboarding_funnel"] = [
        {"idx": int(x["idx"]), "step": x["step"], "users": int(x["users"])} for x in onb
    ]

    # ── 페이싱 커브: %별 도달 소요시간 중앙값 ─────────────────────────
    pacing = q(f"""
      WITH p AS (
        SELECT
          (SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct') AS pct,
          user_pseudo_id,
          MIN((SELECT value.int_value FROM UNNEST(event_params) WHERE key='secs_since_install')) AS secs
        FROM {TABLE}
        WHERE event_name='progress_pct'
          AND {suffix_daily(f"_TABLE_SUFFIX BETWEEN '{win_start}' AND '{end_s}'")}
        GROUP BY pct, user_pseudo_id
      )
      SELECT pct,
        COUNT(DISTINCT user_pseudo_id) AS users,
        APPROX_QUANTILES(secs,2)[OFFSET(1)] AS median_secs
      FROM p WHERE pct BETWEEN 1 AND 100 GROUP BY pct ORDER BY pct
    """)
    out["pacing"] = [{
        "pct": int(x["pct"]), "users": int(x["users"]),
        "median_hours": (round(int(x["median_secs"]) / 3600.0, 1) if x["median_secs"] is not None else None),
    } for x in pacing]

    # ── 버전별 비교 (첫 등장 버전 코호트) — 20단계 구간 도달율 ──────────
    # 유저를 '처음 나타난 app_version'으로 묶고, 각 온보딩 단계 도달수를 전부 집계.
    # ⚠️ 최신 버전 코호트는 어려서(cohort_age 작음) 뒷단계 도달율이 낮게 보이는 게 정상 → age 병기.
    STAGES = [
        ("new_game", "새게임"), ("intro_done", "인트로"), ("dev_concept", "기획"),
        ("dev_design", "디자인"), ("dev_prototype", "프로토"), ("dev_alpha", "알파"),
        ("dev_beta", "베타"), ("dev_launch", "출시"), ("first_ops", "첫운영"),
        ("property_1", "부동산1"), ("property_2", "부동산2"), ("property_3", "부동산3"),
        ("property_4", "부동산4"), ("property_5", "부동산5"), ("game_sale", "은퇴"),
        ("first_manager", "첫매니저"), ("first_donate", "첫후원"), ("first_settle", "첫정산"),
        ("first_finance", "첫금융"), ("first_rebirth", "첫환생"),
    ]
    flag_sql = ",\n          ".join(
        f"MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='{k}',1,0)) AS s_{k}"
        for k, _ in STAGES)
    sum_sql = ", ".join(f"SUM(s_{k}) AS s_{k}" for k, _ in STAGES)
    # 신분 등반(class_up level>=N) 단계 — 첫후원 뒤에 신분2~7 삽입.
    CLASS_STAGES = [(2, "신분2"), (3, "신분3"), (4, "신분4"), (5, "신분5"), (6, "신분6"), (7, "신분7")]
    flag_sql += ",\n          " + ",\n          ".join(
        f"MAX(IF(event_name='class_up' AND (SELECT value.int_value FROM UNNEST(event_params) WHERE key='level')>={lv},1,0)) AS c{lv}"
        for lv, _ in CLASS_STAGES)
    sum_sql += ", " + ", ".join(f"SUM(c{lv}) AS c{lv}" for lv, _ in CLASS_STAGES)
    # 표시 순서(라벨 + 각 버전 steps 조립 공용): 첫후원 뒤 신분2~7.
    ORDER = []
    for k, lab in STAGES:
        ORDER.append((k, lab, "s_" + k))
        if k == "first_donate":
            for lv, clab in CLASS_STAGES:
                ORDER.append((f"class{lv}", clab, f"c{lv}"))

    def steps_from(x: dict, ng: int) -> list:
        res = []
        for key, lab, col in ORDER:
            n = int(x.get(col) or 0)
            res.append({"key": key, "label": lab, "n": n, "pct": round(100 * n / ng, 1)})
        return res
    ver = q(f"""
      WITH u AS (
        SELECT user_pseudo_id,
          ARRAY_AGG(app_info.version IGNORE NULLS ORDER BY event_timestamp LIMIT 1)[SAFE_OFFSET(0)] AS fver,
          MIN(event_timestamp) AS first_ts,
          {flag_sql}
        FROM {TABLE}
        WHERE {suffix_daily(f"_TABLE_SUFFIX BETWEEN '{win_start}' AND '{end_s}'")}
        GROUP BY user_pseudo_id
      )
      SELECT fver AS version, COUNT(*) AS users,
        ROUND(AVG(TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MICROS(first_ts), HOUR))/24.0, 1) AS cohort_age_days,
        {sum_sql}
      FROM u WHERE fver IS NOT NULL
      GROUP BY version HAVING COUNT(*) >= 50
      ORDER BY version DESC LIMIT 12
    """)
    out["stage_labels"] = [{"key": k, "label": lab} for k, lab, _ in ORDER]
    out["by_version"] = []
    for x in ver:
        ng = int(x["s_new_game"] or 0) or 1
        retired = int(x["s_game_sale"] or 0)
        reborn = int(x["s_first_rebirth"] or 0)
        out["by_version"].append({
            "version": x["version"], "users": int(x["users"]),
            "cohort_age_days": (float(x["cohort_age_days"]) if x["cohort_age_days"] is not None else None),
            "new_game": int(x["s_new_game"] or 0), "retired": retired, "rebirthed": reborn,
            "conv_new_to_retire": round(100 * retired / ng, 1) if ng else None,
            "conv_retire_to_rebirth": round(100 * reborn / retired, 1) if retired else None,
            "stages": steps_from(x, ng),
        })

    # ── (전체기간) 버전별 온보딩 퍼널 — 첫 등장 버전 코호트, all-time ──────
    # 대시보드 '버전 선택(체크박스)' 뷰용. 윈도우 없이 전 기간. 첫 등장 버전으로 코호트.
    ver_onb = q(f"""
      WITH u AS (
        SELECT user_pseudo_id,
          ARRAY_AGG(app_info.version IGNORE NULLS ORDER BY event_timestamp)[SAFE_OFFSET(0)] AS fver,
          {flag_sql}
        FROM {TABLE}
        WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
        GROUP BY user_pseudo_id
      )
      SELECT fver AS version, COUNT(*) AS users, {sum_sql}
      FROM u WHERE fver IS NOT NULL
      GROUP BY version HAVING COUNT(*) >= 30
      ORDER BY version DESC
    """)
    out["onb_versions"] = []
    for x in ver_onb:
        ng = int(x["s_new_game"] or 0) or 1
        out["onb_versions"].append({
            "version": x["version"], "users": int(x["users"]),
            "new_game": int(x["s_new_game"] or 0),
            "steps": steps_from(x, ng),
        })
    # "전체" = 전 버전(업데이트한 사람 포함) 합산 온보딩 퍼널. 맨 앞에 → 체크박스로 선택 가능하고
    # reach '전체' 컬럼도 이 버전키로 필터를 통과한다. (버전별과 나란히 '통합 한 장' 보기)
    if ver_onb:
        # ⚠ s_new_game은 ORDER(new_game 단계)에 이미 포함 → 여기서 따로 더하면 분모 이중합산(=%가 반토막)됨.
        # ORDER 루프로만 합산한다.
        totx: dict = {}
        for x in ver_onb:
            for _k, _l, col in ORDER:
                totx[col] = totx.get(col, 0) + int(x[col] or 0)
        ng_all = totx.get("s_new_game", 0) or 1
        out["onb_versions"].insert(0, {
            "version": "통합", "users": sum(int(x["users"]) for x in ver_onb),
            "new_game": totx.get("s_new_game", 0), "steps": steps_from(totx, ng_all),
        })

    # ── (전체기간) 버전별 '최대 추월%' 도달 분포 ──────────────────────────
    # progress_pct(pct=정수 추월%)의 유저별 최대값 분포. 미도달(1% 미만)=0 버킷.
    # 버킷 0~100 개별(추월% 전 구간) + 100+ 묶음(엔딩 초과분·이론상 없음). 첫 등장 버전 코호트.
    reach = q(f"""
      WITH u AS (
        SELECT user_pseudo_id,
          ARRAY_AGG(app_info.version IGNORE NULLS ORDER BY event_timestamp)[SAFE_OFFSET(0)] AS fver,
          MAX(IF(event_name='progress_pct',
                 (SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct'), 0)) AS maxpct
        FROM {TABLE}
        WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
        GROUP BY user_pseudo_id
      )
      SELECT fver AS version, IFNULL(maxpct, 0) AS maxpct, COUNT(*) AS users
      FROM u WHERE fver IS NOT NULL
      GROUP BY version, maxpct
    """)
    from collections import defaultdict
    CAP = 100  # 0~100 개별(추월% 전 구간 표시), 그 이상은 CAP+1(=101, 이론상 없음)
    vtot: dict = defaultdict(int)
    vdist: dict = defaultdict(lambda: defaultdict(int))
    for x in reach:
        v = x["version"]
        b = min(int(x["maxpct"] or 0), CAP + 1)
        vtot[v] += int(x["users"])
        vdist[v][b] += int(x["users"])
    keep = sorted([v for v in vtot if vtot[v] >= 30], reverse=True)
    # "전체" = 전 버전(업데이트한 사람 포함) 유저를 1회씩 합산한 통합 분포. 버전별 옆에 한 컬럼으로.
    all_dist: dict = defaultdict(int)
    all_users = 0
    for v in vtot:               # keep 필터 없이 모든 버전 합산 = 진짜 전체
        all_users += vtot[v]
        for b, n in vdist[v].items():
            all_dist[b] += n
    total_entry = {"version": "통합", "users": all_users,
                   "dist": {str(b): all_dist.get(b, 0) for b in range(0, CAP + 2)}}
    out["reach_versions"] = {
        "buckets": list(range(0, CAP + 2)),
        "cap": CAP,
        # "전체"를 맨 앞에 → 버전별과 나란히 비교. (합산은 keep 무관 전 버전 포함)
        "versions": [total_entry] + [{"version": v, "users": vtot[v],
                      "dist": {str(b): vdist[v].get(b, 0) for b in range(0, CAP + 2)}} for v in keep],
    }
    # ── 도달 생존곡선(통합) — %별 "그 %까지 도달한 유저 수" (max분포 누적합; 추월%는 단조라 정확) ──
    # 최고점 분포와 달리 매끄러운 하강곡선. survival(p)=Σ dist[b≥p]. survival(0)=전체.
    cum = 0
    surv: list = []
    for p in range(CAP + 1, -1, -1):
        cum += all_dist.get(p, 0)
        surv.append({"pct": p, "users": cum,
                     "pct_of_all": (round(100 * cum / all_users, 1) if all_users else 0.0)})
    surv.reverse()   # 0→101 오름차순
    out["reach_curve"] = surv

    # ══ 2부(도시) — 진입 퍼널 · 초반 이탈곡선 · 진행 페이싱 ════════════════════
    # city_* 계측(v916+). 진입→첫액션 퍼널=city_enter/city_onb_step/city_complete,
    # 초반 이탈곡선=city_progress_deci(완성도 0.1%×50), 페이싱=city_progress_pct.
    def _p_str(k: str) -> str:
        return f"(SELECT value.string_value FROM UNNEST(event_params) WHERE key='{k}')"
    def _p_int(k: str) -> str:
        return f"(SELECT value.int_value FROM UNNEST(event_params) WHERE key='{k}')"
    cu = q(f"""
      WITH u AS (
        SELECT user_pseudo_id,
          MAX(IF(event_name='city_enter',1,0)) AS entered,
          MAX(IF(event_name='city_onb_step' AND {_p_str('step')}='first_conquer',1,0)) AS s_conquer,
          MAX(IF(event_name='city_onb_step' AND {_p_str('step')}='first_upgrade',1,0)) AS s_upgrade,
          MAX(IF(event_name='city_onb_step' AND {_p_str('step')}='first_rent',1,0)) AS s_rent,
          MAX(IF(event_name='city_onb_step' AND {_p_str('step')}='first_event',1,0)) AS s_event,
          MAX(IF(event_name='city_complete',1,0)) AS completed
        FROM {TABLE}
        WHERE {suffix_daily(f"_TABLE_SUFFIX >= '{DIAG_START}'")}
        GROUP BY user_pseudo_id
      )
      SELECT SUM(entered) AS entered, SUM(s_conquer) AS s_conquer, SUM(s_upgrade) AS s_upgrade,
             SUM(s_rent) AS s_rent, SUM(s_event) AS s_event, SUM(completed) AS completed
      FROM u WHERE entered=1
    """)[0]
    ce = int(cu["entered"] or 0)
    out["city_kpi"] = {
        "entered": ce,
        "completed": int(cu["completed"] or 0),
        "completion_pct": (round(100 * int(cu["completed"] or 0) / ce, 1) if ce else None),
    }
    out["city_entry_funnel"] = [
        {"stage": "도시 진입", "users": ce},
        {"stage": "첫 인수", "users": int(cu["s_conquer"] or 0)},
        {"stage": "첫 업그레이드", "users": int(cu["s_upgrade"] or 0)},
        {"stage": "첫 월세 수금", "users": int(cu["s_rent"] or 0)},
        {"stage": "첫 라이브이벤트", "users": int(cu["s_event"] or 0)},
        {"stage": "도시 완성(엔딩)", "users": int(cu["completed"] or 0)},
    ]
    # 초반 이탈곡선(완성도 0.1%×50) — baseline=city_enter 유저.
    cdeci = q(f"""
      SELECT deci, COUNT(DISTINCT user_pseudo_id) AS users,
             APPROX_QUANTILES(days,2)[OFFSET(1)] AS median_days
      FROM (
        SELECT {_p_int('deci')} AS deci, user_pseudo_id,
               MIN({_p_int('days_since_enter')}) AS days
        FROM {TABLE}
        WHERE event_name='city_progress_deci' AND {suffix_daily(f"_TABLE_SUFFIX >= '{DIAG_START}'")}
        GROUP BY deci, user_pseudo_id
      )
      WHERE deci BETWEEN 1 AND 50 GROUP BY deci ORDER BY deci
    """)
    cseries = [{"deci": 0, "pct": 0.0, "users": ce, "median_days": 0}]
    for x in cdeci:
        cseries.append({"deci": int(x["deci"]), "pct": round(int(x["deci"]) / 10.0, 1),
                        "users": int(x["users"]), "median_days": x["median_days"]})
    cstart = ce or (cseries[1]["users"] if len(cseries) > 1 else 1) or 1
    out["city_deci_baseline"] = ce
    out["city_deci_curve"] = []
    cprev = None
    for s in cseries:
        drop = (round(100 * (cprev - s["users"]) / cprev, 1) if (cprev and cprev > 0) else None)
        out["city_deci_curve"].append({
            "deci": s["deci"], "pct": s["pct"], "users": s["users"],
            "pct_of_start": round(100 * s["users"] / cstart, 1),
            "step_drop_pct": drop,
            "median_days": (int(s["median_days"]) if s["median_days"] is not None else None),
        })
        cprev = s["users"]
    # 진행 페이싱(완성도 %) — 도달 유저 + 중위 경과일.
    cpace = q(f"""
      SELECT pct, COUNT(DISTINCT user_pseudo_id) AS users,
             APPROX_QUANTILES(days,2)[OFFSET(1)] AS median_days
      FROM (
        SELECT {_p_int('pct')} AS pct, user_pseudo_id, MIN({_p_int('days_since_enter')}) AS days
        FROM {TABLE}
        WHERE event_name='city_progress_pct' AND {suffix_daily(f"_TABLE_SUFFIX >= '{DIAG_START}'")}
        GROUP BY pct, user_pseudo_id
      )
      GROUP BY pct ORDER BY pct
    """)
    out["city_pacing"] = [{
        "pct": int(x["pct"]), "users": int(x["users"]),
        "median_days": (int(x["median_days"]) if x["median_days"] is not None else None),
    } for x in cpace]

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"wrote {OUT}: retired={r['retired']} rebirth={r['rebirthed']} "
          f"deci_rows={len(out['deci_curve'])} onb={len(out['onboarding_funnel'])} "
          f"pacing={len(out['pacing'])} versions={len(out['by_version'])} "
          f"onb_versions={len(out['onb_versions'])} reach_versions={len(out['reach_versions']['versions'])} "
          f"city_entered={ce} city_complete={out['city_kpi']['completed']} city_deci={len(out['city_deci_curve'])} "
          f"last_table={out['last_table']}")


if __name__ == "__main__":
    main()
