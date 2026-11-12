#!/usr/bin/env python3
"""전체 앱 공통지표 — 앱마다 BigQuery 를 **가볍게** 한 번씩 → docs/data/common.json

받는 것: 일별 DAU·신규·세션·예외·광고노출·결제·삭제(app_remove) 이벤트 수, 가입일 코호트 D1/D3/D7/D14/D30,
최근 14일 이벤트별 횟수(게임별 '인게임' 화면의 재료), 최근 7일 버전별 유저.

★ 가벼운 이유: 읽는 컬럼이 user_pseudo_id · event_timestamp · user_first_touch_timestamp ·
event_name · geo.country · app_info.version 여섯 개뿐이다. event_params(전체 바이트의
대부분)를 안 읽으니, 인생 2막 기준 45일이 수백 MB 다(인게임 수집 1회 18GB 와 비교).
그래도 BigQuery 라 **수동 실행만** 한다(HANDOFF §1 원칙). 드라이런으로 먼저 재고
MAX_GB 를 넘는 앱은 건너뛴다.

앱 목록·키 이름은 docs/data/apps.json. 키는 GitHub Secret 에 서비스계정 JSON 그대로 들어
있고, 워크플로가 같은 이름의 환경변수로 넘긴다. 키가 없는 앱은 status=no_secret 로 남는다.

창(window): 기본 45일을 다시 계산해서 덮는다. D30 이 익는 데 30일이 걸리므로 그보다 길어야
코호트가 '익은 값'으로 굳는다. 더 옛날 날짜는 파일에 남은 값을 그대로 둔다(누적).
처음 붙는 앱은 DAYS=120 같은 값으로 한 번 백필한다.

봇: geo.country 가 빈 줄(Play 사전출시 봇)도 **세어 넣는다** — 2026-11-12 형 지시(Firebase 콘솔과 맞추려고).
     전에는 IFNULL(geo.country,'') != '' 로 뺐다.
날짜는 전부 KST(이벤트 타임스탬프 기준). 확정 테이블이 없는 날은 intraday 로 채우고
provisional=true 를 단다(확정본은 26~34시간 늦게 온다).
"""
import json
import os
import pathlib
import sys
from datetime import date, datetime, timedelta, timezone

from google.cloud import bigquery
from google.oauth2 import service_account

ROOT = pathlib.Path(__file__).resolve().parent.parent
APPS = ROOT / "docs" / "data" / "apps.json"
OUT = ROOT / "docs" / "data" / "common.json"
KST = timezone(timedelta(hours=9))
DAYS = int(os.environ.get("DAYS") or 45)
MAX_GB = float(os.environ.get("MAX_GB") or 3)
ONLY = {s for s in (os.environ.get("ONLY") or "").split(",") if s}
RET_DAYS = (1, 3, 7, 14, 30)
EVENT_DAYS = 14


def client_for(secret: str) -> bigquery.Client | None:
    raw = os.environ.get(secret or "", "").strip()
    if not raw:
        return None
    info = json.loads(raw)
    cred = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/cloud-platform"])
    return bigquery.Client(project=info["project_id"], credentials=cred)


def find_dataset(c: bigquery.Client, project: str):
    """GA4 export 데이터셋은 analytics_<속성ID>. 속성 ID 를 몰라도 목록에서 찾는다(무료 API)."""
    for ds in c.list_datasets(project):
        if ds.dataset_id.startswith("analytics_"):
            full = c.get_dataset(f"{project}.{ds.dataset_id}")
            return ds.dataset_id, full.location
    return None, None


def pick_suffixes(c, project, dataset, start: date, end: date):
    """날짜마다 확정본(events_YYYYMMDD) 우선, 없으면 intraday. 둘 다 읽으면 그날이 두 배가 된다.
    테이블 목록은 메타데이터 API 라 과금이 없다."""
    have = {t.table_id for t in c.list_tables(f"{project}.{dataset}")}
    want, prov = [], []
    d = start
    while d <= end:
        s = d.strftime("%Y%m%d")
        if f"events_{s}" in have:
            want.append(s)
        elif f"events_intraday_{s}" in have:
            want.append(f"intraday_{s}")
            prov.append(d.isoformat())
        d += timedelta(days=1)
    last = max((t[7:] for t in have if t.startswith("events_") and t[7:].isdigit()), default=None)
    return want, prov, last


SQL = """
WITH ev AS (
  SELECT user_pseudo_id AS u,
         DATE(TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul') AS d,
         DATE(TIMESTAMP_MICROS(user_first_touch_timestamp), 'Asia/Seoul') AS d0,
         event_name AS e,
         app_info.version AS v
  FROM `{p}.{ds}.events_*`
  WHERE _TABLE_SUFFIX IN ({suffixes})
),
act AS (SELECT DISTINCT u, d, d0 FROM ev WHERE d BETWEEN @start AND @end)
SELECT 'day' AS kind, d, CAST(NULL AS INT64) AS k, CAST(NULL AS STRING) AS e, CAST(NULL AS STRING) AS v,
       COUNT(DISTINCT u) AS n, COUNT(DISTINCT IF(d0 = d, u, NULL)) AS n2,
       COUNTIF(e = 'session_start') AS c1, COUNTIF(e = 'app_exception') AS c2,
       COUNTIF(e = 'ad_impression') AS c3, COUNTIF(e = 'purchase') AS c4,
       COUNTIF(e = 'app_remove') AS c5
FROM ev WHERE d BETWEEN @start AND @end GROUP BY d
UNION ALL
SELECT 'base', d0, NULL, NULL, NULL, COUNT(DISTINCT u), NULL, NULL, NULL, NULL, NULL, NULL
FROM act WHERE d0 BETWEEN @start AND @end GROUP BY d0
UNION ALL
SELECT 'ret', d0, DATE_DIFF(d, d0, DAY), NULL, NULL, COUNT(DISTINCT u), NULL, NULL, NULL, NULL, NULL, NULL
FROM act WHERE d0 BETWEEN @start AND @end AND DATE_DIFF(d, d0, DAY) IN ({ret})
GROUP BY d0, DATE_DIFF(d, d0, DAY)
UNION ALL
SELECT 'evt', d, NULL, e, NULL, COUNT(*), COUNT(DISTINCT u), NULL, NULL, NULL, NULL, NULL
FROM ev WHERE d BETWEEN @evstart AND @end GROUP BY d, e
UNION ALL
SELECT 'ver', CAST(NULL AS DATE), NULL, NULL, v, COUNT(DISTINCT u), NULL, NULL, NULL, NULL, NULL, NULL
FROM ev WHERE d BETWEEN @verstart AND @end GROUP BY v
"""


def total_users(c, app: dict, ds: str, loc: str):
    """누적 가입자(형 지시 2026-11-12) — 내보내기 전 기간 고유 유저 수(user_pseudo_id) + 첫 데이터 날짜.
    봇 포함(보드 기준과 같음). 내보내기를 켜기 전 가입자는 BigQuery 에 없어 못 센다. 인생 2막 ~240MB."""
    sql = f"""SELECT COUNT(DISTINCT user_pseudo_id) AS n, MIN(event_date) AS d0
              FROM `{app['project']}.{ds}.events_*`"""
    try:
        job = c.query(sql, location=loc, job_config=bigquery.QueryJobConfig(maximum_bytes_billed=int(MAX_GB * 1e9)))
        r = list(job.result())[0]
        d0 = f"{r['d0'][:4]}-{r['d0'][4:6]}-{r['d0'][6:]}" if r["d0"] else None
        print(f"    누적 가입자 {r['n']}명(since {d0}) · 스캔 {(job.total_bytes_billed or 0) / 1e6:.1f} MB")
        return int(r["n"]), d0
    except Exception as e:
        print(f"    누적 가입자 집계 실패: {e}"[:300])
        return None


def subs_active(c, app: dict, ds: str, loc: str, today) -> int | None:
    """구독 앱의 활성 구독자 추정(형 지시 2026-11-12) — apps.json 의 subs 설정이 있을 때만.
    구독 결제 완료 이벤트(plan 파라미터)를 플랜별 기간(월 31일·연 366일) 안에 남긴 유저 수.
    안드로이드는 갱신이 클라이언트 이벤트로 안 남아서 '최초 결제 후 기간 안'만 센다 — 갱신·해지는 못 본다(추정)."""
    cfg = app.get("subs")
    if not cfg:
        return None
    longest = max(cfg["days"].values())
    cases = " ".join(f"WHEN '{plan}' THEN {int(d)}" for plan, d in cfg["days"].items())
    sql = f"""
    SELECT COUNT(DISTINCT user_pseudo_id) AS n FROM (
      SELECT user_pseudo_id,
             DATE(TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul') AS d,
             (SELECT value.string_value FROM UNNEST(event_params) WHERE key = @param) AS plan
      FROM `{app['project']}.{ds}.events_*`
      WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(@today, INTERVAL {longest + 1} DAY))
        AND event_name = @event)
    WHERE DATE_DIFF(@today, d, DAY) < CASE plan {cases} ELSE 0 END"""
    params = [bigquery.ScalarQueryParameter("param", "STRING", cfg.get("param", "plan")),
              bigquery.ScalarQueryParameter("event", "STRING", cfg["event"]),
              bigquery.ScalarQueryParameter("today", "DATE", today)]
    try:
        job = c.query(sql, location=loc, job_config=bigquery.QueryJobConfig(
            query_parameters=params, maximum_bytes_billed=int(MAX_GB * 1e9)))
        n = list(job.result())[0]["n"]
        print(f"    활성 구독자(추정) {n}명 · 스캔 {(job.total_bytes_billed or 0) / 1e6:.1f} MB")
        return int(n)
    except Exception as e:
        print(f"    활성 구독자 집계 실패: {e}"[:300])
        return None


def collect(app: dict, prev: dict) -> dict:
    if not app.get("secret") or not app.get("project"):
        return {**prev, "status": "no_secret"}
    c = client_for(app["secret"])
    if c is None:
        return {**prev, "status": "no_secret", "msg": f"시크릿 {app['secret']} 이 비어 있습니다"}

    try:
        ds, loc = find_dataset(c, app["project"])
    except Exception as e:
        return {**prev, "status": "error", "msg": f"데이터셋 조회 실패: {e}"[:300]}
    if not ds:
        return {**prev, "status": "no_dataset", "msg": "GA4 BigQuery export 데이터셋이 없습니다"}

    today = datetime.now(KST).date()
    start = today - timedelta(days=DAYS)
    # 이벤트 타임스탬프(KST)와 테이블 날짜(속성 시간대)가 하루 어긋날 수 있어 앞뒤로 하루씩 더 읽는다
    suffixes, prov, last = pick_suffixes(c, app["project"], ds, start - timedelta(days=1), today)
    if not suffixes:
        return {**prev, "status": "no_data", "dataset": ds, "msg": "창 안에 이벤트 테이블이 없습니다"}

    sql = SQL.format(p=app["project"], ds=ds, ret=", ".join(map(str, RET_DAYS)),
                     suffixes=", ".join(f"'{s}'" for s in suffixes))
    params = [bigquery.ScalarQueryParameter("start", "DATE", start),
              bigquery.ScalarQueryParameter("end", "DATE", today),
              bigquery.ScalarQueryParameter("evstart", "DATE", today - timedelta(days=EVENT_DAYS - 1)),
              bigquery.ScalarQueryParameter("verstart", "DATE", today - timedelta(days=6))]
    dry = c.query(sql, location=loc, job_config=bigquery.QueryJobConfig(
        query_parameters=params, dry_run=True, use_query_cache=False))
    est_gb = dry.total_bytes_processed / 1e9
    print(f"  {app['key']}: {ds} ({loc}) 테이블 {len(suffixes)}장 · 예상 {est_gb * 1000:.0f} MB")
    if est_gb > MAX_GB:
        return {**prev, "status": "skipped", "msg": f"예상 스캔 {est_gb:.1f}GB > 상한 {MAX_GB}GB — MAX_GB 로 올려서 다시"}

    job = c.query(sql, location=loc, job_config=bigquery.QueryJobConfig(
        query_parameters=params, maximum_bytes_billed=int(MAX_GB * 1e9)))
    rows = list(job.result())
    scan_mb = round((job.total_bytes_billed or 0) / 1e6, 1)

    day, base, ret, evt, ver = {}, {}, {}, {}, []
    for r in rows:
        k = r["kind"]
        if k == "day":
            day[r["d"].isoformat()] = {"date": r["d"].isoformat(), "dau": r["n"], "new": r["n2"],
                                       "sessions": r["c1"], "exceptions": r["c2"],
                                       "ad_impressions": r["c3"], "purchases": r["c4"],
                                       "uninstalls": r["c5"]}
        elif k == "base":
            base[r["d"].isoformat()] = r["n"]
        elif k == "ret":
            ret.setdefault(r["d"].isoformat(), {})[int(r["k"])] = r["n"]
        elif k == "evt":
            evt.setdefault(r["e"], {})[r["d"].isoformat()] = (r["n"], r["n2"])
        elif k == "ver":
            ver.append({"v": r["v"] or "(미기록)", "users": r["n"]})

    for d in prov:
        if d in day:
            day[d]["provisional"] = True

    # 코호트: 아직 그 날이 안 온 칸은 None(=미성숙) — 0 과 구분해야 곡선이 꺾여 보이지 않는다.
    last_day = max(day) if day else today.isoformat()
    cohorts = {}
    for d0, n in base.items():
        row = {"date": d0, "base": n}
        for k in RET_DAYS:
            due = (date.fromisoformat(d0) + timedelta(days=k)).isoformat()
            row[f"d{k}"] = ret.get(d0, {}).get(k, 0) if due <= last_day else None
        cohorts[d0] = row

    # 누적 병합: 창 밖 옛 날짜는 이전 값 유지, 창 안은 새로 계산한 값으로 덮는다.
    keep = lambda xs: {x["date"]: x for x in xs if x["date"] < start.isoformat()}
    daily = {**keep(prev.get("daily", [])), **day}
    coh = {**keep(prev.get("cohorts", [])), **cohorts}

    ev_days = sorted({d for m in evt.values() for d in m})
    events = sorted(({"e": e, "n": sum(v[0] for v in m.values()),
                      "by_day": [m.get(d, (0, 0))[0] for d in ev_days],
                      "users": max((v[1] for v in m.values()), default=0)}
                     for e, m in evt.items()), key=lambda x: -x["n"])

    subs = subs_active(c, app, ds, loc, today)
    total = total_users(c, app, ds, loc)

    return {
        **({"subs_active": subs} if subs is not None else {}),
        **({"total_users": total[0], "total_since": total[1]} if total else {}),
        "status": "ok", "dataset": ds, "location": loc, "last_table": last,
        "window": [start.isoformat(), today.isoformat()], "scan_mb": scan_mb,
        "collected": datetime.now(KST).isoformat(timespec="seconds"),
        "daily": [daily[k] for k in sorted(daily)],
        "cohorts": [coh[k] for k in sorted(coh)],
        "events": {"days": ev_days, "rows": events[:60]},
        "versions": sorted(ver, key=lambda x: -x["users"])[:12],
    }


def main() -> int:
    apps = json.loads(APPS.read_text(encoding="utf-8"))["apps"]
    doc = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"apps": {}}
    total = 0.0
    for app in apps:
        if ONLY and app["key"] not in ONLY:
            continue
        prev = doc["apps"].get(app["key"], {})
        try:
            res = collect(app, prev)
        except Exception as e:   # 한 앱이 터져도 나머지는 받는다
            res = {**prev, "status": "error", "msg": str(e)[:300]}
        if res.get("status") != "ok":
            print(f"  {app['key']}: {res.get('status')} {res.get('msg', '')}")
        total += res.get("scan_mb", 0) if res.get("status") == "ok" else 0
        doc["apps"][app["key"]] = res
    doc["updated"] = datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")
    doc["ret_days"] = list(RET_DAYS)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"합계 스캔 {total:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
