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
from datetime import date, timedelta

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

    out: dict = {"updated": date.today().isoformat(), "window_days": WINDOW_DAYS,
                 "diag_start": f"{DIAG_START[:4]}-{DIAG_START[4:6]}-{DIAG_START[6:]}"}

    # ── KPI: 신규(7d)·활성(7d)·마지막 테이블 ───────────────────────────
    kpi = q(f"""
      SELECT
        COUNT(DISTINCT IF(event_name='first_open', user_pseudo_id, NULL)) AS new_users_win,
        COUNT(DISTINCT user_pseudo_id) AS active_users_win
      FROM {TABLE}
      WHERE {suffix_daily(f"_TABLE_SUFFIX BETWEEN '{win_start}' AND '{end_s}'")}
    """)[0]
    out["kpi"] = {k: int(v or 0) for k, v in kpi.items()}
    out["last_table"] = q(
        f"SELECT MAX(_TABLE_SUFFIX) AS t FROM {TABLE} "
        f"WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'"
    )[0]["t"]

    # ── 은퇴→자격→화면→첫환생 퍼널 (진단이벤트 기간) ──────────────────
    fr = q(f"""
      WITH u AS (
        SELECT user_pseudo_id,
          MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='game_sale',1,0))     AS retired,
          MAX(IF(event_name='rebirth_available',1,0))                                                                                   AS avail,
          MAX(IF(event_name='rebirth_screen_view',1,0))                                                                                 AS screen,
          MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='first_rebirth',1,0)) AS rebirthed
        FROM {TABLE}
        WHERE {suffix_daily(f"_TABLE_SUFFIX >= '{DIAG_START}'")}
        GROUP BY user_pseudo_id
      )
      SELECT
        SUM(retired) AS retired,
        SUM(IF(retired=1 AND avail=1,1,0)) AS eligible,
        SUM(IF(retired=1 AND screen=1,1,0)) AS opened,
        SUM(IF(retired=1 AND rebirthed=1,1,0)) AS rebirthed,
        SUM(IF(retired=1 AND rebirthed=0 AND avail=0,1,0)) AS reason_slow_climb,
        SUM(IF(retired=1 AND rebirthed=0 AND avail=1 AND screen=0,1,0)) AS reason_discoverability,
        SUM(IF(retired=1 AND rebirthed=0 AND screen=1,1,0)) AS reason_reset_shock
      FROM u WHERE retired=1
    """)[0]
    r = {k: int(v or 0) for k, v in fr.items()}
    out["rebirth_funnel"] = [
        {"stage": "은퇴", "users": r["retired"]},
        {"stage": "환생자격", "users": r["eligible"]},
        {"stage": "화면방문", "users": r["opened"]},
        {"stage": "첫환생", "users": r["rebirthed"]},
    ]
    out["rebirth_reasons"] = {
        "slow_climb": r["reason_slow_climb"],
        "discoverability": r["reason_discoverability"],
        "reset_shock": r["reason_reset_shock"],
    }

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
    out["stage_labels"] = [{"key": k, "label": lab} for k, lab in STAGES]
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
            "stages": [{"key": k, "label": lab, "n": int(x[f"s_{k}"] or 0),
                        "pct": round(100 * int(x[f"s_{k}"] or 0) / ng, 1)} for k, lab in STAGES],
        })

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"wrote {OUT}: retired={r['retired']} rebirth={r['rebirthed']} "
          f"deci_rows={len(out['deci_curve'])} onb={len(out['onboarding_funnel'])} "
          f"pacing={len(out['pacing'])} versions={len(out['by_version'])} last_table={out['last_table']}")


if __name__ == "__main__":
    main()
