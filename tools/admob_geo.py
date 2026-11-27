#!/usr/bin/env python3
"""앱 하나의 국가별 누적 AdMob 광고매출 — 진단 전용, 파일로 남기지 않는다(Actions 로그로만).

  python3 tools/admob_geo.py --app "Second Act" [--since 2026-08-30]

--app 은 AdMob 앱 이름(displayLabel)에 들어가는 글자. 인증은 sync.py 와 같은 ADMOB_* 환경변수.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from sync import ADMOB_API, admob_token, post  # noqa: E402

KST = timezone(timedelta(hours=9))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--app", required=True)
    p.add_argument("--since", default="2026-08-30")
    a = p.parse_args()
    s = date.fromisoformat(a.since)
    e = datetime.now(KST).date()
    spec = {"reportSpec": {
        "dateRange": {"startDate": {"year": s.year, "month": s.month, "day": s.day},
                      "endDate": {"year": e.year, "month": e.month, "day": e.day}},
        "dimensions": ["APP", "COUNTRY"],
        "metrics": ["ESTIMATED_EARNINGS", "IMPRESSIONS"],
        "localizationSettings": {"currencyCode": "USD"},
    }}
    out = post(f"{ADMOB_API}/accounts/{os.environ['ADMOB_PUBLISHER_ID']}/networkReport:generate",
               json.dumps(spec).encode(),
               {"Authorization": "Bearer " + admob_token(), "Content-Type": "application/json"})
    rows = []
    for ent in out if isinstance(out, list) else [out]:
        r = ent.get("row")
        if not r:
            continue
        dv = r["dimensionValues"]
        name = dv.get("APP", {}).get("displayLabel") or ""
        if a.app.lower() not in name.lower():
            continue
        m = r["metricValues"]
        rows.append((dv.get("COUNTRY", {}).get("value") or "??",
                     int(m["ESTIMATED_EARNINGS"].get("microsValue", 0)) / 1e6,
                     int(m.get("IMPRESSIONS", {}).get("integerValue", 0))))
    rows.sort(key=lambda x: -x[1])
    tot = sum(r[1] for r in rows) or 1
    print(f"{a.app} · {s}~{e} · 국가 {len(rows)}개 · 합계 ${tot:.2f}")
    for cc, usd, imp in rows:
        ecpm = usd / imp * 1000 if imp else 0
        print(f"GEO {cc}\t${usd:.2f}\t{usd / tot * 100:.1f}%\timpr {imp}\teCPM ${ecpm:.2f}")


if __name__ == "__main__":
    main()
