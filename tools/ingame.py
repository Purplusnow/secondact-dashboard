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
    # 리텐션 곡선 D1~D30 — 설치일(d0) 대비 정확히 n일 뒤 복귀. 분모(base[n])=마지막 테이블일 기준 n일 관측
    # 가능한 코호트(d0 ≤ last-n). 복귀자는 정의상 d0+n ≤ last라 모두 관측가능(별도 필터 불필요).
    inst_hist = q(f"""
      SELECT d0, COUNT(*) AS n FROM (
        SELECT user_pseudo_id, MIN(_TABLE_SUFFIX) AS d0
        FROM {TABLE} WHERE event_name='first_open' AND _TABLE_SUFFIX NOT LIKE 'intraday%'
        GROUP BY user_pseudo_id
      ) GROUP BY d0
    """)
    retq = q(f"""
      SELECT off, COUNT(DISTINCT uid) AS ret FROM (
        SELECT i.user_pseudo_id AS uid, DATE_DIFF(a.d, i.d0, DAY) AS off
        FROM (
          SELECT user_pseudo_id, MIN(PARSE_DATE('%Y%m%d', _TABLE_SUFFIX)) AS d0
          FROM {TABLE} WHERE event_name='first_open' AND _TABLE_SUFFIX NOT LIKE 'intraday%'
          GROUP BY user_pseudo_id
        ) i
        JOIN (
          SELECT DISTINCT user_pseudo_id, PARSE_DATE('%Y%m%d', _TABLE_SUFFIX) AS d
          FROM {TABLE} WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
        ) a ON a.user_pseudo_id = i.user_pseudo_id
      ) WHERE off BETWEEN 1 AND 30 GROUP BY off
    """)
    ret_by = {int(x["off"]): int(x["ret"] or 0) for x in retq}
    insts = [(datetime.strptime(x["d0"], "%Y%m%d").date(), int(x["n"])) for x in inst_hist]
    out["retention_curve"] = []
    for nd in range(1, 31):
        cutoff = _last - timedelta(days=nd)
        base = sum(c for d0, c in insts if d0 <= cutoff)
        rr = ret_by.get(nd, 0)
        out["retention_curve"].append({
            "day": nd, "ret": rr, "base": base,
            "pct": (round(100 * rr / base, 1) if base else None),
        })
    # 코호트 리텐션 삼각 — 설치일(d0) 행 × Day1..DayN 열. 셀=그 코호트 중 정확히 n일 뒤 복귀 비율.
    # d0+n > last(아직 안 지난 날)은 관측불가 → null. 최근 COHORT_DAYS일치 코호트 × Day1..COHORT_N.
    COHORT_N = 14
    cohq = q(f"""
      SELECT d0, off, COUNT(DISTINCT uid) AS ret FROM (
        SELECT i.user_pseudo_id AS uid, i.d0 AS d0, DATE_DIFF(a.d, PARSE_DATE('%Y%m%d', i.d0), DAY) AS off
        FROM (
          SELECT user_pseudo_id, MIN(_TABLE_SUFFIX) AS d0
          FROM {TABLE} WHERE event_name='first_open' AND _TABLE_SUFFIX NOT LIKE 'intraday%'
          GROUP BY user_pseudo_id
        ) i
        JOIN (
          SELECT DISTINCT user_pseudo_id, PARSE_DATE('%Y%m%d', _TABLE_SUFFIX) AS d
          FROM {TABLE} WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
        ) a ON a.user_pseudo_id = i.user_pseudo_id
      ) WHERE off BETWEEN 1 AND {COHORT_N} GROUP BY d0, off
    """)
    coh_ret: dict = {}
    for x in cohq:
        coh_ret[(x["d0"], int(x["off"]))] = int(x["ret"] or 0)
    inst_by = {x["d0"]: int(x["n"]) for x in inst_hist}
    out["retention_cohort"] = {"n": COHORT_N, "rows": []}
    for d0s in sorted(inst_by.keys()):
        d0 = datetime.strptime(d0s, "%Y%m%d").date()
        nu = inst_by[d0s]
        days = []
        for nd in range(1, COHORT_N + 1):
            if d0 + timedelta(days=nd) > _last or nu == 0:
                days.append(None)  # 아직 관측 불가 / 코호트 없음
            else:
                days.append(round(100 * coh_ret.get((d0s, nd), 0) / nu, 1))
        out["retention_cohort"]["rows"].append({
            "date": d0.strftime("%Y-%m-%d"), "new": nu, "days": days,
        })
    def _dget(nd):
        row = out["retention_curve"][nd - 1]
        return row["pct"], row["base"]
    d1p, d1b = _dget(1); d7p, d7b = _dget(7); d30p, d30b = _dget(30)
    out["kpi"] = {
        "dau": int(k["dau"] or 0), "wau": int(k["wau"] or 0),
        "new_7d": int(k["new_7d"] or 0), "cumulative": int(cum or 0),
        "d1": d1p, "d1_base": d1b, "d7": d7p, "d7_base": d7b, "d30": d30p, "d30_base": d30b,
    }

    # ── 새게임→은퇴→첫환생 퍼널 (진단이벤트 기간, 신뢰 가능한 onb_step만) ──────────────────
    # 은퇴 이전 모수(새게임=전체 시작)를 함께 보여 은퇴/환생을 맥락 속에서 읽는다.
    # ⚠ 구 중간2단계(rebirth_available/screen_view)는 과소기록으로 퍼널 역전이라 제외(원인분할도 제거).
    # ⚠ onb_step은 계정당 1회 생애이벤트라 '창'으로 자르면 코호트가 섞여(창 전 은퇴 + 창 내 환생) 퍼널이
    #   역전됨. 전체기간(lifetime)으로 세야 new_game ⊇ 은퇴 ⊇ 첫환생 단조가 성립.
    def _stp(v): return f"(SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')='{v}'"
    fr = q(f"""
      SELECT
        COUNT(DISTINCT IF(event_name='onb_step' AND {_stp('new_game')}, user_pseudo_id, NULL)) AS started,
        COUNT(DISTINCT IF(event_name='onb_step' AND {_stp('game_sale')}, user_pseudo_id, NULL)) AS retired,
        COUNT(DISTINCT IF(event_name='onb_step' AND {_stp('first_rebirth')}, user_pseudo_id, NULL)) AS rebirthed
      FROM {TABLE}
      WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
    """)[0]
    r = {k: int(v or 0) for k, v in fr.items()}
    out["rebirth_funnel"] = [
        {"stage": "새게임", "users": r["started"]},
        {"stage": "은퇴", "users": r["retired"]},
        {"stage": "첫환생", "users": r["rebirthed"]},
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

    # ── 진행 분포 히트맵 (날짜 × 추월% 프론티어) ────────────────────────
    # 그날 progress_pct(1% 크로싱)를 찍은 유저별 '그날 최고 도달%'를 5%버킷으로 묶어
    # (날짜, 버킷)당 distinct 유저수 집계. 셀 진하기=유저수 → 진행 무리가 날짜따라 어디로 움직이나.
    # ⚠ progress_pct는 크로싱만 찍혀 1%미만(미돌파 69%)은 안 잡힘 — '전진 중인 유저의 프론티어' 분포.
    PROG_BUCKET = 5
    prog = q(f"""
      WITH u AS (
        SELECT _TABLE_SUFFIX AS d, user_pseudo_id AS uid,
          MAX((SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct')) AS mp
        FROM {TABLE}
        WHERE event_name='progress_pct'
          AND {suffix_daily(f"_TABLE_SUFFIX BETWEEN '{win_start}' AND '{end_s}'")}
        GROUP BY d, uid
      )
      SELECT d, CAST(FLOOR(LEAST(mp,100)/{PROG_BUCKET})*{PROG_BUCKET} AS INT64) AS bucket,
        COUNT(DISTINCT uid) AS n
      FROM u WHERE mp BETWEEN 1 AND 100 GROUP BY d, bucket ORDER BY d, bucket
    """)
    # 날짜 목록(연속) — 데이터 없는 날도 빈 칼럼으로 보이게 win_start~end 전체.
    _dstart = datetime.strptime(win_start, "%Y%m%d").date()
    _dend = datetime.strptime(end_s, "%Y%m%d").date()
    _dates = []
    _dd = _dstart
    while _dd <= _dend:
        _dates.append(_dd.strftime("%Y-%m-%d"))
        _dd += timedelta(days=1)
    out["progress_heatmap"] = {
        "bucket": PROG_BUCKET,
        "dates": _dates,
        "cells": [{"date": f"{x['d'][:4]}-{x['d'][4:6]}-{x['d'][6:]}",
                   "bucket": int(x["bucket"]), "n": int(x["n"])} for x in prog],
    }

    # ── 수익 지표 (전체 + 국가별) — GA4 표준 purchase(event_value_in_usd) + ad_impression ──
    # 결제=purchase 이벤트(value USD 자동환산), 광고=ad_impression value 파라미터. 전기간 기준.
    # ARPPU=매출/결제자, ARPU=매출/전체유저, 결제율=결제자/전체유저, LTV≈ARPU(현재까지 누적).
    # ARPDAU=최근 WINDOW 일매출합/일DAU합(창 평균). 통화는 USD($) 통일(교차국가 비교용).
    mon = q(f"""
      SELECT
        COUNT(DISTINCT IF(event_name='purchase', user_pseudo_id, NULL)) AS payers,
        COUNTIF(event_name='purchase') AS txns,
        SUM(IF(event_name='purchase', COALESCE(event_value_in_usd, 0.0), 0.0)) AS rev,
        SUM(IF(event_name='ad_impression',
            COALESCE((SELECT value.double_value FROM UNNEST(event_params) WHERE key='value'), 0.0), 0.0)) AS ad_rev
      FROM {TABLE} WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
    """)[0]
    payers = int(mon["payers"] or 0)
    rev = float(mon["rev"] or 0.0)
    ad_rev = float(mon["ad_rev"] or 0.0)
    txns = int(mon["txns"] or 0)
    tot_users = int(cum or 0)
    # ARPDAU(창 평균): 일별 DAU·매출 집계 후 합/합
    ad_iap = q(f"""
      WITH days AS (
        SELECT _TABLE_SUFFIX AS d,
          COUNT(DISTINCT user_pseudo_id) AS dau,
          SUM(IF(event_name='purchase', COALESCE(event_value_in_usd,0.0), 0.0)) AS prev,
          SUM(IF(event_name='ad_impression',
              COALESCE((SELECT value.double_value FROM UNNEST(event_params) WHERE key='value'),0.0),0.0)) AS arev
        FROM {TABLE}
        WHERE {suffix_daily(f"_TABLE_SUFFIX BETWEEN '{win_start}' AND '{end_s}'")}
        GROUP BY d
      )
      SELECT SUM(dau) AS dau_sum, SUM(prev) AS prev_sum, SUM(arev) AS arev_sum FROM days
    """)[0]
    dau_sum = int(ad_iap["dau_sum"] or 0)
    win_iap = float(ad_iap["prev_sum"] or 0.0)
    win_ad = float(ad_iap["arev_sum"] or 0.0)
    def _d(a, b): return round(a / b, 4) if b else None
    out["monetization"] = {
        "currency": "USD",
        "overall": {
            "users": tot_users, "payers": payers, "txns": txns,
            "revenue": round(rev, 2), "ad_revenue": round(ad_rev, 2),
            "total_revenue": round(rev + ad_rev, 2),
            "pay_rate": _d(100.0 * payers, tot_users),           # 결제율 %
            "arppu": _d(rev, payers),                            # 결제자당 매출
            "arpu": _d(rev + ad_rev, tot_users),                 # 유저당 총매출(≈LTV 누적)
            "ltv": _d(rev + ad_rev, tot_users),                  # 현재까지 누적 LTV(=ARPU)
            "avg_txn": _d(rev, txns),                            # 건당 평균 결제액
            "arpdau": _d(win_iap + win_ad, dau_sum),             # 총 ARPDAU(창평균)
            "iap_arpdau": _d(win_iap, dau_sum),
            "ad_arpdau": _d(win_ad, dau_sum),
        },
    }
    # 국가별(전기간, 매출 상위 20) — 단일 스캔으로 유저/결제자/매출.
    cty = q(f"""
      SELECT geo.country AS country,
        COUNT(DISTINCT user_pseudo_id) AS users,
        COUNT(DISTINCT IF(event_name='purchase', user_pseudo_id, NULL)) AS payers,
        SUM(IF(event_name='purchase', COALESCE(event_value_in_usd,0.0), 0.0)) AS rev,
        SUM(IF(event_name='ad_impression',
            COALESCE((SELECT value.double_value FROM UNNEST(event_params) WHERE key='value'),0.0),0.0)) AS ad_rev
      FROM {TABLE} WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
      GROUP BY country ORDER BY rev DESC, users DESC LIMIT 20
    """)
    out["monetization"]["by_country"] = [{
        "country": (x["country"] or "(unknown)"),
        "users": int(x["users"] or 0), "payers": int(x["payers"] or 0),
        "revenue": round(float(x["rev"] or 0.0), 2),
        "ad_revenue": round(float(x["ad_rev"] or 0.0), 2),
        "pay_rate": _d(100.0 * int(x["payers"] or 0), int(x["users"] or 0)),
        "arppu": _d(float(x["rev"] or 0.0), int(x["payers"] or 0)),
        "arpu": _d(float(x["rev"] or 0.0) + float(x["ad_rev"] or 0.0), int(x["users"] or 0)),
    } for x in cty]

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
    # ── 추월 1% 돌파율 → KPI 타일 (은퇴 후 최대 누수 지점) ──
    # 1%+ 도달 유저 = 전체 - 0%(추월0)에 머문 유저. all_dist[0]=maxpct 0인 유저.
    reach1 = all_users - all_dist.get(0, 0)
    out["kpi"]["reach1"] = (round(100 * reach1 / all_users, 1) if all_users else None)
    out["kpi"]["reach1_base"] = all_users

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
          f"reach1={out['kpi'].get('reach1')}% "
          f"pacing={len(out['pacing'])} versions={len(out['by_version'])} "
          f"onb_versions={len(out['onb_versions'])} reach_versions={len(out['reach_versions']['versions'])} "
          f"city_entered={ce} city_complete={out['city_kpi']['completed']} city_deci={len(out['city_deci_curve'])} "
          f"last_table={out['last_table']}")


if __name__ == "__main__":
    main()
