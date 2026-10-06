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
    const [rt, dy, cfg] = await Promise.all([
      get('realtime.json', 60000), get('daily.json', 3600000), get('config.json', 86400000)]);
    if (!rt && !dy) { $('#ad-empty').hidden = false; return; }
    $('#ad-meta').textContent = rt ? `노출 수집 ${rt.updated} · 오늘 활동 유저 전체 기준` : '';
    revenue(dy, rt, cfg);
    ads((rt || {}).ads);
  }

  /* 매출·노출·eCPM. 오늘 값은 둘 다 '자정부터 지금까지'라 비율은 쓸 만하지만,
     AdMob 집계가 뒤늦게 올라오므로 금액 자체는 잠정이다 — 그렇게 적어 둔다. */
  function revenue(dy, rt, cfg) {
    const card = $('#ad-rev');
    const rows = ((dy || {}).daily || []).filter(r => r.admob);
    if (!rows.length) { card.hidden = true; return; }
    card.hidden = false;

    const fx = (cfg || {}).fx_fallback || { USD: 1350 };
    const krw = m => Object.entries(m || {}).reduce((t, [c, v]) => t + v * (fx[c] || 0), 0);
    const last = rows[rows.length - 1];
    const prior = rows.slice(-8, -1);                       // 어제까지 7일
    const avg = prior.length ? prior.reduce((t, r) => t + krw(r.admob), 0) / prior.length : 0;

    const shown = (((rt || {}).ads || {}).by_result || [])
      .filter(x => x.result === 'earned').reduce((t, x) => t + x.n, 0);
    const today = krw(last.admob);
    // eCPM = 1,000회 노출당 매출. 분모는 '완주'다 — 보상형은 완주해야 매출이 잡힌다.
    const ecpm = shown ? today / shown * 1000 : null;

    const host = $('#ad-rev-tiles');
    host.textContent = '';
    const put = (label, value, sub) => {
      const el = document.createElement('div');
      el.className = 'tile';
      const l = document.createElement('div'); l.className = 'tile-label'; l.textContent = label;
      const v = document.createElement('div'); v.className = 'tile-value num'; v.textContent = value;
      const b = document.createElement('div'); b.className = 'tile-sub'; b.textContent = sub;
      el.append(l, v, b);
      host.appendChild(el);
    };
    put('오늘 광고매출', '₩' + num(today), `${last.date} · 잠정`);
    put('최근 7일 평균', '₩' + num(avg), '어제까지');
    put('오늘 완주', num(shown), '매출이 잡히는 노출');
    put('eCPM', ecpm != null ? '₩' + num(ecpm) : '—', '완주 1,000회당 · 잠정');

    // 일별 추이 — 막대 하나짜리 표. 선 그래프를 새로 들이는 것보다 이 화면 어휘에 맞는다.
    const t = $('#ad-rev-table');
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    ['날짜', '광고매출', ''].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });
    const tb = t.createTBody();
    const recent = rows.slice(-14);
    const top = Math.max(...recent.map(r => krw(r.admob)), 1);
    for (const r of recent.slice().reverse()) {
      const v = krw(r.admob);
      const tr = tb.insertRow();
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      c(r.date, 'date');
      c('₩' + num(v));
      const bar = tr.insertCell();
      const track = document.createElement('span'); track.className = 'pg';
      const fill = document.createElement('i'); fill.style.width = (v / top * 100) + '%';
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
