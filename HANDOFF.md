# 핸드오프 — SECONDACT BOARD

최종 업데이트: 2026-11-09

터미널에서 이 리포 작업을 이어받는 사람을 위한 문서. 구조·계산규칙은 `README.md` 에 있고
여기엔 **README 에 없거나 README 가 틀린 것, 그리고 이미 결론이 난 것**만 적는다.

> ⚠ **`README.md` 는 2026-09-04 기준이라 지금과 다른 대목이 있다.** 고치지 않고 남겨뒀다.
> - "자동 수집 — 매시간" → **BigQuery 쓰는 건 전부 수동이다**(아래 참조). `sync` 만 매시간.
> - "여기 없는 것 — 설치수·DAU·CPI·LTV·코호트는 일부러 뺐다" → **지금은 다 있다.**
>   탭이 6개다: 매출 / 인게임 / 실시간 / 광고 / 국가 / 전체 가입자.

---

## 1. 지금 무엇이 어떻게 도는가

| 워크플로 | 트리거 | 하는 일 | 1회 스캔 |
|---|---|---|---|
| `ingame` | **수동만** | `tools/ingame.py` — 확정 테이블 기준 KPI·리텐션·퍼널·DAU·광고 | **18.5GB** |
| `realtime` | **수동만** | `tools/realtime.py` + `tools/iap.py` — intraday 기준 당일 유저·D1·미확정 보정 | 0.35GB |
| `users` | **수동만** | `tools/users.py`, `tools/geo_roi.py --days 60 --write` | 작음 |
| `sync` | 매시간(`7 * * * *`) + `repository_dispatch` + 수동 | `tools/sync.py` — AdMob 매출(`--days 7`) + Google Ads 마케팅비 | **0 (BigQuery 안 씀)** |
| `common` | **수동만** | `tools/common.py`(전체 앱 DAU·신규·리텐션·이벤트·버전) → `tools/gamestats.py`(게임별 맞춤 인게임) → `tools/feedback.py`(유저 의견 **건수**) → `tools/iap.py`(인생 2막 인앱 GA4 — 판매 리포트 전 오늘·어제 인앱) | 공통 ~0.7GB + 게임별 ~0.25GB |
| `probe` | 수동만 | `tools/probe.py` — 진단용. 평시엔 안 돌린다 | 모드마다 다름 |

**원칙: BigQuery 를 쓰는 워크플로는 자동 실행하지 않는다.** 2026-10-27 형 지시.
이유는 비용 부담(심리적인 것 포함)이고, `ingame` 이 1회 18.5GB 라 하루 2회만 돌려도
월 1,082GB 로 무료 구간(1,024GB)을 넘는다. `sync` 는 BigQuery 를 안 쓰므로 예외로 자동 유지.

`ingame.py` 에는 **스킵 가드**가 있다 — 확정 테이블이 지난번과 같으면 수집을 건너뛴다.
강제로 다시 받으려면 `FORCE=1` (워크플로는 `force` 입력).

### 네 워크플로는 같은 concurrency 그룹이다
`push-docs-data`. 2026-10-27 에 넷을 한 그룹으로 묶었다(`19636f0`). 그 전엔 각자 다른
그룹이어서 동시에 돌면 같은 `main` 에 푸시가 밀려 `sync` 가 3연속 재시도 끝에 죽었다.
**그룹을 다시 쪼개지 말 것.**

### 단축 명령 (형이 쓰는 말)
- **"업데이트" / "대시보드 업데이트"** → **`sync` → `common`** 두 개만(2026-11-09 부터). 통합 보드 전체가 이걸로 찬다.
  BigQuery 는 `common` 하나(전체 앱 ≈ 1.4GB). 예전 4개(ingame 18.5GB 포함)를 돌리던 것보다 10배 이상 가볍다.
- **"인생2막 상세 업데이트"** → `realtime` → `ingame` → `users` (기존 '인생 2막 상세' 탭 — 이상징후·국가 ROI·실시간 유저 목록·가입자 행).
  이 탭들은 통합 보드에 대응물이 없어서 남겨 뒀지만, 평소엔 안 돌린다(ingame 1회 18.5GB).
- **"실시간"** → `realtime`, **"지표업데이트"** → `ingame` (예전 그대로)
되묻지 말고 돌리고, **해석해서 보고까지** 한다.
⚠ **한꺼번에 던지지 말고 하나씩 끝난 뒤 다음**을 돌린다. 같은 concurrency 그룹이라
대기열에 하나만 남고 나머지는 **취소된다**(2026-11-08 실측).

```sh
run(){ gh workflow run "$@" >/dev/null && sleep 8 && id=$(gh run list -w "$1" -L1 --json databaseId -q '.[0].databaseId') && gh run watch $id --exit-status >/dev/null; echo "$1 rc=$?"; }
run sync.yml -f days=7; run common.yml                       # 업데이트
run realtime.yml; run ingame.yml; run users.yml               # 인생2막 상세 업데이트
git pull --rebase
```

---

## 2. 다시 묻지 말 것 — 이미 확증된 사실

- **확정 테이블은 하루가 끝난 뒤 26~34시간 뒤에 온다**(D+2 새벽). 실측 2026-10-08~15.
  "다음날 오후"가 아니다. 그래서 차트의 **마지막 이틀이 항상 비어 있고**, intraday 로 메운다.
- **살아 있는 `intraday_*` 테이블의 집합 = 아직 확정 안 된 날의 집합.** 모든 스트리밍 보정이
  이 사실 위에 서 있다.
- **금액은 GA4 가 맞다.** `price_micros` = ProductDetails 정가이고, 개발사 정산도 정가 기준이다.
  Play Console 화면이 더 적게 나오는 건 **구글이 부담하는 Play Points 할인** 때문이고,
  더 많게 나오는 건 세금 때문이다. **스크린샷은 금액 정정용이 아니라 '빠진 건 있나' 확인용.**
  - **0원 결제는 허위가 아니다** — 포인트 전액결제다. 지우지 말 것(2026-10-20 에 한 번 잘못 지웠다).
  - 실수령 공식: `GA4 ÷ (1+세율) × 0.85`. 수수료 15% 는 earnings CSV 에서 확인됨.
  - 미국은 표시가에 세금이 **빠져** 있어 결제 때 더 붙는다(GA4 = 정산 기준). 유럽·일본은 포함.
- **`geo.country` 가 빈 줄은 Play 사전출시 봇이다.** 모든 쿼리에 `IFNULL(geo.country,'') != ''`.
- **버전 코호트 비교는 나이와 관측창을 둘 다 맞춰야 한다.** 안 맞추면 어린 코호트가 회귀로 보인다
  (v965 "회귀"는 이 착시였고 반증됨).
  - ⚠ **`by_version.cohort_age_days` 에 알려진 편향이 있다**: 나이는 `CURRENT_TIMESTAMP` 기준
    실제 경과일인데 퍼널 집계는 **마지막 확정 테이블까지만** 센다. 확정본이 26~34시간 늦으니
    **최신 빌드는 항상 자기 나이보다 덜 익은 상태로 표시된다.** 아직 보정 안 넣었다.
- **GitHub Actions `schedule` 은 best-effort** 다. 실측으로 49시간에 11회만 실행됐다.
  "5분마다"에 기대는 설계를 하지 말 것.
- **`fx_fallback` 에 통화가 빠지면 그 나라 매출이 조용히 0 이 된다.** KRW 가 빠져서 ₩92,200 을
  0 으로 세고 있었고, 실제 earnings 리포트와 대조해서야 찾았다. 새 통화가 보이면 먼저 여기 확인.

---

## 3. 열려 있는 결정 — 형 답을 기다리는 것

1. **광고비 규모.** 2026-10-27 기준 유저당 LTV30 ≈ ₩76~108 인데 CPI ₩240~262 다.
   한 명 살 때마다 ₩140~190 씩 잃는 구조고, 10월 누적 손익 −₩765,847(9월 −₩117,509).
   줄이자고 건의했고 아직 결정 안 났다.
2. **`no_details` 결제 실패.** 1,200명 이상이 상품 목록을 못 받아 결제창을 못 본다
   (`gem_pack_1` 단독 16,145건 / 213명). **게임 쪽 수정 사항**이고 SecondActLife2 세션에
   아직 넘기지 않았다. 전송 전 형 승인 필요.
3. **Google Ads 전환 수가 GA4 신규설치 총합보다 많다.** 10/24 646 vs 467, 10/25 776 vs 444.
   유기 설치를 포함한 전체보다 유료 전환이 많은 건 불가능하다. 10/22~23 까지는 맞았다.
   광고 콘솔 전환 설정을 형이 확인해주기로 했다. **CPI 는 GA4 기준으로 쓴다**(광고 콘솔 숫자보다 나쁘다).
4. **v977 결함 여부 — 결함 아님으로 판단, 재확인 대기.** 리텐션이 두 시기 동일하고
   (D1~D5 합 9/28~10/07 97.8~136.4 vs 10/18~10/21 101.8~130.9), v971→v977 커밋에
   밸런스 변경이 0건(전부 UI 잘림·글꼴·번역·공실배지)이고, 격차가 특정 게이트의 절벽 없이
   깊이에 비례해 벌어진다. 유력 가설은 **1부 환생 게이트(순자산 ≥ 개방총가치×0.80)** 가
   저단가 유입에게 더 늦게 열리는 것. **v977 코호트가 2주쯤 익은 뒤 같은 나이로 재비교**하면
   갈린다(게이트 가설이면 격차가 줄어든다). 국가별 퍼널 쿼리(2~3GB)는 형이 안 돌려도 된다고 했다.
5. **10월 earnings 리포트.** 11월 초에 형이 보내주면 10월 매출을 실제 정산액에 고정한다.

### 보류된 것 (형이 지금은 안 한다고 한 것)
- 유로존 국가별 세율 세분화 (오차 월 ₩500 수준, `config.json` `_caveats` 에 기록)
- BigQuery 롤업 테이블 (새 `dashboard_rollup` 데이터셋에 `BigQuery Data Editor` 권한 필요)
- **전체 앱 실시간 동접 보드** — 2026-11-02 검토만 완료, 코드 미착수. 아래 참조.

---

## 4. 실시간 동접 보드 — 검토 결과 (미착수)

- **데이터 소스는 GA4 Data API `runRealtimeReport`** (메트릭 `activeUsers`, 창 = 최근 30분).
  파이어베이스 콘솔의 그 숫자와 같은 출처고 **BigQuery 를 거치지 않아 비용이 0**이다.
- 권한은 **속성마다 따로** — IAM 이 아니라 Analytics 관리 › 속성 액세스 관리에서 서비스계정
  이메일을 뷰어로 추가한다(Play API 때와 같은 함정). 키는 `~/dev/keystore/*-bq.json` 에
  앱별로 있지만 **BigQuery 용으로 만든 거라 GA4 권한이 붙어 있는지 미확인**이다(샌드박스가
  자격증명 접근을 차단해서 검증 못 했다). 붙여보면 1분에 판명된다.
- 전달 경로: **스케줄 수집 → 커밋 방식은 하지 말 것**(하루 288커밋 + cron 이 안 믿김).
  진짜 실시간은 Cloudflare Worker 같은 초소형 프록시가 정답이지만 "서버 없는 정적 사이트"
  원칙을 깨고, 공개 Pages 라 토큰/레퍼러 체크가 필요하다. **지금은 요청 시 조회해서 보고**가
  권고안이다.
- ⚠ **"최근 30분 활성 사용자"는 동접이 아니다** — 30분 안에 이벤트를 한 번이라도 보낸 사람 수고,
  방치형이라 실제 동시 접속보다 부풀려진다. "동접"이라 이름 붙이면 나중에 다른 지표와 안 맞는다.
- ⚠ 실시간 API 에서 봇 필터는 `geo.country 공백` 이 아니라 `(not set)` 으로 와서 **필터식이 다르다.**
- **지금 만들면 칸이 거의 다 0 이다.** 최근 14일 AdMob: Second Act ₩198,288 /
  Crown & Coin ₩11,556 / Plop Cat ₩5,832 / Pocket Arcade ₩1,472 / Private Camera ₩122.
  그래서 "동접 전광판"보다 **앱별 한 줄 요약(30분 활성 + 오늘 DAU + 오늘 신규)** 를 권했다.

---

## 5. 터미널 작업 시 주의

- **`docs/*.js` 나 `docs/style.css` 를 고쳤으면 커밋 전에 `python3 tools/stamp.py`.**
  안 하면 배포 후 10분간 브라우저가 옛 파일을 쓴다(README 에도 있다).
- **`git add -A` 금지** — 병렬 작업 중이면 남의 파일을 삼킨다. 파일을 지정하고 커밋 후 `--stat` 대조.
- **커밋 신원은 전역 설정을 쓴다.** `-c user.email` 로 우회하지 말 것(pre-commit 훅이 막는다).
- 로컬에서 볼 때: `cd docs && python3 -m http.server 8731`
- 데이터 상태 확인:
  ```sh
  python3 -c "import json;d=json.load(open('docs/data/ingame.json'));print(d['last_table'],d['scan_mb'])"
  ```
- `docs/data/users/` 는 날짜별 스냅샷이 쌓이는 디렉터리다(파일이 많다). `anomaly.json`,
  `geo_cost.json`, `geo_roi.json` 도 생성물이니 손으로 고치지 않는다.


---

## 6. 통합 대시보드 (2026-11-09 전환)

인생 2막 전용 보드를 **전체 앱 보드**로 바꿨다. 레포·URL 은 그대로다. 기존 6개 탭은 **'인생 2막 상세'** 안으로 옮겼다.
상단 탭: **전체 / 월별 / 앱별 / 유저 의견 / 인생 2막 상세**. 코드는 `docs/portfolio.js` 한 파일이고, 기존 스크립트와 전역 이름이 겹치지 않게 IIFE 로 감쌌다.

| 데이터 | 파일 | 수집 | 비고 |
|---|---|---|---|
| 앱 목록 | `docs/data/apps.json` | 손으로 | 순서 = 색 순서. 7번째 이후 앱은 차트에서 '기타'로 접힌다 |
| 광고매출 | `daily.json` `admob_apps` | `sync` 매시간 | AdMob 이름 → 앱은 apps.json 의 `admob` |
| 인앱매출 | `iap_sales.json` | `sync`(버킷 설정 시) 또는 `playsales.py --zip` | **Play 판매 리포트가 기준.** 세전가 × 0.85, KST 날짜 |
| 마케팅비(앱별) | `ads_apps.json` | Ads 스크립트 → `sync` | 스크립트를 다시 붙여넣기 전까지 비어 있다 → '미배정' |
| DAU·리텐션·이벤트 | `common.json` | `common` 수동 | 키 없는 앱은 '지표 미연결' |
| 게임별 인게임 | `gamestats.json` | `common` 안 | 스펙 `tools/gamespecs.json`(위젯: funnel/levels/breakdown/maxval). 인생 2막은 전용 보드라 제외 |
| 유저 의견 | `feedback.json` | `common` 안 | **앱 × 날짜 건수만**(형 지시). 내용은 Firebase 콘솔. 쿼리도 created_unix 만 받는다 |

- **인생 2막 상세의 광고매출은 이제 인생 2막 몫만** 쓴다(`app.js` `ownAppOnly`). 전에는 AdMob 계정 전체 합계라 Crown & Coin 이 섞여 있었다.
- 11/1 이후 마케팅비는 **구글 프로모션 크레딧**이다(형 확인). `config.json` `promo_credit` 에 기간이 있고, 월별 표에 '크레딧' 표시가 붙는다. 크레딧이 끝나면 `to` 에 마지막 날짜를 넣는다.
- 인앱: 판매 리포트가 덮는 기간(그 달 ∩ 마지막 주문 시각까지)은 리포트 값, 그 밖의 기간은 인생 2막 GA4/수동 값만 쓴다. 리포트가 없는 달의 다른 앱 인앱은 0 이 아니라 **'모름'**이다.

### 형이 해야 남은 것 (이게 끝나야 다 찬다)
1. **게임별 BigQuery 키를 시크릿으로 등록** — 터미널에서 직접:
   ```sh
   gh secret set GCP_SA_CROWNCOIN    < ~/dev/keystore/crowncoin-bq.json
   gh secret set GCP_SA_PLOPCAT      < ~/dev/keystore/plopcat-bq.json
   gh secret set GCP_SA_BEEARCHITECT < ~/dev/keystore/beearchitect-88dbb-bq.json
   gh secret set GCP_SA_GYROGRID     < ~/dev/keystore/gyrogrid-bq.json
   gh secret set GCP_SA_WORLDREST    < ~/dev/keystore/worldrestaurant-530d2-bq.json
   gh secret set GCP_SA_ONELINEPATH  < ~/dev/keystore/hanbutgil-bq.json
   gh workflow run common.yml -f days=120     # 처음 한 번 백필
   ```
   Pocket Arcade · FaceLapse · Private Camera 는 키가 없다(매출만 보인다).
2. **판매 리포트 자동화** — Play Console › 사용자 및 권한 에 서비스계정(`GCP_SA_KEY` 의 client_email)을 초대하고
   '재무 데이터 보기'를 준다(반영까지 최대 24시간). 그다음 `gh variable set PLAY_BUCKET -b pubsite_prod_rev_…`
   (Play Console › 다운로드 보고서 › 재무 › 'Cloud Storage URI 복사'). 그 전까진 월말에 zip 을 받아 `playsales.py --zip`.
3. **Google Ads 스크립트 다시 붙여넣기** — `tools/google-ads-script.js` 에 캠페인→앱 패키지별 비용(`appRows`)을 추가했다.
4. **유저 의견 건수 — 인생 2막·Bee Architect 만 403.** 그 두 프로젝트의 서비스계정에 'Cloud Datastore 뷰어'
   (roles/datastore.viewer)를 주면 다음 `common` 부터 잡힌다. 나머지 게임은 이미 읽힌다(2026-11-09).

### 게임별 인게임 화면 (2026-11-09)
- 엔진 하나(`gamestats.py`) + 게임별 스펙(`gamespecs.json`). 스펙의 이벤트·파라미터는 각 게임 레포의
  `scripts/**/analytics.gd`·`docs/ANALYTICS.md` 에서 확인한 값이다. **게임이 이벤트 이름을 바꾸면 화면이 조용히 0 이 된다** — 스펙도 같이 고칠 것.
- 파라미터 타입 함정: 왕관과 금화·퐁당냥은 bool 이 문자열 "true"/"false", Bee Architect·신규 3종은 int 0/1. 엔진은 모든 값을 문자열로 비교하므로 스펙의 value 는 `"1"`·`"true"` 처럼 쓴다.
- '레벨별 진행'의 벽 = (L1·L2 제외) 클리어율 90% 미만 하위 셋 ∪ 1인당 실패 상위 셋. 퐁당냥·Bee Architect 는 level_start/clear 가 계정당 첫 1회라 클리어율보다 실패/인이 막힘을 더 잘 드러낸다.
- World Restaurant Tour 는 레벨이 나라×스테이지라 levels 위젯 대신 온보딩 마일스톤(누적 클리어 수)으로 본다.
- Bee Architect·GYROGRID·World Restaurant Tour·OneLine Path 는 **스트리밍 내보내기만** 켜져 있다(확정 테이블 없음). 지표엔 지장 없고 차트가 '확정 전' 색으로 나온다.
