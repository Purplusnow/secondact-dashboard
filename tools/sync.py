#!/usr/bin/env python3
"""daily.json 을 외부 소스에서 자동 갱신한다. GitHub Actions에서 돌린다.

  --ads-json '[{"date":"2026-09-09","cost":11800}, ...]'
      Google Ads 스크립트가 repository_dispatch 로 보낸 마케팅비. 스크립트는 매시간
      '오늘'과 '어제'를 함께 보낸다 — 구글이 확정 수치를 하루 뒤에 상향 조정하기 때문에
      어제 값도 계속 덮어써야 맞는다.

  --admob [--days N]
      AdMob API(networkReport)에서 최근 N일 광고매출을 USD로 받아 채운다.
      refresh token 으로 access token 을 그때그때 발급받는다.

인앱매출(iap)은 절대 건드리지 않는다 — 손으로 넣는 값이다.
"""
import argparse
import json
import os
import pathlib
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DAILY = ROOT / "docs" / "data" / "daily.json"
KST = timezone(timedelta(hours=9))
TOKEN_URL = "https://oauth2.googleapis.com/token"
ADMOB_API = "https://admob.googleapis.com/v1"

today = lambda: datetime.now(KST).strftime("%Y-%m-%d")


def post(url: str, data: bytes, headers: dict) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def load() -> dict:
    return json.loads(DAILY.read_text(encoding="utf-8"))


def save(data: dict, changed: list[str]) -> None:
    if not changed:
        print("변경 없음")
        return
    data["daily"].sort(key=lambda r: r["date"])
    data["updated"] = today()
    DAILY.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("갱신:", ", ".join(changed))


def row_for(data: dict, date: str) -> dict:
    row = next((r for r in data["daily"] if r.get("date") == date), None)
    if row is None:
        row = {"date": date}
        data["daily"].append(row)
    return row


# ── 마케팅비 ──────────────────────────────────────────
def apply_ads(payload: str) -> None:
    rows = json.loads(payload)
    if isinstance(rows, dict):
        rows = [rows]

    data = load()
    changed = []
    for item in rows:
        date, cost = item.get("date"), item.get("cost")
        try:
            datetime.strptime(date, "%Y-%m-%d")
            cost = int(round(float(cost)))
        except (TypeError, ValueError):
            print(f"건너뜀(형식 오류): {item}", file=sys.stderr)
            continue
        if cost < 0:
            continue
        row = row_for(data, date)
        if row.get("ads") != cost:
            changed.append(f"{date} 마케팅비 {row.get('ads', '-')}→{cost:,}")
            row["ads"] = cost
    save(data, changed)


# ── 광고매출 ──────────────────────────────────────────
def admob_token() -> str:
    body = urllib.parse.urlencode({
        "client_id": os.environ["ADMOB_CLIENT_ID"],
        "client_secret": os.environ["ADMOB_CLIENT_SECRET"],
        "refresh_token": os.environ["ADMOB_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }).encode()
    return post(TOKEN_URL, body,
                {"Content-Type": "application/x-www-form-urlencoded"})["access_token"]


def apply_admob(days: int) -> None:
    pub = os.environ["ADMOB_PUBLISHER_ID"]
    end = datetime.now(KST).date()
    start = end - timedelta(days=days - 1)
    spec = {"reportSpec": {
        "dateRange": {
            "startDate": {"year": start.year, "month": start.month, "day": start.day},
            "endDate": {"year": end.year, "month": end.month, "day": end.day},
        },
        "dimensions": ["DATE"],
        "metrics": ["ESTIMATED_EARNINGS"],
        "localizationSettings": {"currencyCode": "USD"},
    }}

    out = post(f"{ADMOB_API}/accounts/{pub}/networkReport:generate",
               json.dumps(spec).encode(),
               {"Authorization": "Bearer " + admob_token(),
                "Content-Type": "application/json"})

    data = load()
    changed = []
    for entry in out if isinstance(out, list) else [out]:
        r = entry.get("row")
        if not r:
            continue
        raw = r["dimensionValues"]["DATE"]["value"]          # 20260908
        date = f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
        micros = int(r["metricValues"]["ESTIMATED_EARNINGS"].get("microsValue", 0))
        usd = round(micros / 1e6, 2)
        if usd <= 0:
            continue
        row = row_for(data, date)
        before = (row.get("admob") or {}).get("USD")
        if before != usd:
            changed.append(f"{date} 광고매출 ${before or 0}→${usd}")
            row["admob"] = {"USD": usd}
    save(data, changed)


def main() -> int:
    p = argparse.ArgumentParser(description="daily.json 자동 갱신")
    p.add_argument("--ads-json", help="[{date, cost}] 형태의 JSON 문자열")
    p.add_argument("--admob", action="store_true", help="AdMob API에서 광고매출 수집")
    p.add_argument("--days", type=int, default=3,
                   help="AdMob 조회 일수 (기본 3 — 사후 상향 조정을 따라잡기 위해 여유를 둔다)")
    a = p.parse_args()

    if a.ads_json:
        apply_ads(a.ads_json)
    if a.admob:
        apply_admob(a.days)
    if not a.ads_json and not a.admob:
        p.error("--ads-json 또는 --admob 중 하나는 필요합니다")
    return 0


if __name__ == "__main__":
    sys.exit(main())
