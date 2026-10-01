#!/usr/bin/env python3
"""전체 가입자 목록 — BigQuery(GA4 확정 일별 테이블) → docs/data/users/YYYY-MM-DD.json.

한 줄 = 한 유저의 **지금까지의 최종 상태**다. 가입 당일이 아니라 평생 누적으로 본다 —
추월 90%는 몇 주에 걸쳐 쌓는 값이라 가입일만 보면 영영 안 보인다
(실측: 가입일 기준 90%+ 는 3명, 평생 기준은 73명).

파일은 **가입일별**로 쪼갠다. 화면이 최신 코호트부터 하루씩 당겨 읽고, 한 파일이
400명 안팎이라 한 번에 그려도 부담이 없다. 다만 평생 누적이라 옛 코호트도 그 사람들이
다시 들어오면 값이 바뀐다 — 그래서 매번 다시 쓰되 **내용이 같으면 파일을 건드리지 않는다**
(안 그러면 휴면 코호트까지 매일 커밋에 올라온다).

실시간(realtime.py)과 퍼널 정의를 공유한다 — 거기서 import 한다. 두 화면이 다른 퍼널을
말하면 비교가 불가능해지므로 정의가 갈라질 여지를 두지 않는다.

레코드는 압축형이다. reached 25칸을 배열로 두면 한 명 216바이트인데 비트마스크 정수로
접으면 130바이트가 된다 — 1.6만 명이면 3.5MB 와 2.1MB 의 차이다. docs/userrow.js 가 푼다.

인증: 환경변수 GOOGLE_APPLICATION_CREDENTIALS. 데이터셋 위치=asia-northeast3.
"""
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import realtime as rt   # ORDER / STAGES / CLASS_STAGES / q() 를 그대로 쓴다

KST = timezone(timedelta(hours=9))
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "users")
INDEX = os.path.join(OUT_DIR, "index.json")


def flags_sql() -> str:
    sql = ",\n        ".join(
        f"MAX(IF(event_name='onb_step' AND (SELECT value.string_value FROM UNNEST(event_params)"
        f" WHERE key='step')='{k}',1,0)) AS s_{k}"
        for k, _ in rt.STAGES)
    sql += ",\n        " + ",\n        ".join(
        f"MAX(IF(event_name='class_up' AND (SELECT value.int_value FROM UNNEST(event_params)"
        f" WHERE key='level')>={lv},1,0)) AS c{lv}"
        for lv, _ in rt.CLASS_STAGES)
    return sql


def fetch_all() -> list[dict]:
    """유저별 평생 누적. 확정 일별 테이블 전부를 한 번에 묶는다(intraday 제외).

    intraday 를 섞지 않는 이유: 후처리 전이라 값이 흔들리고, 그러면 '최고 기록'이
    다음 수집에서 내려가는 일이 생긴다. 오늘 몫은 실시간 뷰가 맡는다.
    """
    return rt.q(f"""
      SELECT ANY_VALUE(SUBSTR(TO_HEX(MD5(user_pseudo_id)), 1, 6)) AS tag,
        -- 가입 시점은 '우리가 처음 본 때'로 잡는다. user_first_touch_timestamp 는 기기 시계에서
        -- 오므로 시계가 틀어진 기기가 2007-11-05 · 2023-09-07 · 2026-11-14(미래) 같은 날짜를
        -- 만들어 낸다(실측 8명). 그러면 쓰레기 코호트 파일이 생기고, 미래 날짜는 목록 맨 앞까지
        -- 차지한다. MIN(event_timestamp) 는 실시간 뷰가 쓰는 기준과도 같다.
        FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_MICROS(MIN(event_timestamp)),
                         'Asia/Seoul') AS joined_day,
        FORMAT_TIMESTAMP('%H:%M', TIMESTAMP_MICROS(MIN(event_timestamp)),
                         'Asia/Seoul') AS joined_at,
        FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_MICROS(MAX(event_timestamp)),
                         'Asia/Seoul') AS last_day,
        COUNT(DISTINCT event_date) AS days,
        SUM((SELECT value.int_value FROM UNNEST(event_params)
             WHERE key='engagement_time_msec')) AS eng_ms,
        MAX(IF(event_name='progress_pct',
               (SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct'), 0)) AS pct,
        MAX(IF(event_name='progress_deci',
               (SELECT value.int_value FROM UNNEST(event_params) WHERE key='deci'), 0)) AS deci,
        MAX(IF(event_name='prog_rebirth',
               (SELECT value.int_value FROM UNNEST(event_params) WHERE key='rebirth'), 0)) AS rebirth,
        COUNTIF(event_name='purchase') AS buys,
        ANY_VALUE(geo.country) AS country,
        {flags_sql()}
      FROM {rt.TABLE}
      WHERE _TABLE_SUFFIX NOT LIKE 'intraday%'
      GROUP BY user_pseudo_id
      HAVING joined_day IS NOT NULL
    """)


def pack(r: dict, spine_n: int) -> dict:
    reached = [int(r.get(col) or 0) for _, _, col in rt.ORDER]
    far = max([i for i, v in enumerate(reached) if v and i < spine_n], default=-1)
    mask = 0
    for i, v in enumerate(reached):
        if v:
            mask |= 1 << i
    return {
        "t": r["tag"], "j": r["joined_at"], "l": r["last_day"],
        "d": int(r["days"] or 0),
        "m": round(float(r["eng_ms"] or 0) / 60000.0, 1),       # 체류 합계(분)
        "p": max(float(r["pct"] or 0), int(r["deci"] or 0) / 10.0),
        "rb": int(r["rebirth"] or 0),
        "r": mask, "f": far,
        "b": int(r["buys"] or 0),
        "c": r["country"] or "",
    }


def write_if_changed(path: str, payload: dict, indent=None) -> bool:
    body = json.dumps(payload, ensure_ascii=False,
                      separators=None if indent else (",", ":"), indent=indent) + "\n"
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == body:
                return False
    except OSError:
        pass
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    return True


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    rows = fetch_all()
    if not rows:
        print("받은 유저가 없습니다.")
        return 0

    spine_n = len(rt._SPINE)
    by_day: dict[str, list] = defaultdict(list)
    progs = []
    for r in rows:
        u = pack(r, spine_n)
        by_day[r["joined_day"]].append(u)
        progs.append(u["p"])

    # 같은 날 안에서는 늦게 들어온 사람이 위로 — 실시간 뷰와 같은 순서다.
    written = 0
    for day, us in by_day.items():
        us.sort(key=lambda u: u["j"], reverse=True)
        if write_if_changed(os.path.join(OUT_DIR, f"{day}.json"), {"date": day, "users": us}):
            written += 1

    # 더 이상 쓰이지 않는 파일 정리 — 가입일 판정이 바뀌어 비는 날이 생길 수 있다.
    keep = {f"{d}.json" for d in by_day} | {"index.json"}
    for name in os.listdir(OUT_DIR):
        if name.endswith(".json") and name not in keep:
            os.remove(os.path.join(OUT_DIR, name))
            print("  삭제:", name)

    days = sorted(({"date": d, "n": len(us)} for d, us in by_day.items()),
                  key=lambda x: x["date"], reverse=True)
    idx = {
        "updated": datetime.now(KST).strftime("%Y-%m-%d %H:%M") + " KST",
        "basis": "lifetime",   # 각 줄은 '지금까지의 누적'이다 — 가입일 한정이 아니다
        "total": sum(d["n"] for d in days),
        # 눈금별 도달 인원 — 인게임 뷰의 '추월% 도달 생존'과 같은 기준이라 숫자가 맞아야 한다
        "reach": {str(m): sum(1 for p in progs if p >= m) for m in (1, 10, 50, 90, 100)},
        "days": days,
        "stage_labels": [{"key": k, "label": lab,
                          "kind": "side" if k in rt.SIDE else "spine"}
                         for k, lab, _ in rt.ORDER],
        "scan_mb": round(rt._billed / 1024 / 1024, 1),
    }
    write_if_changed(INDEX, idx, indent=1)
    print(f"총 {idx['total']}명 / {len(days)}일 · 파일 {written}장 갱신 · 스캔 {idx['scan_mb']}MB")
    print("  추월 도달:", " · ".join(f"{k}%+ {v}명" for k, v in idx["reach"].items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
