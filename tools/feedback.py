#!/usr/bin/env python3
"""유저 의견 건수(전체 앱) — 각 게임 Firestore 'feedback' 컬렉션 → docs/data/feedback.json

게임은 인앱 '의견 보내기'를 Firestore REST 로 POST 한다(cloud.gd submit_feedback).
★ **건수만** 남긴다(형 지시 2026-11-09): 앱 × KST 날짜별 개수. 내용·uid·기기는 읽지도 않는다 —
쿼리가 created_unix 한 필드만 projection 으로 받는다. 이 레포와 Pages 가 공개라 그게 맞다.
내용은 Firebase 콘솔에서 본다. 대시보드는 '새 의견이 왔나'를 알려주는 자리.

증분: 앱마다 마지막으로 센 created_unix 이후만 읽는다(단일 필드 정렬이라 복합 색인 불필요).
Firestore 읽기라 BigQuery 비용과 무관하고, 무료 구간(일 5만 건) 안이다.

권한: 서비스계정에 그 프로젝트의 'Cloud Datastore 뷰어'(roles/datastore.viewer)가 있어야 한다.
BigQuery 용 키라 대개 없다 → status=no_access 로 남고 다른 앱은 계속 받는다.
"""
import json
import os
import pathlib
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


def fetch(app: dict, since: int) -> list[int]:
    info = json.loads(os.environ[app["secret"]])
    cred = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/datastore"])
    cred.refresh(Request())
    url = f"https://firestore.googleapis.com/v1/projects/{app['project']}/databases/(default)/documents:runQuery"
    body = {"structuredQuery": {
        "from": [{"collectionId": "feedback"}],
        "select": {"fields": [{"fieldPath": "created_unix"}]},   # 내용은 안 받는다
        "where": {"fieldFilter": {"field": {"fieldPath": "created_unix"}, "op": "GREATER_THAN",
                                  "value": {"integerValue": str(since)}}},
        "orderBy": [{"field": {"fieldPath": "created_unix"}, "direction": "ASCENDING"}],
        "limit": 1000}}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {cred.token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.loads(r.read().decode())
    out = []
    for x in res:
        f = (x.get("document") or {}).get("fields", {}).get("created_unix", {})
        t = int(f.get("integerValue") or f.get("doubleValue") or 0)
        if t > 0:
            out.append(t)
    return out


def main() -> int:
    apps = json.loads(APPS.read_text(encoding="utf-8"))["apps"]
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    doc = {"apps": old.get("apps", {}), "counts": old.get("counts", {})}
    new = 0
    for app in apps:
        st = doc["apps"].setdefault(app["key"], {})
        if not app.get("secret") or not os.environ.get(app["secret"], "").strip() or not app.get("project"):
            st.update(status="no_secret")
            continue
        try:
            got = fetch(app, int(st.get("last_unix", 0)))
        except urllib.error.HTTPError as e:
            st.update(status="no_access" if e.code in (401, 403) else "error",
                      msg=f"HTTP {e.code}" + (" — 서비스계정에 Cloud Datastore 뷰어 권한 필요" if e.code == 403 else ""))
            print(f"  {app['key']}: {st['msg']}")
            continue
        except Exception as e:
            st.update(status="error", msg=str(e)[:200])
            print(f"  {app['key']}: 오류 {st['msg']}")
            continue
        for t in got:
            d = datetime.fromtimestamp(t, KST).date().isoformat()
            day = doc["counts"].setdefault(d, {})
            day[app["key"]] = day.get(app["key"], 0) + 1
        if got:
            st["last_unix"] = max(got)
            st["last_at"] = datetime.fromtimestamp(max(got), KST).isoformat(timespec="minutes")
        st.update(status="ok", msg="", checked=datetime.now(KST).isoformat(timespec="minutes"))
        new += len(got)
        print(f"  {app['key']}: 새 의견 {len(got)}건")
    doc["counts"] = dict(sorted(doc["counts"].items()))
    doc["updated"] = datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"새 의견 합계 {new}건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
