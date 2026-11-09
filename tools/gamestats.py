#!/usr/bin/env python3
"""게임별 맞춤 인게임 지표 — tools/gamespecs.json 의 위젯 정의 → BigQuery → docs/data/gamestats.json

게임마다 화면이 다르지만 엔진은 하나다. 스펙(gamespecs.json)이 게임별로 '무엇을 볼지'를
선언하고, 이 파일은 그걸 쿼리 한 방으로 바꾼다. 게임 화면을 바꾸고 싶으면 스펙만 고친다.

위젯 종류
  funnel    steps:[{label, event, param?, value?}]  — 최근 COHORT_DAYS 일 신규 유저 중 각 단계를 한 사람
  levels    start:{event}, clear:{event, param?, value?}, fail:{…}?, level_param, max_level
            — 레벨별 시작 유저·클리어 유저·실패 횟수·시도/인, 그리고 '최고 도달 레벨' 분포(도달률 곡선)
  breakdown event, param, (num:true 면 값을 숫자로) — 값별 횟수·유저 상위 N
  maxval    event, param — 유저별 최댓값 분포(등급·환생 횟수 같은 '어디까지 갔나')

★ 비용: event_params 를 읽어야 해서 공통지표(컬럼 6개)보다 무겁다. 그래서
  · 스펙에 나온 이벤트만 거른다(WHERE event_name IN …) — 다만 BigQuery 는 컬럼 단위 과금이라
    거르기 전 event_params 컬럼 전체가 스캔된다. 줄이는 건 **기간(DAYS)** 뿐이다.
  · 드라이런으로 먼저 재고 MAX_GB 를 넘으면 그 게임은 건너뛴다.
  · 인생 2막은 이미 전용 인게임 수집(ingame.py)이 있어 여기서 다루지 않는다.
수동 실행만(common 워크플로 안에서 같이 돈다).
"""
import json
import os
import pathlib
import sys
from datetime import datetime, timedelta, timezone

from google.cloud import bigquery

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import client_for, find_dataset, pick_suffixes  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
APPS = ROOT / "docs" / "data" / "apps.json"
SPECS = ROOT / "tools" / "gamespecs.json"
OUT = ROOT / "docs" / "data" / "gamestats.json"
KST = timezone(timedelta(hours=9))
DAYS = int(os.environ.get("GS_DAYS") or 30)
COHORT_DAYS = int(os.environ.get("GS_COHORT_DAYS") or 30)
MAX_GB = float(os.environ.get("MAX_GB") or 3)
ONLY = {s for s in (os.environ.get("ONLY") or "").split(",") if s}
TOP = 25


def q(s: str) -> str:
    """SQL 문자열 리터럴 — 스펙은 우리가 쓰는 파일이지만 따옴표 하나에 쿼리가 깨지지 않게."""
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def pval(key: str, num: bool = False) -> str:
    """event_params 에서 키 하나를 꺼낸다. 게임마다 같은 키가 string/int/double 로 갈려 와서 다 본다."""
    if num:
        return (f"COALESCE((SELECT value.int_value FROM UNNEST(event_params) WHERE key={q(key)}),"
                f"CAST((SELECT value.double_value FROM UNNEST(event_params) WHERE key={q(key)}) AS INT64),"
                f"SAFE_CAST((SELECT value.string_value FROM UNNEST(event_params) WHERE key={q(key)}) AS INT64))")
    return (f"COALESCE((SELECT value.string_value FROM UNNEST(event_params) WHERE key={q(key)}),"
            f"CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key={q(key)}) AS STRING),"
            f"CAST((SELECT value.double_value FROM UNNEST(event_params) WHERE key={q(key)}) AS STRING))")


def filters(step: dict) -> dict:
    """param/value(한 개) + where{param: value|[values]}(여러 개)를 한 dict 로."""
    f = dict(step.get("where") or {})
    if step.get("param") is not None and step.get("value") is not None:
        f[step["param"]] = step["value"]
    return f


def cond(step: dict) -> str:
    c = f"e = {q(step['event'])}"
    for k, v in filters(step).items():
        vals = v if isinstance(v, list) else [v]
        c += f" AND p_{k} IN ({', '.join(q(x) for x in vals)})"
    return c


def build(spec: dict) -> tuple[str, list[str]]:
    """스펙 → (SELECT … UNION ALL …, 필요한 이벤트 목록). 결과 모양은 위젯 공통:
       (w 위젯ID, k 문자열키, l 정수키, n1, n2, n3)"""
    events, params, nums = set(), set(), set()
    for w in spec["widgets"]:
        t = w["type"]
        if t == "funnel":
            for s in w["steps"]:
                events.add(s["event"])
                params.update(filters(s))
        elif t == "levels":
            for part in ("start", "clear", "fail"):
                if w.get(part):
                    events.add(w[part]["event"])
                    params.update(filters(w[part]))
            nums.add(w["level_param"])
        elif t == "breakdown":
            events.add(w["event"])
            (nums if w.get("num") else params).add(w["param"])
        elif t == "maxval":
            events.add(w["event"])
            nums.add(w["param"])

    cols = [f"{pval(p)} AS p_{p}" for p in sorted(params)] + [f"{pval(p, True)} AS n_{p}" for p in sorted(nums)]
    # 첫 줄이 열 이름·타입을 정한다 — 위젯 순서와 상관없이 같은 모양이 나오게 빈 머리줄을 둔다
    parts = ["SELECT '-1' AS w, CAST(NULL AS STRING) AS k, CAST(NULL AS INT64) AS l, CAST(NULL AS INT64) AS n1, "
             "CAST(NULL AS INT64) AS n2, CAST(NULL AS INT64) AS n3 FROM (SELECT 1) WHERE FALSE"]
    for i, w in enumerate(spec["widgets"]):
        wid = q(i)
        t = w["type"]
        if t == "funnel":
            for j, s in enumerate(w["steps"]):
                parts.append(f"SELECT {wid}, NULL, {j}, COUNT(DISTINCT u), NULL, NULL FROM ev WHERE coh AND {cond(s)}")
            parts.append(f"SELECT {wid}, '_base', -1, COUNT(DISTINCT u), NULL, NULL FROM base")
        elif t == "levels":
            lp, mx = f"n_{w['level_param']}", int(w.get("max_level", 100))
            fail = cond(w["fail"]) if w.get("fail") else "FALSE"
            parts.append(f"""SELECT {wid}, 'lv', {lp}, COUNT(DISTINCT IF({cond(w['start'])}, u, NULL)),
                COUNT(DISTINCT IF({cond(w['clear'])}, u, NULL)), COUNTIF({fail})
              FROM ev WHERE {lp} BETWEEN 1 AND {mx} GROUP BY {lp}""")
            parts.append(f"""SELECT {wid}, 'att', {lp}, COUNTIF({cond(w['start'])}), NULL, NULL
              FROM ev WHERE {lp} BETWEEN 1 AND {mx} GROUP BY {lp}""")
            # 도달률: 최근 신규 코호트가 '시작이라도 해 본' 최고 레벨
            parts.append(f"""SELECT {wid}, 'reach', top, COUNT(*), NULL, NULL FROM (
                SELECT u, MAX({lp}) AS top FROM ev WHERE coh AND {cond(w['start'])} AND {lp} BETWEEN 1 AND {mx} GROUP BY u)
              GROUP BY top""")
            parts.append(f"SELECT {wid}, '_base', -1, COUNT(DISTINCT u), NULL, NULL FROM base")
        elif t == "breakdown":
            col = f"CAST(n_{w['param']} AS STRING)" if w.get("num") else f"p_{w['param']}"
            parts.append(f"""SELECT {wid}, IFNULL({col}, '(없음)'), NULL, COUNT(*), COUNT(DISTINCT u), NULL
              FROM ev WHERE e = {q(w['event'])} GROUP BY 2""")
        elif t == "maxval":
            parts.append(f"""SELECT {wid}, NULL, top, COUNT(*), NULL, NULL FROM (
                SELECT u, MAX(n_{w['param']}) AS top FROM ev WHERE e = {q(w['event'])} GROUP BY u)
              WHERE top IS NOT NULL GROUP BY top""")
    sel = "\nUNION ALL\n".join(parts)
    head = f"""
WITH ev AS (
  SELECT user_pseudo_id AS u, event_name AS e,
         DATE(TIMESTAMP_MICROS(user_first_touch_timestamp), 'Asia/Seoul') >= @cstart AS coh
         {''.join(', ' + c for c in cols)}
  FROM `{{p}}.{{ds}}.events_*`
  WHERE _TABLE_SUFFIX IN ({{suffixes}}) AND IFNULL(geo.country, '') != ''
    AND event_name IN ({', '.join(q(e) for e in sorted(events | {'first_open'}))})
),
base AS (SELECT DISTINCT u FROM ev WHERE coh)
"""
    return head + sel, sorted(events)


def shape(spec: dict, rows: list) -> list[dict]:
    by = {}
    for r in rows:
        by.setdefault(int(r["w"]), []).append(r)
    out = []
    for i, w in enumerate(spec["widgets"]):
        rs = by.get(i, [])
        o = {k: v for k, v in w.items() if k not in ("steps",)}
        if w["type"] == "funnel":
            base = next((r["n1"] for r in rs if r["k"] == "_base"), 0)
            cnt = {r["l"]: r["n1"] for r in rs if r["k"] != "_base"}
            o["base"] = base
            o["steps"] = [{"label": s["label"], "users": cnt.get(j, 0)} for j, s in enumerate(w["steps"])]
        elif w["type"] == "levels":
            lv = {r["l"]: r for r in rs if r["k"] == "lv"}
            att = {r["l"]: r["n1"] for r in rs if r["k"] == "att"}
            reach = {r["l"]: r["n1"] for r in rs if r["k"] == "reach"}
            o["base"] = next((r["n1"] for r in rs if r["k"] == "_base"), 0)
            o["rows"] = [{"level": L, "start": lv[L]["n1"], "clear": lv[L]["n2"], "fails": lv[L]["n3"],
                          "attempts": att.get(L, 0)} for L in sorted(lv)]
            o["reach"] = [{"level": L, "users": n} for L, n in sorted(reach.items())]
        elif w["type"] == "breakdown":
            o["rows"] = sorted(({"value": r["k"], "n": r["n1"], "users": r["n2"]} for r in rs),
                               key=lambda x: -x["n"])[:w.get("top", TOP)]
        elif w["type"] == "maxval":
            o["rows"] = [{"value": r["l"], "users": r["n1"]} for r in sorted(rs, key=lambda r: r["l"])]
        out.append(o)
    return out


def collect(app: dict, spec: dict) -> dict:
    c = client_for(app.get("secret", ""))
    if c is None:
        return {"status": "no_secret"}
    ds, loc = find_dataset(c, app["project"])
    if not ds:
        return {"status": "no_dataset"}
    today = datetime.now(KST).date()
    start = today - timedelta(days=DAYS)
    suffixes, _, _ = pick_suffixes(c, app["project"], ds, start, today)
    if not suffixes:
        return {"status": "no_data"}
    body, events = build(spec)
    sql = body.format(p=app["project"], ds=ds, suffixes=", ".join(q(s) for s in suffixes))
    params = [bigquery.ScalarQueryParameter("cstart", "DATE", today - timedelta(days=COHORT_DAYS))]
    dry = c.query(sql, location=loc, job_config=bigquery.QueryJobConfig(query_parameters=params, dry_run=True))
    gb = dry.total_bytes_processed / 1e9
    print(f"  {app['key']}: 테이블 {len(suffixes)}장 · 이벤트 {len(events)}종 · 예상 {gb * 1000:.0f} MB")
    if gb > MAX_GB:
        return {"status": "skipped", "msg": f"예상 {gb:.1f}GB > 상한 {MAX_GB}GB"}
    job = c.query(sql, location=loc, job_config=bigquery.QueryJobConfig(
        query_parameters=params, maximum_bytes_billed=int(MAX_GB * 1e9)))
    rows = list(job.result())
    return {"status": "ok", "title": spec.get("title", ""), "note": spec.get("note", ""),
            "window": [start.isoformat(), today.isoformat()], "cohort_days": COHORT_DAYS,
            "scan_mb": round((job.total_bytes_billed or 0) / 1e6, 1),
            "collected": datetime.now(KST).isoformat(timespec="minutes"),
            "widgets": shape(spec, rows)}


def main() -> int:
    apps = {a["key"]: a for a in json.loads(APPS.read_text(encoding="utf-8"))["apps"]}
    specs = json.loads(SPECS.read_text(encoding="utf-8"))["games"]
    doc = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"games": {}}
    total = 0.0
    for key, spec in specs.items():
        if ONLY and key not in ONLY or key not in apps:
            continue
        try:
            res = collect(apps[key], spec)
        except Exception as e:
            res = {**doc["games"].get(key, {}), "status": "error", "msg": str(e)[:400]}
            print(f"  {key}: 오류 {res['msg']}")
        if res.get("status") == "ok":
            total += res["scan_mb"]
        elif res.get("status") != "error":
            res = {**doc["games"].get(key, {}), **res}
        doc["games"][key] = res
    doc["updated"] = datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"게임 지표 합계 스캔 {total:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
