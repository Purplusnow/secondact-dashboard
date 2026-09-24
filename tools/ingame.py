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

    out: dict = {"updated": date.today().isoformat(), "window_days": WINDOW_DAYS}

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
      SELECT deci, users, median_secs, median_class,
        ROUND(100*(LAG(users) OVER (ORDER BY deci)-users)/NULLIF(LAG(users) OVER (ORDER BY deci),0),1) AS step_drop_pct
      FROM agg ORDER BY deci
    """)
    peak = max((row["users"] for row in deci), default=0) or 1
    out["deci_curve"] = [{
        "deci": int(x["deci"]), "pct": round(int(x["deci"]) / 10.0, 1),
        "users": int(x["users"]),
        "pct_of_start": round(100 * int(x["users"]) / peak, 1),
        "step_drop_pct": (round(float(x["step_drop_pct"]), 1) if x["step_drop_pct"] is not None else None),
        "median_hours": (round(int(x["median_secs"]) / 3600.0, 1) if x["median_secs"] is not None else None),
        "median_class": (int(x["median_class"]) if x["median_class"] is not None else None),
    } for x in deci]

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

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"wrote {OUT}: retired={r['retired']} rebirth={r['rebirthed']} "
          f"deci_rows={len(out['deci_curve'])} onb={len(out['onboarding_funnel'])} "
          f"pacing={len(out['pacing'])} last_table={out['last_table']}")


if __name__ == "__main__":
    main()
