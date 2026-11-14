/* 통합 대시보드 — 전체 앱의 공통지표(매출·DAU·리텐션·월별)와 앱별 페이지.
 *
 * 데이터(전부 정적 JSON):
 *   apps.json       앱 목록(손으로 고친다). 순서 = 색 순서. 색은 앱에 붙는다(순위 아님).
 *   daily.json      admob_apps(앱별 AdMob USD) · iap(인생 2막 GA4/수동)
 *   iap_sales.json  Play 판매 리포트 → 앱(패키지)별·KST 날짜별 인앱 세전가
 *
 * 마케팅비(daily.json ads · ads_apps.json)는 수집은 계속되지만 화면엔 안 쓴다 — 2026-11-12 형 지시.
 *   common.json     앱별 BigQuery 경량 수집(DAU·신규·코호트·이벤트·버전)
 *
 * 인앱 기준: 판매 리포트가 덮는 기간은 리포트(세전가 × (1−수수료)), 그 밖은 인생 2막만
 * daily.json(표시가 ÷ (1+세율) × (1−수수료)). 리포트가 없는 기간의 다른 앱 인앱은 '모름'이지
 * 0 이 아니다 — 화면에 반영 기간을 항상 적는다.
 *
 * 전역을 더럽히지 않게 전부 이 IIFE 안에 둔다.
 */
(() => {
  const $ = s => document.querySelector(s);
  const FX_API = 'https://api.frankfurter.dev/v1';
  const ECB = new Set('USD JPY BGN CZK DKK GBP HUF PLN RON SEK CHF ISK NOK TRY AUD BRL CAD CNY HKD IDR ILS INR KRW MXN MYR NZD PHP SGD THB ZAR EUR'.split(' '));
  /* 앱 고정색 48개(apps.json 의 color = 인덱스). 앞 7개 = 검증된 범주 팔레트, 나머지는 OKLCH 16색조×밝기 3단 격자에서
   * 이미 고른 색과 가장 먼 것부터 뽑았다 — 앞 번호일수록 서로 잘 갈린다(8번 ΔE≥16.7, 16번 ≥10). 순서를 바꾸지 말 것. */
  const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#9b4153', '#50b3e8', '#9a8700', '#007872', '#746300', '#b066b4', '#b695e6', '#9ab45a', '#009ab7', '#cb5e73', '#71509b', '#24bfb8', '#006c9d', '#964d09', '#e98a77', '#777ad8', '#c56c21', '#2f7434', '#479c4d', '#78931e', '#d19d47', '#976fcb', '#cc624d', '#c15f96', '#009f99', '#4c86d9', '#0091ce', '#4cc098', '#934370', '#ce8dd1', '#b47900', '#5759a6', '#b9a947', '#28bbd4', '#77a9f2', '#e1925a', '#576d05', '#9c4534', '#854888', '#999ff2', '#75bc78'];
  const PALETTE = COLORS.slice(0, 7);
  const OTHER = '#a3a29c';
  const SEQ = ['#cde2fb', '#b7d3f6', '#86b6ef', '#6da7ec', '#3987e5', '#2a78d6', '#1c5cab', '#184f95'];
  const AUTO_EVENTS = new Set(['screen_view', 'user_engagement', 'session_start', 'first_open', 'app_remove',
    'firebase_campaign', 'os_update', 'app_update', 'app_clear_data', 'ad_impression', 'in_app_purchase',
    'notification_receive', 'notification_open', 'notification_dismiss', 'notification_foreground',
    'first_visit', 'page_view', 'dynamic_link_first_open', 'dynamic_link_app_open', 'app_exception']);

  const S = { apps: [], byKey: {}, cfg: {}, daily: [], sales: null, common: null, fb: null, gs: null, fbApp: '', fbN: 50,
              fx: { byDate: {}, dates: [] }, M: null, revBy: 'app', top: 'all', app: null, range: 30, evAuto: false };

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
  /* 색 기준(형 지시 2026-11-12): 최근 7일(어제까지) 평균 DAU 가 COLOR_MIN_DAU 이상인 앱만 색, 나머지는 회색.
   * 색 자체는 앱마다 고정(apps.json color → COLORS) — 다른 앱이 들고 나도 안 바뀐다. DAU 지표가 없는 앱은 늘 회색. */
  const COLOR_MIN_DAU = 10;

  /* 게임명 가리기(캡처·외부 공유용, 형 지시 2026-11-12) — **앱별 DAU 카드에만** 적용. 켜면 그 카드의 앱 이름을
   * '프로젝트 N'(목록 순서)으로 바꾼다. 다른 화면은 그대로. 보는 사람 브라우저에만 기억한다. */
  const MASK_KEY = 'pf-mask';
  S.mask = (() => { try { return localStorage.getItem(MASK_KEY) === '1'; } catch { return false; } })();
  function applyMask() {
    const b = $('#pf-mask');
    if (!b) return;
    // 글자 대신 눈 아이콘 — 보이는 중이면 눈, 가린 중이면 빗금 친 눈. 설명은 title·aria-label 로.
    const eye = '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>';
    b.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">${eye}${S.mask ? '<path d="M2.5 2.5l11 11"/>' : ''}</svg>`;
    const label = S.mask ? '게임명 보이기' : '게임명 가리기(캡처용)';
    b.title = label; b.setAttribute('aria-label', label);
    b.classList.toggle('is-on', S.mask); b.setAttribute('aria-pressed', S.mask);
  }
  function assignColors() {
    const ds = span(kstDate(7), kstDate(1));
    S.apps.forEach(a => {
      if (a.color_idx == null) a.color_idx = typeof a.color === 'number' ? a.color : -1;
      const daily = ((S.common && S.common.apps && S.common.apps[a.key]) || {}).daily || [];
      const by = Object.fromEntries(daily.map(r => [r.date, r.dau || 0]));
      a.dau7 = sum(ds.map(d => by[d] || 0)) / ds.length;
      a.color = a.dau7 >= COLOR_MIN_DAU && COLORS[a.color_idx] ? COLORS[a.color_idx] : OTHER;
    });
  }

  const get = u => fetch(u, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);

  async function load() {
    const [apps, cfg, daily, sales, common, fb] = await Promise.all([
      get('data/apps.json'), get('data/config.json'), get('data/daily.json'),
      get('data/iap_sales.json'), get('data/common.json'), get('data/feedback.json')]);
    S.fb = fb;
    S.gs = await get('data/gamestats.json');
    S.manualSales = await get('data/manual_sales.json');   // 판매 리포트 전 주문 수동 기록(유료 앱 구매 등)
    S.adsApps = await get('data/ads_apps.json');   // 광고 손익 탭용(앱별 광고비 — Ads 스크립트 갱신 전엔 없음)
    if (!apps || !daily) { $('#pf-error').hidden = false; return; }
    // review: true = Play 심사 중(스토어 미공개) — 화면에서 뺀다(형 지시 2026-11-12). 매출이 잡히면 '기타(목록 밖)'로 간다.
    S.apps = apps.apps.filter(a => !a.review);
    S.apps.forEach((a, i) => (a.alias = `프로젝트 ${i + 1}`));
    applyMask();
    S.apps.forEach(a => (S.byKey[a.key] = a));
    S.cfg = { store_fee: 0.15, fx_fallback: {}, tax_rates: {}, ...(cfg || {}) };
    S.daily = (daily.daily || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    S.sales = sales; S.common = common;
    assignColors();
    // 갱신 = 수집 시각들(AdMob·광고비·인앱·공통지표) 중 가장 늦은 것, 날짜+시각(KST)
    const stamps = [...Object.entries(daily.synced || {}).filter(([k]) => k !== 'iap_scanned').map(([, v]) => v), common && common.updated]
      .filter(Boolean).map(v => String(v).replace('T', ' ').slice(0, 16)).filter(v => /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(v)).sort();
    $('#updated').textContent = stamps.length ? '갱신 ' + stamps[stamps.length - 1] : (daily.updated ? '갱신 ' + daily.updated : '');
    S.dailySynced = daily.synced || {};
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
    const M = { apps: {}, first: null, last: kstDate(0) };
    S.apps.forEach(a => (M.apps[a.key] = { ad: {}, iap: {}, iapProv: {}, dau: {}, new: {}, prov: {} }));
    M.apps._other = { ad: {}, iap: {}, iapProv: {}, dau: {}, new: {}, prov: {} };
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
    // 수동 판매 기록(manual_sales.json) — 판매 리포트가 아직 안 담은 주문만. earn 은 이미 실수령(수수료·세금 뺀 값).
    for (const o of manualOrders()) {
      const k = byPkg[o.package] || '_other';
      M.apps[k].iap[o.date] = (M.apps[k].iap[o.date] || 0) + o.earn * rate(o.currency || 'KRW', o.date);
    }
    for (const r of S.daily) {
      if (!r.iap || covered(r.date)) continue;
      const parts = typeof r.iap === 'number' ? [['KRW', r.iap]] : Object.entries(r.iap);
      const amt = sum(parts.map(([c, x]) => (x * rate(c, r.date)) / (1 + tax(c)))) * (1 - fee);
      M.apps.secondact.iap[r.date] = amt;
      if (r.iap_src === 'ga4') M.apps.secondact.iapProv[r.date] = true;
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
  /* 유형 태그 + 구독 앱은 활성 구독자(추정, common.json subs_active), 유료 앱은 유료 구매자(Play 판매 리포트 주문 − 환불) */
  /* 수동 주문 중 판매 리포트가 아직 안 담은 것(리포트 마지막 주문 시각 < 주문 시각) */
  function manualOrders() {
    const last = (S.sales && S.sales.last_order) || '';
    return ((S.manualSales && S.manualSales.orders) || []).filter(o => !last || o.at > last);
  }
  function paidBuyers(a) {
    let n = manualOrders().filter(o => o.package === a.package).length;
    for (const m of Object.values((S.sales && S.sales.months) || {}))
      for (const day of Object.values(m.by_date || {})) { const x = day[a.package]; if (x) n += (x.n || 0) - (x.refunds || 0); }
    return n;
  }
  const bizTag = a => {
    if (!a || !a.biz) return '';
    const cls = { 무료: 'free', 유료: 'paid', 구독: 'sub' }[a.biz] || 'free';
    let extra = '';
    if (a.biz === '구독') {
      const c = commonOf(a.key);
      if (c && c.subs_active != null) extra = ` <span class="pf-biz-n" title="구독 결제 완료 이벤트 기준 추정(월 31일·연 366일 안) — 갱신·해지는 못 봄">(활성구독자: ${nf(c.subs_active)}명)</span>`;
    } else if (a.biz === '유료') {
      const last = S.sales && S.sales.last_order;
      extra = ` <span class="pf-biz-n" title="Play 판매 리포트 주문 − 환불${last ? ' · 리포트 ' + esc(last.replace('T', ' ').slice(0, 16)) + '까지' : ' · 리포트 없음'}">(유료구매자: ${nf(paidBuyers(a))}명)</span>`;
    }
    return ` <span class="pf-biz pf-biz-${cls}">${esc(a.biz)}</span>${extra}`;
  };
  const nameOf = k => (k === '_other' ? '기타(심사 중·목록 밖)' : S.byKey[k].name);
  const colorOf = k => (k === '_other' ? OTHER : S.byKey[k].color);
  const commonOf = k => (S.common && S.common.apps && S.common.apps[k]) || null;

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
    S.top = ['all', 'month', 'app', 'voice', 'roi'].includes(top) ? top : 'all';
    if (S.top === 'app') S.app = S.byKey[arg] || arg === '_sum' ? arg : (S.app || '_sum');
    document.querySelectorAll('.ttab').forEach(b => b.classList.toggle('is-on', b.dataset.top === S.top));
    ['all', 'month', 'app', 'voice', 'roi'].forEach(t => { $('#top-' + t).hidden = t !== S.top; });
    if (S.top === 'all') renderAll();
    if (S.top === 'month') renderMonth();
    if (S.top === 'app') renderApp();
    if (S.top === 'voice') renderVoice();
    if (S.top === 'roi') renderRoi();
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
  /* 회색 앱(7일 평균 DAU 10 미만 등)은 한 계열 '기타'로 접는다 — 같은 회색 계열이 여러 개면 구별이 안 된다 */
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

    $('#pf-tiles').innerHTML = [
      tile('이번 달 매출', krw(monRev), `광고 ${krw(monAd)} · 인앱 ${krw(monIap)}${proj ? ` · 예상 ${krw(proj)}` : ''}`),
      tile('오늘 매출', krw(tot(rev, [today])), `광고 ${krw(tot(ad, [today]))} · 인앱 ${krw(tot(iap, [today]))} · 진행 중${S.dailySynced && S.dailySynced.admob ? ' (' + S.dailySynced.admob.slice(11, 16) + ' 기준)' : ''}`),
      tile('어제 매출', krw(ydRev), `광고 ${krw(tot(ad, [yday]))} · 인앱 ${krw(tot(iap, [yday]))} · 7일 평균 ${krw(wkAvg)}`),
      tile('어제 DAU', dauKs.length ? nf(ydDau) + '명' : '—', dauKs.length ? `신규 ${nf(ydNew)}명 · 지표 연결 ${dauKs.length}개 앱` : '공통지표 수집 전'),
    ].join('');

    renderDay(today, yday);

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
    $('#pf-apps').innerHTML = `<thead><tr><th class="date">앱</th><th>DAU<span class="th-note">어제</span></th><th>신규<span class="th-note">7일</span></th><th>누적 가입자</th>
      <th>D1</th><th>D7</th><th>광고<span class="th-note">30일</span></th><th>인앱<span class="th-note">30일</span></th><th>매출<span class="th-note">30일</span></th><th>30일 추이</th></tr></thead><tbody>` +
      rows.map(x => `<tr class="pf-row" data-app="${x.a.key}"><td class="date"><span class="dot" style="background:${x.a.color}"></span> ${esc(x.a.name)}${bizTag(x.a)}${x.a.kind === 'app' ? ' <span class="pf-muted">앱</span>' : ''} ${status(x.c)}</td>
        <td>${x.dau != null ? nf(x.dau) : '—'}</td><td>${x.new7 != null ? nf(x.new7) : '—'}</td><td title="${x.c && x.c.total_since ? esc(x.c.total_since) + ' 부터(BigQuery 내보내기 시작) · 봇 제외' : ''}">${x.c && x.c.total_users != null ? nf(x.c.total_users) : '—'}</td>
        <td title="${x.d1 ? '코호트 ' + nf(x.d1.base) + '명' : ''}">${r(x.d1)}</td><td title="${x.d7r ? '코호트 ' + nf(x.d7r.base) + '명' : ''}">${r(x.d7r)}</td>
        <td>${krw(x.ad30)}</td><td>${krw(x.iap30)}</td><td class="sum">${krw(x.r30)}</td><td>${spark(x.trend, x.a.color)}</td></tr>`).join('') +
      (oth ? `<tr><td class="date"><span class="dot" style="background:${OTHER}"></span> 기타(심사 중·목록 밖 AdMob 앱)</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td colspan="2"></td><td class="sum">${krw(oth)}</td><td></td></tr>` : '') +
      `</tbody><tfoot><tr><td class="date">합계</td><td>${dauKs.length ? nf(ydDau) : '—'}</td><td></td><td>${nf(sum(rows.map(x => (x.c && x.c.total_users) || 0)))}</td><td></td><td></td>
        <td>${krw(sum(rows.map(x => x.ad30)))}</td><td>${krw(sum(rows.map(x => x.iap30)))}</td><td class="sum">${krw(sum(rows.map(x => x.r30)) + oth)}</td><td></td></tr></tfoot>`;
    document.querySelectorAll('#pf-apps .pf-row').forEach(tr => tr.addEventListener('click', () => (location.hash = 'app=' + tr.dataset.app)));

    // 일매출 · DAU 누적 막대
    const days = span(addDays(today, -(S.range - 1)), today);
    // 보기 전환(형 지시 2026-11-12): 앱별 누적 ↔ 광고·인앱 누적(전체 앱 합). 앱 페이지 일매출과 같은 두 색.
    const allSum = fn => d => sum(ks.map(k => fn(k, d)));
    const rs = S.revBy === 'src'
      ? [{ key: 'ad', label: '광고매출', color: '#2a78d6', val: allSum((k, d) => M.apps[k].ad[d] || 0) },
         { key: 'iap', label: '인앱매출', color: '#1baf7a', val: allSum((k, d) => M.apps[k].iap[d] || 0) }]
      : revSeries(ks.filter(k => days.some(d => rev(k, d) > 0)));
    // 기간 누적(형 지시 2026-11-12) — 막대 위 숫자 하나. 누적선을 겹치면 축이 둘이 돼서 숫자로 둔다.
    const cum = sum(days.map(d => sum(ks.map(k => rev(k, d)))));
    const cumAd = sum(days.map(d => sum(ks.map(k => M.apps[k].ad[d] || 0))));
    $('#pf-revsum').innerHTML = `<span class="pf-muted">최근 ${S.range}일 누적</span> <b>${won(cum)}</b>` +
      `<span class="pf-muted"> · 광고 ${krw(cumAd)} · 인앱 ${krw(cum - cumAd)}</span>`;
    stacked($('#pf-rev'), days, rs, (v, ax) => (ax ? krw(v).replace('₩', '') : won(v)),
      { note: d => (d === today ? ' · 오늘(진행 중)' : '') });
    legend($('#pf-rev-legend'), legendOf(rs));
    renderDauGrid(days);
    renderNew7(today);
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
    const has = Object.keys((fb && fb.counts) || {}).sort();
    const dates = has.length ? span(has[0], kstDate(0)).reverse() : [];
    $('#pf-voice-empty').hidden = !!dates.length;
    $('#pf-voice-body').hidden = !dates.length;
    if (!fb) return;
    $('#pf-voice-meta').textContent = `건수만 · 내용은 Firebase 콘솔 › Firestore › feedback · 갱신 ${String(fb.updated || '').replace(' KST', '')}`;
    if (!dates.length) return;
    // 행 = 목록의 앱 전부. 못 읽는 앱은 0 이 아니라 '—' 와 이유.
    const ks = S.apps.map(a => a.key);
    const stOf = k => (fb.apps[k] || {}).status;
    const readable = k => stOf(k) === 'ok' || dates.some(d => fbCount(d, k));
    const why = k => ({ no_access: '권한 필요', no_secret: '미연결', no_feature: '기능 없음', error: /404/.test((fb.apps[k] || {}).msg || '') ? '기능 없음' : '오류' }[stOf(k)] || '—');
    // 행 = 앱, 열 = 날짜(왼쪽 오래된 → 오른쪽 최근 30일), 형 지시 2026-11-12. 표는 오른쪽 끝(오늘)으로 스크롤해 둔다.
    const today = kstDate(0), yday = kstDate(1);
    const cols = span(addDays(today, -29), today);
    const head = cols.map(d => `<th class="pf-vd${d === today ? ' pf-vd-today' : ''}">${d === today ? '오늘' : mmdd(d)}</th>`).join('');
    $('#pf-voice-table').innerHTML = `<thead><tr><th class="date">앱</th>${head}<th>30일</th><th>마지막 접수</th></tr></thead><tbody>` +
      ks.map(k => { const v = fb.apps[k] || {}, ok = readable(k);
        return `<tr><td class="date"><span class="dot" style="background:${colorOf(k)}"></span> ${esc(nameOf(k))}${ok ? '' : ` <span class="pf-muted" title="${esc(v.msg || '')}">${why(k)}</span>`}</td>` +
          cols.map(d => `<td class="pf-vd${d === today ? ' pf-vd-today' : ''}">${ok ? (fbCount(d, k) || '<span class="pf-muted">·</span>') : '<span class="pf-muted">—</span>'}</td>`).join('') +
          `<td class="sum">${ok ? sum(cols.map(d => fbCount(d, k))) : '—'}</td><td class="pf-muted">${v.last_at ? esc(v.last_at.replace('T', ' ').slice(2, 16)) : '—'}</td></tr>`; }).join('') +
      `</tbody><tfoot><tr><td class="date">합계</td>${cols.map(d => `<td class="sum pf-vd${d === today ? ' pf-vd-today' : ''}">${sum(ks.map(k => fbCount(d, k))) || ''}</td>`).join('')}<td class="sum">${sum(cols.map(d => sum(ks.map(k => fbCount(d, k)))))}</td><td></td></tr></tfoot>`;
    $('#pf-voice-last').innerHTML = '';
    const sc = $('#pf-voice-table').parentElement; requestAnimationFrame(() => (sc.scrollLeft = sc.scrollWidth));
  }

  /* 오늘·어제 — 앱별 광고/인앱. 오늘은 진행 중이고 두 출처의 반영 시각이 달라 그걸 같이 적는다. */
  function renderDay(today, yday) {
    const M = S.M, ks = keys();
    const ad = (k, d) => M.apps[k].ad[d] || 0, iap = (k, d) => M.apps[k].iap[d] || 0;
    // 값이 0 이어도 목록의 앱은 전부 보인다(형 지시 2026-11-12). '기타'만 값이 있을 때 붙인다.
    const live = ks.filter(k => k !== '_other' || [today, yday].some(d => ad(k, d) || iap(k, d)));
    const cell = v => (v ? won(v) : '<span class="pf-muted">—</span>');
    const prov = (k, d) => (M.apps[k].iapProv[d] ? ' <span class="pf-muted" title="판매 리포트 반영 전 — GA4 기록">GA4</span>' : '');
    const tot = (fn, d) => sum(ks.map(k => fn(k, d)));
    $('#pf-day').innerHTML = `<thead><tr><th class="date">앱</th><th>광고<span class="th-note">오늘</span></th><th>인앱<span class="th-note">오늘</span></th><th>합계<span class="th-note">오늘</span></th>
      <th>광고<span class="th-note">어제</span></th><th>인앱<span class="th-note">어제</span></th><th>합계<span class="th-note">어제</span></th></tr></thead><tbody>` +
      live.map(k => `<tr><td class="date"><span class="dot" style="background:${colorOf(k)}"></span> ${esc(nameOf(k))}</td>
        <td>${cell(ad(k, today))}</td><td>${cell(iap(k, today))}${prov(k, today)}</td><td class="sum">${cell(rev(k, today))}</td>
        <td>${cell(ad(k, yday))}</td><td>${cell(iap(k, yday))}${prov(k, yday)}</td><td class="sum">${cell(rev(k, yday))}</td></tr>`).join('') +
      `</tbody><tfoot><tr><td class="date">합계</td><td>${won(tot(ad, today))}</td><td>${won(tot(iap, today))}</td><td class="sum">${won(tot(rev, today))}</td>
        <td>${won(tot(ad, yday))}</td><td>${won(tot(iap, yday))}</td><td class="sum">${won(tot(rev, yday))}</td></tr></tfoot>`;
    const synced = (S.dailySynced && S.dailySynced.admob) || '';
    const last = S.M.salesCover.last;
    const iapNote = last && last.slice(0, 10) >= today ? `판매 리포트 ${last.slice(11, 16)}까지`
      : `판매 리포트는 ${last ? last.replace('T', ' ').slice(5, 16) : '—'}까지라 그 뒤 인앱은 ${nameOf('secondact')} GA4 기록만(다른 앱은 리포트가 들어오면 채워짐)`;
    $('#pf-day-sub').textContent = `실수령 기준. 광고 = AdMob 추정(매시간, 마지막 ${synced ? synced.slice(11, 16) : '—'}). 인앱 = ${iapNote}.`;
  }

  function coverNote() {
    const c = S.M.salesCover, cm = S.common;
    const ok = cm ? Object.values(cm.apps || {}).filter(x => x.status === 'ok').length : 0;
    return [
      `인앱: Play 판매 리포트 ${c.months.length ? c.months.map(m => m.slice(0, 4) + '.' + m.slice(4)).join(', ') + ` (마지막 주문 ${c.last ? c.last.replace('T', ' ').slice(0, 16) : '—'})` : '없음'} · 그 밖의 기간은 ${nameOf('secondact')} GA4/수동 기록만.`,
      `광고매출: AdMob 앱별.`,
      `DAU·리텐션: ${cm ? `BigQuery 경량 수집 ${cm.updated} · ${ok}/${S.apps.length}개 앱 연결` : '아직 수집 전'}.`,
    ].map(x => `<span>${esc(x)}</span>`).join('');
  }

  const tile = (label, value, sub) =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value num">${value}</div><div class="tile-sub">${esc(sub)}</div></div>`;

  /* 신규 가입자 7일 표(형 지시 2026-11-13) — 행 = 앱(목록 순서), 열 = 날짜(왼쪽 오래된 → 오른쪽 오늘). 지표 없는 앱은 '—'. */
  function renderNew7(today) {
    const M = S.M, cols = span(addDays(today, -6), today);
    const has = k => !!(commonOf(k) && commonOf(k).daily);
    const cell = (k, d) => (!has(k) ? '<span class="pf-muted">—</span>' : M.apps[k].new[d] ? nf(M.apps[k].new[d]) : '<span class="pf-muted">0</span>');
    const th = d => `<th class="pf-vd${d === today ? ' pf-vd-today' : ''}">${d === today ? '오늘' : mmdd(d)}</th>`;
    const ks = S.apps.map(a => a.key);
    const tot7 = k => sum(cols.map(d => M.apps[k].new[d] || 0));
    $('#pf-new7').innerHTML = `<thead><tr><th class="date">앱</th>${cols.map(th).join('')}<th>7일 합계</th></tr></thead><tbody>` +
      ks.map(k => `<tr class="pf-row" data-app="${k}"><td class="date"><span class="dot" style="background:${colorOf(k)}"></span> ${esc(nameOf(k))}</td>` +
        cols.map(d => `<td class="pf-vd${d === today ? ' pf-vd-today' : ''}">${cell(k, d)}</td>`).join('') +
        `<td class="sum">${has(k) ? nf(tot7(k)) : '—'}</td></tr>`).join('') +
      `</tbody><tfoot><tr><td class="date">합계</td>${cols.map(d => `<td class="sum pf-vd${d === today ? ' pf-vd-today' : ''}">${nf(sum(ks.map(k => M.apps[k].new[d] || 0)))}</td>`).join('')}<td class="sum">${nf(sum(ks.map(tot7)))}</td></tr></tfoot>`;
    document.querySelectorAll('#pf-new7 .pf-row').forEach(tr => tr.addEventListener('click', () => (location.hash = 'app=' + tr.dataset.app)));
  }

  /* 앱별 DAU — 앱 하나에 작은 차트 하나(바둑판). '기타'로 접지 않고 목록의 앱을 전부 보인다(형 지시 2026-11-12).
   * 앱마다 축이 따로라 작은 앱도 모양이 보인다 — 크기 비교는 칸 제목의 숫자로 한다.
   * 한 계열뿐이라 범주색이 필요 없어서 전부 같은 색. 확정 전(intraday) 날도 구분 없이 같은 진하기(형 지시 2026-11-12). */
  function renderDauGrid(days) {
    const M = S.M, yday = kstDate(1);
    const has = k => days.some(d => M.apps[k].dau[d]);
    // 순서 = 앱 목록(apps.json) 순서 고정 — 자리가 안 바뀌게(형 지시 2026-11-12). 제목 숫자 = 어제 DAU
    const order = S.apps.map(a => a.key);
    const today = kstDate(0);
    // 리텐션 — 앱별 현황 표와 같은 창(D1: 최근 2주 코호트, D7: 익은 최근 4주 코호트, 가중 평균)
    const retLine = k => {
      const r1 = retention(k, 1, addDays(today, -15), addDays(today, -2)), r7 = retention(k, 7, addDays(today, -37), addDays(today, -8));
      const f = (n, r) => `<span title="${r ? '코호트 ' + nf(r.base) + '명' : '코호트 없음'}">D${n} <b>${r ? (r.pct * 100).toFixed(1) + '%' : '—'}</b></span>`;
      return `<div class="pf-mini-ret">${f(1, r1)}${f(7, r7)}</div>`;
    };
    const host = $('#pf-dau-grid');
    host.innerHTML = order.map(k => {
      const c = commonOf(k), v = M.apps[k].dau[yday];
      return `<div class="pf-mini" data-app="${k}"><div class="pf-mini-head"><span class="pf-mini-name">${esc(S.mask ? S.byKey[k].alias : nameOf(k))}${bizTag(S.byKey[k])}</span>` +
        `<span class="pf-mini-val"><span class="pf-muted">어제</span> ${v != null ? nf(v) + '명' : '—'}</span></div>` +
        (has(k) ? `<div class="chart" id="pf-gw-${k}"></div>` + retLine(k) : `<p class="pf-mini-empty">${esc(statusText(c))}</p>`) + '</div>';
    }).join('');
    order.filter(has).forEach(k => stacked($('#pf-gw-' + k), days,
      [{ key: k, label: 'DAU', color: PALETTE[0], val: d => M.apps[k].dau[d] || 0 }],
      (v, ax) => (ax ? (v >= 1000 ? (v / 1000).toFixed(v >= 1e4 ? 0 : 1) + '천' : nf(v)) : nf(v) + '명'),
      { h: 120 }));
    host.querySelectorAll('.pf-mini').forEach(el => el.addEventListener('click', () => (location.hash = 'app=' + el.dataset.app)));
  }

  /* ══ 광고 손익 탭(형 지시 2026-11-13) ══════════════════════════════════════════
   * 기점(ROI_FROM)부터 광고비 누적 지출을 0 으로 두고, 앱별 누적 광고비 vs 누적 매출(광고+인앱 실수령)을 본다.
   * 광고비: 계정 합계 = daily.json ads, 앱별 = ads_apps.json(캠페인 app_id=패키지). 앱별 내역이 없는 날은 '앱 미배정'.
   * 지울 때: 이 블록 + index.html 의 '광고 손익' 버튼·#top-roi + route() 의 'roi' 두 곳 + S.adsApps 로드 한 줄. */
  const ROI_FROM = '2026-11-13';
  function renderRoi() {
    const M = S.M, today = kstDate(0), days = span(ROI_FROM, today);
    const byPkg = Object.fromEntries(S.apps.filter(a => a.package).map(a => [a.package, a.key]));
    const total = {}, perApp = {}, unassigned = {};
    const split = (S.adsApps && S.adsApps.by_date) || {};
    for (const r of S.daily) {
      if (r.date < ROI_FROM || !r.ads) continue;
      total[r.date] = r.ads;
      let got = 0;
      for (const [pkg, v] of Object.entries(split[r.date] || {})) {
        const k = byPkg[pkg]; if (!k) continue;
        perApp[k] = (perApp[k] || 0) + v.cost; got += v.cost;
      }
      if (r.ads - got > 0) unassigned[r.date] = r.ads - got;
    }
    const spend = sum(Object.values(total)), unas = sum(Object.values(unassigned));
    const revOf = k => sum(days.map(d => rev(k, d)));
    const adOf = k => sum(days.map(d => M.apps[k].ad[d] || 0)), iapOf = k => sum(days.map(d => M.apps[k].iap[d] || 0));
    // 보조지표: 기점 이후 신규 가입자(직접·간접 구분 없이 전부 — 광고 유입 + 자연 유입), 봇 제외. 지표 없는 앱은 null.
    const newOf = k => (commonOf(k) && commonOf(k).daily ? sum(days.map(d => M.apps[k].new[d] || 0)) : null);
    const cpu = (sp, n) => (sp > 0 && n > 0 ? won(sp / n) : '—');
    const ks = keys(), revAll = sum(ks.map(revOf));
    const newAll = sum(S.apps.map(a => newOf(a.key) || 0));
    const p = S.cfg.promo_credit, credit = p && today >= p.from && (!p.to || ROI_FROM <= p.to);
    $('#roi-from').innerHTML = `<b>기점 ${ROI_FROM.replace(/-/g, '.')}</b> — 이날부터 광고비 누적 지출을 0원으로 두고 다시 셉니다. 그 전 지출·매출은 이 탭에 넣지 않습니다.` +
      (credit ? ` <span class="pf-chip" title="config.json promo_credit">구글 프로모션 크레딧 기간</span>` : '');
    const cls = v => (v < 0 ? 'neg' : 'pos');
    const roas = (r, sp) => (sp > 0 ? (100 * r / sp).toFixed(0) + '%' : '—');
    $('#roi-tiles').innerHTML = [
      tile('누적 광고비', won(spend), `${days.length}일 · 오늘 ${won(total[today] || 0)}`),
      tile('누적 매출', won(revAll), `광고 ${krw(sum(ks.map(adOf)))} · 인앱 ${krw(sum(ks.map(iapOf)))}`),
      tile('손익', `<span class="${cls(revAll - spend)}">${won(revAll - spend)}</span>`, `ROAS ${roas(revAll, spend)} (매출 ÷ 광고비)`),
      tile('신규 가입자 (보조지표)', nf(newAll) + '명', `가입자당 광고비 ${cpu(spend, newAll)} · 광고·자연 유입 전부`),
    ].join('');
    $('#roi-sub').textContent = S.adsApps ? '앱별 광고비 = Google Ads 앱 캠페인(패키지) 기준. 앱에 안 묶인 비용은 \'앱 미배정\'.'
      : '⚠ 앱별 광고비가 아직 안 들어온다 — Google Ads 스크립트를 새 버전(tools/google-ads-script.js)으로 바꿔 붙여야 나뉜다. 그 전엔 전부 \'앱 미배정\'.';
    const rows = S.apps.map(a => ({ k: a.key, name: a.name, color: a.color, sp: perApp[a.key] || 0, ad: adOf(a.key), iap: iapOf(a.key), r: revOf(a.key), nu: newOf(a.key) }))
      .sort((x, y) => (y.sp - x.sp) || (y.r - x.r));
    const oth = revOf('_other');
    const line = (name, color, sp, ad, iap, r, title = '', nu = null) => `<tr${title ? ` title="${esc(title)}"` : ''}><td class="date"><span class="dot" style="background:${color}"></span> ${name}</td>` +
      `<td>${sp ? won(sp) : '<span class="pf-muted">—</span>'}</td><td>${won(ad)}</td><td>${won(iap)}</td><td class="sum">${won(r)}</td>` +
      `<td class="${cls(r - sp)}">${won(r - sp)}</td><td>${roas(r, sp)}</td>` +
      `<td class="pf-aux">${nu != null ? nf(nu) : '—'}</td><td class="pf-aux">${cpu(sp, nu)}</td></tr>`;
    $('#roi-apps').innerHTML = `<thead><tr><th class="date">앱</th><th>광고비<span class="th-note">누적</span></th><th>광고매출</th><th>인앱매출</th><th>매출<span class="th-note">누적</span></th><th>손익</th><th>ROAS</th><th class="pf-aux">신규 가입자<span class="th-note">보조</span></th><th class="pf-aux">가입자당 광고비</th></tr></thead><tbody>` +
      rows.map(x => line(esc(x.name), x.color, x.sp, x.ad, x.iap, x.r, '', x.nu)).join('') +
      (unas ? line('앱 미배정', OTHER, unas, 0, 0, 0, '앱 캠페인에 묶이지 않았거나 앱별 내역이 없는 날의 광고비') : '') +
      (oth ? line('기타(심사 중·목록 밖)', OTHER, 0, oth, 0, oth) : '') +
      `</tbody><tfoot><tr><td class="date">합계</td><td>${won(spend)}</td><td>${won(sum(ks.map(adOf)))}</td><td>${won(sum(ks.map(iapOf)))}</td><td class="sum">${won(revAll)}</td><td class="${cls(revAll - spend)}">${won(revAll - spend)}</td><td>${roas(revAll, spend)}</td><td class="pf-aux">${nf(newAll)}</td><td class="pf-aux">${cpu(spend, newAll)}</td></tr></tfoot>`;
    let cs = 0, cr = 0;
    const drows = days.map(d => { const s0 = total[d] || 0, r0 = sum(ks.map(k => rev(k, d))); cs += s0; cr += r0;
      return { d, s0, r0, cs, cr, n0: sum(S.apps.map(a => M.apps[a.key].new[d] || 0)) }; }).reverse();
    $('#roi-days').innerHTML = `<thead><tr><th class="date">날짜</th><th>광고비</th><th>매출</th><th>누적 광고비</th><th>누적 매출</th><th>누적 손익</th><th class="pf-aux">신규 가입자<span class="th-note">보조</span></th></tr></thead><tbody>` +
      drows.map(x => `<tr><td class="date">${mmdd(x.d)}${x.d === today ? ' <span class="pf-new">오늘</span>' : ''}</td><td>${won(x.s0)}</td><td>${won(x.r0)}</td><td>${won(x.cs)}</td><td>${won(x.cr)}</td><td class="${cls(x.cr - x.cs)}">${won(x.cr - x.cs)}</td><td class="pf-aux">${nf(x.n0)}</td></tr>`).join('') + '</tbody>';
  }
  /* ══ 광고 손익 탭 끝 ══ */

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
      const dauDays = ds.filter(d => S.apps.some(a => M.apps[a.key].dau[d] != null));
      const avgDau = dauDays.length ? sum(dauDays.map(d => sum(S.apps.map(a => M.apps[a.key].dau[d] || 0)))) / dauDays.length : null;
      const nw = dauDays.length ? sum(dauDays.map(d => sum(S.apps.map(a => M.apps[a.key].new[d] || 0)))) : null;
      return { m, ad, iap, rev: ad + iap, avgDau, nw,
               partial: m === today.slice(0, 7), dauPartial: dauDays.length < ds.length };
    });
    $('#pf-month').innerHTML = `<thead><tr><th class="date">월</th><th>광고매출</th><th>인앱매출</th><th>총매출</th><th>평균 DAU<span class="th-note">전체 앱 합</span></th><th>신규</th></tr></thead><tbody>` +
      rows.map(r => `<tr><td class="date">${r.m.replace('-', '.')}${r.partial ? ' <span class="pf-muted">진행 중</span>' : ''}</td><td>${won(r.ad)}</td><td>${won(r.iap)}</td><td class="sum">${won(r.rev)}</td>
        <td>${r.avgDau != null ? nf(r.avgDau) + (r.dauPartial ? '*' : '') : '—'}</td><td>${r.nw != null ? nf(r.nw) + (r.dauPartial ? '*' : '') : '—'}</td></tr>`).join('') + '</tbody>';

    // 앱 × 월 매출
    const show = months.slice(0, 6);
    const live = ks.filter(k => days.some(d => rev(k, d) > 0));
    const listed = ks.filter(k => k !== '_other' || live.includes(k));   // 표는 0 인 앱도 전부
    const cell = (k, m) => sum(inM(m).map(d => rev(k, d)));
    $('#pf-month-apps').innerHTML = `<thead><tr><th class="date">앱</th>${show.map(m => `<th>${m.replace('-', '.')}</th>`).join('')}</tr></thead><tbody>` +
      listed.map(k => `<tr><td class="date"><span class="dot" style="background:${colorOf(k)}"></span> ${esc(nameOf(k))}</td>${show.map(m => `<td>${cell(k, m) ? won(cell(k, m)) : '—'}</td>`).join('')}</tr>`).join('') +
      `</tbody><tfoot><tr><td class="date">합계</td>${show.map(m => `<td class="sum">${won(sum(live.map(k => cell(k, m))))}</td>`).join('')}</tr></tfoot>`;

    const asc = months.slice(0, 12).reverse();
    const ms = fold(live, k => m => cell(k, m));
    stacked($('#pf-month-chart'), asc, ms, (v, ax) => (ax ? krw(v).replace('₩', '') : won(v)), { xfmt: m => m.replace('-', '.'), h: 240 });
    legend($('#pf-month-legend'), legendOf(ms));
    $('#pf-month-note').textContent = `* 표시는 그달 일부 날짜만 DAU 가 수집된 값(공통지표는 ${S.common ? '최근 수집 창부터' : '아직 수집 전'}). 인앱은 판매 리포트가 있는 달만 전체 앱 기준이고, 없는 달은 ${nameOf('secondact')} 기록만 들어 있습니다.`;
  }

  /* ── 앱별 ───────────────────────────────────────── */
  /* ══ 초기 퍼널 점검(형 지시 2026-11-13) ═══════════════════════════════════════
   * gamestats.json 의 첫 '퍼널' 위젯(최근 N일 신규 코호트, 스펙은 tools/gamespecs.json)에서 앞 6단계를 본다.
   * 단계 전환율 = 이 단계 도달 ÷ 직전 단계 도달(첫 단계는 ÷ 코호트 신규). 단계 순서가 엄격하지 않은 스펙도 있어 1 을 넘으면 1 로 본다.
   *   문제   : 한 단계에서 40% 넘게 빠짐(전환 < 60%) 또는 직전 단계 10명 이상인데 0명 — 버그 의심
   *   양호   : 가장 약한 단계 60~85% 또는 6단계까지 남는 비율 < 60%
   *   좋음   : 전 단계 85% 이상이고 6단계 누적 60% 이상
   *   판단 보류: 코호트 신규 30명 미만
   * 30일 코호트 합계라 '최근 며칠 새 깨진 것'은 묽어질 수 있다(필요하면 최근 7일 코호트 비교를 gamestats 에 추가).
   * ★스펙에는 '첫 접속 안에 갈 수 있는 단계'만 넣을 것 — 재접속·며칠 걸리는 단계는 광고로 막 들어온 코호트를 '문제'로 오판한다(빗물초밥 2026-11-14). */
  const FUNNEL_STEPS = 6;
  function funnelCheck(k) {
    const g = S.gs && S.gs.games && S.gs.games[k];
    const w = g && g.status === 'ok' && (g.widgets || []).find(x => x.type === 'funnel');
    if (!w) return { level: 'none', title: '퍼널 없음', detail: '이 게임은 퍼널 스펙(gamespecs.json)이 없다' };
    const steps = (w.steps || []).slice(0, FUNNEL_STEPS);
    const base = w.base || 0;
    const rows = steps.map((st, i) => { const prev = i ? steps[i - 1].users : base;
      return { label: st.label, users: st.users, prev, conv: prev > 0 ? Math.min(1, st.users / prev) : null }; });
    const cum = base > 0 && steps.length ? Math.min(1, steps[steps.length - 1].users / base) : null;
    const days = g.cohort_days || 30;
    if (base < 30) return { level: 'hold', title: '판단 보류', detail: `최근 ${days}일 신규 ${nf(base)}명 — 표본이 30명 미만`, rows, base, cum, days };
    const worst = rows.filter(r => r.conv != null).reduce((a, b) => (b.conv < a.conv ? b : a), { conv: 2 });
    const broken = rows.find(r => r.prev >= 10 && r.users === 0);
    let level = 'good';
    if (broken || worst.conv < 0.6) level = 'bad';
    else if (worst.conv < 0.85 || (cum != null && cum < 0.6)) level = 'ok';
    const title = { good: '좋음', ok: '양호', bad: '문제' }[level];
    const detail = broken ? `'${broken.label}' 도달 0명(직전 단계 ${nf(broken.prev)}명) — 이벤트·화면 버그 의심`
      : `가장 많이 빠지는 단계 '${worst.label}' ${(100 * worst.conv).toFixed(0)}% · ${rows.length}단계까지 ${(100 * cum).toFixed(0)}% 남음`;
    return { level, title, detail, rows, base, cum, days, worst };
  }

  function renderFunnelCheck(k) {
    const f = funnelCheck(k), host = $('#pf-alerts');
    const head = `<div class="card-head pf-head-row"><div><h2>초기 퍼널 점검</h2><p class="card-sub">최근 ${f.days || 30}일 신규 ${f.base != null ? nf(f.base) + '명' : ''} 기준 · 앞 ${FUNNEL_STEPS}단계 단계별 전환율</p></div>` +
      `<span class="pf-fc pf-fc-${f.level}">${f.title}</span></div>`;
    const steps = f.rows ? `<ol class="pf-fc-steps">${f.rows.map(r => `<li class="${f.worst && r === f.worst && f.level !== 'good' ? 'is-worst' : ''}${r.prev >= 10 && r.users === 0 ? ' is-broken' : ''}">` +
      `<span class="pf-fc-name">${esc(r.label)}</span><span class="pf-fc-n">${nf(r.users)}명</span><span class="pf-fc-c">${r.conv != null ? (100 * r.conv).toFixed(0) + '%' : '—'}</span></li>`).join('')}</ol>` : '';
    host.innerHTML = head + `<p class="pf-fc-detail">${esc(f.detail)}</p>` + steps;
  }

  /* 앱별 탭 '종합'(형 지시 2026-11-13) — 전 앱의 초기 퍼널 판정 + 핵심 지표를 한 표로. 문제 → 양호 → 좋음 → 보류 → 없음 순. */
  function renderAppSummary() {
    const M = S.M, today = kstDate(0), yday = kstDate(1), d7 = span(addDays(yday, -6), yday);
    const order = { bad: 0, ok: 1, good: 2, hold: 3, none: 4 };
    const rows = S.apps.map(a => { const f = funnelCheck(a.key), A = M.apps[a.key], c = commonOf(a.key);
      return { a, f, dau: A.dau[yday], new7: c && c.daily ? sum(d7.map(d => A.new[d] || 0)) : null,
               d1: retention(a.key, 1, addDays(today, -15), addDays(today, -2)) }; })
      .sort((x, y) => (order[x.f.level] - order[y.f.level]) || ((y.dau || 0) - (x.dau || 0)));
    const cnt = lv => rows.filter(r => r.f.level === lv).length;
    $('#pf-sum-sub').textContent = `문제 ${cnt('bad')} · 양호 ${cnt('ok')} · 좋음 ${cnt('good')} · 판단 보류 ${cnt('hold')} · 퍼널 없음 ${cnt('none')} — 줄을 누르면 그 앱 페이지`;
    $('#pf-sum-table').innerHTML = `<thead><tr><th class="date">앱</th><th>초기 퍼널</th><th class="date">요약</th><th>DAU<span class="th-note">어제</span></th><th>신규<span class="th-note">7일</span></th><th>D1</th></tr></thead><tbody>` +
      rows.map(r => `<tr class="pf-row" data-app="${r.a.key}"><td class="date"><span class="dot" style="background:${r.a.color}"></span> ${esc(r.a.name)}${bizTag(r.a)}</td>` +
        `<td><span class="pf-fc pf-fc-${r.f.level}">${r.f.title}</span></td><td class="date pf-sum-detail">${esc(r.f.detail)}</td>` +
        `<td>${r.dau != null ? nf(r.dau) : '—'}</td><td>${r.new7 != null ? nf(r.new7) : '—'}</td><td>${r.d1 ? (100 * r.d1.pct).toFixed(1) + '%' : '—'}</td></tr>`).join('') + '</tbody>';
    document.querySelectorAll('#pf-sum-table .pf-row').forEach(tr => tr.addEventListener('click', () => (location.hash = 'app=' + tr.dataset.app)));
  }

  function renderApp() {
    const k = S.app, a = S.byKey[k] || {}, A = S.M.apps[k] || {}, c = commonOf(k);
    const today = kstDate(0), yday = kstDate(1);
    $('#pf-chips').innerHTML = `<button type="button" class="pf-appchip pf-chip-sum${k === '_sum' ? ' is-on' : ''}" data-app="_sum">종합</button>` + S.apps.map(x => { const f = funnelCheck(x.key);
      return `<button type="button" class="pf-appchip${x.key === k ? ' is-on' : ''}" data-app="${x.key}"><span class="dot" style="background:${x.color}"></span>${esc(x.name)}${f.level === 'bad' ? `<span class="pf-chip-al pf-fc-bad" title="초기 퍼널 문제">!</span>` : ''}</button>`; }).join('');
    document.querySelectorAll('.pf-appchip').forEach(b => b.addEventListener('click', () => (location.hash = 'app=' + b.dataset.app)));
    $('#pf-app-summary').hidden = k !== '_sum';
    $('#pf-app-one').hidden = k === '_sum';
    if (k === '_sum') { renderAppSummary(); return; }
    renderFunnelCheck(k);
    $('#pf-app-title').innerHTML = esc(a.name) + bizTag(a);
    $('#pf-app-meta').textContent = [a.package, c && c.dataset ? `${c.dataset} · 최종 확정 ${c.last_table || '—'} · 스캔 ${c.scan_mb}MB` : null].filter(Boolean).join(' · ');

    const d30 = span(addDays(yday, -29), yday), d7 = span(addDays(yday, -6), yday);
    const r30 = sum(d30.map(d => rev(k, d))), dau30 = sum(d30.map(d => A.dau[d] || 0));
    const d1 = retention(k, 1, addDays(today, -15), addDays(today, -2)), d7r = retention(k, 7, addDays(today, -37), addDays(today, -8));
    $('#pf-app-tiles').innerHTML = [
      tile('어제 DAU', A.dau[yday] != null ? nf(A.dau[yday]) + '명' : '—', c && c.daily ? `신규 7일 ${nf(sum(d7.map(d => A.new[d])))}명` : statusText(c)),
      tile('D1 · D7', `${d1 ? (d1.pct * 100).toFixed(1) + '%' : '—'} · ${d7r ? (d7r.pct * 100).toFixed(1) + '%' : '—'}`, d1 ? `최근 2주 코호트 ${nf(d1.base)}명 기준` : '코호트 없음'),
      tile('매출 30일', krw(r30), `광고 ${krw(sum(d30.map(d => A.ad[d] || 0)))} · 인앱 ${krw(sum(d30.map(d => A.iap[d] || 0)))}`),
      tile('ARPDAU 30일', dau30 ? won(r30 / dau30) : '—', dau30 ? `30일 누적 DAU ${nf(dau30)}` : '지표 없음'),
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
      {});
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
    crosstab(el, w) {
      const rows = w.rows || [], t = sum(rows.map(r => r.n));
      if (!rows.length) { el.innerHTML = '<p class="card-sub">기록이 없습니다.</p>'; return; }
      const head = w.param_label ? `<th class="date">${esc(w.param_label)}</th>` : '';
      el.innerHTML = `<div class="table-scroll"><table class="ledger"><thead><tr>${head}<th class="date">${esc(w.dim_label || w.dim)}</th><th>횟수</th><th>유저</th><th>비중</th></tr></thead><tbody>` +
        rows.map(r => `<tr>${w.param_label ? `<td class="date">${esc(r.value)}</td>` : ''}<td class="date"><code>${esc(r.dim)}</code></td><td>${nf(r.n)}</td><td>${nf(r.users)}</td><td>${pctf(r.n, t)}</td></tr>`).join('') + '</tbody></table></div>';
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
    location.hash = b.dataset.top === 'app' ? 'app=' + (S.app || '_sum') : b.dataset.top;
  }));
  document.querySelectorAll('#pf-revby .tab').forEach(b => b.addEventListener('click', () => {
    S.revBy = b.dataset.by;
    document.querySelectorAll('#pf-revby .tab').forEach(x => x.classList.toggle('is-on', x === b));
    renderAll();
  }));
  document.querySelectorAll('#pf-range .tab').forEach(b => b.addEventListener('click', () => {
    S.range = +b.dataset.days;
    document.querySelectorAll('#pf-range .tab').forEach(x => x.classList.toggle('is-on', x === b));
    renderAll();
  }));
  $('#pf-mask').addEventListener('click', () => {
    S.mask = !S.mask;
    try { localStorage.setItem(MASK_KEY, S.mask ? '1' : '0'); } catch { /* 저장 막혀도 이번 화면엔 적용 */ }
    applyMask();
    if (S.M && S.top === 'all') renderDauGrid(span(addDays(kstDate(0), -(S.range - 1)), kstDate(0)));
  });
  /* 앱별 DAU 카드만 PNG 로 저장(형 지시 2026-11-12) — 누를 때만 html2canvas 를 불러온다. 버튼은 이미지에서 뺀다.
   * 가리기가 켜져 있으면 가린 이름 그대로 찍힌다(캡처용). */
  let h2c = null;
  const loadH2C = () => h2c || (h2c = new Promise((ok, bad) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    sc.onload = () => ok(window.html2canvas); sc.onerror = () => { h2c = null; bad(new Error('이미지 라이브러리를 못 불러왔습니다')); };
    document.head.append(sc);
  }));
  $('#pf-dau-png').addEventListener('click', async e => {
    const btn = e.currentTarget, card = $('#pf-dau-card');
    btn.disabled = true;
    try {
      const html2canvas = await loadH2C();
      const bg = getComputedStyle(document.body).backgroundColor;
      const canvas = await html2canvas(card, { scale: 2, backgroundColor: bg, logging: false,
        ignoreElements: el => el.id === 'pf-mask' || el.id === 'pf-dau-png' });
      const a = document.createElement('a');
      a.download = `dau-${kstDate(0)}${S.mask ? '-masked' : ''}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    } catch (err) {
      console.error('[pf] DAU 이미지 저장 실패', err);
      btn.title = '저장 실패 — 다시 눌러 보세요';
    } finally { btn.disabled = false; }
  });
  $('#pf-ev-auto').addEventListener('change', e => { S.evAuto = e.target.checked; if (S.app) renderEvents(commonOf(S.app)); });
  $('#pf-voice-all').addEventListener('click', () => (location.hash = 'voice'));
  let rt;
  addEventListener('resize', () => {
    if (!S.M) return;
    clearTimeout(rt);
    rt = setTimeout(route, 160);
  });

  load().catch(e => { $('#pf-error').hidden = false; $('#pf-error').querySelector('pre').textContent = String(e); });
})();
