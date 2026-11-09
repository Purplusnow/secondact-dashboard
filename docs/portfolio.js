/* 통합 대시보드 — 전체 앱의 공통지표(매출·DAU·리텐션·월별)와 앱별 페이지.
 *
 * 데이터(전부 정적 JSON):
 *   apps.json       앱 목록(손으로 고친다). 순서 = 색 순서. 색은 앱에 붙는다(순위 아님).
 *   daily.json      admob_apps(앱별 AdMob USD) · ads(계정 전체 마케팅비) · iap(인생 2막 GA4/수동)
 *   iap_sales.json  Play 판매 리포트 → 앱(패키지)별·KST 날짜별 인앱 세전가
 *   ads_apps.json   캠페인→앱 패키지별 마케팅비(Ads 스크립트 갱신 이후부터)
 *   common.json     앱별 BigQuery 경량 수집(DAU·신규·코호트·이벤트·버전)
 *
 * 인앱 기준: 판매 리포트가 덮는 기간은 리포트(세전가 × (1−수수료)), 그 밖은 인생 2막만
 * daily.json(표시가 ÷ (1+세율) × (1−수수료)). 리포트가 없는 기간의 다른 앱 인앱은 '모름'이지
 * 0 이 아니다 — 화면에 반영 기간을 항상 적는다.
 *
 * 기존 인생 2막 보드(app.js 등)와 전역 이름이 겹치지 않게 전부 이 IIFE 안에 둔다.
 */
(() => {
  const $ = s => document.querySelector(s);
  const FX_API = 'https://api.frankfurter.dev/v1';
  const ECB = new Set('USD JPY BGN CZK DKK GBP HUF PLN RON SEK CHF ISK NOK TRY AUD BRL CAD CNY HKD IDR ILS INR KRW MXN MYR NZD PHP SGD THB ZAR EUR'.split(' '));
  /* 검증된 범주 팔레트 8색 중 앞 7색 — 8번째 이후 앱은 '기타'(중립 회색)로 접는다 */
  const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'];
  const OTHER = '#a3a29c';
  const SEQ = ['#cde2fb', '#b7d3f6', '#86b6ef', '#6da7ec', '#3987e5', '#2a78d6', '#1c5cab', '#184f95'];
  const AUTO_EVENTS = new Set(['screen_view', 'user_engagement', 'session_start', 'first_open', 'app_remove',
    'firebase_campaign', 'os_update', 'app_update', 'app_clear_data', 'ad_impression', 'in_app_purchase',
    'notification_receive', 'notification_open', 'notification_dismiss', 'notification_foreground',
    'first_visit', 'page_view', 'dynamic_link_first_open', 'dynamic_link_app_open', 'app_exception']);

  const S = { apps: [], byKey: {}, cfg: {}, daily: [], sales: null, adsApps: null, common: null, fb: null, gs: null, fbApp: '', fbN: 50,
              fx: { byDate: {}, dates: [] }, M: null, top: 'all', app: null, range: 30, evAuto: false };

  /* ── 형식 ───────────────────────────────────────── */
  const nf = n => Math.round(n).toLocaleString('ko-KR');
  function krw(n) {
    const a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e8) return s + '₩' + (a / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '억';
    if (a >= 1e4) return s + '₩' + (a / 1e4).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + '만';
    return s + '₩' + nf(a);
  }
  const won = n => (n < 0 ? '−' : '') + '₩' + nf(Math.abs(n));
  const pctf = (a, b) => (b > 0 ? (100 * a / b).toFixed(1) + '%' : '—');
  const mmdd = d => d.slice(5).replace('-', '/');
  const kstDate = (off = 0) => new Date(Date.now() + 9 * 3600e3 - off * 864e5).toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const span = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sum = xs => xs.reduce((t, x) => t + (x || 0), 0);

  /* ── 로드 ───────────────────────────────────────── */
  const get = u => fetch(u, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);

  async function load() {
    const [apps, cfg, daily, sales, adsApps, common, fb] = await Promise.all([
      get('data/apps.json'), get('data/config.json'), get('data/daily.json'),
      get('data/iap_sales.json'), get('data/ads_apps.json'), get('data/common.json'), get('data/feedback.json')]);
    S.fb = fb;
    S.gs = await get('data/gamestats.json');
    if (!apps || !daily) { $('#pf-error').hidden = false; return; }
    S.apps = apps.apps;
    S.apps.forEach((a, i) => { a.color = i < PALETTE.length ? PALETTE[i] : OTHER; S.byKey[a.key] = a; });
    S.cfg = { store_fee: 0.15, fx_fallback: {}, tax_rates: {}, ...(cfg || {}) };
    S.daily = (daily.daily || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    S.sales = sales; S.adsApps = adsApps; S.common = common;
    $('#updated').textContent = daily.updated ? '갱신 ' + daily.updated : '';
    await loadFx();
    S.M = model();
    route();
  }

  async function loadFx() {
    const curs = new Set(['USD']);
    S.daily.forEach(r => r.iap && typeof r.iap === 'object' && Object.keys(r.iap).forEach(c => curs.add(c)));
    Object.values((S.sales && S.sales.by_date) || {}).forEach(pk =>
      Object.values(pk).forEach(v => Object.keys(v.net).forEach(c => curs.add(c))));
    const want = [...curs].filter(c => ECB.has(c) && c !== 'KRW' && c !== 'EUR');
    const start = S.daily.length ? S.daily[0].date : kstDate(90);
    const key = `pf-fx:${start}:${want.sort().join(',')}`;
    let p = null;
    try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && Date.now() - c.t < 6 * 3600e3) p = c.p; } catch {}
    if (!p) {
      try {
        const r = await fetch(`${FX_API}/${start}..?symbols=${['KRW', ...want].join(',')}`);
        if (r.ok) { p = await r.json(); try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), p })); } catch {} }
      } catch { /* 고정환율로 떨어진다 */ }
    }
    if (p && p.rates) {
      for (const [d, r] of Object.entries(p.rates)) {
        if (!r.KRW) continue;
        const row = { EUR: r.KRW };
        want.forEach(c => { if (r[c]) row[c] = r.KRW / r[c]; });
        S.fx.byDate[d] = row;
      }
      S.fx.dates = Object.keys(S.fx.byDate).sort();
    }
  }

  function rate(cur, date) {
    if (cur === 'KRW') return 1;
    let d = null;
    for (const x of S.fx.dates) { if (x > date) break; d = x; }
    const r = d && S.fx.byDate[d][cur];
    return r || S.cfg.fx_fallback[cur] || 0;
  }
  const tax = c => { const t = S.cfg.tax_rates; return typeof t[c] === 'number' ? t[c] : (t._default || 0); };

  /* ── 모델: 앱 × 날짜 ─────────────────────────────── */
  function model() {
    const fee = S.cfg.store_fee;
    const M = { apps: {}, spendTotal: {}, spendUnassigned: {}, first: null, last: kstDate(0) };
    S.apps.forEach(a => (M.apps[a.key] = { ad: {}, iap: {}, iapProv: {}, spend: {}, dau: {}, new: {}, prov: {} }));
    M.apps._other = { ad: {}, iap: {}, iapProv: {}, spend: {}, dau: {}, new: {}, prov: {} };
    const byAdmob = {}, byPkg = {};
    S.apps.forEach(a => { a.admob.forEach(n => (byAdmob[n] = a.key)); if (a.package) byPkg[a.package] = a.key; });

    for (const r of S.daily) {
      const d = r.date;
      if (r.admob_apps) {
        for (const [name, usd] of Object.entries(r.admob_apps)) {
          const k = byAdmob[name] || '_other';
          M.apps[k].ad[d] = (M.apps[k].ad[d] || 0) + usd * rate('USD', d);
        }
      } else if (r.admob) {
        /* 앱별 내역이 생기기 전(초기)엔 AdMob 이 사실상 인생 2막 하나였다 */
        const usd = typeof r.admob === 'object' ? (r.admob.USD || 0) : 0;
        const k = typeof r.admob === 'number' ? r.admob : usd * rate('USD', d);
        M.apps.secondact.ad[d] = (M.apps.secondact.ad[d] || 0) + k;
      }
      if (r.ads) M.spendTotal[d] = r.ads;
    }

    // 인앱: 판매 리포트가 덮는 기간 = 리포트 달 ∩ 마지막 주문 시각까지
    const months = new Set(Object.keys((S.sales && S.sales.months) || {}));
    const lastOrder = S.sales && S.sales.last_order ? S.sales.last_order.slice(0, 10) : null;
    M.salesCover = { months: [...months].sort(), last: S.sales && S.sales.last_order };
    const covered = d => months.has(d.slice(0, 7).replace('-', '')) && lastOrder && d <= lastOrder;
    M.covered = covered;
    for (const [d, pk] of Object.entries((S.sales && S.sales.by_date) || {})) {
      for (const [p, v] of Object.entries(pk)) {
        const k = byPkg[p] || '_other';
        const amt = sum(Object.entries(v.net).map(([c, x]) => x * rate(c, d))) * (1 - fee);
        M.apps[k].iap[d] = (M.apps[k].iap[d] || 0) + amt;
      }
    }
    for (const r of S.daily) {
      if (!r.iap || covered(r.date)) continue;
      const parts = typeof r.iap === 'number' ? [['KRW', r.iap]] : Object.entries(r.iap);
      const amt = sum(parts.map(([c, x]) => (x * rate(c, r.date)) / (1 + tax(c)))) * (1 - fee);
      M.apps.secondact.iap[r.date] = amt;
      if (r.iap_src === 'ga4') M.apps.secondact.iapProv[r.date] = true;
    }

    // 마케팅비: 앱별 내역이 있는 날은 앱으로, 없는 날은 '미배정'
    const split = (S.adsApps && S.adsApps.by_date) || {};
    for (const [d, total] of Object.entries(M.spendTotal)) {
      if (split[d]) {
        let assigned = 0;
        for (const [p, v] of Object.entries(split[d])) {
          const k = byPkg[p];
          if (k) { M.apps[k].spend[d] = v.cost; assigned += v.cost; }
        }
        if (total - assigned > 0) M.spendUnassigned[d] = total - assigned;
      } else M.spendUnassigned[d] = total;
    }

    // 공통지표
    for (const a of S.apps) {
      const c = S.common && S.common.apps && S.common.apps[a.key];
      if (!c || !c.daily) continue;
      for (const x of c.daily) {
        M.apps[a.key].dau[x.date] = x.dau;
        M.apps[a.key].new[x.date] = x.new;
        if (x.provisional) M.apps[a.key].prov[x.date] = true;
      }
    }
    const all = S.daily.map(r => r.date);
    M.first = all[0] || kstDate(90);
    return M;
  }

  const rev = (k, d) => (S.M.apps[k].ad[d] || 0) + (S.M.apps[k].iap[d] || 0);
  const keys = () => [...S.apps.map(a => a.key), '_other'];
  const nameOf = k => (k === '_other' ? '기타(목록 밖)' : S.byKey[k].name);
  const colorOf = k => (k === '_other' ? OTHER : S.byKey[k].color);
  const commonOf = k => (S.common && S.common.apps && S.common.apps[k]) || null;
  const spendCredit = d => { const p = S.cfg.promo_credit; return p && d >= p.from && (!p.to || d <= p.to); };

  function retention(k, day, from, to) {
    const c = commonOf(k);
    if (!c || !c.cohorts) return null;
    let b = 0, n = 0;
    for (const x of c.cohorts) {
      if (x.date < from || x.date > to || x[`d${day}`] == null) continue;
      b += x.base; n += x[`d${day}`];
    }
    return b ? { pct: n / b, base: b } : null;
  }

  /* ── 라우팅(해시) ────────────────────────────────── */
  function route() {
    const h = location.hash.replace('#', '');
    const [top, arg] = h.split('=');
    S.top = ['all', 'month', 'app', 'voice', 'secondact'].includes(top) ? top : 'all';
    if (S.top === 'app') S.app = S.byKey[arg] ? arg : (S.app || S.apps[0].key);
    document.querySelectorAll('.ttab').forEach(b => b.classList.toggle('is-on', b.dataset.top === S.top));
    ['all', 'month', 'app', 'voice', 'secondact'].forEach(t => { $('#top-' + t).hidden = t !== S.top; });
    $('#brand-sub').textContent = S.top === 'secondact' ? '인생 2막 상세' : '전체 앱 · 매출 × 지표';
    if (S.top === 'all') renderAll();
    if (S.top === 'month') renderMonth();
    if (S.top === 'app') renderApp();
    if (S.top === 'voice') renderVoice();
    if (S.top === 'secondact') dispatchEvent(new Event('resize'));   // 숨겨져 있던 차트를 다시 잰다
  }
  addEventListener('hashchange', () => S.M && route());

  /* ── 차트: 누적 막대 ─────────────────────────────── */
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
    return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(x => m <= x)) * p;
  }

  /* series: [{key,label,color,val:d=>number}] — 아래에서부터 쌓는다. fmt: 값 표기 */
  function stacked(host, dates, series, fmt, opts = {}) {
    host.innerHTML = '';
    const W = Math.max(host.clientWidth, 280), H = opts.h || 220, ML = 46, MR = 8, MT = 10, MB = 24;
    const totals = dates.map(d => sum(series.map(s => Math.max(0, s.val(d)))));
    const max = niceMax(Math.max(...totals, 0));
    if (!totals.some(v => v > 0)) { host.innerHTML = '<p class="no-data">기간 안에 값이 없습니다</p>'; return; }
    const NS = 'http://www.w3.org/2000/svg';
    const el = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img' });
    const iw = W - ML - MR, ih = H - MT - MB, bw = iw / dates.length;
    const y = v => MT + ih - (v / max) * ih;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, yy = y(v);
      svg.append(el('line', { x1: ML, x2: W - MR, y1: yy, y2: yy, class: i ? 'g-line' : 'g-zero' }));
      const t = el('text', { x: ML - 6, y: yy + 3.5, class: 'g-label', 'text-anchor': 'end' });
      t.textContent = fmt(v, true); svg.append(t);
    }
    const step = Math.ceil(dates.length / Math.max(2, Math.floor(iw / 52)));
    dates.forEach((d, i) => {
      const last = i === dates.length - 1;
      if (i % step && !last) return;
      if (!last && dates.length - 1 - i < step * 0.75 && dates.length > 2) return;   // 마지막 라벨과 겹치면 생략
      const t = el('text', { x: ML + bw * i + bw / 2, y: H - 6, class: 'x-label' });
      t.textContent = opts.xfmt ? opts.xfmt(d) : mmdd(d); svg.append(t);
    });
    const gap = bw > 6 ? 2 : 1, w = Math.max(1, bw - gap);
    dates.forEach((d, i) => {
      let acc = 0;
      const segs = series.map(s => ({ s, v: Math.max(0, s.val(d)) })).filter(x => x.v > 0);
      segs.forEach((x, j) => {
        const y0 = y(acc), y1 = y(acc + x.v);
        const top = j === segs.length - 1;
        const hgt = Math.max(0, y0 - y1 - (top ? 0 : 1));   // 쌓인 칸 사이 표면색 틈
        const r = top ? Math.min(4, w / 2, hgt) : 0, X = ML + bw * i + gap / 2;
        const dPath = `M${X},${y0}V${y1 + r}${r ? `Q${X},${y1} ${X + r},${y1}` : ''}H${X + w - r}${r ? `Q${X + w},${y1} ${X + w},${y1 + r}` : ''}V${y0}Z`;
        svg.append(el('path', { d: dPath, fill: x.s.color, opacity: opts.dim && opts.dim(d) ? 0.45 : 1 }));
        acc += x.v;
      });
    });
    const hit = el('rect', { x: ML, y: MT, width: iw, height: ih, fill: 'transparent' });
    svg.append(hit);
    const band = el('rect', { y: MT, height: ih, width: bw, class: 'band' });
    svg.insertBefore(band, svg.firstChild);
    host.append(svg);
    const tip = document.createElement('div'); tip.className = 'tip'; host.append(tip);
    const move = ev => {
      const rc = svg.getBoundingClientRect(), px = (ev.clientX - rc.left) * (W / rc.width);
      const i = Math.min(dates.length - 1, Math.max(0, Math.floor((px - ML) / bw)));
      const d = dates[i];
      band.setAttribute('x', ML + bw * i); band.classList.add('is-on');
      const rows = series.map(s => ({ s, v: s.val(d) })).filter(x => x.v).sort((a, b) => b.v - a.v);
      tip.innerHTML = `<div class="tip-date">${opts.xfmt ? opts.xfmt(d) : d}${opts.note ? opts.note(d) : ''}</div>` +
        rows.map(x => `<div class="tip-row"><span class="tip-key" style="background:${x.s.color};height:8px;width:8px;border-radius:2px"></span>` +
          `<span class="tip-name">${esc(x.s.label)}</span><span class="tip-val">${fmt(x.v)}</span></div>`).join('') +
        (rows.length > 1 ? `<div class="tip-sep"></div><div class="tip-row"><span class="tip-name">합계</span><span class="tip-val">${fmt(totals[i])}</span></div>` : '');
      tip.classList.add('is-on');
      const tx = (ML + bw * i + bw / 2) * (rc.width / W);
      tip.style.left = Math.min(Math.max(0, tx + 12), rc.width - tip.offsetWidth) + 'px';
      if (tx + 12 + tip.offsetWidth > rc.width) tip.style.left = Math.max(0, tx - 12 - tip.offsetWidth) + 'px';
      tip.style.top = '8px';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { tip.classList.remove('is-on'); band.classList.remove('is-on'); });
  }

  function legend(host, items) {
    host.innerHTML = items.map(x => `<span class="key"><span class="sw" style="background:${x.color}"></span>${esc(x.label)}</span>`).join('');
  }

  function spark(vals, color) {
    const W = 84, H = 22, max = Math.max(...vals, 0);
    if (!max) return '<span class="pf-muted">—</span>';
    const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * (W - 2) + 1},${H - 2 - (v / max) * (H - 4)}`).join(' ');
    return `<svg class="pf-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }

  /* 레전드가 2개 이상일 때만 — 앱 순서 고정, 값이 있는 앱만 */
  const revSeries = ks => fold(ks, k => d => rev(k, d));
  /* 팔레트 7색 밖의 앱(회색)은 한 계열 '기타'로 접는다 — 같은 회색 계열이 여러 개면 구별이 안 된다 */
  function fold(ks, valOf) {
    const main = ks.filter(k => colorOf(k) !== OTHER), rest = ks.filter(k => colorOf(k) === OTHER);
    const out = main.map(k => ({ key: k, label: nameOf(k), color: colorOf(k), val: valOf(k) }));
    if (rest.length) {
      const fs = rest.map(valOf);
      out.push({ key: '_fold', label: rest.length === 1 ? nameOf(rest[0]) : `기타 ${rest.length}개 앱`, color: OTHER,
                 val: d => sum(fs.map(f => f(d))), members: rest.map(nameOf) });
    }
    return out;
  }
  const legendOf = series => series.map(s => ({ label: s.label, color: s.color }));

  /* ── 전체 ───────────────────────────────────────── */
  function renderAll() {
    const M = S.M, today = kstDate(0), yday = kstDate(1);
    const mStart = today.slice(0, 8) + '01';
    const mDays = span(mStart, today);
    const ks = keys();
    const tot = (fn, days) => sum(days.map(d => sum(ks.map(k => fn(k, d)))));
    const ad = (k, d) => M.apps[k].ad[d] || 0, iap = (k, d) => M.apps[k].iap[d] || 0;
    const monRev = tot(rev, mDays), monAd = tot(ad, mDays), monIap = tot(iap, mDays);
    const past = mDays.filter(d => d < today);
    const dim = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).getUTCDate();
    const proj = past.length ? (tot(rev, past) / past.length) * dim : 0;
    const ydRev = tot(rev, [yday]);
    const wk = span(addDays(yday, -6), yday), wkAvg = tot(rev, wk) / 7;
    const dauKs = S.apps.filter(a => M.apps[a.key].dau[yday] != null);
    const ydDau = sum(dauKs.map(a => M.apps[a.key].dau[yday])), ydNew = sum(dauKs.map(a => M.apps[a.key].new[yday]));
    const monSpend = sum(mDays.map(d => M.spendTotal[d] || 0));
    const credit = mDays.some(spendCredit);

    $('#pf-tiles').innerHTML = [
      tile('이번 달 매출', krw(monRev), `광고 ${krw(monAd)} · 인앱 ${krw(monIap)}${proj ? ` · 예상 ${krw(proj)}` : ''}`),
      tile('어제 매출', krw(ydRev), `최근 7일 평균 ${krw(wkAvg)}`),
      tile('어제 DAU', dauKs.length ? nf(ydDau) + '명' : '—', dauKs.length ? `신규 ${nf(ydNew)}명 · 지표 연결 ${dauKs.length}개 앱` : '공통지표 수집 전'),
      tile('이번 달 마케팅비', krw(monSpend), credit ? `프로모션 크레딧 — 현금 아님 · 손익 ${krw(monRev - monSpend)}` : `손익 ${krw(monRev - monSpend)}`),
    ].join('');

    // 앱별 현황 표
    const d30 = span(addDays(yday, -29), yday), d7 = span(addDays(yday, -6), yday);
    const rows = S.apps.map(a => {
      const A = M.apps[a.key], c = commonOf(a.key);
      const r30 = sum(d30.map(d => rev(a.key, d)));
      return { a, A, c, r30, ad30: sum(d30.map(d => A.ad[d] || 0)), iap30: sum(d30.map(d => A.iap[d] || 0)),
               dau: A.dau[yday], new7: c && c.daily ? sum(d7.map(d => A.new[d])) : null,
               d1: retention(a.key, 1, addDays(today, -15), addDays(today, -2)),
               d7r: retention(a.key, 7, addDays(today, -37), addDays(today, -8)),
               trend: d30.map(d => rev(a.key, d)) };
    }).sort((x, y) => y.r30 - x.r30 || (y.dau || 0) - (x.dau || 0));
    const oth = sum(d30.map(d => rev('_other', d)));
    const status = c => !c ? '<span class="pf-chip">지표 미연결</span>'
      : c.status === 'ok' ? '' : `<span class="pf-chip" title="${esc(c.msg || '')}">${{ no_secret: '지표 미연결', no_dataset: 'BQ 없음', no_data: '이벤트 없음', skipped: '건너뜀', error: '수집 오류' }[c.status] || c.status}</span>`;
    const r = x => (x ? `${(x.pct * 100).toFixed(1)}%` : '—');
    $('#pf-apps').innerHTML = `<thead><tr><th class="date">앱</th><th>DAU<span class="th-note">어제</span></th><th>신규<span class="th-note">7일</span></th>
      <th>D1</th><th>D7</th><th>광고<span class="th-note">30일</span></th><th>인앱<span class="th-note">30일</span></th><th>매출<span class="th-note">30일</span></th><th>30일 추이</th></tr></thead><tbody>` +
      rows.map(x => `<tr class="pf-row" data-app="${x.a.key}"><td class="date"><span class="dot" style="background:${x.a.color}"></span> ${esc(x.a.name)}${x.a.kind === 'app' ? ' <span class="pf-muted">앱</span>' : ''} ${status(x.c)}</td>
        <td>${x.dau != null ? nf(x.dau) : '—'}</td><td>${x.new7 != null ? nf(x.new7) : '—'}</td>
        <td title="${x.d1 ? '코호트 ' + nf(x.d1.base) + '명' : ''}">${r(x.d1)}</td><td title="${x.d7r ? '코호트 ' + nf(x.d7r.base) + '명' : ''}">${r(x.d7r)}</td>
        <td>${krw(x.ad30)}</td><td>${krw(x.iap30)}</td><td class="sum">${krw(x.r30)}</td><td>${spark(x.trend, x.a.color)}</td></tr>`).join('') +
      (oth ? `<tr><td class="date"><span class="dot" style="background:${OTHER}"></span> 기타(목록 밖 AdMob 앱)</td><td>—</td><td>—</td><td>—</td><td>—</td><td colspan="2"></td><td class="sum">${krw(oth)}</td><td></td></tr>` : '') +
      `</tbody><tfoot><tr><td class="date">합계</td><td>${dauKs.length ? nf(ydDau) : '—'}</td><td></td><td></td><td></td>
        <td>${krw(sum(rows.map(x => x.ad30)))}</td><td>${krw(sum(rows.map(x => x.iap30)))}</td><td class="sum">${krw(sum(rows.map(x => x.r30)) + oth)}</td><td></td></tr></tfoot>`;
    document.querySelectorAll('#pf-apps .pf-row').forEach(tr => tr.addEventListener('click', () => (location.hash = 'app=' + tr.dataset.app)));

    // 일매출 · DAU 누적 막대
    const days = span(addDays(today, -(S.range - 1)), today);
    const live = ks.filter(k => days.some(d => rev(k, d) > 0));
    const rs = revSeries(live);
    stacked($('#pf-rev'), days, rs, (v, ax) => (ax ? krw(v).replace('₩', '') : won(v)),
      { note: d => (d === today ? ' · 오늘(진행 중)' : '') });
    legend($('#pf-rev-legend'), legendOf(rs));
    const dk = S.apps.filter(a => days.some(d => M.apps[a.key].dau[d])).map(a => a.key);
    const ds = fold(dk, k => d => M.apps[k].dau[d] || 0);
    stacked($('#pf-dau'), days, ds,
      (v, ax) => (ax ? (v >= 1000 ? (v / 1000).toFixed(v >= 1e4 ? 0 : 1) + '천' : nf(v)) : nf(v) + '명'),
      { dim: d => dk.some(k => M.apps[k].prov[d]), note: d => (dk.some(k => M.apps[k].prov[d]) ? ' · 확정 전(intraday)' : '') });
    legend($('#pf-dau-legend'), legendOf(ds));
    $('#pf-dau-card').hidden = !dk.length;
    $('#pf-dau-empty').hidden = !!dk.length;
    $('#pf-cover').innerHTML = coverNote();
    renderVoiceSummary();
  }

  /* ── 유저 의견: 앱 × 날짜 '건수'만(내용은 Firebase 콘솔에서) ── */
  const fbCount = (d, k) => ((S.fb && S.fb.counts && S.fb.counts[d]) || {})[k] || 0;

  function renderVoiceSummary() {
    const fb = S.fb, today = kstDate(0);
    const d7 = span(addDays(today, -6), today);
    const per = S.apps.map(a => ({ a, n7: sum(d7.map(d => fbCount(d, a.key))), today: fbCount(today, a.key),
                                   last: fb && fb.apps && fb.apps[a.key] && fb.apps[a.key].last_at })).filter(x => x.n7);
    $('#pf-voice-card').hidden = !fb;
    if (!fb) return;
    $('#pf-voice-latest').innerHTML = per.length
      ? `<div class="pf-voice-sum">${per.map(x => `<span class="pf-vs"><span class="dot" style="background:${x.a.color}"></span>${esc(x.a.name)} <b class="num">${x.n7}</b>${x.today ? ` <span class="pf-new">오늘 +${x.today}</span>` : ''}</span>`).join('')}</div>`
      : '<p class="card-sub">최근 7일 새 의견이 없습니다.</p>';
  }

  function renderVoice() {
    const fb = S.fb;
    const dates = Object.keys((fb && fb.counts) || {}).sort().reverse();
    $('#pf-voice-empty').hidden = !!dates.length;
    $('#pf-voice-body').hidden = !dates.length;
    if (!fb) return;
    const st = Object.entries(fb.apps || {}).filter(([, v]) => v.status && v.status !== 'ok' && v.status !== 'no_secret');
    $('#pf-voice-meta').textContent = `갱신 ${fb.updated} · 건수만 보여 줍니다(내용은 Firebase 콘솔 › Firestore › feedback).` +
      (st.length ? ` 못 읽은 앱: ${st.map(([k, v]) => (S.byKey[k] ? S.byKey[k].name : k) + '(' + (v.msg || v.status) + ')').join(', ')}` : '');
    if (!dates.length) return;
    const ks = S.apps.filter(a => dates.some(d => fbCount(d, a.key))).map(a => a.key);
    const today = kstDate(0), yday = kstDate(1);
    const rows = dates.slice(0, 60);
    $('#pf-voice-table').innerHTML = `<thead><tr><th class="date">날짜</th>${ks.map(k => `<th><span class="dot" style="background:${colorOf(k)}"></span> ${esc(nameOf(k))}</th>`).join('')}<th>합계</th></tr></thead><tbody>` +
      rows.map(d => { const t = sum(ks.map(k => fbCount(d, k)));
        return `<tr${d >= yday ? ' class="pf-fresh"' : ''}><td class="date">${mmdd(d)}${d === today ? ' <span class="pf-new">오늘</span>' : d === yday ? ' <span class="pf-muted">어제</span>' : ''}</td>${ks.map(k => `<td>${fbCount(d, k) || '<span class="pf-muted">·</span>'}</td>`).join('')}<td class="sum">${t}</td></tr>`; }).join('') +
      `</tbody><tfoot><tr><td class="date">합계</td>${ks.map(k => `<td class="sum">${sum(rows.map(d => fbCount(d, k)))}</td>`).join('')}<td class="sum">${sum(rows.map(d => sum(ks.map(k => fbCount(d, k)))))}</td></tr></tfoot>`;
    $('#pf-voice-last').innerHTML = ks.map(k => { const v = fb.apps[k] || {};
      return `<span class="pf-vs"><span class="dot" style="background:${colorOf(k)}"></span>${esc(nameOf(k))} <span class="pf-muted">마지막 ${v.last_at ? esc(v.last_at.replace('T', ' ').slice(0, 16)) : '—'}</span></span>`; }).join('');
  }

  function coverNote() {
    const c = S.M.salesCover, cm = S.common;
    const ok = cm ? Object.values(cm.apps || {}).filter(x => x.status === 'ok').length : 0;
    return [
      `인앱: Play 판매 리포트 ${c.months.length ? c.months.map(m => m.slice(0, 4) + '.' + m.slice(4)).join(', ') + ` (마지막 주문 ${c.last ? c.last.replace('T', ' ').slice(0, 16) : '—'})` : '없음'} · 그 밖의 기간은 인생 2막 GA4/수동 기록만.`,
      `광고매출: AdMob 앱별. 마케팅비: ${S.adsApps ? '캠페인→앱 내역이 있는 날은 앱별, 없는 날은 미배정' : '앱별 내역 없음(Ads 스크립트 갱신 전) — 합계만'}.`,
      `DAU·리텐션: ${cm ? `BigQuery 경량 수집 ${cm.updated} · ${ok}/${S.apps.length}개 앱 연결` : '아직 수집 전'}.`,
    ].map(x => `<span>${esc(x)}</span>`).join('');
  }

  const tile = (label, value, sub) =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value num">${value}</div><div class="tile-sub">${esc(sub)}</div></div>`;

  /* ── 월별 ───────────────────────────────────────── */
  function renderMonth() {
    const M = S.M, ks = keys(), today = kstDate(0);
    const days = span(M.first, today);
    const months = [...new Set(days.map(d => d.slice(0, 7)))].sort().reverse();
    const inM = m => days.filter(d => d.startsWith(m));
    const rows = months.map(m => {
      const ds = inM(m);
      const ad = sum(ds.map(d => sum(ks.map(k => M.apps[k].ad[d] || 0))));
      const iap = sum(ds.map(d => sum(ks.map(k => M.apps[k].iap[d] || 0))));
      const spend = sum(ds.map(d => M.spendTotal[d] || 0));
      const dauDays = ds.filter(d => S.apps.some(a => M.apps[a.key].dau[d] != null));
      const avgDau = dauDays.length ? sum(dauDays.map(d => sum(S.apps.map(a => M.apps[a.key].dau[d] || 0)))) / dauDays.length : null;
      const nw = dauDays.length ? sum(dauDays.map(d => sum(S.apps.map(a => M.apps[a.key].new[d] || 0)))) : null;
      return { m, ad, iap, rev: ad + iap, spend, profit: ad + iap - spend, avgDau, nw, credit: ds.some(spendCredit),
               partial: m === today.slice(0, 7), dauPartial: dauDays.length < ds.length };
    });
    const cls = v => (v < 0 ? 'neg' : 'pos');
    $('#pf-month').innerHTML = `<thead><tr><th class="date">월</th><th>광고매출</th><th>인앱매출</th><th>총매출</th><th>마케팅비</th><th>손익</th><th>평균 DAU<span class="th-note">전체 앱 합</span></th><th>신규</th></tr></thead><tbody>` +
      rows.map(r => `<tr><td class="date">${r.m.replace('-', '.')}${r.partial ? ' <span class="pf-muted">진행 중</span>' : ''}</td><td>${won(r.ad)}</td><td>${won(r.iap)}</td><td class="sum">${won(r.rev)}</td>
        <td>${won(r.spend)}${r.credit ? ' <span class="pf-chip" title="11/1 이후 마케팅비는 구글 프로모션 크레딧 — 현금 지출 아님">크레딧</span>' : ''}</td><td class="${cls(r.profit)}">${won(r.profit)}</td>
        <td>${r.avgDau != null ? nf(r.avgDau) + (r.dauPartial ? '*' : '') : '—'}</td><td>${r.nw != null ? nf(r.nw) + (r.dauPartial ? '*' : '') : '—'}</td></tr>`).join('') + '</tbody>';

    // 앱 × 월 매출
    const show = months.slice(0, 6);
    const live = ks.filter(k => days.some(d => rev(k, d) > 0));
    const cell = (k, m) => sum(inM(m).map(d => rev(k, d)));
    $('#pf-month-apps').innerHTML = `<thead><tr><th class="date">앱</th>${show.map(m => `<th>${m.replace('-', '.')}</th>`).join('')}</tr></thead><tbody>` +
      live.map(k => `<tr><td class="date"><span class="dot" style="background:${colorOf(k)}"></span> ${esc(nameOf(k))}</td>${show.map(m => `<td>${cell(k, m) ? won(cell(k, m)) : '—'}</td>`).join('')}</tr>`).join('') +
      `</tbody><tfoot><tr><td class="date">합계</td>${show.map(m => `<td class="sum">${won(sum(live.map(k => cell(k, m))))}</td>`).join('')}</tr></tfoot>`;

    const asc = months.slice(0, 12).reverse();
    const ms = fold(live, k => m => cell(k, m));
    stacked($('#pf-month-chart'), asc, ms, (v, ax) => (ax ? krw(v).replace('₩', '') : won(v)), { xfmt: m => m.replace('-', '.'), h: 240 });
    legend($('#pf-month-legend'), legendOf(ms));
    $('#pf-month-note').textContent = `* 표시는 그달 일부 날짜만 DAU 가 수집된 값(공통지표는 ${S.common ? '최근 수집 창부터' : '아직 수집 전'}). 인앱은 판매 리포트가 있는 달만 전체 앱 기준이고, 없는 달은 인생 2막 기록만 들어 있습니다.`;
  }

  /* ── 앱별 ───────────────────────────────────────── */
  function renderApp() {
    const k = S.app, a = S.byKey[k], A = S.M.apps[k], c = commonOf(k);
    const today = kstDate(0), yday = kstDate(1);
    $('#pf-chips').innerHTML = S.apps.map(x => `<button type="button" class="pf-appchip${x.key === k ? ' is-on' : ''}" data-app="${x.key}"><span class="dot" style="background:${x.color}"></span>${esc(x.name)}</button>`).join('');
    document.querySelectorAll('.pf-appchip').forEach(b => b.addEventListener('click', () => (location.hash = 'app=' + b.dataset.app)));
    $('#pf-app-title').textContent = a.name;
    $('#pf-app-meta').textContent = [a.package, c && c.dataset ? `${c.dataset} · 최종 확정 ${c.last_table || '—'} · 스캔 ${c.scan_mb}MB` : null].filter(Boolean).join(' · ');
    $('#pf-detail-link').hidden = a.detail !== 'secondact';

    const d30 = span(addDays(yday, -29), yday), d7 = span(addDays(yday, -6), yday);
    const r30 = sum(d30.map(d => rev(k, d))), dau30 = sum(d30.map(d => A.dau[d] || 0));
    const d1 = retention(k, 1, addDays(today, -15), addDays(today, -2)), d7r = retention(k, 7, addDays(today, -37), addDays(today, -8));
    const sp30 = sum(d30.map(d => A.spend[d] || 0));
    $('#pf-app-tiles').innerHTML = [
      tile('어제 DAU', A.dau[yday] != null ? nf(A.dau[yday]) + '명' : '—', c && c.daily ? `신규 7일 ${nf(sum(d7.map(d => A.new[d])))}명` : statusText(c)),
      tile('D1 · D7', `${d1 ? (d1.pct * 100).toFixed(1) + '%' : '—'} · ${d7r ? (d7r.pct * 100).toFixed(1) + '%' : '—'}`, d1 ? `최근 2주 코호트 ${nf(d1.base)}명 기준` : '코호트 없음'),
      tile('매출 30일', krw(r30), `광고 ${krw(sum(d30.map(d => A.ad[d] || 0)))} · 인앱 ${krw(sum(d30.map(d => A.iap[d] || 0)))}`),
      tile('ARPDAU 30일', dau30 ? won(r30 / dau30) : '—', sp30 ? `마케팅비 30일 ${krw(sp30)}` : '앱별 마케팅비 내역 없음'),
    ].join('');

    const days = span(addDays(today, -59), today);
    stacked($('#pf-app-rev'), days, [
      { key: 'ad', label: '광고매출', color: '#2a78d6', val: d => A.ad[d] || 0 },
      { key: 'iap', label: '인앱매출', color: '#1baf7a', val: d => A.iap[d] || 0 }],
      (v, ax) => (ax ? krw(v).replace('₩', '') : won(v)),
      { note: d => (A.iapProv[d] ? ' · 인앱은 GA4 기록(판매 리포트 전)' : '') });
    legend($('#pf-app-rev-legend'), [{ label: '광고매출', color: '#2a78d6' }, { label: '인앱매출', color: '#1baf7a' }]);

    const hasDau = c && c.daily && c.daily.length;
    $('#pf-app-metrics').hidden = !hasDau;
    $('#pf-app-nodata').hidden = !!hasDau;
    $('#pf-app-nodata').innerHTML = hasDau ? '' : `<h2>DAU·리텐션·이벤트가 아직 없습니다</h2><p>${esc(statusText(c))}</p>`;
    if (!hasDau) return;

    stacked($('#pf-app-dau'), days, [
      { key: 'ret', label: '기존 유저', color: '#86b6ef', val: d => Math.max(0, (A.dau[d] || 0) - (A.new[d] || 0)) },
      { key: 'new', label: '신규 유저', color: '#1c5cab', val: d => A.new[d] || 0 }],
      (v, ax) => (ax ? nf(v) : nf(v) + '명'),
      { dim: d => A.prov[d], note: d => (A.prov[d] ? ' · 확정 전(intraday)' : '') });
    legend($('#pf-app-dau-legend'), [{ label: '기존 유저', color: '#86b6ef' }, { label: '신규 유저', color: '#1c5cab' }]);

    renderGame(k);
    renderCohorts(k, c);
    renderHealth(c);
    renderEvents(c);
    renderVersions(c);
  }

  /* ── 게임별 맞춤 지표(gamestats.json — 스펙은 tools/gamespecs.json) ── */
  function renderGame(k) {
    const host = $('#pf-game'), g = S.gs && S.gs.games && S.gs.games[k];
    if (k === 'secondact') {
      host.innerHTML = `<section class="card"><div class="card-head"><h2>인게임 지표</h2>
        <p class="card-sub">인생 2막은 전용 인게임 보드가 있습니다 — 상단 '인생 2막 상세' › 인게임.</p></div></section>`;
      return;
    }
    if (!g || g.status !== 'ok' || !g.widgets) {
      host.innerHTML = g && g.msg ? `<section class="card"><p class="card-sub">맞춤 지표 수집 실패: ${esc(g.msg)}</p></section>` : '';
      return;
    }
    host.innerHTML = `<div class="pf-game-head"><h2>${esc(g.title || '인게임 지표')}</h2>
      <p class="card-sub">최근 ${esc(g.window[0].slice(5).replace('-', '/'))}~${esc(g.window[1].slice(5).replace('-', '/'))} · 퍼널·도달률은 최근 ${g.cohort_days}일 신규 유저 기준 · 스캔 ${g.scan_mb}MB${g.note ? ' · ' + esc(g.note) : ''}</p></div>` +
      g.widgets.map((w, i) => `<section class="card"><div class="card-head"><h2>${esc(w.title || '')}</h2>${w.sub ? `<p class="card-sub">${esc(w.sub)}</p>` : ''}</div><div id="pf-gw-${i}"></div></section>`).join('');
    g.widgets.forEach((w, i) => {
      const el = $('#pf-gw-' + i);
      try { WIDGET[w.type] && WIDGET[w.type](el, w); } catch (e) { el.innerHTML = `<p class="card-sub">표시 오류: ${esc(e.message)}</p>`; }
    });
  }

  const bar = (label, n, base, note = '') => {
    const p = base ? n / base : 0;
    return `<div class="pf-fbar"><div class="pf-fbar-head"><span>${esc(label)}</span><span class="num">${nf(n)}명 · <b>${(p * 100).toFixed(1)}%</b>${note}</span></div>
      <div class="pf-fbar-track"><div class="pf-fbar-fill" style="width:${Math.min(100, p * 100).toFixed(1)}%"></div></div></div>`;
  };

  const WIDGET = {
    funnel(el, w) {
      let prev = null;
      el.innerHTML = (w.base ? '' : '<p class="card-sub">이 기간 신규 유저가 없습니다.</p>') + w.steps.map(s => {
        const drop = prev && prev > 0 ? 1 - s.users / prev : 0;
        const note = prev != null && drop > 0.15 ? ` <span class="pf-drop">−${(drop * 100).toFixed(0)}%</span>` : '';
        prev = s.users;
        return bar(s.label, s.users, w.base, note);
      }).join('') + `<p class="pf-muted">기준: 신규 ${nf(w.base)}명. 빨간 숫자는 앞 단계 대비 15% 넘게 빠진 곳.</p>`;
    },
    levels(el, w) {
      const rows = w.rows || [];
      if (!rows.length) { el.innerHTML = '<p class="card-sub">레벨 기록이 없습니다.</p>'; return; }
      const maxL = Math.max(...rows.map(r => r.level), ...(w.reach || []).map(r => r.level));
      const atLeast = {};
      let acc = 0;
      for (let L = maxL; L >= 1; L--) { acc += ((w.reach || []).find(r => r.level === L) || {}).users || 0; atLeast[L] = acc; }
      const levels = []; for (let L = 1; L <= maxL; L++) levels.push(L);
      const chart = document.createElement('div'); chart.className = 'chart';
      el.append(chart);
      if (w.base) {
        stacked(chart, levels, [{ key: 'r', label: '도달률', color: '#2a78d6', val: L => (atLeast[L] || 0) / w.base * 100 }],
          (v, ax) => (ax ? v.toFixed(0) + '%' : v.toFixed(1) + '%'), { xfmt: L => 'L' + L, h: 180 });
      }
      const rated = rows.filter(r => r.start >= 5).map(r => ({ ...r, rate: r.clear / r.start }));
      /* 벽 = 클리어율 낮은 셋 ∪ 실패/인 높은 셋. 첫 클리어만 찍는 게임은 결국 다 깨서 클리어율이 높게 나오고,
         막힘은 실패 횟수로 드러난다(퐁당냥 L32: 클리어 87% 인데 실패 200회). */
      // L1·L2 는 튜토리얼 이탈이라 벽에서 뺀다. 클리어율 벽은 90% 미만일 때만.
      const cand = rated.filter(r => r.level > 2);
      const walls = new Set([...cand.filter(r => r.rate < 0.9).sort((a, b) => a.rate - b.rate).slice(0, 3),
                             ...cand.filter(r => r.fails > 0).sort((a, b) => b.fails / b.start - a.fails / a.start).slice(0, 3)].map(r => r.level));
      const t = document.createElement('div'); t.className = 'table-scroll';
      /* 시작 이벤트가 레벨당 1회만 찍히는 게임(퐁당냥·Bee Architect)은 시도/인이 늘 1 이라 숨긴다 */
      const showAtt = sum(rows.map(r => r.attempts)) > sum(rows.map(r => r.start)) * 1.05;
      t.innerHTML = `<table class="ledger"><thead><tr><th class="date">레벨</th><th>시작 유저</th><th>클리어 유저</th><th>클리어율</th><th>실패</th><th>실패/인</th>${showAtt ? '<th>시도/인</th>' : ''}<th>도달<span class="th-note">신규 기준</span></th></tr></thead><tbody>` +
        rows.map((r, i) => `<tr class="${walls.has(r.level) ? 'pf-wall' : ''}${i >= 30 && !walls.has(r.level) ? ' pf-more-row' : ''}"><td class="date">L${r.level}${walls.has(r.level) ? ' <span class="pf-chip">벽</span>' : ''}</td><td>${nf(r.start)}</td><td>${nf(r.clear)}</td>
          <td>${pctf(r.clear, r.start)}</td><td>${nf(r.fails)}</td><td>${r.start ? (r.fails / r.start).toFixed(2) : '—'}</td>${showAtt ? `<td>${r.start ? (r.attempts / r.start).toFixed(1) : '—'}</td>` : ''}<td>${w.base ? pctf(atLeast[r.level] || 0, w.base) : '—'}</td></tr>`).join('') + '</tbody></table>';
      el.append(t);
      if (rows.length > 30) {
        t.classList.add('pf-folded');
        const more = document.createElement('button'); more.type = 'button'; more.className = 'tab rt-more';
        more.textContent = `전체 ${rows.length}개 레벨 보기`;
        more.addEventListener('click', () => { t.classList.remove('pf-folded'); more.remove(); });
        el.append(more);
      }
      const n = document.createElement('p'); n.className = 'pf-muted';
      n.textContent = `위: 최근 신규 ${nf(w.base)}명 중 그 레벨 이상을 시작해 본 비율. 아래 표의 '벽'은 시작 유저 5명 이상인 레벨 중(L1·L2 튜토리얼 제외) 클리어율 90% 미만 하위 셋과 1인당 실패가 가장 많은 셋. 처음 30개 레벨과 벽만 먼저 보입니다.`;
      el.append(n);
    },
    breakdown(el, w) {
      const rows = w.rows || [], t = sum(rows.map(r => r.n));
      if (!rows.length) { el.innerHTML = '<p class="card-sub">기록이 없습니다.</p>'; return; }
      const label = v => (w.labels && w.labels[v]) || v;
      el.innerHTML = `<div class="table-scroll"><table class="ledger"><thead><tr><th class="date">${esc(w.param_label || w.param)}</th><th>횟수</th><th>유저</th><th>비중</th><th></th></tr></thead><tbody>` +
        rows.map(r => `<tr><td class="date">${esc(label(r.value))}</td><td>${nf(r.n)}</td><td>${nf(r.users)}</td><td>${pctf(r.n, t)}</td>
          <td style="width:30%"><div class="pf-fbar-track pf-mini"><div class="pf-fbar-fill" style="width:${(100 * r.n / rows[0].n).toFixed(1)}%"></div></div></td></tr>`).join('') + '</tbody></table></div>';
    },
    maxval(el, w) {
      const rows = w.rows || [];
      if (!rows.length) { el.innerHTML = '<p class="card-sub">기록이 없습니다.</p>'; return; }
      const t = sum(rows.map(r => r.users));
      const chart = document.createElement('div'); chart.className = 'chart'; el.append(chart);
      const vals = rows.map(r => r.value), by = Object.fromEntries(rows.map(r => [r.value, r.users]));
      stacked(chart, vals, [{ key: 'u', label: '유저', color: '#2a78d6', val: v => by[v] || 0 }],
        (v, ax) => (ax ? nf(v) : nf(v) + '명'), { xfmt: v => (w.prefix || '') + v, h: 170 });
      const n = document.createElement('p'); n.className = 'pf-muted';
      n.textContent = `이 기간 이벤트를 남긴 ${nf(t)}명의 최고 ${w.param_label || w.param} 분포.`;
      el.append(n);
    },
  };

  function statusText(c) {
    if (!c) return '공통지표가 아직 수집되지 않았습니다 — common 워크플로를 돌리세요.';
    return { no_secret: 'BigQuery 키(GitHub Secret)가 등록되지 않았습니다.', no_dataset: '이 프로젝트에 GA4 BigQuery export 가 없습니다.',
             no_data: '수집 창 안에 이벤트 테이블이 없습니다.', skipped: c.msg, error: '수집 오류: ' + (c.msg || '') }[c.status] || c.msg || '';
  }

  function renderCohorts(k, c) {
    const RD = (S.common && S.common.ret_days) || [1, 3, 7, 14, 30];
    const today = kstDate(0);
    // 곡선(가중 평균): 각 Dn 마다 '그 칸이 익은 최근 코호트 4주'만 쓴다
    const curve = RD.map(n => ({ n, r: retention(k, n, addDays(today, -(n + 29)), addDays(today, -(n + 1))) }));
    $('#pf-ret-tiles').innerHTML = curve.map(x =>
      `<div class="pf-ret"><span class="pf-muted">D${x.n}</span><b class="num">${x.r ? (x.r.pct * 100).toFixed(1) + '%' : '—'}</b><span class="pf-muted">${x.r ? nf(x.r.base) + '명' : ''}</span></div>`).join('');
    const rows = (c.cohorts || []).slice(-21).reverse();
    const heat = p => SEQ[Math.min(SEQ.length - 1, Math.floor(p * 2 * SEQ.length))];   // 0~50% 를 8단계로
    $('#pf-cohorts').innerHTML = `<thead><tr><th class="date">가입일</th><th>신규</th>${RD.map(n => `<th>D${n}</th>`).join('')}</tr></thead><tbody>` +
      rows.map(r => `<tr><td class="date">${mmdd(r.date)}</td><td>${nf(r.base)}</td>${RD.map(n => {
        const v = r[`d${n}`];
        if (v == null) return '<td class="pf-muted">·</td>';
        const p = r.base ? v / r.base : 0, bg = heat(p), dark = SEQ.indexOf(bg) >= 5;
        return `<td class="pf-heat" style="background:${bg};color:${dark ? '#fff' : 'var(--ink)'}" title="${nf(v)}/${nf(r.base)}명">${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%</td>`;
      }).join('')}</tr>`).join('') + '</tbody>';
  }

  function renderHealth(c) {
    const xs = (c.daily || []).slice(-14);
    const per = (a, b) => (b ? (a / b).toFixed(1) : '—');
    $('#pf-health').innerHTML = `<thead><tr><th class="date">날짜</th><th>DAU</th><th>신규</th><th>세션/인</th><th>광고노출/인</th><th>결제 이벤트</th><th>삭제</th><th>예외</th></tr></thead><tbody>` +
      xs.slice().reverse().map(x => `<tr><td class="date">${mmdd(x.date)}${x.provisional ? ' <span class="pf-muted">진행 중</span>' : ''}</td><td>${nf(x.dau)}</td><td>${nf(x.new)}</td>
        <td>${per(x.sessions, x.dau)}</td><td>${per(x.ad_impressions, x.dau)}</td><td>${nf(x.purchases)}</td><td>${x.uninstalls != null ? nf(x.uninstalls) : '—'}</td><td>${nf(x.exceptions)}</td></tr>`).join('') + '</tbody>';
  }

  function renderEvents(c) {
    const ev = c.events || { days: [], rows: [] };
    const rows = ev.rows.filter(r => S.evAuto || !AUTO_EVENTS.has(r.e));
    const n = Math.max(1, ev.days.length);
    $('#pf-ev-sub').textContent = `최근 ${ev.days.length}일 · 게임이 직접 남긴 이벤트${S.evAuto ? '와 GA4 자동 이벤트' : ''} ${rows.length}종. '하루 최대 유저'는 그 이벤트를 남긴 사람이 가장 많았던 날의 수.`;
    $('#pf-events').innerHTML = `<thead><tr><th class="date">이벤트</th><th>횟수</th><th>일평균</th><th>하루 최대 유저</th><th>${ev.days.length}일 추이</th></tr></thead><tbody>` +
      rows.map(r => `<tr><td class="date"><code>${esc(r.e)}</code>${AUTO_EVENTS.has(r.e) ? ' <span class="pf-muted">자동</span>' : ''}</td><td>${nf(r.n)}</td><td>${nf(r.n / n)}</td><td>${nf(r.users)}</td><td>${spark(r.by_day, '#52514e')}</td></tr>`).join('') + '</tbody>';
  }

  function renderVersions(c) {
    const v = c.versions || [], t = sum(v.map(x => x.users));
    $('#pf-versions').innerHTML = `<thead><tr><th class="date">버전</th><th>유저<span class="th-note">최근 7일</span></th><th>비중</th></tr></thead><tbody>` +
      v.map(x => `<tr><td class="date">${esc(x.v)}</td><td>${nf(x.users)}</td><td>${pctf(x.users, t)}</td></tr>`).join('') + '</tbody>';
  }

  /* ── 배선 ───────────────────────────────────────── */
  document.querySelectorAll('.ttab').forEach(b => b.addEventListener('click', () => {
    location.hash = b.dataset.top === 'app' ? 'app=' + (S.app || S.apps[0].key) : b.dataset.top;
  }));
  document.querySelectorAll('#pf-range .tab').forEach(b => b.addEventListener('click', () => {
    S.range = +b.dataset.days;
    document.querySelectorAll('#pf-range .tab').forEach(x => x.classList.toggle('is-on', x === b));
    renderAll();
  }));
  $('#pf-ev-auto').addEventListener('change', e => { S.evAuto = e.target.checked; if (S.app) renderEvents(commonOf(S.app)); });
  $('#pf-detail-link').addEventListener('click', () => (location.hash = 'secondact'));
  $('#pf-voice-all').addEventListener('click', () => (location.hash = 'voice'));
  let rt;
  addEventListener('resize', () => {
    if (!S.M || S.top === 'secondact') return;
    clearTimeout(rt);
    rt = setTimeout(route, 160);
  });

  load().catch(e => { $('#pf-error').hidden = false; $('#pf-error').querySelector('pre').textContent = String(e); });
})();
