#!/usr/bin/env python3
"""index.html 의 app.js / style.css 참조에 내용 해시를 박는다.

GitHub Pages는 정적 파일에 max-age=600을 걸어서, 배포 직후 10분 동안 브라우저가
옛날 app.js를 계속 쓴다(=고친 게 반영 안 된 것처럼 보인다). 파일이 바뀌면 URL도
바뀌게 만들어 그 창을 없앤다. 커밋 전에 돌리면 된다.
"""
import hashlib
import pathlib
import re
import sys

DOCS = pathlib.Path(__file__).resolve().parent.parent / "docs"
INDEX = DOCS / "index.html"
ASSETS = ["app.js", "style.css"]


def main() -> int:
    html = INDEX.read_text(encoding="utf-8")
    before = html
    for name in ASSETS:
        h = hashlib.md5((DOCS / name).read_bytes()).hexdigest()[:8]
        # name 또는 name?v=... 를 name?v=<hash> 로
        html = re.sub(rf'({re.escape(name)})(\?v=[0-9a-f]+)?(["\'])',
                      rf'\g<1>?v={h}\g<3>', html)
        print(f"{name} → ?v={h}")
    if html != before:
        INDEX.write_text(html, encoding="utf-8")
        print("index.html 갱신됨")
    else:
        print("변경 없음")
    return 0


if __name__ == "__main__":
    sys.exit(main())
