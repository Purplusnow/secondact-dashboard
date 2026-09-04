#!/usr/bin/env python3
"""하루치 기록을 docs/data/daily.json 에 넣는다 (같은 날짜가 있으면 그 항목만 덮어씀).

플래그는 config.json 의 series 에서 그대로 만들어진다. 계열을 추가하면 여기 손댈 필요 없다.

    # 전부 원화
    python3 tools/add.py 2026-09-04 --admob 4200 --iap 11000 --ads 30000

    # 구글플레이에 찍힌 통화 그대로 (환산은 대시보드가 그날 환율로 한다)
    python3 tools/add.py 2026-09-04 --iap KRW:11000 USD:8.97 JPY:600 --ads 30000

날짜를 빼면 오늘(KST). --show 로 최근 기록만 볼 수도 있다.
"""
import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "docs" / "data" / "config.json"
DAILY = ROOT / "docs" / "data" / "daily.json"
KST = timezone(timedelta(hours=9))

today = lambda: datetime.now(KST).strftime("%Y-%m-%d")
load = lambda p: json.loads(p.read_text(encoding="utf-8"))


def parse_amount(tokens: list[str], flag: str):
    """'11000' → 11000 (원) / 'USD:8.97 JPY:600' → {'USD': 8.97, 'JPY': 600}"""
    if len(tokens) == 1 and ":" not in tokens[0]:
        return to_num(tokens[0], flag)

    out: dict[str, float] = {}
    for tok in tokens:
        if ":" not in tok:
            raise SystemExit(f"{flag}: '{tok}' 는 통화 형식이 아닙니다 (예: USD:8.97)")
        cur, _, amt = tok.partition(":")
        cur = cur.strip().upper()
        if not cur.isalpha() or len(cur) != 3:
            raise SystemExit(f"{flag}: '{cur}' 는 3글자 통화코드가 아닙니다")
        out[cur] = out.get(cur, 0) + to_num(amt, flag)
    return out


def to_num(s: str, flag: str):
    try:
        v = float(s.replace(",", "").replace("원", ""))
    except ValueError:
        raise SystemExit(f"{flag}: '{s}' 는 숫자가 아닙니다")
    return int(v) if v == int(v) else round(v, 2)


def krw_of(value, fx: dict) -> float:
    """미리보기용 대략 환산. 화면은 그날 ECB 환율을 쓰므로 여기 값과 조금 다를 수 있다."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return sum(amt * (1.0 if cur == "KRW" else fx.get(cur, 0)) for cur, amt in value.items())


def main() -> int:
    cfg = load(CONFIG)
    series = cfg.get("series", [])
    fee = cfg.get("store_fee", 0.15)
    fee_keys = set(cfg.get("fee_applies_to", []))
    fx = cfg.get("fx_fallback", {})

    p = argparse.ArgumentParser(
        description="하루치 광고매출/인앱매출/마케팅비 기록",
        epilog="금액은 '30000' 또는 'USD:8.97 JPY:600' 형태 둘 다 됩니다.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("date", nargs="?", default=None, help="YYYY-MM-DD (기본: 오늘 KST)")
    for s in series:
        p.add_argument(f"--{s['key'].replace('_', '-')}", nargs="+", metavar="금액",
                       help=s.get("label", s["key"]))
    p.add_argument("--note", help="메모")
    p.add_argument("--show", type=int, nargs="?", const=14, metavar="N",
                   help="최근 N일 기록만 출력하고 종료")
    a = p.parse_args()

    data = load(DAILY)
    rows = data.setdefault("daily", [])

    if a.show is not None:
        for r in rows[-a.show:]:
            print(json.dumps(r, ensure_ascii=False))
        print(f"— 총 {len(rows)}일치 기록됨", file=sys.stderr)
        return 0

    date = a.date or today()
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        print(f"날짜 형식이 아닙니다: {date} (YYYY-MM-DD)", file=sys.stderr)
        return 1

    given = {}
    for s in series:
        tokens = getattr(a, s["key"], None)
        if tokens:
            given[s["key"]] = parse_amount(tokens, "--" + s["key"])

    if not given and a.note is None:
        print("넣을 값이 하나도 없습니다. --help 로 플래그를 확인하세요.", file=sys.stderr)
        return 1

    row = next((r for r in rows if r.get("date") == date), None)
    verb = "갱신"
    if row is None:
        row, verb = {"date": date}, "추가"
        rows.append(row)

    row.update(given)
    if a.note is not None:
        row["note"] = a.note

    rows.sort(key=lambda r: r["date"])
    data["updated"] = today()
    DAILY.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    rev = spend = 0.0
    for s in series:
        v = krw_of(row.get(s["key"]), fx)
        if s["key"] in fee_keys:
            v *= 1 - fee
        if s.get("type") == "spend":
            spend += v
        else:
            rev += v

    print(f"{date} {verb} — 매출 {rev:,.0f}원 / 마케팅비 {spend:,.0f}원 / 손익 {rev - spend:,.0f}원"
          f"   (고정환율 기준 어림값)")
    print(json.dumps(row, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
