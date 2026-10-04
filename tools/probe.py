#!/usr/bin/env python3
"""유저 한 명의 이벤트 로그를 들여다본다 — 진단 전용, 파일로 남기지 않는다.

목록에서 이상한 줄을 하나 집었을 때 "무슨 짓을 한 건가"를 보려고 쓴다.
출력은 Actions 로그로만 간다(공개 리포라 원본 식별자·IP·기기정보는 찍지 않는다).

  python3 probe.py --tag 8bc9b8 [--day 20260927] [--limit 400]

--day 를 주면 그 하루만 스캔한다(수십 MB). 안 주면 전 기간을 훑는다(1.5GB).
tag 는 화면에 보이는 6자 해시 — SUBSTR(TO_HEX(MD5(user_pseudo_id)),1,6) 이라
BigQuery 에서 같은 식으로 맞춰 찾는다.
"""
import argparse
import os
import sys

import realtime as rt

# 눈여겨볼 파라미터만 꺼낸다. 전부 펼치면 줄이 길어져서 흐름이 안 보인다.
KEYS = ["step", "step_idx", "pct", "deci", "level", "rebirth", "class", "stage",
        "kind", "granted", "order_id",   # purchase_anomaly 진단용
        "value", "currency", "product_id", "gems", "reason", "balance", "cost",
        "placement", "result", "secs_since_install", "session", "world", "nw_band",
        "overtake_pct", "beat", "beat_total", "engagement_time_msec"]


def scan(day: str | None) -> int:
    """시계 조작 탐지 — secs_since_install 이 벽시계보다 빨리 흐른 유저를 찾는다.

    게임은 이벤트마다 secs_since_install(기기 시계로 잰 설치 후 경과)을 같이 보낸다.
    GA4 의 event_timestamp 는 업로드 때 서버 기준으로 보정된다. 정상 플레이면 두 값의
    증가폭이 같다(실측: 8bc9b8 은 7.03시간 대 7.02시간으로 일치).

    기기 시계를 앞으로 돌리면 secs_since_install 만 뛴다. 방치보상이 '비운 시간'으로
    계산되므로 그게 그대로 돈이 된다 — save_system.gd 는 온라인일 때만 서버 시각으로
    캡을 걸고, 비행기모드면 무캡으로 지급한다(의도된 fail-open).

    드리프트 = secs 증가폭 − 벽시계 증가폭. 양수로 크면 시계를 앞당긴 것이다.
    """
    where = (f"_TABLE_SUFFIX = '{day}'" if day else "_TABLE_SUFFIX NOT LIKE 'intraday%'")
    rows = rt.q(f"""
      WITH e AS (
        SELECT user_pseudo_id AS uid, event_timestamp AS ts,
          (SELECT value.int_value FROM UNNEST(event_params)
           WHERE key='secs_since_install') AS secs
        FROM {rt.TABLE}
        WHERE {where}
          AND (SELECT value.int_value FROM UNNEST(event_params)
               WHERE key='secs_since_install') IS NOT NULL
      )
      SELECT SUBSTR(TO_HEX(MD5(uid)), 1, 6) AS tag,
        COUNT(*) AS n,
        (MAX(secs) - MIN(secs)) AS secs_span,
        CAST((MAX(ts) - MIN(ts)) / 1000000 AS INT64) AS wall_span,
        (MAX(secs) - MIN(secs)) - CAST((MAX(ts) - MIN(ts)) / 1000000 AS INT64) AS drift,
        FORMAT_TIMESTAMP('%m-%d %H:%M', TIMESTAMP_MICROS(MIN(ts)), 'Asia/Seoul') AS first_at,
        FORMAT_TIMESTAMP('%m-%d %H:%M', TIMESTAMP_MICROS(MAX(ts)), 'Asia/Seoul') AS last_at
      FROM e
      GROUP BY uid
      HAVING n >= 5 AND drift > 3600
      ORDER BY drift DESC
      LIMIT 60
    """)
    if not rows:
        print("시계가 앞당겨진 유저를 찾지 못했습니다(드리프트 1시간 초과 없음).")
        return 0
    print(f"=== 시계 드리프트 1시간 초과: {len(rows)}명 ===")
    print(f"{'유저':<9}{'드리프트':>12}{'기기경과':>11}{'실경과':>10}{'건수':>6}  구간")
    for r in rows:
        d, se, wa = int(r["drift"]), int(r["secs_span"]), int(r["wall_span"])
        print(f"{r['tag']:<9}{d/3600:>10.1f}h{se/3600:>10.1f}h{wa/3600:>9.1f}h"
              f"{r['n']:>6}  {r['first_at']} ~ {r['last_at']}")
    return 0


def fake(day: str | None) -> int:
    """결제 위조 사유별 분해 — 고치기 전에 '정상 결제가 섞여 있나'를 봐야 한다.

    reason 세 갈래의 성격이 다르다:
      bad_orderid  주문ID 형식 불일치/누락 — 위조 정황이지만, 빌링 라이브러리가 orderId 를
                   늦게 주거나 복구(restore) 경로에선 비어 올 수도 있어 정상 섞임 가능.
      dup_orderid  주문ID 재사용 — 리플레이. 정상 결제에서는 나올 수 없다.
      no_price     ProductDetails 미로드 — **정상 결제에서도 난다.** 네트워크가 느리거나
                   가격 조회가 안 끝난 상태에서 결제가 완료되면 여기로 떨어진다. 차단하면 안 된다.
    """
    where = (f"_TABLE_SUFFIX = '{day}'" if day else "_TABLE_SUFFIX NOT LIKE 'intraday%'")
    g = ("(SELECT COALESCE(value.string_value, CAST(value.int_value AS STRING))"
         " FROM UNNEST(event_params) WHERE key='granted')")
    r = "(SELECT value.string_value FROM UNNEST(event_params) WHERE key='reason')"
    pid = "(SELECT value.string_value FROM UNNEST(event_params) WHERE key='product_id')"
    rows = rt.q(f"""
      SELECT {r} AS reason, {g} AS granted,
             COUNT(*) AS n, COUNT(DISTINCT user_pseudo_id) AS users,
             COUNT(DISTINCT {pid}) AS products
      FROM {rt.TABLE} WHERE {where} AND event_name='purchase_anomaly'
      GROUP BY reason, granted ORDER BY n DESC
    """)
    print("=== purchase_anomaly 사유별 ===")
    print(f"{'사유':<14}{'지급':>6}{'건수':>8}{'유저':>7}{'상품종류':>9}")
    for x in rows:
        print(f"{str(x['reason']):<14}{str(x['granted']):>6}{x['n']:>8}{x['users']:>7}{x['products']:>9}")

    # 정상 purchase 와 비교 — 위조가 전체 결제에서 차지하는 비중
    tot = rt.q(f"""
      SELECT COUNTIF(event_name='purchase') AS ok,
             COUNTIF(event_name='purchase_anomaly') AS bad,
             COUNT(DISTINCT IF(event_name='purchase', user_pseudo_id, NULL)) AS ok_users
      FROM {rt.TABLE} WHERE {where}
    """)[0]
    print(f"\n정상 purchase {tot['ok']}건({tot['ok_users']}명) · 위조 {tot['bad']}건")

    # 버전별 — 특정 빌드가 구멍을 냈는지, 아니면 변조 APK 라 버전과 무관한지 가른다.
    # 버전마다 유저 수가 다르므로 비율로 봐야 한다(v823 이 제일 크다고 제일 나쁜 게 아니다).
    byver = rt.q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid,
          ARRAY_AGG(app_info.version IGNORE NULLS ORDER BY event_timestamp)[SAFE_OFFSET(0)] AS ver,
          COUNTIF(event_name='purchase_anomaly') AS bad,
          COUNTIF(event_name='purchase') AS ok
        FROM {rt.TABLE} WHERE {where} GROUP BY uid
      )
      SELECT ver, COUNT(*) AS users,
             COUNTIF(bad > 0) AS bad_users, SUM(bad) AS bad_events,
             COUNTIF(ok > 0) AS ok_users, SUM(ok) AS ok_events
      FROM u WHERE ver IS NOT NULL
      GROUP BY ver HAVING users >= 30
      ORDER BY ver DESC
    """)
    print(f"\n=== 버전별(첫 등장 버전 코호트, 30명 이상) ===")
    print(f"{'버전':<14}{'유저':>7}{'위조유저':>9}{'비율':>8}{'위조건수':>9}{'정상결제':>9}")
    for x in byver:
        rate = 100 * x["bad_users"] / x["users"] if x["users"] else 0
        print(f"{str(x['ver']).replace('1.0 (','').replace(')',''):<14}"
              f"{x['users']:>7}{x['bad_users']:>9}{rate:>7.2f}%{x['bad_events']:>9}{x['ok_events']:>9}")

    # 위조 유저가 '돈 낼 사람이었나' — 피해 추정의 핵심.
    # 막혔다면 샀을까? 위조와 정상결제를 모두 한 사람이 있으면 '낼 의사는 있던 사람'이고,
    # 겹침이 0 이면 치터는 애초에 안 사는 집단이라 직접 매출 손실은 0 에 가깝다.
    ov = rt.q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid,
          COUNTIF(event_name='purchase_anomaly') AS bad,
          COUNTIF(event_name='purchase') AS ok,
          COUNTIF(event_name='ad_impression') AS ads
        FROM {rt.TABLE} WHERE {where} GROUP BY uid
      )
      SELECT
        COUNTIF(bad > 0) AS fake_users,
        COUNTIF(ok > 0) AS pay_users,
        COUNTIF(bad > 0 AND ok > 0) AS both,
        ROUND(AVG(IF(bad > 0, ads, NULL)), 1) AS ads_fake,
        ROUND(AVG(IF(bad = 0 AND ok > 0, ads, NULL)), 1) AS ads_payer,
        ROUND(AVG(IF(bad = 0 AND ok = 0, ads, NULL)), 1) AS ads_plain
      FROM u
    """)[0]
    # ⚠ '결제 이력이 없으니 손실 아님'은 반사실을 잘못 잡은 것이다. 비교해야 할 건
    #   "그 상품을 샀겠나"가 아니라 "조작 안 했으면 평범한 유저였을 텐데 그 가치는 얼마인가"다.
    #   그래서 위조 유저의 결제율·체류·접속일을 **일반 유저와 나란히** 둔다.
    ltv = rt.q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid,
          COUNTIF(event_name='purchase_anomaly') AS bad,
          COUNTIF(event_name='purchase') AS ok,
          COUNTIF(event_name='ad_impression') AS ads,
          COUNT(DISTINCT event_date) AS days,
          SUM((SELECT value.int_value FROM UNNEST(event_params)
               WHERE key='engagement_time_msec')) AS eng
        FROM {rt.TABLE} WHERE {where} GROUP BY uid
      )
      SELECT CASE WHEN bad > 0 THEN '위조' ELSE '일반' END AS seg,
             COUNT(*) AS users, COUNTIF(ok > 0) AS payers,
             ROUND(AVG(ads), 1) AS ads, ROUND(AVG(days), 1) AS days,
             ROUND(AVG(eng) / 60000.0, 1) AS mins
      FROM u GROUP BY seg ORDER BY seg
    """)
    print(f"\n=== 위조 유저 vs 일반 유저 (반사실 비교) ===")
    print(f"{'':<6}{'유저':>7}{'결제자':>7}{'결제율':>8}{'광고':>7}{'접속일':>7}{'체류':>8}")
    for x in ltv:
        n, pay = int(x["users"]), int(x["payers"])
        print(f"{x['seg']:<6}{n:>7}{pay:>7}{(100*pay/n if n else 0):>7.2f}%"
              f"{x['ads']:>7}{x['days']:>7}{x['mins']:>7}분")

    print(f"\n=== 위조 유저는 '돈 낼 사람'이었나 ===")
    print(f"  위조 유저 {ov['fake_users']}명 · 정상 결제자 {ov['pay_users']}명 · "
          f"**둘 다 한 사람 {ov['both']}명**")
    print(f"  광고 시청 평균 — 위조 {ov['ads_fake']}회 · 결제자 {ov['ads_payer']}회 · 일반 {ov['ads_plain']}회")

    # no_price 와 bad_orderid 의 교집합 — 같은 변조군인지, 다른 성격인지 가른다.
    # 겹치면 같은 집단, 안 겹치면 no_price 는 '가격 조회 전에 콜백이 온 정상 케이스'일 가능성이 크다.
    ix = rt.q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid,
          COUNTIF(event_name='purchase_anomaly' AND {r} = 'bad_orderid') AS bo,
          COUNTIF(event_name='purchase_anomaly' AND {r} = 'no_price') AS np
        FROM {rt.TABLE} WHERE {where} GROUP BY uid
      )
      SELECT COUNTIF(bo > 0 AND np = 0) AS only_bo,
             COUNTIF(np > 0 AND bo = 0) AS only_np,
             COUNTIF(bo > 0 AND np > 0) AS both
      FROM u
    """)[0]
    print(f"\n=== no_price 와 bad_orderid 의 관계 ===")
    print(f"  bad_orderid 만 {ix['only_bo']}명 · no_price 만 {ix['only_np']}명 · 둘 다 {ix['both']}명")

    # 2부(도시) 도달 코호트 안의 위조 비율 — 전체 비율과 비교해야 '과대표집'이 보인다.
    # 엔드게임은 모수가 작아서 0.76% 가 두 자릿수 %가 될 수 있다.
    city = rt.q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid,
          COUNTIF(event_name='purchase_anomaly') AS bad,
          COUNTIF(STARTS_WITH(event_name, 'city_')) AS city_ev,
          MAX(IF(event_name='progress_pct',
                 (SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct'), 0)) AS mp
        FROM {rt.TABLE} WHERE {where} GROUP BY uid
      )
      SELECT 'ALL' AS seg, COUNT(*) AS users, COUNTIF(bad > 0) AS fake FROM u
      UNION ALL SELECT '추월 50%+', COUNTIF(mp >= 50), COUNTIF(mp >= 50 AND bad > 0) FROM u
      UNION ALL SELECT '추월 90%+', COUNTIF(mp >= 90), COUNTIF(mp >= 90 AND bad > 0) FROM u
      UNION ALL SELECT '추월 100%', COUNTIF(mp >= 100), COUNTIF(mp >= 100 AND bad > 0) FROM u
      UNION ALL SELECT '2부 진입', COUNTIF(city_ev > 0), COUNTIF(city_ev > 0 AND bad > 0) FROM u
    """)
    print(f"\n=== 구간별 위조 유저 비율 (과대표집 확인) ===")
    print(f"{'구간':<12}{'유저':>8}{'위조':>7}{'비율':>8}")
    for x in city:
        n, f = int(x["users"] or 0), int(x["fake"] or 0)
        print(f"{x['seg']:<12}{n:>8}{f:>7}{(100*f/n if n else 0):>7.1f}%")

    # 유저당 건수 분포 — 1~2건은 사고일 수 있고 수백 건은 변명의 여지가 없다
    dist = rt.q(f"""
      SELECT CASE WHEN n = 1 THEN '1건' WHEN n <= 3 THEN '2~3건'
                  WHEN n <= 10 THEN '4~10건' WHEN n <= 50 THEN '11~50건'
                  ELSE '51건+' END AS band, COUNT(*) AS users, SUM(n) AS events
      FROM (SELECT user_pseudo_id, COUNT(*) AS n FROM {rt.TABLE}
            WHERE {where} AND event_name='purchase_anomaly' GROUP BY user_pseudo_id)
      GROUP BY band ORDER BY users DESC
    """)
    print(f"\n{'유저당 건수':<12}{'유저':>7}{'건수합':>9}")
    for x in dist:
        print(f"{x['band']:<12}{x['users']:>7}{x['events']:>9}")
    return 0


def city(day: str | None) -> int:
    """2부 진입 자격자 수 — 관문이 실제로 몇 명에게 열려 있나.

    main.gd _maybe_begin_city_transition 의 조건은 둘 다다:
      · discovered_count() >= properties.size()   (도감 100%)
      · world_stage >= WORLD_ENDING               (최종 환생 = 추월 100%)
    그리고 rebirth_done 때만 판정하므로, 둘을 채운 상태로 '환생을 한 번 더' 해야 열린다.

    ⚠ 도감은 codex_open(유저가 도감 화면을 연 순간)으로만 관측된다. 100% 를 채웠지만
      화면을 안 연 사람은 안 잡히므로 **아래 숫자는 하한**이다.
    """
    where = (f"_TABLE_SUFFIX = '{day}'" if day else "_TABLE_SUFFIX NOT LIKE 'intraday%'")
    cp = "(SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct')"
    pp = "(SELECT value.int_value FROM UNNEST(event_params) WHERE key='pct')"
    wd = "(SELECT value.int_value FROM UNNEST(event_params) WHERE key='world')"
    rows = rt.q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid,
          MAX(IF(event_name='codex_open', {cp}, 0)) AS codex,
          MAX(IF(event_name='progress_pct', {pp}, 0)) AS pct,
          MAX(IF(event_name='prog_rebirth', {wd}, 0)) AS world,
          COUNTIF(event_name='codex_open') AS codex_opens,
          COUNTIF(STARTS_WITH(event_name, 'city_')) AS city_ev,
          MAX(event_date) AS last_day
        FROM {rt.TABLE} WHERE {where} GROUP BY uid
      )
      SELECT
        COUNT(*) AS all_users,
        COUNTIF(codex_opens > 0) AS opened_codex,
        COUNTIF(codex >= 100) AS codex100,
        COUNTIF(pct >= 100) AS pct100,
        COUNTIF(codex >= 100 AND pct >= 100) AS both,
        COUNTIF(codex >= 100 AND pct >= 100
                AND last_day >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 30 DAY))) AS both_30d,
        COUNTIF(city_ev > 0) AS entered,
        MAX(world) AS max_world
      FROM u
    """)[0]
    print("=== 2부 진입 자격자 ===")
    print(f"  전체 {rows['all_users']}명 · 도감을 한 번이라도 연 사람 {rows['opened_codex']}명")
    print(f"  도감 100%  {rows['codex100']}명   (열어본 사람 기준 — 하한)")
    print(f"  추월 100%  {rows['pct100']}명")
    print(f"  **둘 다 = 자격자 {rows['both']}명** · 그중 최근 30일 활성 {rows['both_30d']}명")
    print(f"  실제 2부 진입 {rows['entered']}명 · 관측된 최대 world_stage {rows['max_world']}")

    # 자격자가 실제로 v965 를 받았나 — '잠긴 게 아니라 아직 업데이트 전'인지 가른다.
    # 버전은 intraday 까지 포함해 '마지막으로 본 버전'으로 잡는다(오늘 업데이트분을 놓치지 않게).
    ver = rt.q(f"""
      WITH q AS (
        SELECT user_pseudo_id AS uid
        FROM {rt.TABLE} WHERE {where}
        GROUP BY uid
        HAVING MAX(IF(event_name='codex_open', {cp}, 0)) >= 100
           AND MAX(IF(event_name='progress_pct', {pp}, 0)) >= 100
      ),
      v AS (
        SELECT user_pseudo_id AS uid,
          ARRAY_AGG(app_info.version IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS ver,
          MAX(event_timestamp) AS last_ts,
          COUNTIF(STARTS_WITH(event_name, 'city_')) AS city_ev
        FROM {rt.TABLE} GROUP BY uid
      )
      SELECT IFNULL(v.ver, '(미상)') AS ver, COUNT(*) AS n, COUNTIF(v.city_ev > 0) AS entered,
             FORMAT_TIMESTAMP('%m-%d %H:%M', TIMESTAMP_MICROS(MAX(v.last_ts)), 'Asia/Seoul') AS last_seen
      FROM q JOIN v USING (uid)
      GROUP BY ver ORDER BY n DESC
    """)
    print("\n=== 자격자 63명이 어느 빌드를 쓰고 있나 (마지막으로 본 버전) ===")
    print(f"{'버전':<14}{'자격자':>7}{'2부진입':>8}  마지막 활동")
    for x in ver:
        print(f"{str(x['ver']).replace('1.0 (','').replace(')',''):<14}{x['n']:>7}{x['entered']:>8}  {x['last_seen']}")

    # 배포 진척도 — 오늘 활성 유저 중 v965 비율
    roll = rt.q(f"""
      WITH v AS (
        SELECT user_pseudo_id AS uid,
          ARRAY_AGG(app_info.version IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS ver
        FROM {rt.TABLE} WHERE _TABLE_SUFFIX LIKE 'intraday%' GROUP BY uid
      )
      SELECT IFNULL(ver, '(미상)') AS ver, COUNT(*) AS n FROM v GROUP BY ver ORDER BY n DESC LIMIT 6
    """)
    tot = sum(int(x["n"]) for x in roll)
    print(f"\n=== 배포 진척도 — 오늘 활성 유저 {tot}명의 버전 ===")
    for x in roll:
        print(f"  {str(x['ver']).replace('1.0 (','').replace(')',''):<10}{x['n']:>6}명  {100*int(x['n'])/tot:>5.1f}%")

    print("\n=== 도감 최고 달성률 분포 (연 적 있는 사람만) ===")
    dist = rt.q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid, MAX({cp}) AS codex
        FROM {rt.TABLE} WHERE {where} AND event_name='codex_open' GROUP BY uid
      )
      SELECT CASE WHEN codex >= 100 THEN '100%' WHEN codex >= 90 THEN '90~99%'
                  WHEN codex >= 70 THEN '70~89%' WHEN codex >= 50 THEN '50~69%'
                  WHEN codex >= 25 THEN '25~49%' ELSE '~24%' END AS band,
             COUNT(*) AS users
      FROM u GROUP BY band ORDER BY users DESC
    """)
    for x in dist:
        print(f"  {x['band']:<8}{x['users']:>6}명")

    print("\n=== 추월% 구간 통과 ===")
    surv = rt.q(f"""
      WITH u AS (
        SELECT user_pseudo_id AS uid, MAX({pp}) AS pct
        FROM {rt.TABLE} WHERE {where} AND event_name='progress_pct' GROUP BY uid
      )
      SELECT COUNTIF(pct >= 50) AS p50, COUNTIF(pct >= 80) AS p80,
             COUNTIF(pct >= 90) AS p90, COUNTIF(pct >= 95) AS p95,
             COUNTIF(pct >= 100) AS p100 FROM u
    """)[0]
    prev, out = None, []
    for k, lab in [("p50", "50%+"), ("p80", "80%+"), ("p90", "90%+"), ("p95", "95%+"), ("p100", "100%")]:
        n = int(surv[k])
        rate = f"  (직전 대비 {100*n/prev:.0f}%)" if prev else ""
        out.append(f"  {lab:<6}{n:>5}명{rate}")
        prev = n
    print("\n".join(out))
    return 0


def vercmp(day: str | None) -> int:
    """버전 코호트 비교 — **설치 후 경과시간을 맞춰서** 본다.

    24시간 창이나 누적 도달률로 버전을 비교하면 새 빌드가 항상 나빠 보인다(코호트가 어리니까).
    여기서는 onb_step 에 실려 오는 secs_since_install 로 '설치 후 N시간 안에 그 단계를 밟았나'를
    재므로 나이 차가 사라진다. 분모는 각 버전의 new_game(그 빌드로 새로 시작한 사람)이다.

    ⚠ first_donate 는 v965 부터 앞에 방치 게이트가 붙었다 — 설계상 당일 수치가 낮아야 맞다.
      '나빠졌다'로 읽으면 안 되는 칸이라 표에서 따로 표시한다.
    """
    # intraday 까지 포함한다 — 확정 테이블만 보면 최근 빌드의 뒷구간이 통째로 안 잡혀
    # '나빠졌다'는 착시가 생긴다(v965 의 6시간·24시간 값이 똑같이 나왔던 게 그 증상이다).
    where = (f"_TABLE_SUFFIX = '{day}'" if day else "TRUE")
    step = "(SELECT value.string_value FROM UNNEST(event_params) WHERE key='step')"
    secs = "(SELECT value.int_value FROM UNNEST(event_params) WHERE key='secs_since_install')"
    STAGES = [("intro_done", "인트로"), ("dev_launch", "출시"), ("property_1", "부동산1"),
              ("property_2", "부동산2"), ("game_sale", "은퇴"), ("first_donate", "첫후원*"),
              ("first_rebirth", "첫환생")]
    for hours in (6, 24):
        sel = ",\n          ".join(
            f"COUNTIF({step}='{k}' AND {secs} <= {hours*3600}) > 0 AS r_{k}"
            for k, _ in STAGES)
        # ⚠ 관측창 보정: 설치 후 N시간이 '데이터에 담길 만큼' 지난 사람만 센다.
        #   어제 23시에 깐 사람은 6시간이 아직 안 지났으니 분모에 넣으면 무조건 미도달로 잡힌다.
        #   이걸 안 하면 최근 빌드가 항상 나빠 보인다 — 비교가 아니라 착시가 된다.
        rows = rt.q(f"""
          WITH u AS (
            SELECT user_pseudo_id AS uid,
              ARRAY_AGG(app_info.version IGNORE NULLS ORDER BY event_timestamp LIMIT 1)[SAFE_OFFSET(0)] AS ver,
              COUNTIF({step}='new_game') > 0 AS started,
              MIN(TIMESTAMP_MICROS(event_timestamp)) AS first_seen,
              {sel}
            FROM {rt.TABLE} WHERE {where} AND event_name='onb_step'
            GROUP BY uid
          )
          SELECT ver, COUNT(*) AS n, """ + ", ".join(
              f"COUNTIF(r_{k}) AS c_{k}" for k, _ in STAGES) + f"""
          FROM u
          WHERE started AND ver IS NOT NULL
            AND first_seen <= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {hours} HOUR)
          GROUP BY ver HAVING n >= 30 ORDER BY ver DESC LIMIT 6
        """)
        print(f"\n=== 설치 후 {hours}시간 안에 도달 (새 게임 시작자 기준) ===")
        print(f"{'버전':<10}{'인원':>6}" + "".join(f"{lab:>9}" for _, lab in STAGES))
        for r in rows:
            n = int(r["n"])
            cells = "".join(f"{100*int(r[f'c_{k}'])/n:>8.1f}%" for k, _ in STAGES)
            print(f"{str(r['ver']).replace('1.0 (','').replace(')',''):<10}{n:>6}{cells}")
    print("\n* 첫후원은 v965 부터 앞에 방치 게이트가 붙었다 — 당일 수치가 낮은 게 설계대로다.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="", help="화면에 보이는 6자 유저 꼬리표")
    ap.add_argument("--day", help="YYYYMMDD. 주면 그 하루만 스캔")
    ap.add_argument("--limit", type=int, default=400, help="찍을 이벤트 줄 수")
    ap.add_argument("--scan", action="store_true", help="tag 대신 시계조작 의심 유저를 훑는다")
    ap.add_argument("--fake", action="store_true", help="결제 위조를 사유별로 분해한다")
    ap.add_argument("--city", action="store_true", help="2부 진입 자격자 수를 센다")
    ap.add_argument("--vercmp", action="store_true", help="버전 코호트를 나이 맞춰 비교한다")
    a = ap.parse_args()

    if a.scan:
        return scan(a.day)
    if a.fake:
        return fake(a.day)
    if a.city:
        return city(a.day)
    if a.vercmp:
        return vercmp(a.day)

    where = (f"_TABLE_SUFFIX = '{a.day}'" if a.day else "_TABLE_SUFFIX NOT LIKE 'intraday%'")
    tag = "".join(c for c in a.tag.lower() if c in "0123456789abcdef")[:6]
    if len(tag) != 6:
        print("tag 는 16진수 6자여야 합니다.", file=sys.stderr)
        return 2

    params = ",\n          ".join(
        f"(SELECT CAST(COALESCE(CAST(value.int_value AS STRING), value.string_value,"
        f" CAST(value.double_value AS STRING)) AS STRING)"
        f" FROM UNNEST(event_params) WHERE key='{k}') AS p_{k}" for k in KEYS)

    rows = rt.q(f"""
      SELECT
        FORMAT_TIMESTAMP('%m-%d %H:%M:%S', TIMESTAMP_MICROS(event_timestamp), 'Asia/Seoul') AS t,
        event_timestamp AS ts,
        event_name AS ev,
        {params}
      FROM {rt.TABLE}
      WHERE {where}
        AND SUBSTR(TO_HEX(MD5(user_pseudo_id)), 1, 6) = '{tag}'
      ORDER BY event_timestamp
    """)
    if not rows:
        print(f"'{tag}' 에 해당하는 이벤트가 없습니다. --day 를 확인하세요.")
        return 0

    # 1) 이벤트 종류별 건수 — 전체 모양을 먼저 본다
    from collections import Counter
    cnt = Counter(r["ev"] for r in rows)
    span = (rows[-1]["ts"] - rows[0]["ts"]) / 1e6
    print(f"=== {tag} · 이벤트 {len(rows)}건 · {rows[0]['t']} ~ {rows[-1]['t']}"
          f" ({span/60:.1f}분) ===")
    print("종류별:", " · ".join(f"{k} {v}" for k, v in cnt.most_common()))
    print()

    # 2) 시간 흐름 — 직전 이벤트와의 간격을 같이 찍는다.
    #    치트·시계조작은 '간격'에서 드러난다(한 초에 수십 건, 또는 시간이 거꾸로 감).
    print(f"{'시각':<16}{'+초':>8}  이벤트")
    prev = None
    shown = 0
    for r in rows:
        gap = "" if prev is None else f"{(r['ts'] - prev) / 1e6:+.1f}"
        prev = r["ts"]
        bits = [f"{k[2:]}={r[k]}" for k in r if k.startswith("p_") and r[k] is not None]
        if shown < a.limit:
            print(f"{r['t']:<16}{gap:>8}  {r['ev']:<22} {' '.join(bits)}")
            shown += 1
    if len(rows) > a.limit:
        print(f"... {len(rows) - a.limit}건 더 (--limit 로 늘리세요)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
