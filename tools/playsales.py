#!/usr/bin/env python3
"""인앱매출(전체 앱) — Play 판매 리포트(salesreport_YYYYMM) → docs/data/iap_sales.json

  python3 tools/playsales.py --zip ~/Downloads/sales_salesreport_202611.zip   # 손으로 받은 파일
  PLAY_BUCKET=pubsite_prod_rev_0123456789 python3 tools/playsales.py          # 버킷에서 자동

★ 이 리포트가 인앱매출의 기준이다. GA4 purchase 이벤트는 누락이 있다(2026-11 실측 3건 중
1건, 9월엔 유럽 결제 약 22%). 리포트는 주문 단위라 모든 앱이 한 파일에 다 들어 있다.

금액: 'Item Price' = 세전 정가, 'Charged Amount' = 세금 포함 청구액. 정산은 세전가에서
수수료를 떼므로 **net 의 기준은 Item Price** 다 — config.json 의 통화별 세율을 추정해서
나눌 필요가 없다(그 추정이 유로존에서 ±1% 오차를 냈다). gross 는 화면 비교용으로만 둔다.

날짜: 'Order Charged Date' 는 미국 서부 시간이다. 대시보드는 KST 라서
'Order Charged Timestamp'(유닉스 초)를 KST 로 바꿔 날짜를 매긴다.

환불: 상태가 Refund/Chargeback 류면 금액을 뺀다. 그 밖의 상태(취소·거절 등)는 세지 않고
skipped 에 개수만 남긴다.

버킷 권한: Play Console › 사용자 및 권한 에서 서비스계정 이메일을 초대하고 '재무 데이터 보기'
를 준다(반영에 최대 24시간). 버킷 ID 는 Play Console › 다운로드 보고서 › 재무 의
'Cloud Storage URI 복사' 에 있는 pubsite_prod_rev_… 부분.
"""
import argparse
import csv
import io
import json
import os
import pathlib
import sys
import zipfile
from datetime import datetime, timedelta, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "iap_sales.json"
KST = timezone(timedelta(hours=9))
NEG = ("refund", "chargeback")


def num(s: str) -> float:
    return float((s or "0").replace(",", "") or 0)


def parse(month: str, raw: bytes) -> dict:
    """한 달치 CSV → {date: {package: {net:{cur}, gross:{cur}, n}}} + 통계."""
    text = raw.decode("utf-8-sig")
    by_date, last_ts, skipped, n = {}, 0, {}, 0
    for r in csv.DictReader(io.StringIO(text)):
        status = (r.get("Financial Status") or "").strip()
        sign = -1 if any(k in status.lower() for k in NEG) else 1 if status.lower() == "charged" else 0
        if sign == 0:
            skipped[status] = skipped.get(status, 0) + 1
            continue
        ts = int(r["Order Charged Timestamp"])
        last_ts = max(last_ts, ts)
        d = datetime.fromtimestamp(ts, KST).date().isoformat()
        cur = r["Currency of Sale"].strip()
        slot = by_date.setdefault(d, {}).setdefault(r["Package ID"].strip(),
                                                    {"net": {}, "gross": {}, "n": 0, "refunds": 0})
        slot["net"][cur] = round(slot["net"].get(cur, 0) + sign * abs(num(r["Item Price"])), 2)
        slot["gross"][cur] = round(slot["gross"].get(cur, 0) + sign * abs(num(r["Charged Amount"])), 2)
        slot["n"] += sign
        if sign < 0:
            slot["refunds"] += 1
        n += 1
    return {"by_date": by_date, "rows": n, "skipped": skipped,
            "last_order": datetime.fromtimestamp(last_ts, KST).isoformat(timespec="minutes") if last_ts else None}


def csv_of_zip(blob: bytes) -> tuple[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        return name, z.read(name)


def from_bucket(bucket: str, months: list[str]) -> dict[str, bytes]:
    from google.cloud import storage
    c = storage.Client()
    b = c.bucket(bucket.replace("gs://", "").strip("/"))
    got = {}
    for m in months:
        blob = b.blob(f"sales/salesreport_{m}.zip")
        if blob.exists():
            got[m] = csv_of_zip(blob.download_as_bytes())[1]
        else:
            print(f"  {m}: 버킷에 아직 없음")
    return got


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", nargs="*", default=[], help="salesreport_YYYYMM.zip 또는 .csv")
    a = ap.parse_args()

    got: dict[str, bytes] = {}
    for p in a.zip:
        blob = pathlib.Path(p).expanduser().read_bytes()
        name, raw = csv_of_zip(blob) if p.endswith(".zip") else (p, blob)
        month = "".join(ch for ch in pathlib.Path(name).stem if ch.isdigit())[-6:]
        got[month] = raw
    bucket = os.environ.get("PLAY_BUCKET", "").strip()
    if bucket and not a.zip:
        now = datetime.now(KST)
        prev = (now.replace(day=1) - timedelta(days=1))
        got.update(from_bucket(bucket, [prev.strftime("%Y%m"), now.strftime("%Y%m")]))
    if not got:
        print("읽을 리포트가 없습니다 (PLAY_BUCKET 미설정, --zip 없음) — 파일을 건드리지 않습니다.")
        return 0

    doc = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"months": {}}
    changed = False
    for m, raw in sorted(got.items()):
        res = parse(m, raw)
        old = doc["months"].get(m, {})
        if {k: old.get(k) for k in res} != res:
            changed = True
        res["fetched"] = datetime.now(KST).isoformat(timespec="seconds")
        res["source"] = "bucket" if bucket and not a.zip else "upload"
        doc["months"][m] = res
        print(f"  {m}: 주문 {res['rows']}건 · 마지막 {res['last_order']} · 제외 {res['skipped'] or '없음'}")
    if not changed:
        print("바뀐 게 없습니다.")
        return 0
    # 같은 KST 날짜가 두 달 파일에 걸칠 수 있다(미국 서부 월말 ↔ KST 월초). 달 순서대로 합친다.
    merged: dict = {}
    for m in sorted(doc["months"]):
        for d, pk in doc["months"][m]["by_date"].items():
            for p, v in pk.items():
                t = merged.setdefault(d, {}).setdefault(p, {"net": {}, "gross": {}, "n": 0, "refunds": 0})
                for key in ("net", "gross"):
                    for cur, amt in v[key].items():
                        t[key][cur] = round(t[key].get(cur, 0) + amt, 2)
                t["n"] += v["n"]
                t["refunds"] += v["refunds"]
    doc["by_date"] = dict(sorted(merged.items()))
    doc["last_order"] = max((x["last_order"] for x in doc["months"].values() if x["last_order"]), default=None)
    doc["updated"] = datetime.now(KST).isoformat(timespec="seconds")
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
