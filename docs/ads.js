/* 광고 뷰 — 리워드 광고 전용 탭.
 *
 * 실시간 뷰에서 떼어냈다. 실시간은 '최근 24시간에 가입한 사람'을 다루는데 광고 매출은
 * 전체 유저에서 나온다 — 모수가 다르다. 한 화면에 같이 두니 2부 전용 광고(city_supply)가
 * "24시간 가입자에게 불가능한 게 왜 있지"로 읽혔다. 축이 다르면 화면을 나누는 게 맞다.
 *
 * 두 파일을 읽는다:
 *   realtime.json  오늘 노출·완주·공급실패 (GA4 ad_impression, 스트리밍)
 *   daily.json     일별 광고 매출 (AdMob API)
 * 둘을 나누면 eCPM 이 나온다 — 광고가 돈이 되고 있는지는 이 한 숫자가 말한다.
 */
(() => {
  const $ = s => document.querySelector(s);
  const num = n => Math.round(n || 0).toLocaleString('ko-KR');
  let loaded = false;

  const prev = window.__viewShown;
  window.__viewShown = view => {
    if (prev) prev(view);
    if (view === 'ads' && !loaded) { loaded = true; load(); }
  };

  /* 리워드 광고 — 결과 네 갈래(ads.gd rewarded_result)를 지점별로 펼친다.
     완주율과 공급 실패율은 원인이 달라서(유저 행동 vs 인벤토리) 한 숫자로 합치면 안 된다. */
  const AD_RES = [['earned', '완주'], ['dismissed', '중간이탈'], ['no_ad', '광고없음'], ['failed', '표시실패']];
  const AD_PLACE = {
    repair: '수리', offline: '방치보상', boost: '수익부스트', gem_ad: '보석광고',
    city_repair: '도시 수리', city_boost: '도시 부스트',
    // 2부 전용. 상점에서 광고를 보면 도시 월수익 N개월치를 즉시 받는다(하루 횟수 제한).
    city_supply: '도시 보급(2부)',
  };

  async function load() {
    const get = async (f, bust) => {
      try {
        const res = await fetch(`data/${f}?t=${Math.floor(Date.now() / bust)}`, { cache: 'no-store' });
        return res.ok ? await res.json() : null;
      } catch { return null; }
    };
    const [rt, dy, cfg, ig] = await Promise.all([
      get('realtime.json', 60000), get('daily.json', 3600000),
      get('config.json', 86400000), get('ingame.json', 3600000)]);
    if (!rt && !dy) { $('#ad-empty').hidden = false; return; }
    $('#ad-meta').textContent = (rt ? `노출 수집 ${rt.updated}` : '')
      + (ig ? `  ·  이력 수집 ${ig.updated}` : '')
      + '  ·  오늘 활동 유저 전체 기준';
    revenue(dy, rt, cfg, ig);
    ads((rt || {}).ads);
  }

  /* 매출·노출·eCPM. 오늘 값은 둘 다 '자정부터 지금까지'라 비율은 쓸 만하지만,
     AdMob 집계가 뒤늦게 올라오므로 금액 자체는 잠정이다 — 그렇게 적어 둔다. */
  function revenue(dy, rt, cfg, ig) {
    const card = $('#ad-rev');
    const rev = {};                                   // 날짜 → 광고매출(원)
    // 매출 뷰(app.js)는 날짜별 ECB 환율을 따로 받는다. 여기선 추세만 보면 되므로
    // config 의 고정 환율로 충분하다 — 환율 때문에 선이 흔들리면 오히려 읽기 나쁘다.
    const fx = (cfg || {}).fx_fallback || { USD: 1350 };
    for (const r of ((dy || {}).daily || [])) {
      if (!r.admob) continue;
      rev[r.date] = Object.entries(r.admob).reduce((t, [c, v]) => t + v * (fx[c] || 0), 0);
    }
    // 노출은 두 출처를 이어 붙인다: 확정본(ingame.json, 어제까지) + 오늘(realtime.json).
    // 같은 날이 겹치면 확정본이 이긴다.
    const imp = {};
    for (const r of ((ig || {}).ads_daily || [])) imp[r.date] = r;
    const rtAds = (rt || {}).ads;
    if (rtAds && rt.summary && rt.summary.first_at) {
      const today = rt.summary.first_at.slice(0, 10);
      if (!imp[today]) {
        const g = k => (rtAds.by_result.find(x => x.result === k) || {}).n || 0;
        imp[today] = { date: today, total: rtAds.total, earned: g('earned'),
                       supply_bad: g('no_ad') + g('failed'), viewers: rtAds.viewers,
                       dau: (rt.summary || {}).users || 0, partial: true };
      }
    }
    const days = Object.keys(rev).filter(d => imp[d]).sort();
    if (!days.length && !Object.keys(rev).length) { card.hidden = true; return; }
    card.hidden = false;

    const ecpm = d => (imp[d] && imp[d].earned) ? rev[d] / imp[d].earned * 1000 : null;
    const last = days[days.length - 1];
    // 오늘은 매출·노출 둘 다 진행 중이라 평균에 넣지 않는다 — 7일 평균이 매일 낮아 보인다.
    const done = days.filter(d => !(imp[d] || {}).partial).slice(-7);
    const avgE = done.length
      ? done.reduce((t, d) => t + (ecpm(d) || 0), 0) / done.filter(d => ecpm(d) != null).length : null;

    const host = $('#ad-rev-tiles');
    host.textContent = '';
    const put = (label, value, sub, warn) => {
      const el = document.createElement('div');
      el.className = 'tile';
      const l = document.createElement('div'); l.className = 'tile-label'; l.textContent = label;
      const v = document.createElement('div'); v.className = 'tile-value num'; v.textContent = value;
      if (warn) v.style.color = 'var(--bad)';
      const b = document.createElement('div'); b.className = 'tile-sub'; b.textContent = sub;
      el.append(l, v, b);
      host.appendChild(el);
    };
    const lastDone = done[done.length - 1];
    put('어제 광고매출', lastDone ? '₩' + num(rev[lastDone]) : '—', lastDone || '');
    put('어제 eCPM', lastDone && ecpm(lastDone) != null ? '₩' + num(ecpm(lastDone)) : '—', '완주 1,000회당');
    put('7일 평균 eCPM', avgE != null ? '₩' + num(avgE) : '—', '확정된 날만');
    put('오늘(잠정)', last && imp[last] ? '₩' + num(rev[last] || 0) : '—',
      last && ecpm(last) != null ? `eCPM ₩${num(ecpm(last))}` : '집계 진행 중');

    const t = $('#ad-rev-table');
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    ['날짜', '광고매출', 'eCPM', '완주', '공급실패', '노출/DAU', ''].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });
    const tb = t.createTBody();
    const recent = days.slice(-14);
    const top = Math.max(...recent.map(d => rev[d] || 0), 1);
    for (const d of recent.slice().reverse()) {
      const a = imp[d], e = ecpm(d);
      const tr = tb.insertRow();
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      c(d + (a.partial ? ' (진행중)' : ''), 'date');
      c('₩' + num(rev[d] || 0));
      c(e != null ? '₩' + num(e) : '—');
      c(num(a.earned));
      // 공급실패는 매출이 그대로 증발하는 칸이라 비율로 보여 주고, 20% 넘으면 붉게 둔다.
      const sp = a.total ? Math.round(100 * a.supply_bad / a.total) : 0;
      const spc = c(a.supply_bad ? `${num(a.supply_bad)} (${sp}%)` : '—');
      if (sp >= 20) spc.className = 'neg';
      // 노출/DAU — 매출이 줄었을 때 '광고를 덜 봤나, 사람이 줄었나'를 가른다.
      c(a.dau ? (a.total / a.dau).toFixed(1) : '—');
      const bar = tr.insertCell();
      const track = document.createElement('span'); track.className = 'pg';
      const fill = document.createElement('i'); fill.style.width = ((rev[d] || 0) / top * 100) + '%';
      if (a.partial) fill.style.opacity = '.45';
      track.appendChild(fill);
      bar.appendChild(track);
    }
  }

  function ads(a) {
    const card = $('#ad-detail');
    if (!a || !a.total) { card.hidden = true; return; }
    card.hidden = false;

    const host = $('#ad-tiles');
    host.textContent = '';
    const put = (label, value, sub, warn) => {
      const el = document.createElement('div');
      el.className = 'tile';
      const l = document.createElement('div'); l.className = 'tile-label'; l.textContent = label;
      const v = document.createElement('div'); v.className = 'tile-value num'; v.textContent = value;
      if (warn) v.style.color = 'var(--bad)';
      const b = document.createElement('div'); b.className = 'tile-sub'; b.textContent = sub;
      el.append(l, v, b);
      host.appendChild(el);
    };
    const got = (k) => (a.by_result.find(x => x.result === k) || {}).n || 0;
    put('광고 요청', num(a.total), '보상 광고를 띄우려 한 횟수');
    put('완주', num(got('earned')), a.finish_pct != null ? `뜬 광고의 ${a.finish_pct}%` : '');
    put('공급 실패', num(got('no_ad') + got('failed')),
      a.supply_pct != null ? `요청의 ${a.supply_pct}%` : '', (a.supply_pct || 0) >= 20);
    put('시청 유저', num(a.viewers), '한 번이라도 본 사람');

    const t = $('#ad-place');
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    ['지점', ...AD_RES.map(x => x[1]), '합계'].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });
    const tb = t.createTBody();
    for (const row of a.by_placement || []) {
      const tr = tb.insertRow();
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      c(AD_PLACE[row.placement] || row.placement, 'date');
      for (const [k] of AD_RES) {
        const cell = c(row[k] ? num(row[k]) : '—');
        // 공급 쪽 실패는 매출이 그대로 증발하는 칸이라 눈에 띄게 둔다
        if ((k === 'no_ad' || k === 'failed') && row[k]) cell.className = 'neg';
      }
      c(num(row.total), 'sum');
    }

    // 국가별 — fill rate 는 지역마다 갈려서 전체 평균 하나로는 어디를 손볼지 안 보인다
    const ct = $('#ad-country');
    ct.textContent = '';
    const rows = a.by_country || [];
    if (!rows.length) return;
    const chr = ct.createTHead().insertRow();
    ['국가', '요청', '완주', '완주율', '광고없음', '표시실패', '공급실패율', '유저'].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      chr.appendChild(th);
    });
    const ctb = ct.createTBody();
    for (const r of rows) {
      const tr = ctb.insertRow();
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      c(r.country, 'date');
      c(num(r.total));
      c(num(r.earned));
      c(r.finish_pct != null ? r.finish_pct + '%' : '—');
      c(r.no_ad ? num(r.no_ad) : '—');
      c(r.failed ? num(r.failed) : '—');
      // 공급실패 20% 넘으면 붉게 — 그 시장에서 광고 매출이 1/5씩 증발하고 있다는 뜻
      const sp = c(r.supply_pct != null ? r.supply_pct + '%' : '—');
      if ((r.supply_pct || 0) >= 20) sp.className = 'neg';
      c(num(r.users));
    }
  }
})();
