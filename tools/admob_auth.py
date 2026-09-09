#!/usr/bin/env python3
"""AdMob refresh token 1회 발급 — 로컬에서 한 번만 돌리면 된다.

  python3 tools/admob_auth.py --client-id XXX.apps.googleusercontent.com --client-secret YYY

브라우저가 열리고 구글 로그인 후, 발급된 refresh token 과 퍼블리셔 ID를 출력한다.
그 둘을 GitHub 저장소 Secrets 에 넣으면 자동 수집이 돈다.

구글이 OOB(콘솔에 코드 붙여넣기) 방식을 폐지해서 로컬 루프백으로 받는다 —
그래서 OAuth 클라이언트 종류는 반드시 '데스크톱 앱'이어야 한다.
"""
import argparse
import http.server
import json
import secrets
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

PORT = 8765
REDIRECT = f"http://127.0.0.1:{PORT}/"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/admob.readonly"

got = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        got.update({k: v[0] for k, v in q.items()})
        ok = "code" in got
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        msg = "인증 완료 — 터미널로 돌아가세요." if ok else "인증 실패: " + got.get("error", "?")
        self.wfile.write(f"<meta charset=utf-8><h2>{msg}</h2>".encode("utf-8"))
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, *a):
        pass


def post(url, params):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    p = argparse.ArgumentParser(description="AdMob refresh token 발급")
    p.add_argument("--client-id", required=True)
    p.add_argument("--client-secret", required=True)
    a = p.parse_args()

    state = secrets.token_urlsafe(16)
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": a.client_id, "redirect_uri": REDIRECT, "response_type": "code",
        "scope": SCOPE, "access_type": "offline", "prompt": "consent", "state": state,
    })

    print("브라우저에서 구글 로그인 후 권한을 허용하세요.")
    print("창이 안 뜨면 이 주소를 직접 여세요:\n  " + url + "\n")
    webbrowser.open(url)

    with http.server.HTTPServer(("127.0.0.1", PORT), Handler) as srv:
        srv.serve_forever()

    if got.get("state") != state:
        print("state 불일치 — 중단합니다.", file=sys.stderr)
        return 1
    if "code" not in got:
        print("인증 코드를 못 받았습니다: " + got.get("error", "?"), file=sys.stderr)
        return 1

    tok = post(TOKEN_URL, {
        "code": got["code"], "client_id": a.client_id, "client_secret": a.client_secret,
        "redirect_uri": REDIRECT, "grant_type": "authorization_code",
    })
    refresh = tok.get("refresh_token")
    if not refresh:
        print("refresh token 이 안 왔습니다. 앱 권한을 지우고 다시 시도하세요:\n"
              "  https://myaccount.google.com/permissions", file=sys.stderr)
        return 1

    # 퍼블리셔 ID까지 여기서 뽑아준다 — 콘솔에서 따로 찾을 필요 없게
    req = urllib.request.Request("https://admob.googleapis.com/v1/accounts",
                                 headers={"Authorization": "Bearer " + tok["access_token"]})
    with urllib.request.urlopen(req, timeout=30) as r:
        accounts = json.loads(r.read().decode("utf-8")).get("account", [])
    pub = accounts[0]["name"].split("/")[-1] if accounts else "(계정 조회 실패)"

    print("\n─ GitHub 저장소 Secrets 에 아래 넷을 넣으세요 ─")
    print("  ADMOB_CLIENT_ID      =", a.client_id)
    print("  ADMOB_CLIENT_SECRET  =", a.client_secret)
    print("  ADMOB_REFRESH_TOKEN  =", refresh)
    print("  ADMOB_PUBLISHER_ID   =", pub)
    return 0


if __name__ == "__main__":
    sys.exit(main())
