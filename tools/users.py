#!/usr/bin/env python3
"""전체 가입자 목록 — BigQuery(GA4 일별 테이블) → docs/data/users/YYYY-MM-DD.json.

실시간 뷰와 **같은 모양**으로 한 명씩 줄을 세운다. 다른 건 범위뿐이다:
실시간은 최근 24시간(스트리밍), 이쪽은 출시 이후 전부(확정 일별 테이블).

왜 날짜별로 쪼개나 — 누적 가입자가 이미 1.6만이고 하루 400명씩 는다. 한 파일에 담으면
매일 그 전체를 다시 커밋하게 돼서 리포가 연 수백 MB씩 불어난다. 하루치 파일은 그날이
끝나면 한 번 쓰고 다시 건드리지 않으므로 히스토리가 쌓이지 않는다.

실시간(realtime.py)과 퍼널 정의를 공유한다 — 거기서 import 한다. 두 화면이 다른 퍼널을
말하면 비교가 불가능해지므로 정의가 갈라질 여지를 아예 두지 않는다.

레코드는 압축형이다. reached 25칸을 배열로 두면 한 명이 216바이트인데 비트마스크 정수로
접으면 130바이트가 된다 — 1.6만 명이면 3.5MB 와 2.1MB 의 차이다. docs/userrow.js 가 푼다.

인증: 환경변수 GOOGLE_APPLICATION_CREDENTIALS. 데이터셋 위치=asia-northeast3.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import realtime as rt   # ORDER / CLASS_STAGES / STAGES / q() 를 그대로 쓴다

KST = timezone(timedelta(hours=9))
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "users")
INDEX = os.path.join(OUT_DIR, "index.json")
FIRST_DAY = os.environ.get("USERS_FIRST_DAY", "20260823")   # 출시일


def day_flags() -> str:
    flags = ",\n        ".join(
        f"MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params)"
        f" WHERE key='step')='{k}',1,0)) AS s_{k}"
        for k, _ in rt.STAGES)
    flags += ",\n        " + ",\n        ".join(
        f"MAX(IF(event_name='class_up' AND (SELECT value.int_value FROM UNNEST(event_params)"
        f" WHERE key='level')>={lv},1,0)) AS c{lv}"
        for lv, _ in rt.CLASS_STAGES)
    return flags


def fetch_day(suffix: str) -> list[dict]:
    """그날 처음 앱을 연 사람들. 하루 테이블 한 장만 읽는다.

    ⚠ 하루를 넘겨 이어서 논 몫은 안 잡힌다 — 그 이벤트는 다음 날 테이블에 있다.
    여기서 보는 건 '가입 당일에 어디까지 갔나'다. 이후까지 보려면 코호트 리텐션 쪽이 맞다.
    """
    rows = rt.q(f"""
      SELECT ANY_VALUE(SUBSTR(TO_HEX(MD5(user_pseudo_id)), 1, 6)) AS tag,
        FORMAT_TIMESTAMP('%H:%M', TIMESTAMP_MICROS(MIN(event_timestamp)), 'Asia/Seoul') AS joined,
        FORMAT_TIMESTAMP('%H:%M', TIMESTAMP_MICROS(MAX(event_timestamp)), 'Asia/Seoul') AS last_seen,
        TIMESTAMP_DIFF(TIMESTAMP_MICROS(MAX(event_timestamp)),
                       TIMESTAMP_MICROS(MIN(event_timestamp)), MINUTE) AS span_min,
        SUM((SELECT value.int_value FROM UNNEST(event_params)
             WHERE key='engagement_time_msec')) AS eng_ms,
        COUNT(DISTINCT (SELECT value.int_value FROM UNNEST(event_params)
                        WHERE key='ga_session_id')) AS sessions,
        ANY_VALUE(geo.country) AS country,
        MAX(IF(event_name='progress_pct',
               (SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct'), 0)) AS pct,
        MAX(IF(event_name='progress_deci',
               (SELECT value.int_value FROM UNNEST(event_params) WHERE key='deci'), 0)) AS deci,
        COUNTIF(event_name='purchase') AS buys,
        {day_flags()}
      FROM {rt.TABLE}
      WHERE _TABLE_SUFFIX = '{suffix}'
      GROUP BY user_pseudo_id
      HAVING COUNTIF(event_name='first_open') > 0
      ORDER BY MIN(event_timestamp) DESC
    """)

    spine_n = len(rt._SPINE)
    out = []
    for r in rows:
        reached = [int(r.get(col) or 0) for _, _, col in rt.ORDER]
        far = max([i for i, v in enumerate(reached) if v and i < spine_n], default=-1)
        mask = 0
        for i, v in enumerate(reached):
            if v:
                mask |= 1 << i
        out.append({
            "t": r["tag"], "j": r["joined"], "l": r["last_seen"],
            "m": round(float(r["eng_ms"] or 0) / 60000.0, 1),   # 체류(분)
            "s": int(r["span_min"] or 0),                       # 첫~마지막(분)
            "n": int(r["sessions"] or 0),
            "p": max(float(r["pct"] or 0), int(r["deci"] or 0) / 10.0),
            "r": mask, "f": far,
            "b": int(r["buys"] or 0),
            "c": r["country"] or "",
        })
    return out


def load_index() -> dict:
    try:
        with open(INDEX, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"days": [], "stage_labels": [], "total": 0}


def write_day(date: str, rows: list[dict]) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, f"{date}.json"), "w", encoding="utf-8") as f:
        json.dump({"date": date, "users": rows}, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


def main() -> int:
    idx = load_index()
    have = {d["date"] for d in idx["days"]}

    # 어제까지만 받는다 — 오늘은 아직 안 끝났고, 그건 실시간 뷰가 맡는다.
    today = datetime.now(KST).date()
    end = today - timedelta(days=1)
    start = datetime.strptime(FIRST_DAY, "%Y%m%d").date()

    # 어느 날짜에 확정 테이블이 있는지 먼저 본다 — 없는 날을 쿼리하면 그냥 0건이 아니라 에러다.
    exists = {r["s"] for r in rt.q(f"""
      SELECT DISTINCT _TABLE_SUFFIX AS s FROM {rt.TABLE}
      WHERE _TABLE_SUFFIX BETWEEN '{start:%Y%m%d}' AND '{end:%Y%m%d}'
    """)}

    todo, d = [], start
    while d <= end:
        iso, suf = d.isoformat(), d.strftime("%Y%m%d")
        if iso not in have and suf in exists:
            todo.append((iso, suf))
        d += timedelta(days=1)

    if not todo:
        print("새로 받을 날짜가 없습니다.")
        return 0

    for iso, suf in todo:
        rows = fetch_day(suf)
        write_day(iso, rows)
        idx["days"].append({"date": iso, "n": len(rows)})
        print(f"  {iso}: {len(rows)}명")

    idx["days"].sort(key=lambda x: x["date"], reverse=True)   # 최신이 앞 — 화면이 그 순서로 읽는다
    idx["total"] = sum(d["n"] for d in idx["days"])
    idx["stage_labels"] = [{"key": k, "label": lab,
                            "kind": "side" if k in rt.SIDE else "spine"}
                           for k, lab, _ in rt.ORDER]
    idx["updated"] = datetime.now(KST).strftime("%Y-%m-%d %H:%M") + " KST"
    idx["scan_mb"] = round(rt._billed / 1024 / 1024, 1)
    with open(INDEX, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"총 {idx['total']}명 / {len(idx['days'])}일 · 이번 스캔 {idx['scan_mb']}MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
