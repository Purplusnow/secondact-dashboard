#!/usr/bin/env python3
"""유저 의견(전체 앱) — 각 게임 Firestore 'feedback' 컬렉션 → docs/data/feedback.json

게임은 인앱 '의견 보내기'를 Firestore REST 로 POST 한다(cloud.gd submit_feedback).
공통 필드: text · created_unix · created_at · version · locale(또는 lang) · uid · device …

★ 이 레포와 Pages 는 **공개**다. 그래서 화면에 필요한 것만 남긴다:
  날짜(KST) · 앱 · 내용 · 버전 · 언어. uid·기기·게임 상태 값은 받지도 저장하지도 않는다.
  내용 속 이메일·전화번호·긴 숫자열은 가린다(유저가 연락처를 적는 일이 실제로 흔하다).
워크플로에서는 vars.FEEDBACK_ON == '1' 일 때만 돈다 — 공개를 확인한 뒤 켠다.

증분: 앱마다 마지막으로 받은 created_unix 이후만 읽는다(runQuery, 단일 필드 정렬이라
복합 색인 불필요). Firestore 읽기 무료 구간(일 5만)과 비교하면 무시할 양이다. BigQuery 아님.

권한: 서비스계정에 그 프로젝트의 'Cloud Datastore 뷰어'(roles/datastore.viewer)가 있어야 한다.
BigQuery 용으로 만든 키라 대개 없다 → status=no_access 로 남고 다른 앱은 계속 받는다.
"""
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from google.auth.transport.requests import Request
from google.oauth2 import service_account

ROOT = pathlib.Path(__file__).resolve().parent.parent
APPS = ROOT / "docs" / "data" / "apps.json"
OUT = ROOT / "docs" / "data" / "feedback.json"
KST = timezone(timedelta(hours=9))
KEEP = 600          # 파일에 남길 최근 의견 수
TEXT_CAP = 1000

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
PHONE = re.compile(r"(?<!\w)\+?\d[\d\s()-]{7,}\d(?!\w)")   # 점(.)은 날짜(2026.11.08)라 뺀다


def mask(t: str) -> str:
    t = EMAIL.sub("[이메일]", t)
    t = PHONE.sub("[번호]", t)
    return t[:TEXT_CAP]


def val(f: dict | None):
    if not f:
        return None
    for k in ("stringValue", "integerValue", "doubleValue", "booleanValue", "timestampValue"):
        if k in f:
            return f[k]
    return None


def fetch(app: dict, since: int) -> list[dict]:
    raw = os.environ.get(app["secret"], "").strip()
    info = json.loads(raw)
    cred = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/datastore"])
    cred.refresh(Request())
    url = f"https://firestore.googleapis.com/v1/projects/{app['project']}/databases/(default)/documents:runQuery"
    body = {"structuredQuery": {
        "from": [{"collectionId": "feedback"}],
        "where": {"fieldFilter": {"field": {"fieldPath": "created_unix"}, "op": "GREATER_THAN",
                                  "value": {"integerValue": str(since)}}},
        "orderBy": [{"field": {"fieldPath": "created_unix"}, "direction": "ASCENDING"}],
        "limit": 500}}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {cred.token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.loads(r.read().decode())
    out = []
    for x in res:
        doc = x.get("document")
        if not doc:
            continue
        f = doc.get("fields", {})
        ts = int(val(f.get("created_unix")) or 0)
        text = (val(f.get("text")) or "").strip()
        if not ts or not text:
            continue
        out.append({
            "app": app["key"],
            "id": doc["name"].rsplit("/", 1)[-1][:8],
            "ts": ts,
            "at": datetime.fromtimestamp(ts, KST).isoformat(timespec="minutes"),
            "text": mask(text),
            "version": str(val(f.get("version")) or ""),
            "locale": str(val(f.get("locale")) or val(f.get("lang")) or ""),
        })
    return out


def main() -> int:
    apps = json.loads(APPS.read_text(encoding="utf-8"))["apps"]
    doc = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"apps": {}, "items": []}
    seen = {(i["app"], i["id"], i["ts"]) for i in doc["items"]}
    new = 0
    for app in apps:
        st = doc["apps"].setdefault(app["key"], {})
        if not app.get("secret") or not os.environ.get(app["secret"], "").strip() or not app.get("project"):
            st.update(status="no_secret")
            continue
        try:
            got = fetch(app, int(st.get("last_unix", 0)))
        except urllib.error.HTTPError as e:
            code = e.code
            st.update(status="no_access" if code in (401, 403) else "error",
                      msg=f"HTTP {code}" + (" — 서비스계정에 Cloud Datastore 뷰어 권한 필요" if code == 403 else ""))
            print(f"  {app['key']}: {st['msg']}")
            continue
        except Exception as e:
            st.update(status="error", msg=str(e)[:200])
            print(f"  {app['key']}: 오류 {st['msg']}")
            continue
        fresh = [g for g in got if (g["app"], g["id"], g["ts"]) not in seen]
        doc["items"].extend(fresh)
        new += len(fresh)
        if got:
            st["last_unix"] = max(g["ts"] for g in got)
        st.update(status="ok", msg="", checked=datetime.now(KST).isoformat(timespec="minutes"))
        st["total"] = st.get("total", 0) + len(fresh)
        print(f"  {app['key']}: 새 의견 {len(fresh)}건")
    doc["items"] = sorted(doc["items"], key=lambda i: -i["ts"])[:KEEP]
    doc["updated"] = datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"새 의견 합계 {new}건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
