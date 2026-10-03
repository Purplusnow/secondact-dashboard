#!/usr/bin/env python3
"""인앱매출 자동 수집 — BigQuery(GA4 purchase 이벤트) → docs/data/daily.json 의 iap.

지금까지 인앱매출만 손으로 넣고 있었다. Play Console 이 주문 목록 API 를 안 주기 때문인데,
게임이 결제 완료 때 GA4 표준 purchase 이벤트(value · currency)를 쏘고 있어서 그쪽으로 받는다.

⚠ Play Console 과 완전히 같은 값이 아니다. 아래 셋은 구조적으로 못 맞춘다:
  · 환불·취소가 반영되지 않는다 — GA4 는 결제 시점만 찍는다. 즉 이 값은 항상 '총액'이다.
  · 라이선스 테스터의 테스트 결제도 섞인다 — 게임이 테스트 결제를 구분해 주지 않는다.
  · Play 포인트로 깎아 산 건은 '실제 낸 돈'으로 찍힌다(예 2,500원짜리가 KRW 450). 할인은
    구글이 부담하고 개발자 정산은 정가 기준이므로, 수동 입력 때 정가로 되돌려 적는다.
그래서 **손으로 넣은 날은 절대 덮어쓰지 않는다**(iap_src=="manual"). Play Console 을 보고
정정한 날이 언제나 이긴다. 자동값은 그 전까지 쓰는 잠정치다.

value 는 Play 표시가(부가세 포함)라 수동 입력과 같은 모양이다 — app.js 의 세율·수수료
계산이 그대로 적용된다.

인증: 환경변수 GOOGLE_APPLICATION_CREDENTIALS. 데이터셋 위치=asia-northeast3.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

from google.cloud import bigquery

KST = timezone(timedelta(hours=9))
PROJECT = os.environ.get("BQ_PROJECT", "second-act-life")
DATASET = os.environ.get("BQ_DATASET", "analytics_544010325")
LOCATION = os.environ.get("BQ_LOCATION", "asia-northeast3")
TABLE = f"`{PROJECT}.{DATASET}.events_*`"
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "daily.json")
DAYS = int(os.environ.get("IAP_DAYS", "3"))   # 늦게 확정되는 날을 다시 훑는 창

client = bigquery.Client(project=PROJECT, location=LOCATION)


def pick_suffixes(days: int) -> list[str]:
    """최근 N일에 대해 쓸 테이블 접미사를 고른다.

    같은 날짜가 일별(events_YYYYMMDD)과 스트리밍(events_intraday_YYYYMMDD)에 동시에
    존재할 수 있다 — GA4 는 일별이 확정된 뒤에야 intraday 를 지운다. 둘 다 읽으면
    그날 매출이 두 배가 된다. 날짜마다 하나만 고른다(확정본 우선).
    """
    rows = client.query(f"""
      SELECT DISTINCT _TABLE_SUFFIX AS s FROM {TABLE}
      WHERE _TABLE_SUFFIX >= '{(datetime.now(KST) - timedelta(days=days)).strftime('%Y%m%d')}'
         OR _TABLE_SUFFIX LIKE 'intraday%'
    """).result()
    have = {r["s"] for r in rows}
    want, today = [], datetime.now(KST).date()
    for i in range(days + 1):
        d = (today - timedelta(days=i)).strftime("%Y%m%d")
        if d in have:                       # 확정본이 있으면 그걸 쓴다
            want.append(d)
        elif f"intraday_{d}" in have:       # 없으면 스트리밍본으로 때운다
            want.append(f"intraday_{d}")
    return want


def fetch(suffixes: list[str]) -> dict[str, dict[str, float]]:
    if not suffixes:
        return {}
    lst = ", ".join(f"'{s}'" for s in suffixes)
    # value 가 double/int/float 중 어디에 담겨 올지 SDK·버전에 따라 갈려서 셋 다 본다.
    val = ("COALESCE((SELECT value.double_value FROM UNNEST(event_params) WHERE key='value'),"
           "(SELECT value.float_value FROM UNNEST(event_params) WHERE key='value'),"
           "CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key='value') AS FLOAT64))")
    rows = client.query(f"""
      SELECT
        FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul') AS d,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key='currency') AS cur,
        SUM({val}) AS amt,
        COUNT(*) AS n
      FROM {TABLE}
      WHERE _TABLE_SUFFIX IN ({lst}) AND event_name = 'purchase'
      GROUP BY d, cur
      HAVING amt > 0
      ORDER BY d
    """).result()
    out: dict[str, dict[str, float]] = {}
    for r in rows:
        cur = (r["cur"] or "").upper()
        if not cur:
            continue
        amt = float(r["amt"] or 0.0)
        # 소수 없는 통화(원·엔·동 등)는 정수로 떨어뜨려 수동 입력과 모양을 맞춘다.
        out.setdefault(r["d"], {})[cur] = round(amt, 2) if amt % 1 else int(amt)
    return out


def main() -> None:
    with open(OUT, encoding="utf-8") as f:
        doc = json.load(f)
    by_date = {row["date"]: row for row in doc["daily"]}

    got = fetch(pick_suffixes(DAYS))
    if not got:
        print("수집된 결제가 없습니다 — 파일을 건드리지 않습니다.")
        return

    changed = []
    for date, iap in sorted(got.items()):
        row = by_date.get(date)
        if row is None:
            row = {"date": date}
            doc["daily"].append(row)
            by_date[date] = row
        if row.get("iap_src") == "manual":
            print(f"  {date} 건너뜀 — 손으로 넣은 날(Play Console 기준이 이긴다)")
            continue
        if row.get("iap") == iap:
            continue
        row["iap"] = iap
        row["iap_src"] = "ga4"
        changed.append(f"{date} {iap}")

    if not changed:
        print("바뀐 날이 없습니다.")
        return

    doc["daily"].sort(key=lambda r: r["date"])
    doc["updated"] = datetime.now(KST).isoformat(timespec="seconds")
    doc.setdefault("synced", {})["iap"] = doc["updated"]
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    for c in changed:
        print("  갱신:", c)


if __name__ == "__main__":
    sys.exit(main())
