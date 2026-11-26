#!/usr/bin/env python3
"""환불·취소된 주문(Play Voided Purchases API) → docs/data/refunds.json

GA4 로 센 인앱(iap.py · iap_apps.py)은 결제 순간만 보고 환불을 모른다. 판매 리포트(playsales.py)는
환불을 빼지만 늦게 온다. 그래서 Play 가 '무효가 된 주문' 목록을 직접 받아 보드가 빼게 한다(2026-11-27).

- 환불 경로: 구매 후 48시간 안엔 유저가 Play 에서 직접, 그 뒤엔 개발자 환불·지원 문의·카드 지불거절
  (몇 달 뒤에도 온다), 3일 안에 acknowledge 안 한 결제는 Google 자동 환불. 즉 '48시간 지나면 끝'이 아니다.
- API 는 최근 30일 안에 무효가 된 주문만 준다 → 매 실행마다 30일을 다시 받고, 받은 건 파일에 계속 쌓는다
  (30일 밖으로 밀려나도 지우지 않는다).
- API 에는 금액·상품이 없다. 그래서 주문마다 그 앱 GA4 에서 결제 이벤트를 한 번 찾아 금액을 붙인다:
  주문번호(order_id·order·transaction_id)가 같으면 그것, 없으면 결제 시각 ±10분 안에서 가장 가까운 것.
  금액 계산은 iap_apps.py 와 같다(value · micros · won · SKU 정가).
- 형 테스트 폰 결제는 GA4 집계에서 이미 빠지므로 test:true 로 두고 보드가 빼지 않는다(두 번 빼기 방지).
- 보드(portfolio.js)는 판매 리포트가 덮지 않는 날(= GA4 로 센 날)에만 amt 를 뺀다. 수동 기록(manual_sales)
  주문이 환불되면 그 기록을 뺀다.

인증: Play = 환경변수 PLAY_API_SA(없으면 GCP_SA_CROWNCOIN) 서비스 계정 JSON.
  Play Console › 사용자 및 권한 › 그 계정 › 계정 권한 '재무 데이터, 주문, 취소 설문조사 응답 보기'.
  GA4 = apps.json 의 secret 이름과 같은 환경변수(common.py 와 같다).
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone

from google.oauth2 import service_account
from google.auth.transport.requests import AuthorizedSession

sys.path.insert(0, os.path.dirname(__file__))
from common import client_for, find_dataset  # noqa: E402
from iap_apps import GPA, SKU_PRICE, PAYWALL_SKU, TEST_MODELS, VAL  # noqa: E402

KST = timezone(timedelta(hours=9))
ROOT = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
OUT = os.path.join(ROOT, "refunds.json")
API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{pkg}/purchases/voidedpurchases"
NEAR_MS = 10 * 60 * 1000
REASON = {0: "other", 1: "remorse", 2: "not_received", 3: "defective", 4: "accidental_purchase",
          5: "fraud", 6: "friendly_fraud", 7: "chargeback", 8: "unacknowledged_purchase"}
SOURCE = {0: "user", 1: "developer", 2: "google"}


def play_session() -> AuthorizedSession | None:
    raw = (os.environ.get("PLAY_API_SA") or os.environ.get("GCP_SA_CROWNCOIN") or "").strip()
    if not raw:
        return None
    cred = service_account.Credentials.from_service_account_info(
        json.loads(raw), scopes=["https://www.googleapis.com/auth/androidpublisher"])
    return AuthorizedSession(cred)


def voided(s: AuthorizedSession, pkg: str) -> list[dict] | int:
    """최근 30일 무효 주문(인앱 + 구독). 권한이 없으면 HTTP 상태 코드를 돌려준다."""
    out, token = [], None
    start = int((datetime.now(timezone.utc) - timedelta(days=30) + timedelta(minutes=5)).timestamp() * 1000)
    while True:
        params = {"type": 1, "maxResults": 1000, "startTime": start}
        if token:
            params["token"] = token
        r = s.get(API.format(pkg=pkg), params=params, timeout=30)
        if r.status_code != 200:
            return r.status_code
        j = r.json()
        out += j.get("voidedPurchases", [])
        token = (j.get("tokenPagination") or {}).get("nextPageToken")
        if not token:
            return out


def kst_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, KST).date().isoformat()


def price_ga4(c, project: str, ds: str, loc: str, key: str, o: dict) -> dict | None:
    """그 주문의 GA4 결제 이벤트를 찾아 금액·통화·날짜를 돌려준다. 못 찾으면 None."""
    ms = int(o["purchaseTimeMillis"])
    days = {(datetime.fromtimestamp(ms / 1000, KST).date() + timedelta(days=i)).strftime("%Y%m%d") for i in (-1, 0, 1)}
    suf = [s for s in (f"{d}" for d in days)] + [f"intraday_{d}" for d in days]
    lst = ", ".join(f"'{s}'" for s in suf)
    sql = f"""
      SELECT event_name, event_timestamp AS ts, device.mobile_model_name AS model,
             UPPER((SELECT value.string_value FROM UNNEST(event_params) WHERE key='currency')) AS cur,
             {VAL} AS val,
             (SELECT COALESCE(value.int_value, CAST(value.double_value AS INT64)) FROM UNNEST(event_params) WHERE key='micros') AS micros,
             (SELECT COALESCE(value.int_value, CAST(value.double_value AS INT64)) FROM UNNEST(event_params) WHERE key='won') AS won,
             COALESCE((SELECT value.string_value FROM UNNEST(event_params) WHERE key='sku'),
                      (SELECT value.string_value FROM UNNEST(event_params) WHERE key='product_id'),
                      (SELECT value.string_value FROM UNNEST(event_params) WHERE key='id')) AS sku,
             COALESCE((SELECT value.string_value FROM UNNEST(event_params) WHERE key='order_id'),
                      (SELECT value.string_value FROM UNNEST(event_params) WHERE key='order'),
                      (SELECT value.string_value FROM UNNEST(event_params) WHERE key='transaction_id')) AS ord,
             geo.country = 'South Korea' AS kr
      FROM `{project}.{ds}.events_*`
      WHERE _TABLE_SUFFIX IN ({lst})
        AND (event_name IN ('purchase', 'iap_purchase')
             OR (event_name = 'paywall_buy' AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key='result') = 'ok'))
        AND ABS(event_timestamp / 1000 - {ms}) < 86400000"""
    rows = list(c.query(sql, location=loc).result())
    oid = o.get("orderId") or ""
    hit = [r for r in rows if r["ord"] and r["ord"] == oid]
    if not hit:   # 주문번호가 없는 앱(해담하우스 등) — 시각이 가장 가까운 것
        near = [r for r in rows if not (r["ord"] and GPA.match(r["ord"])) and abs(r["ts"] / 1000 - ms) < NEAR_MS]
        hit = sorted(near, key=lambda r: abs(r["ts"] / 1000 - ms))[:1]
    if not hit:
        return None
    # 같은 결제를 purchase 와 iap_purchase 로 둘 다 남기는 앱이 있다 — 표준 purchase 를 먼저 본다(iap_apps 와 같다)
    r = sorted(hit, key=lambda r: r["event_name"] != "purchase")[0]
    if r["val"] and r["cur"]:
        cur, amt = r["cur"], float(r["val"])
    elif r["micros"] and r["cur"]:
        cur, amt = r["cur"], r["micros"] / 1e6
    elif r["won"]:
        cur, amt = "KRW", float(r["won"])
    elif (r["sku"] or PAYWALL_SKU.get(key)) in SKU_PRICE:
        cur = "KRW" if r["kr"] else "USD"
        amt = SKU_PRICE[r["sku"] or PAYWALL_SKU[key]][cur]
    else:
        return None
    return {"date": kst_date(r["ts"] // 1000), "cur": cur, "amt": round(amt, 2) if amt % 1 else int(amt),
            "test": (r["model"] or "") in TEST_MODELS, "match": "order" if r["ord"] == oid and oid else "time"}


def main() -> None:
    s = play_session()
    if s is None:
        print("::warning::Play API 키(PLAY_API_SA / GCP_SA_CROWNCOIN)가 없어 건너뜀")
        return
    apps = json.load(open(os.path.join(ROOT, "apps.json"), encoding="utf-8"))["apps"]
    try:
        doc = json.load(open(OUT, encoding="utf-8"))
    except FileNotFoundError:
        doc = {"orders": {}}
    orders = doc.setdefault("orders", {})
    manual = {o.get("order") for o in json.load(open(os.path.join(ROOT, "manual_sales.json"), encoding="utf-8")).get("orders", [])}
    try:
        last = (json.load(open(os.path.join(ROOT, "iap_sales.json"), encoding="utf-8")).get("last_order") or "")[:10]
    except FileNotFoundError:
        last = ""
    cutoff = (datetime.now(KST).date() - timedelta(days=3)).isoformat()
    access, new = {}, []
    for a in apps:
        k, pkg = a["key"], a.get("package")
        if not pkg or a.get("review"):
            continue
        got = voided(s, pkg)
        if isinstance(got, int):
            access[k] = got
            continue
        access[k] = 200
        bq = None
        for o in got:
            oid = o.get("orderId") or o.get("purchaseToken", "")[:24]
            old = orders.get(oid)
            # 금액을 찾았거나, 결제 3일이 지나도록 GA4 에 없으면(=애초에 안 찍힌 결제) 다시 찾지 않는다
            if old and ("amt" in old or old.get("manual") or old.get("covered") or old["purchased"] < cutoff):
                continue
            row = old or {
                "app": k, "purchased": kst_date(int(o["purchaseTimeMillis"])), "voided": kst_date(int(o["voidedTimeMillis"])),
                "reason": REASON.get(o.get("voidedReason"), str(o.get("voidedReason"))),
                "source": SOURCE.get(o.get("voidedSource"), str(o.get("voidedSource"))),
                "kind": "sub" if ".." in oid else "iap"}
            if oid in manual:
                row["manual"] = True
            elif last and row["purchased"] <= last:
                row["covered"] = True   # 판매 리포트가 덮는 날 — 리포트가 이미 환불을 뺐다
            elif a.get("project") and a.get("secret"):
                try:
                    if bq is None:
                        c = client_for(a["secret"])
                        ds, loc = find_dataset(c, a["project"]) if c else (None, None)
                        bq = (c, ds, loc)
                    c, ds, loc = bq
                    if c and ds:
                        p = price_ga4(c, a["project"], ds, loc, k, o)
                        if p:
                            row.update(p)
                except Exception as e:  # 한 건이 실패해도 나머지는 받는다
                    print(f"::warning::{k} {oid} 금액 찾기 실패: {str(e)[:160]}")
            orders[oid] = row
            new.append(f"{k} {oid} {row.get('amt', '?')}{row.get('cur', '')} {row['reason']}")
    doc["orders"] = dict(sorted(orders.items(), key=lambda x: (x[1]["purchased"], x[0])))
    doc["access"] = access
    doc["updated"] = datetime.now(KST).isoformat(timespec="seconds")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    denied = [k for k, v in access.items() if v != 200]
    print(f"환불 {len(orders)}건(새로 {len(new)}) · 권한 없음 {len(denied)}개 앱: {', '.join(denied) or '-'}")
    for n in new:
        print("  +", n)


if __name__ == "__main__":
    main()
