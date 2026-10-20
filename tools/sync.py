#!/usr/bin/env python3
"""daily.json 을 외부 소스에서 자동 갱신한다. GitHub Actions에서 돌린다.

  --ads-json '[{"date":"2026-09-09","cost":11800}, ...]'
  --geo-json '[{"date":"2026-09-09","geo":"2410","cost":3200,"conv":2}, ...]'   # 국가별(선택)
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
GEO = ROOT / "docs" / "data" / "geo_cost.json"
GEOMAP = ROOT / "tools" / "geo_targets_countries.json"
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


def stamp(data: dict, key: str) -> None:
    """계열별 '마지막으로 확인한 시각'. 값이 안 바뀌어도 찍는다 —
    화면에서 알고 싶은 건 '언제 바뀌었나'가 아니라 '지금 값이 최신인가'다."""
    data.setdefault("synced", {})[key] = datetime.now(KST).isoformat(timespec="seconds")


def save(data: dict, changed: list[str]) -> None:
    data["daily"].sort(key=lambda r: r["date"])
    data["updated"] = today()
    DAILY.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("갱신:", ", ".join(changed) if changed else "값 변동 없음 (확인 시각만 기록)")


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
    stamp(data, "ads")
    save(data, changed)


def apply_geo(payload: str) -> None:
    """국가별 비용·전환 → docs/data/geo_cost.json.

    ★daily.json 에 넣지 않는다. 그 파일은 realtime(iap.py)과 공유라 동시쓰기 충돌을
    피하려고 concurrency 그룹을 하나로 묶어 뒀다. 국가별은 성격이 달라(장부가 아니라 분석)
    별도 파일로 두면 그 직렬화에 끼어들지 않는다.

    ⚠총액(daily.ads)과 합이 정확히 맞지 않는다 — 위치를 특정 못 한 노출이 geographic_view
    에서 빠진다. 장부 기준은 여전히 daily.ads 이고 여기는 **비율을 보는 용도**다.
    """
    rows = json.loads(payload) if payload else []
    if isinstance(rows, dict):
        rows = [rows]
    if not rows:
        print("국가별: 받은 행 없음 — 건너뜀")
        return
    gmap = json.loads(GEOMAP.read_text(encoding="utf-8"))
    data = json.loads(GEO.read_text(encoding="utf-8")) if GEO.exists() else {"by_date": {}}
    unknown = set()
    n = 0
    for it in rows:
        date = it.get("date")
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except (TypeError, ValueError):
            print(f"건너뜀(날짜 형식): {it}", file=sys.stderr)
            continue
        gid = str(it.get("geo", ""))
        ent = gmap.get(gid)
        if ent is None:
            unknown.add(gid)
            continue
        day = data["by_date"].setdefault(date, {})
        day[ent["cc"]] = {
            "cost": int(round(float(it.get("cost", 0)))),
            "conv": round(float(it.get("conv", 0)), 2),
            "clicks": int(it.get("clicks", 0)),
            "impr": int(it.get("impr", 0)),
        }
        n += 1
    if unknown:
        # 매핑표가 낡으면 조용히 유실된다. 반드시 눈에 띄게 남긴다.
        print(f"⚠ 매핑에 없는 geo id {len(unknown)}개: {sorted(unknown)[:10]} "
              f"— tools/geo_targets_countries.json 갱신 필요", file=sys.stderr)
    data["updated"] = datetime.now(KST).isoformat(timespec="seconds")
    GEO.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    days = len(data["by_date"])
    print(f"국가별: {n}행 반영 (누적 {days}일)")


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
        # APP 을 빼면 계정의 모든 앱이 합산된다. ★이 보드는 **통합 대시보드**로 간다
        # (투자자 결정 2026-10-20) — purplusnow 계정의 앱 전부를 한 화면에서 보는 쪽이다.
        # 그래서 합산은 **의도된 동작**이다. 앱별 내역은 admob_apps 에 남겨 어느 앱이
        # 얼마를 벌었는지 쪼개 볼 수 있게 한다.
        # ⚠ 아직 정리가 덜 된 상태다 — 화면 제목·문구는 여전히 '인생 2막' 하나를
        #   말하고 있다. 앞으로 대시보드 하나에 모든 게임을 담는 방향으로 정리한다.
        #   그때까지 '다른 앱이 섞였다'를 버그로 읽지 말 것(포크 쪽에서 실제로 그렇게
        #   읽고 앱 필터를 넣을 뻔했다).
        "dimensions": ["DATE", "APP"],
        "metrics": ["ESTIMATED_EARNINGS"],
        "localizationSettings": {"currencyCode": "USD"},
    }}

    out = post(f"{ADMOB_API}/accounts/{pub}/networkReport:generate",
               json.dumps(spec).encode(),
               {"Authorization": "Bearer " + admob_token(),
                "Content-Type": "application/json"})

    # 날짜 × 앱으로 모은다. 앱 이름은 displayLabel(없으면 앱 ID)로 잡는다.
    per: dict[str, dict[str, float]] = {}
    for entry in out if isinstance(out, list) else [out]:
        r = entry.get("row")
        if not r:
            continue
        dv = r["dimensionValues"]
        raw = dv["DATE"]["value"]                            # 20260908
        date = f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
        app = dv.get("APP", {})
        name = app.get("displayLabel") or app.get("value") or "(미상)"
        usd = round(int(r["metricValues"]["ESTIMATED_EARNINGS"].get("microsValue", 0)) / 1e6, 2)
        if usd <= 0:
            continue
        per.setdefault(date, {})[name] = per.setdefault(date, {}).get(name, 0.0) + usd

    data = load()
    changed = []
    for date, apps in sorted(per.items()):
        row = row_for(data, date)
        total = round(sum(apps.values()), 2)
        before = (row.get("admob") or {}).get("USD")
        if before != total:
            changed.append(f"{date} 광고매출 ${before or 0}→${total}")
        row["admob"] = {"USD": total}
        # 앱별 내역도 남긴다 — 어느 앱이 얼마를 벌었는지 화면에서 쪼개 보기 위함이고,
        # 합계만 두면 어느 앱이 얼마를 벌었는지 영영 모른다(통합 보드라 더 중요하다).
        row["admob_apps"] = {k: round(v, 2) for k, v in sorted(apps.items(), key=lambda x: -x[1])}
        print(f"  {date}  " + " · ".join(f"{k} ${v:.2f}" for k, v in row["admob_apps"].items()))
    stamp(data, "admob")
    save(data, changed)


def main() -> int:
    p = argparse.ArgumentParser(description="daily.json 자동 갱신")
    p.add_argument("--ads-json", help="[{date, cost}] 형태의 JSON 문자열")
    p.add_argument("--geo-json", help="[{date, geo, cost, conv, clicks, impr}] 국가별(선택)")
    p.add_argument("--admob", action="store_true", help="AdMob API에서 광고매출 수집")
    p.add_argument("--days", type=int, default=3,
                   help="AdMob 조회 일수 (기본 3 — 사후 상향 조정을 따라잡기 위해 여유를 둔다)")
    a = p.parse_args()

    if a.ads_json:
        apply_ads(a.ads_json)
    if a.geo_json:
        apply_geo(a.geo_json)
    if a.admob:
        apply_admob(a.days)
    if not a.ads_json and not a.admob and not a.geo_json:
        p.error("--ads-json 또는 --admob 중 하나는 필요합니다")
    return 0


if __name__ == "__main__":
    sys.exit(main())
