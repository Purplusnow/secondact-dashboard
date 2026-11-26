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
import re
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
# 자체 iap_purchase 에 금액이 없고 sku 만 있는 앱의 정가(국내 KRW, 해외는 USD 정가로 근사 — Play 가 나라별로
# 바꾼 현지가와는 조금 다르다). 2026-11-17 해담하우스 콜롬비아 결제가 0 으로 보여 추가.
# Play 주문번호 형식 GPA.dddd-dddd-dddd-ddddd(구독 갱신은 ..N 접미). 2026-11-17 심연의 등불에서 5마디짜리 가짜
# 주문번호 + 한국 유저인데 currency=USD 인 '결제' 100여 건(₩119,000 상품 연타)이 들어와 ₩64만으로 잡혔다 — 결제 위조 앱.
GPA = re.compile(r"^GPA\.\d{4}-\d{4}-\d{4}-\d{5}(\.\.\d+)?$")
SKU_PRICE = {"haedam_full": {"KRW": 8800, "USD": 6.99},
             "haemu_full": {"KRW": 6600, "USD": 4.99}}
# iap_purchase 대신 paywall_buy(result='ok') 로 결제를 남기는 앱 → 그 앱의 정식판 sku.
# 해무사진관: 2026-11-26 유료 앱 → 무료+정식판 해금(haemu_full)으로 전환. 이벤트에 sku 가 없고 v1.3.0 부터 order_id 가 붙는다.
PAYWALL_SKU = {"haemu": "haemu_full"}

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
            cust: dict[str, dict] = {}
            fake: dict[str, int] = {}
            for r in c.query(sql, location=loc).result():
                if r["cur"]:
                    amt = float(r["amt"])
                    got.setdefault(r["d"], {})[r["cur"]] = round(amt, 2) if amt % 1 else int(amt)
            # 표준 purchase 를 안 남기는 앱 — 자체 iap_purchase 이벤트. 앱(템플릿)마다 금액 키가 다르다:
            #   value+currency(Monet 템플릿: 월드 레스토랑·한붓길·자이로그리드) · micros+currency(빗물초밥·심연의 등불)
            #   · won(꿀벌 건축가, 원화) · sku 만(해담하우스 → SKU_PRICE 정가)
            #   · paywall_buy result=ok(해무사진관 — PAYWALL_SKU 정가, 웹 테스트 web=1 은 뺀다)
            pw = "TRUE" if k in PAYWALL_SKU else "FALSE"
            sql2 = f"""
              SELECT FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul') AS d,
                     UPPER((SELECT value.string_value FROM UNNEST(event_params) WHERE key='currency')) AS cur,
                     COALESCE((SELECT value.string_value FROM UNNEST(event_params) WHERE key='sku'),
                              (SELECT value.string_value FROM UNNEST(event_params) WHERE key='product_id'),
                              (SELECT value.string_value FROM UNNEST(event_params) WHERE key='id')) AS sku,
                     {VAL} AS val,
                     (SELECT COALESCE(value.int_value, CAST(value.double_value AS INT64)) FROM UNNEST(event_params) WHERE key='micros') AS micros,
                     (SELECT COALESCE(value.int_value, CAST(value.double_value AS INT64)) FROM UNNEST(event_params) WHERE key='won') AS won,
                     geo.country = 'South Korea' AS kr,
                     COALESCE((SELECT value.string_value FROM UNNEST(event_params) WHERE key='order_id'),
                              (SELECT value.string_value FROM UNNEST(event_params) WHERE key='order')) AS ord
              FROM `{a['project']}.{ds}.events_*`
              WHERE _TABLE_SUFFIX IN ({lst})
                AND (event_name = 'iap_purchase' OR ({pw} AND event_name = 'paywall_buy'
                     AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='result') = 'ok'
                     AND (SELECT value.int_value FROM UNNEST(event_params) WHERE key='web') IS NULL))
                AND IFNULL(device.mobile_model_name, '') NOT IN ({", ".join(repr(m) for m in TEST_MODELS)})
                AND (SELECT value.int_value FROM UNNEST(event_params) WHERE key='debug_event') IS NULL"""
            for r in c.query(sql2, location=loc).result():
                if r["d"] in got:          # 그날 표준 purchase 가 있으면 그걸 쓴다(이중 계산 방지)
                    continue
                if r["ord"] and not GPA.match(r["ord"]):   # 위조 결제(주문번호 형식이 Play 와 다름)
                    fake[r["d"]] = fake.get(r["d"], 0) + 1
                    continue
                if r["val"] and r["cur"]:
                    cur, amt = r["cur"], float(r["val"])
                elif r["micros"] and r["cur"]:
                    cur, amt = r["cur"], r["micros"] / 1e6
                elif r["won"]:
                    cur, amt = "KRW", float(r["won"])
                elif (r["sku"] or PAYWALL_SKU.get(k)) in SKU_PRICE:
                    cur = "KRW" if r["kr"] else "USD"
                    amt = SKU_PRICE[r["sku"] or PAYWALL_SKU[k]][cur]
                else:
                    print(f"::warning::{k} iap_purchase 금액 모름: {r['sku']}")
                    continue
                cust.setdefault(r["d"], {})
                cust[r["d"]][cur] = round(cust[r["d"]].get(cur, 0) + amt, 2)
            for d, v in cust.items():
                got.setdefault(d, v)
            if fake:
                print(f"::warning::{k} 위조 결제 의심(주문번호 형식 불일치) 제외: {fake}")
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
