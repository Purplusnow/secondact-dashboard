# -*- coding: utf-8 -*-
"""국가별 효율 — 광고비(Google Ads) × 유저·결제자(GA4 BigQuery).

왜 필요한가
-----------
유저 수만 보면 정확히 거꾸로 읽는다. 2026-10-20 실측(최근 60일):
  인도 2,526명 유입 1위인데 결제자 6명 / 한국 975명인데 결제자 36명.
  **한국 유저 1명 ≈ 인도 유저 15명.**
여기에 '그 유저를 사는 데 얼마 썼나'가 붙어야 "어디를 끄고 어디를 늘릴지"가 정해진다.

데이터 두 갈래
  · 광고비  docs/data/geo_cost.json   ← Google Ads 스크립트가 국가별로 보낸 것(ISO 코드)
  · 유저    GA4 BigQuery              ← geo.country 는 **이름**이라 ISO 로 바꿔 붙인다
비용 파일이 아직 없으면 유저 쪽만 출력한다(스크립트를 아직 안 돌린 상태).

⚠광고비 총액과 국가별 합은 정확히 맞지 않는다 — 위치를 특정 못 한 노출이 빠진다.
  장부 기준은 daily.json 의 ads 이고, 여기는 **국가 간 비율**을 보는 용도다.

사용:
  export GOOGLE_APPLICATION_CREDENTIALS=~/dev/keystore/secondact-bq.json
  python3 tools/geo_roi.py            # 최근 60일
  python3 tools/geo_roi.py --days 30
  python3 tools/geo_roi.py --write    # docs/data/geo_roi.json 으로도 저장
"""
import argparse, json, pathlib, sys
from datetime import datetime, timedelta, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
GEO_COST = ROOT / "docs" / "data" / "geo_cost.json"
GEOMAP = ROOT / "tools" / "geo_targets_countries.json"
OUT = ROOT / "docs" / "data" / "geo_roi.json"
KST = timezone(timedelta(hours=9))
PROJECT, DATASET = "second-act-life", "analytics_544010325"
LOCATION = "asia-northeast3"

# GA4 geo.country(이름) → ISO. 대부분 Google Ads 지역표와 같은 표기라 그걸 역으로 쓰고,
# 어긋나는 것만 여기 적는다. 새로 어긋나면 실행 시 '미매칭'으로 찍히니 그때 추가하면 된다.
ALIAS = {
    "Türkiye": "TR", "Turkey": "TR", "South Korea": "KR", "Czechia": "CZ",
    "Myanmar (Burma)": "MM", "Hong Kong": "HK", "Macao": "MO",
    "United States": "US", "United Kingdom": "GB", "Russia": "RU",
    # GA4 와 Google Ads 의 표기 차이(실측으로 걸린 것만 — 추측으로 넣지 않는다)
    "Bosnia & Herzegovina": "BA", "Congo - Kinshasa": "CD", "Congo - Brazzaville": "CG",
    "Côte d\u2019Ivoire": "CI", "Côte d'Ivoire": "CI", "Réunion": "RE",
    "St. Martin": "MF", "Palestine": "PS", "Taiwan": "TW",
}
# ⚠아래는 **Google Ads 가 광고를 못 돌리는 지역**이라 매핑이 없는 게 정상이다(제재 등).
# 유저는 들어오지만 광고비는 영원히 0 — 미매칭 경고에서 제외해 소음을 줄인다.
NO_ADS = {"Iran", "Cuba", "North Korea", "Syria", "Sudan"}


def name_to_iso() -> dict:
    m = {v["name"]: v["cc"] for v in json.loads(GEOMAP.read_text(encoding="utf-8")).values()}
    m.update(ALIAS)
    return m


def fetch_users(days: int) -> list[dict]:
    from google.cloud import bigquery
    c = bigquery.Client(project=PROJECT, location=LOCATION)
    q = f"""
    WITH ev AS (
      SELECT user_pseudo_id, geo.country AS country, event_name, event_timestamp
      FROM `{PROJECT}.{DATASET}.events_*`
      WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL {days} DAY))
                              AND FORMAT_DATE('%Y%m%d', CURRENT_DATE('Asia/Seoul'))
        AND IFNULL(geo.country,'') != ''          -- 국가 빈 행 = Play 사전출시 로봇
    ),
    u AS (
      SELECT user_pseudo_id,
             ARRAY_AGG(country IGNORE NULLS ORDER BY event_timestamp LIMIT 1)[SAFE_OFFSET(0)] AS c,
             COUNTIF(event_name='purchase') > 0 AS payer
      FROM ev GROUP BY user_pseudo_id
    )
    SELECT c AS country, COUNT(*) AS users, COUNTIF(payer) AS payers
    FROM u GROUP BY country ORDER BY users DESC
    """
    job = c.query(q)
    rows = [dict(r) for r in job]
    print(f"BigQuery 스캔 {job.total_bytes_billed/1e6:.0f}MB", file=sys.stderr)
    return rows


def load_cost(days: int) -> dict:
    """ISO → 누적 비용·전환. 파일이 없으면 빈 dict(아직 스크립트 미실행)."""
    if not GEO_COST.exists():
        return {}
    data = json.loads(GEO_COST.read_text(encoding="utf-8")).get("by_date", {})
    since = (datetime.now(KST) - timedelta(days=days)).strftime("%Y-%m-%d")
    out: dict = {}
    for date, per in data.items():
        if date < since:
            continue
        for cc, v in per.items():
            a = out.setdefault(cc, {"cost": 0, "conv": 0.0, "clicks": 0})
            a["cost"] += int(v.get("cost", 0))
            a["conv"] += float(v.get("conv", 0))
            a["clicks"] += int(v.get("clicks", 0))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--min-users", type=int, default=100, help="이 미만 국가는 표에서 제외(노이즈)")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()

    iso = name_to_iso()
    users = fetch_users(a.days)
    cost = load_cost(a.days)
    unmatched = []

    rows = []
    for r in users:
        cc = iso.get(r["country"])
        if cc is None and r["country"] not in NO_ADS:
            unmatched.append(r["country"])
        c = cost.get(cc or "", {})
        spend = c.get("cost", 0)
        rows.append({
            "country": r["country"], "cc": cc, "users": r["users"], "payers": r["payers"],
            "payers_per_1k": round(r["payers"] * 1000 / r["users"], 1) if r["users"] else 0.0,
            "cost": spend,
            "cpi": round(spend / r["users"]) if spend and r["users"] else None,
            "cost_per_payer": round(spend / r["payers"]) if spend and r["payers"] else None,
        })

    shown = [r for r in rows if r["users"] >= a.min_users]
    shown.sort(key=lambda r: -r["payers_per_1k"])
    has_cost = any(r["cost"] for r in shown)

    print(f"\n최근 {a.days}일 · 유저 {a.min_users}명 이상 국가 {len(shown)}개"
          + ("" if has_cost else "   ⚠광고비 없음 — Google Ads 스크립트를 아직 안 돌렸습니다"))
    hdr = f"{'국가':<18}{'유저':>7}{'결제자':>7}{'1천명당':>8}"
    if has_cost:
        hdr += f"{'광고비':>10}{'CPI':>7}{'결제자당':>9}"
    print(hdr)
    for r in shown:
        line = f"{r['country']:<18}{r['users']:>7,}{r['payers']:>7}{r['payers_per_1k']:>7.1f}명"
        if has_cost:
            line += (f"{r['cost']:>10,}" if r["cost"] else f"{'-':>10}")
            line += (f"{r['cpi']:>7,}" if r["cpi"] else f"{'-':>7}")
            line += (f"{r['cost_per_payer']:>9,}" if r["cost_per_payer"] else f"{'-':>9}")
        print(line)

    if unmatched:
        print(f"\n⚠ISO 미매칭 {len(unmatched)}개: {sorted(set(unmatched))[:12]}"
              f"\n  → tools/geo_roi.py 의 ALIAS 에 추가하세요(광고비가 안 붙습니다)", file=sys.stderr)

    if a.write:
        OUT.write_text(json.dumps(
            {"updated": datetime.now(KST).isoformat(timespec="seconds"),
             "days": a.days, "has_cost": has_cost, "rows": rows},
            ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"\n저장 {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
