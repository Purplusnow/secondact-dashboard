#!/usr/bin/env python3
"""인생 2막 말고 다른 앱들의 인앱(GA4 purchase) → docs/data/iap_ga4.json.

인생 2막은 tools/iap.py 가 daily.json 의 iap 로 받는다. 다른 앱은 원래 Play 판매 리포트(손으로
받는 zip)만 봤기 때문에, 리포트가 오기 전 결제는 보드에 0 으로 보였다(2026-11-15 왕관과 금화
JPY 1,490 이 안 잡힌 일). 그래서 같은 방식(GA4 표준 purchase 의 value·currency)으로 앱마다 받는다.

- 보드(portfolio.js)는 판매 리포트 마지막 주문일 다음 날부터만 이 값을 쓰고 'GA4' 표시를 단다.
- 금액은 표시가(부가세 포함) — 보드가 세금·수수료를 뺀다(iap.py 와 같은 모양).
- 환불·테스트 결제는 구분 못 한다(iap.py 주석 참고).
- 앱마다 '마지막으로 훑은 날' 이후만 읽는다(최소 3일, 처음엔 30일). 드라이런이 MAX_GB 를 넘으면 건너뛴다.

인증: apps.json 의 secret 이름과 같은 환경변수(common.py 와 같다).
"""
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from common import client_for, find_dataset, pick_suffixes  # noqa: E402

from google.cloud import bigquery  # noqa: E402

KST = timezone(timedelta(hours=9))
ROOT = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
OUT = os.path.join(ROOT, "iap_ga4.json")
SKIP = {"secondact"}          # iap.py 가 맡는다
MIN_DAYS, FIRST_DAYS = 3, 30
MAX_GB = float(os.environ.get("IAP_MAX_GB") or 1)
# 형의 테스트 폰(갤럭시 S21) — 여기서 난 결제는 판매 리포트에 없는 테스트 결제였다(2026-11-15 확인:
# 퐁당냥 ₩49,000 · 드레이크윙 · 머지 레일웨이 · 왕관과 금화 10월 KRW 전부 이 기기).
TEST_MODELS = ("SM-G991N",)
# 표준 purchase 이벤트 대신 자체 iap_purchase{sku} 만 남기는 앱 — 정가로 계산(국내 KRW, 해외는 USD 정가로
# 근사. Play 가 나라별로 바꾼 현지가와는 조금 다르다). 2026-11-17 해담하우스 콜롬비아 결제가 0 으로 보여 추가.
SKU_PRICE = {"haedam_full": {"KRW": 8800, "USD": 6.99}}
PREFIX = {"haedamhouse": "haedam_"}

VAL = ("COALESCE((SELECT value.double_value FROM UNNEST(event_params) WHERE key='value'),"
       "(SELECT value.float_value FROM UNNEST(event_params) WHERE key='value'),"
       "CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key='value') AS FLOAT64))")


def main() -> None:
    apps = json.load(open(os.path.join(ROOT, "apps.json"), encoding="utf-8"))["apps"]
    try:
        doc = json.load(open(OUT, encoding="utf-8"))
    except FileNotFoundError:
        doc = {"apps": {}, "scanned": {}}
    today = datetime.now(KST).date()

    for a in apps:
        k = a["key"]
        if k in SKIP or a.get("review") or not a.get("secret") or not a.get("project"):
            continue
        c = client_for(a["secret"])
        if c is None:
            continue
        try:
            ds, loc = find_dataset(c, a["project"])
            if not ds:
                continue
            last = doc["scanned"].get(k)
            days = FIRST_DAYS if not last else max(MIN_DAYS, (today - date.fromisoformat(last)).days + 1)
            suf, _, _ = pick_suffixes(c, a["project"], ds, today - timedelta(days=days), today)
            if not suf:
                continue
            lst = ", ".join(f"'{s}'" for s in suf)
            sql = f"""
              SELECT FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul') AS d,
                     UPPER((SELECT value.string_value FROM UNNEST(event_params) WHERE key='currency')) AS cur,
                     SUM({VAL}) AS amt
              FROM `{a['project']}.{ds}.events_*`
              WHERE _TABLE_SUFFIX IN ({lst}) AND event_name = 'purchase'
                AND IFNULL(device.mobile_model_name, '') NOT IN ({", ".join(repr(m) for m in TEST_MODELS)})
              GROUP BY d, cur HAVING amt > 0"""
            dry = c.query(sql, job_config=bigquery.QueryJobConfig(dry_run=True), location=loc)
            gb = dry.total_bytes_processed / 1e9
            if gb > MAX_GB:
                print(f"::warning::{k} {gb:.2f}GB > {MAX_GB}GB — 건너뜀")
                continue
            got: dict[str, dict] = {}
            for r in c.query(sql, location=loc).result():
                if r["cur"]:
                    amt = float(r["amt"])
                    got.setdefault(r["d"], {})[r["cur"]] = round(amt, 2) if amt % 1 else int(amt)
            # 표준 purchase 를 안 남기는 앱(자체 iap_purchase{sku}) — 정가표로 금액을 붙인다
            skus = [s for s in SKU_PRICE if s.startswith(PREFIX.get(k, "\0"))]
            if skus:
                sql2 = f"""
                  SELECT FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul') AS d,
                         (SELECT value.string_value FROM UNNEST(event_params) WHERE key='sku') AS sku,
                         geo.country = 'South Korea' AS kr, COUNT(*) AS n
                  FROM `{a['project']}.{ds}.events_*`
                  WHERE _TABLE_SUFFIX IN ({lst}) AND event_name = 'iap_purchase'
                    AND IFNULL(device.mobile_model_name, '') NOT IN ({", ".join(repr(m) for m in TEST_MODELS)})
                  GROUP BY d, sku, kr"""
                for r in c.query(sql2, location=loc).result():
                    p = SKU_PRICE.get(r["sku"])
                    if not p:
                        continue
                    cur = "KRW" if r["kr"] else "USD"
                    day = got.setdefault(r["d"], {})
                    day[cur] = round(day.get(cur, 0) + p[cur] * r["n"], 2)
            mine = doc["apps"].setdefault(k, {})
            start = (today - timedelta(days=days)).isoformat()
            for d in [d for d in mine if d >= start]:   # 창 안은 새로 받은 값으로 갈아끼운다
                del mine[d]
            mine.update(got)
            if not mine:
                doc["apps"].pop(k)
            doc["scanned"][k] = today.isoformat()
            print(f"{k}: {days}일 · {gb * 1000:.0f}MB · {got or '결제 없음'}")
        except Exception as e:  # 한 앱이 실패해도 나머지는 받는다
            print(f"::warning::{k} 실패: {str(e)[:200]}")

    doc["apps"] = {k: dict(sorted(v.items())) for k, v in sorted(doc["apps"].items())}
    doc["updated"] = datetime.now(KST).isoformat(timespec="seconds")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
