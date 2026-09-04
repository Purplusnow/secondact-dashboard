/* SECONDACT BOARD — 광고매출 · 인앱매출 · 마케팅비
 *
 * 입력은 손으로 넣은 data/daily.json 한 장이 전부다. 화면이 하는 일은 셋뿐:
 *   (1) 구글플레이에 찍힌 각국 통화를 그날 환율로 원화로 바꾸고
 *   (2) 인앱매출에서 스토어 수수료를 떼고
 *   (3) 일별과 누적으로 그린다.
 *
 * 환율은 ECB 기준(api.frankfurter.dev)을 날짜별로 한 번에 받아 쓴다. 주말·공휴일은
 * 고시가 없으므로 직전 영업일 환율을 끌어다 쓰고, ECB가 안 다루는 통화(TWD 등)와
 * API가 죽은 경우는 config.json 의 fx_fallback 고정환율로 떨어진다.
 *
 * 색은 데이터에만 쓴다. 계열색은 검증된 카테고리 팔레트 슬롯이고(파랑·아쿠아·주황),
 * 손익은 계열이 아니라 파생값이라 잉크(검정)로 그린다.
 */

const FX_API = 'https://api.frankfurter.dev/v1';
const FX_TTL = 6 * 3600e3;
const INK = '#0b0b0b';
const SURFACE = '#fcfcfb';
const GAP = 2;            /* 마크 사이를 가르는 건 선이 아니라 표면색 2px 틈이다 */

const state = { cfg: null, raw: [], rows: [], days: 0, fx: null,
                dailyView: 'both', cumView: 'both', applyFee: true };

/* ── 포맷 ────────────────────────────────────────── */
const won = n => Math.round(n).toLocaleString('ko-KR') + '원';
const num = n => Math.round(n).toLocaleString('ko-KR');
const trim = v => (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')).toString();

function short(n) {
  const s = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e8) return s + trim(a / 1e8) + '억';
  if (a >= 1e4) return s + trim(a / 1e4) + '만';
  return s + Math.round(a).toLocaleString('ko-KR');
}
const pct = r => (r * 100).toFixed(r >= 10 ? 0 : 1).replace(/\.0$/, '') + '%';
const mmdd = d => d.slice(5).replace('-', '/');
const daysAgo = n =>
  new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
const todayKST = () => daysAgo(0);

/* ── 환율 ────────────────────────────────────────── */

/* 하루치 값은 숫자(원) 또는 {통화: 금액} 두 형태를 다 받는다. */
const parts = v =>
  v == null ? []
  : typeof v === 'number' ? (v ? [['KRW', v]] : [])
  : Object.entries(v).filter(([, a]) => +a);

function currenciesUsed(daily, series) {
  const set = new Set();
  daily.forEach(r => series.forEach(s =>
    parts(r[s.key]).forEach(([c]) => set.add(c.toUpperCase()))));
  set.delete('KRW');
  return [...set];
}

async function loadFx(daily, currencies) {
  const fb = state.cfg.fx_fallback || {};
  const fx = { byDate: {}, dates: [], live: [], fallback: [], missing: [], asOf: null, error: null };
  state.fx = fx;
  if (!currencies.length || !daily.length) return fx;

  const start = daily[0].date;
  const key = `fx:${start}:${currencies.slice().sort().join(',')}`;

  let payload = null;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached && Date.now() - cached.t < FX_TTL) payload = cached.p;
  } catch { /* localStorage 없거나 깨진 캐시 — 새로 받는다 */ }

  if (!payload) {
    try {
      const url = `${FX_API}/${start}..?symbols=${['KRW', ...currencies].join(',')}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      payload = await res.json();
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), p: payload })); } catch {}
    } catch (e) {
      fx.error = String(e.message || e);
    }
  }

  /* EUR 기준 고시가를 원화 환산율로: 1통화 = (KRW/EUR) ÷ (통화/EUR) 원.
     KRW 기준으로 직접 받으면 USD가 0.00074로 반올림돼 0.7%쯤 틀어진다. */
  if (payload && payload.rates) {
    for (const [d, r] of Object.entries(payload.rates)) {
      if (!r.KRW) continue;
      const row = {};
      for (const c of currencies) if (r[c]) row[c] = r.KRW / r[c];
      fx.byDate[d] = row;
    }
    fx.dates = Object.keys(fx.byDate).sort();
    fx.asOf = fx.dates[fx.dates.length - 1] || null;
  }

  const covered = new Set(fx.asOf ? Object.keys(fx.byDate[fx.asOf]) : []);
  currencies.forEach(c => (covered.has(c) ? fx.live : fx.fallback).push(c));
  fx.missing = fx.fallback.filter(c => !(c in fb));
  return fx;
}

/* 그날 고시가가 없으면(주말·공휴일) 직전 영업일로 끌어온다. */
function rateOn(cur, date) {
  const c = cur.toUpperCase();
  if (c === 'KRW') return { rate: 1, src: 'krw' };
  const fx = state.fx;
  if (fx && fx.dates.length) {
    let d = null;
    for (const x of fx.dates) { if (x > date) break; d = x; }
    d = d || fx.dates[0];
    const r = fx.byDate[d] && fx.byDate[d][c];
    if (r) return { rate: r, src: d === date ? 'live' : 'carry', on: d };
  }
  const fb = (state.cfg.fx_fallback || {})[c];
  if (fb) return { rate: fb, src: 'fallback' };
  return { rate: 0, src: 'unknown' };
}

/* ── 로드 ────────────────────────────────────────── */
async function load() {
  const demo = new URLSearchParams(location.search).has('demo');

  const [cfg, data] = await Promise.all([
    fetch('data/config.json', { cache: 'no-store' }).then(r => r.json()),
    demo ? Promise.resolve(demoData())
         : fetch('data/daily.json', { cache: 'no-store' }).then(r => r.json()),
  ]);

  state.cfg = { store_fee: 0.15, fee_applies_to: ['iap'], series: [], fx_fallback: {}, ...cfg };

  document.getElementById('brand-sub').textContent =
    (state.cfg.app_name ? state.cfg.app_name + ' · ' : '') + '마케팅비 × 매출';
  document.getElementById('updated').textContent = data.updated ? '갱신 ' + data.updated : '';
  document.getElementById('demo-banner').hidden = !demo;
  document.getElementById('foot-fee').textContent = pct(state.cfg.store_fee);
  document.getElementById('foot-fee-target').textContent =
    (state.cfg.fee_applies_to || []).map(labelOf).join(' · ') || '없음';

  const daily = (data.daily || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const has = daily.length > 0;
  document.getElementById('empty').hidden = has;
  document.getElementById('content').hidden = !has;
  if (!has) return;

  await loadFx(daily, currenciesUsed(daily, state.cfg.series));
  renderFxNote();

  state.raw = daily;
  try { state.applyFee = localStorage.getItem('applyFee') !== '0'; } catch {}
  const box = document.getElementById('fee-toggle');
  box.checked = state.applyFee;
  document.getElementById('fee-label').textContent =
    `인앱 수수료 ${pct(state.cfg.store_fee)} 반영`;

  recompute();
}

const labelOf = k => (state.cfg.series.find(s => s.key === k) || {}).label || k;
const colorOf = k => (state.cfg.series.find(s => s.key === k) || {}).color || INK;

/* 누적은 항상 전체 기간 기준으로 미리 깔아둔다 — 7일 탭에서도 누적 위치는 진짜여야 한다. */
function recompute() {
  state.rows = derive(state.raw);
  render();
}

function derive(raw) {
  const { series, store_fee } = state.cfg;
  /* 체크를 풀면 구매자가 결제한 총액 그대로 — 화면 전체가 같은 기준으로 다시 계산된다 */
  const feeKeys = new Set(state.applyFee ? (state.cfg.fee_applies_to || []) : []);
  const cum = {};
  let cumProfit = 0;

  return raw.map(r => {
    const out = { date: r.date, note: r.note, val: {}, fx: {}, cum: {} };
    let rev = 0, spend = 0;

    for (const s of series) {
      let krw = 0;
      const breakdown = [];
      for (const [cur, amt] of parts(r[s.key])) {
        const { rate, src, on } = rateOn(cur, r.date);
        krw += (+amt) * rate;
        if (cur.toUpperCase() !== 'KRW') breakdown.push({ cur, amt: +amt, rate, src, on });
      }
      if (feeKeys.has(s.key)) krw *= 1 - store_fee;

      out.val[s.key] = krw;
      if (breakdown.length) out.fx[s.key] = breakdown;
      cum[s.key] = (cum[s.key] || 0) + krw;
      out.cum[s.key] = cum[s.key];

      if (s.type === 'spend') spend += krw; else rev += krw;
    }

    out.rev = rev;
    out.spend = spend;
    out.profit = rev - spend;
    cumProfit += out.profit;
    out.cumProfit = cumProfit;
    return out;
  });
}

const visible = () =>
  state.days ? state.rows.filter(r => r.date >= daysAgo(state.days - 1)) : state.rows;

/* ── 렌더 ────────────────────────────────────────── */
function render() {
  const rows = visible();
  const last = state.rows[state.rows.length - 1];

  renderHero(rows, last);
  renderTiles(rows, last);

  if (!rows.length) {
    ['chart-daily', 'chart-cum'].forEach(id =>
      (document.getElementById(id).innerHTML = '<div class="no-data">이 기간에는 기록이 없습니다</div>'));
    ['legend-daily', 'legend-cum'].forEach(id => (document.getElementById(id).innerHTML = ''));
    document.getElementById('ledger').innerHTML = '';
    return;
  }
  drawDaily(rows);
  drawCum(rows);
  renderLedger(rows);
}

function renderHero(rows, last) {
  const v = document.getElementById('hero-value');
  v.textContent = won(last.cumProfit);
  v.className = 'hero-value num ' + (last.cumProfit >= 0 ? 'is-good' : 'is-bad');

  const cumOf = t => state.cfg.series.filter(s => (s.type === 'spend') === t)
    .reduce((a, s) => a + (last.cum[s.key] || 0), 0);
  const rev = cumOf(false), spend = cumOf(true);

  const sub = document.getElementById('hero-sub');
  sub.innerHTML = last.cumProfit >= 0
    ? `마케팅비 <b>${won(spend)}</b>을 모두 회수하고 <b>${won(last.cumProfit)}</b> 남았습니다.`
    : `마케팅비 <b>${won(spend)}</b> 중 <b>${won(rev)}</b>이 돌아왔습니다 — ` +
      `<b>${won(-last.cumProfit)}</b> 미회수.`;
}

function renderTiles(rows, last) {
  const sum = k => rows.reduce((s, r) => s + (r.val[k] || 0), 0);
  const rev = rows.reduce((s, r) => s + r.rev, 0);
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const roas = spend > 0 ? rev / spend : null;

  const tiles = state.cfg.series.map(s => ({
    dot: s.color, label: s.label, value: short(sum(s.key)) + '원',
    sub: '누적 ' + short(last.cum[s.key] || 0) + '원',
  }));
  tiles.push({
    label: 'ROAS', value: roas === null ? '—' : pct(roas),
    sub: roas === null ? '이 기간 마케팅비 없음' : `마케팅비 1원당 ${roas.toFixed(2)}원`,
  });

  const host = document.getElementById('tiles');
  host.textContent = '';
  for (const t of tiles) {
    const el = document.createElement('div');
    el.className = 'tile';

    const lab = document.createElement('div');
    lab.className = 'tile-label';
    if (t.dot) {
      const d = document.createElement('i');
      d.className = 'dot';
      d.style.background = t.dot;
      lab.appendChild(d);
    }
    lab.appendChild(document.createTextNode(t.label));

    const val = document.createElement('div');
    val.className = 'tile-value num';
    val.textContent = t.value;

    const sub = document.createElement('div');
    sub.className = 'tile-sub';
    sub.textContent = t.sub;

    el.append(lab, val, sub);
    host.appendChild(el);
  }
}

function renderFxNote() {
  const fx = state.fx, el = document.getElementById('fx-note');
  if (!fx || (!fx.live.length && !fx.fallback.length)) { el.hidden = true; return; }
  el.hidden = false;

  const bits = [];
  if (fx.live.length) bits.push(`ECB 일별 ${fx.live.join(', ')}${fx.asOf ? ` (~${fx.asOf})` : ''}`);
  if (fx.fallback.length) {
    const known = fx.fallback.filter(c => !fx.missing.includes(c));
    if (known.length) bits.push(`고정환율 ${known.join(', ')}`);
    if (fx.missing.length) bits.push(`<b class="warn">환율 없음, 0원 처리: ${fx.missing.join(', ')}</b>`);
  }
  if (fx.error) bits.push(`<b class="warn">환율 API 실패 — 고정환율로 계산됨</b>`);
  el.innerHTML = '환율 · ' + bits.join(' · ');
}

/* ── SVG 유틸 ────────────────────────────────────── */
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, text) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
}

function niceTicks(min, max, count) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(v);
  return out;
}

function frame(host, h) {
  host.textContent = '';
  const w = Math.max(host.clientWidth || 640, 300);
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, style: `height:${h}px` });
  host.appendChild(svg);
  const tip = document.createElement('div');
  tip.className = 'tip';
  host.appendChild(tip);
  return { svg, tip, w, h };
}

function xLabels(svg, rows, x, y) {
  const step = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach((r, i) => {
    if (i % step && i !== rows.length - 1) return;
    svg.appendChild(el('text', { class: 'x-label', x: x(i), y }, mmdd(r.date)));
  });
}

/* 데이터 끝만 둥글게(4px), 기준선 쪽은 각지게 */
function barPath(x, y, w, h, up, round = true) {
  const r = round ? Math.min(4, w / 2, h) : 0;
  if (!r) return `M${x},${y} h${w} v${h} h${-w} Z`;
  return up
    ? `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} ` +
      `Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`
    : `M${x},${y} L${x},${y + h - r} Q${x},${y + h} ${x + r},${y + h} L${x + w - r},${y + h} ` +
      `Q${x + w},${y + h} ${x + w},${y + h - r} L${x + w},${y} Z`;
}

/* ── 툴팁 ────────────────────────────────────────── */
function showTip(tip, host, px, rowsHtml, dateText) {
  tip.textContent = '';
  const d = document.createElement('div');
  d.className = 'tip-date';
  d.textContent = dateText;
  tip.appendChild(d);

  for (const r of rowsHtml) {
    if (r.sep) { const s = document.createElement('div'); s.className = 'tip-sep'; tip.appendChild(s); continue; }
    const row = document.createElement('div');
    row.className = 'tip-row';
    const k = document.createElement('i');
    k.className = 'tip-key';
    k.style.background = r.color;
    const n = document.createElement('span');
    n.className = 'tip-name';
    n.textContent = r.name;
    const v = document.createElement('span');
    v.className = 'tip-val';
    v.textContent = r.value;
    row.append(k, n, v);
    tip.appendChild(row);
    if (r.fx) {
      const f = document.createElement('div');
      f.className = 'tip-fx';
      f.textContent = r.fx;
      tip.appendChild(f);
    }
  }

  tip.classList.add('is-on');
  const w = tip.offsetWidth, hw = host.clientWidth;
  tip.style.left = Math.max(4, Math.min(px - w / 2, hw - w - 4)) + 'px';
  tip.style.top = '6px';
}
const hideTip = tip => tip.classList.remove('is-on');

function fxText(r, key) {
  const b = r.fx[key];
  if (!b) return '';
  return b.map(p =>
    `${p.cur} ${p.amt.toLocaleString('ko-KR')} × ${trim(p.rate)}원` +
    (p.src === 'fallback' ? ' (고정)' : p.src === 'carry' ? ` (${p.on} 고시)` :
     p.src === 'unknown' ? ' (환율 없음)' : '')).join(' · ');
}

/* ── 일별 ────────────────────────────────────────
 *
 * '둘 다'는 0선을 가운데 두고 위로 들어온 돈, 아래로 나간 돈을 마주 세운다 —
 * 같은 축이라 길이를 그대로 비교할 수 있다. 한쪽만 볼 때는 마주 세울 상대가 없으니
 * 기준선을 바닥으로 내리고 축을 다시 잡는다. 그래야 남은 계열이 화면을 다 쓴다.
 */
function dailySpec() {
  const { series } = state.cfg;
  const rev = series.filter(s => s.type !== 'spend');
  const spd = series.filter(s => s.type === 'spend');

  if (state.dailyView === 'rev') return {
    up: rev, down: [], profit: false,
    sub: '광고매출과 인앱매출만. 마케팅비를 뺀 축이라 매출이 적던 날의 차이도 보입니다.',
  };
  if (state.dailyView === 'spend') return {
    up: spd, down: [], profit: false,
    sub: '그날 태운 마케팅비만.',
  };
  return {
    up: rev, down: spd, profit: true,
    sub: '0선 위가 그날 들어온 돈, 아래가 그날 나간 마케팅비. 검은 선은 그날의 손익.',
  };
}

function drawDaily(rows) {
  const host = document.getElementById('chart-daily');
  const spec = dailySpec();
  document.getElementById('daily-sub').textContent = spec.sub;
  const shown = [...spec.up, ...spec.down];

  const H = 344, ML = 62, MR = 14, MT = 26, MB = 46;   /* 위아래 라벨 자리 */
  const { svg, tip, w } = frame(host, H);
  const iw = w - ML - MR, ih = H - MT - MB;

  const total = (r, list) => list.reduce((a, s) => a + (r.val[s.key] || 0), 0);
  const mirrored = spec.down.length > 0;

  /* 마주 세울 때만 축을 반으로 접는다 */
  const zeroY = mirrored ? MT + ih / 2 : MT + ih;
  const reach = mirrored ? ih / 2 : ih;
  const cap = Math.max(1, ...rows.map(r => Math.max(
    total(r, spec.up), total(r, spec.down), spec.profit ? Math.abs(r.profit) : 0)));
  const sc = v => (v / cap) * reach;

  const band = iw / rows.length;
  const bw = Math.max(3, Math.min(24, band * 0.55));
  const x = i => ML + band * (i + 0.5);

  niceTicks(0, cap, 4).forEach(v => {
    if (v <= 0) return;
    (mirrored ? [1, -1] : [1]).forEach(sign => {
      const y = zeroY - sign * sc(v);
      svg.appendChild(el('line', { class: 'g-line', x1: ML, x2: w - MR, y1: y, y2: y }));
      svg.appendChild(el('text', { class: 'g-label', x: ML - 10, y: y + 4, 'text-anchor': 'end' },
        short(v)));
    });
  });

  const bands = rows.map((r, i) => {
    const b = el('rect', { class: 'band', x: ML + band * i, y: MT, width: band, height: ih });
    svg.appendChild(b);
    return b;
  });

  /* 조각은 테두리가 아니라 표면색 2px 틈으로 가른다. 바깥 끝(데이터 끝)만 둥글다. */
  const stack = (r, i, list, dir) => {
    const items = list.map(s => ({ s, v: r.val[s.key] || 0 })).filter(o => o.v > 0);
    let acc = 0;
    items.forEach((o, k) => {
      const isEnd = k === items.length - 1;
      const h = Math.max(1, sc(o.v) - (isEnd ? 0 : GAP));   /* 틈은 바깥쪽에 남긴다 */
      const y = dir > 0 ? zeroY - sc(acc) - h : zeroY + sc(acc);
      svg.appendChild(el('path', {
        d: barPath(x(i) - bw / 2, y, bw, h, dir > 0, isEnd),
        fill: o.s.color,
      }));
      acc += o.v;
    });
  };

  rows.forEach((r, i) => { stack(r, i, spec.up, +1); stack(r, i, spec.down, -1); });

  /* 막대 끝 숫자. 조각마다 붙이면 안쪽 조각엔 붙일 자리가 없으므로 기둥 합계만 캡에 얹는다.
     좁아서 겹칠 것 같으면 자르지 않고 건너뛰되, 몇 칸마다 찍었는지 부제에 밝힌다. */
  const textW = t => [...t].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 10 : 5.6), 0);
  const caps = rows.map(r => [total(r, spec.up), total(r, spec.down)]);
  const widest = Math.max(6, ...caps.flat().filter(v => v > 0).map(v => textW(short(v))));
  const step = Math.max(1, Math.ceil((widest + 8) / band));

  rows.forEach((r, i) => {
    if (i % step) return;
    const [up, down] = caps[i];
    if (up > 0) svg.appendChild(el('text', { class: 'bar-label', x: x(i), y: zeroY - sc(up) - 7 },
      short(up)));
    if (down > 0) svg.appendChild(el('text', { class: 'bar-label', x: x(i), y: zeroY + sc(down) + 14 },
      short(down)));
  });

  if (step > 1) {
    const sub = document.getElementById('daily-sub');
    sub.textContent += ` 막대가 좁아 숫자는 ${step}칸마다 표시합니다.`;
  }

  svg.appendChild(el('line', { class: 'g-zero', x1: ML, x2: w - MR, y1: zeroY, y2: zeroY }));

  if (spec.profit) {
    svg.appendChild(el('path', {
      d: rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${zeroY - sc(r.profit)}`).join(' '),
      fill: 'none', stroke: INK, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }

  xLabels(svg, rows, x, H - 10);

  attachHover(host, svg, tip, rows, band, ML, bands, null, null, r => [
    ...shown.map(s => ({ color: s.color, name: s.label, value: won(r.val[s.key] || 0),
                         fx: fxText(r, s.key) })),
    ...(spec.profit ? [{ sep: true }, { color: INK, name: '손익', value: won(r.profit) }] : []),
  ]);

  /* 계열이 하나뿐이면 범례는 제목이 이미 한 말을 되풀이할 뿐이라 달지 않는다 */
  const used = s => rows.some(r => (r.val[s.key] || 0) > 0);
  const keys = [...shown.filter(used).map(s => ({ color: s.color, name: s.label })),
                ...(spec.profit ? [{ color: INK, name: '그날 손익', line: true }] : [])];
  legend(document.getElementById('legend-daily'), keys.length > 1 ? keys : []);
}


/* ── 누적 ────────────────────────────────────────
 *
 * 누적값은 정의상 단조증가라 막대로 그리면 같은 램프를 무겁게 다시 그릴 뿐이다.
 * 여기서 읽고 싶은 건 크기가 아니라 기울기라서 선이 맞다. 셋을 쌓는 면적도 틀리다 —
 * 광고+인앱은 부분-전체지만 마케팅비는 그 전체의 일부가 아니라 부호가 반대인 값이다.
 *
 * '둘 다'는 회수 여부 하나만 답하게 두 선으로 줄이고 사이를 칠한다. 그 면적이 곧
 * 미회수액이고, 두 선이 만나는 날이 회수 완료일이다. 누적 손익 선을 따로 그리는 건
 * 두 선의 차이를 한 번 더 그리는 중복이라 뺐다 — 숫자는 툴팁과 히어로에 남는다.
 * 계열이 하나뿐인 '비용만'은 면적으로 채운다(면적은 단일 계열일 때만 맞다).
 */
function cumSpec() {
  const { series } = state.cfg;
  const rev = series.filter(s => s.type !== 'spend');
  const spd = series.filter(s => s.type === 'spend');
  const sumOf = list => r => list.reduce((a, s) => a + (r.cum[s.key] || 0), 0);
  const revSum = sumOf(rev), spdSum = sumOf(spd);

  if (state.cumView === 'rev') return {
    lines: [...rev.map(s => ({ color: s.color, name: '누적 ' + s.label, pick: r => r.cum[s.key] || 0 })),
            { color: INK, name: '누적 매출 합계', pick: revSum, width: 2.5 }],
    sub: '광고매출과 인앱매출만. 마케팅비 축에 눌리지 않아 두 매출의 기울기가 보입니다.',
  };

  if (state.cumView === 'spend') return {
    lines: spd.map(s => ({ color: s.color, name: '누적 ' + s.label, pick: r => r.cum[s.key] || 0 })),
    area: { color: spd[0] ? spd[0].color : INK, pick: spdSum },
    sub: '마케팅비만. 지금까지 태운 총액이 어떤 속도로 늘고 있는지 봅니다.',
  };

  return {
    lines: [{ color: INK, name: '누적 매출 합계', pick: revSum, width: 2.5 },
            ...spd.map(s => ({ color: s.color, name: '누적 ' + s.label, pick: r => r.cum[s.key] || 0 }))],
    band: { hi: revSum, lo: spdSum },
    extraTip: r => [{ sep: true }, { color: INK, name: '누적 손익', value: won(r.cumProfit) }],
    sub: '두 선 사이의 칠해진 면적이 아직 회수 못 한 금액입니다. 선이 교차하는 날이 마케팅비를 다 회수한 날이고, ' +
         '그때부터 색이 뒤집힙니다. 광고매출과 인앱매출을 나눠 보려면 “매출만”으로 바꾸세요.',
  };
}

/* 두 선 사이를 부호별로 잘라 칠한다. 교차점에서 끊어 이어붙이므로
   부호가 바뀌는 날에도 색이 정직하다(클립으로 자르면 경계가 어긋난다). */
function bandPaths(rows, x, y, hi, lo) {
  const p = rows.map((r, i) => ({ x: x(i), h: hi(r), l: lo(r) }));
  const out = [];
  let seg = null;

  const open = sign => (seg = { sign, top: [], bot: [] });
  const at = (px, hv, lv) => { seg.top.push(`${px},${y(hv)}`); seg.bot.push(`${px},${y(lv)}`); };

  p.forEach((pt, i) => {
    const d = pt.h - pt.l;
    const sign = d >= 0 ? 1 : -1;
    if (i === 0) open(sign);
    else {
      const dPrev = p[i - 1].h - p[i - 1].l;
      if ((dPrev >= 0 ? 1 : -1) !== sign && dPrev !== d) {
        const t = dPrev / (dPrev - d);
        const cx = p[i - 1].x + t * (pt.x - p[i - 1].x);
        const cv = p[i - 1].h + t * (pt.h - p[i - 1].h);
        at(cx, cv, cv);
        out.push(seg);
        open(sign);
        at(cx, cv, cv);
      }
    }
    at(pt.x, pt.h, pt.l);
  });
  if (seg) out.push(seg);

  return out
    .filter(s => s.top.length > 1)
    .map(s => ({ sign: s.sign, d: `M${s.top.join(' L')} L${s.bot.slice().reverse().join(' L')} Z` }));
}

function drawCum(rows) {
  const host = document.getElementById('chart-cum');
  const spec = cumSpec();
  document.getElementById('cum-sub').textContent = spec.sub;

  const H = 300, ML = 62, MR = 14, MT = 18, MB = 30;
  const { svg, tip, w } = frame(host, H);
  const iw = w - ML - MR, ih = H - MT - MB;

  const all = rows.flatMap(r => spec.lines.map(L => L.pick(r)));
  const lo = Math.min(0, ...all), hi = Math.max(1, ...all);
  const pad = (hi - lo) * 0.08;
  const y = v => MT + ih * (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad)));
  const band = iw / rows.length;
  const x = i => ML + (rows.length === 1 ? iw / 2 : iw * (i / (rows.length - 1)));

  niceTicks(lo - pad, hi + pad, 4).forEach(v => {
    svg.appendChild(el('line', { class: 'g-line', x1: ML, x2: w - MR, y1: y(v), y2: y(v) }));
    svg.appendChild(el('text', { class: 'g-label', x: ML - 10, y: y(v) + 4, 'text-anchor': 'end' },
      short(v)));
  });
  svg.appendChild(el('line', { class: 'g-zero', x1: ML, x2: w - MR, y1: y(0), y2: y(0) }));

  let signs = [];
  if (spec.band) {
    const paths = bandPaths(rows, x, y, spec.band.hi, spec.band.lo);
    signs = [...new Set(paths.map(p => p.sign))];
    paths.forEach(p => svg.appendChild(el('path', {
      d: p.d, fill: p.sign > 0 ? 'var(--good)' : 'var(--bad)', 'fill-opacity': .12,
    })));
  }
  if (spec.area) {
    svg.appendChild(el('path', {
      d: `M${x(0)},${y(0)} ` + rows.map((r, i) => `L${x(i)},${y(spec.area.pick(r))}`).join(' ') +
         ` L${x(rows.length - 1)},${y(0)} Z`,
      fill: spec.area.color, 'fill-opacity': .10,
    }));
  }

  const cross = el('line', { x1: 0, x2: 0, y1: MT, y2: MT + ih,
    stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0 });
  svg.appendChild(cross);

  spec.lines.forEach(L => {
    svg.appendChild(el('path', {
      d: rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${y(L.pick(r))}`).join(' '),
      fill: 'none', stroke: L.color, 'stroke-width': L.width || 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  });

  /* 끝점 마커는 표면색 2px 링을 둘러 선 위에서도 읽히게 한다 */
  const lastI = rows.length - 1;
  spec.lines.forEach(L => {
    svg.appendChild(el('circle', { cx: x(lastI), cy: y(L.pick(rows[lastI])), r: 4,
      fill: L.color, stroke: SURFACE, 'stroke-width': GAP }));
  });

  const dots = spec.lines.map(L => {
    const c = el('circle', { r: 4, fill: L.color, stroke: SURFACE, 'stroke-width': GAP, opacity: 0 });
    svg.appendChild(c);
    return { c, L };
  });

  xLabels(svg, rows, x, H - 10);

  attachHover(host, svg, tip, rows, band, ML, null, i => {
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    cross.setAttribute('opacity', 1);
    dots.forEach(({ c, L }) => {
      c.setAttribute('cx', x(i)); c.setAttribute('cy', y(L.pick(rows[i])));
      c.setAttribute('opacity', 1);
    });
  }, () => {
    cross.setAttribute('opacity', 0);
    dots.forEach(({ c }) => c.setAttribute('opacity', 0));
  }, r => [
    ...spec.lines.map(L => ({ color: L.color, name: L.name, value: won(L.pick(r)) })),
    ...(spec.extraTip ? spec.extraTip(r) : []),
  ]);

  /* 계열이 하나뿐이면 범례는 제목이 이미 한 말을 되풀이할 뿐이라 달지 않는다 */
  const keys = [
    ...spec.lines.map(L => ({ color: L.color, name: L.name, line: true })),
    ...(signs.includes(-1) ? [{ color: 'var(--bad)', name: '미회수', wash: true }] : []),
    ...(signs.includes(1) ? [{ color: 'var(--good)', name: '회수분', wash: true }] : []),
  ];
  legend(document.getElementById('legend-cum'), keys.length > 1 ? keys : []);
}


/* 포인터는 날짜만 맞히면 된다 — 가장 가까운 열을 잡는다 */
function attachHover(host, svg, tip, rows, band, ML, bands, onIn, onOut, rowsFn) {
  const pick = e => {
    const box = svg.getBoundingClientRect();
    const px = (e.clientX - box.left) * (svg.viewBox.baseVal.width / box.width);
    return Math.max(0, Math.min(rows.length - 1, Math.floor((px - ML) / band)));
  };
  const move = e => {
    const i = pick(e);
    const r = rows[i];
    if (bands) bands.forEach((b, k) => b.classList.toggle('is-on', k === i));
    if (onIn) onIn(i);
    const box = svg.getBoundingClientRect();
    showTip(tip, host, e.clientX - box.left, rowsFn(r), r.date);
  };
  const out = () => {
    hideTip(tip);
    if (bands) bands.forEach(b => b.classList.remove('is-on'));
    if (onOut) onOut();
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', out);
}

function legend(host, items) {
  host.textContent = '';
  for (const it of items) {
    const k = document.createElement('span');
    k.className = 'key';
    const sw = document.createElement('i');
    sw.className = 'sw' + (it.line ? ' line' : it.wash ? ' wash' : '');
    sw.style.background = it.color;
    k.appendChild(sw);
    k.appendChild(document.createTextNode(it.name));
    host.appendChild(k);
  }
}

/* ── 원장 ────────────────────────────────────────── */
function renderLedger(rows) {
  const { series } = state.cfg;
  const money = v => (Math.round(v) ? num(v) : '·');
  const t = document.getElementById('ledger');
  t.textContent = '';

  const thead = t.createTHead().insertRow();
  ['날짜', ...series.map(s => s.label), '손익', '누적 손익'].forEach((h, i) => {
    const th = document.createElement('th');
    if (!i) th.className = 'date';
    th.textContent = h;
    thead.appendChild(th);
  });

  const tbody = t.createTBody();
  rows.slice().reverse().forEach(r => {
    const tr = tbody.insertRow();
    const d = tr.insertCell(); d.className = 'date'; d.textContent = r.date;
    series.forEach(s => {
      const td = tr.insertCell();
      td.textContent = money(r.val[s.key] || 0);
      if (r.fx[s.key]) {
        td.title = fxText(r, s.key);
        const m = document.createElement('i');
        m.className = 'fx-mark';
        m.textContent = '*';
        td.appendChild(m);
      }
    });
    const p = tr.insertCell(); p.className = r.profit >= 0 ? 'pos' : 'neg'; p.textContent = money(r.profit);
    const c = tr.insertCell(); c.className = r.cumProfit >= 0 ? 'pos' : 'neg'; c.textContent = money(r.cumProfit);
  });

  const sum = k => rows.reduce((s, r) => s + (r.val[k] || 0), 0);
  const tp = rows.reduce((s, r) => s + r.profit, 0);
  const tf = t.createTFoot().insertRow();
  const fd = tf.insertCell(); fd.className = 'date'; fd.textContent = '합계';
  series.forEach(s => (tf.insertCell().textContent = money(sum(s.key))));
  const fp = tf.insertCell(); fp.className = tp >= 0 ? 'pos' : 'neg'; fp.textContent = money(tp);
  tf.insertCell().textContent = '·';
}

/* ── 데모 데이터 (결정론적) ──────────────────────── */
function demoData() {
  let seed = 20260904;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const daily = [];
  for (let i = 59; i >= 0; i--) {
    const ramp = (60 - i) / 60;
    const k = 0.7 + rnd() * 0.6;
    daily.push({
      date: daysAgo(i),
      admob: Math.round((2000 + 9000 * ramp) * k / 10) * 10,
      iap: { KRW: Math.round((3000 + 12000 * ramp) * k / 100) * 100,
             USD: +((2 + 9 * ramp) * k).toFixed(2),
             JPY: Math.round((150 + 700 * ramp) * k / 10) * 10 },
      ads: i > 42 ? 0 : Math.round((8000 + 26000 * ramp) * k / 100) * 100,
    });
  }
  return { updated: todayKST(), daily };
}

/* ── 부팅 ────────────────────────────────────────── */
document.querySelector('.toolbar').addEventListener('click', e => {
  const b = e.target.closest('.tab');
  if (!b) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-on', t === b));
  state.days = +b.dataset.days;
  render();
});

/* 카드 안의 표시 범위 전환 — 기간 필터와 달리 그 차트 하나만 다시 그린다 */
function wireSeg(id, key, redraw) {
  document.getElementById(id).addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    document.querySelectorAll(`#${id} .seg-btn`).forEach(t => t.classList.toggle('is-on', t === b));
    state[key] = b.dataset.view;
    const rows = visible();
    if (rows.length) redraw(rows);
  });
}
wireSeg('daily-view', 'dailyView', drawDaily);
wireSeg('cum-view', 'cumView', drawCum);

/* 수수료는 표시 방식이 아니라 계산 기준이라 차트별로 두지 않는다 —
   차트마다 다르면 같은 화면 안에서 숫자가 서로 안 맞는다. */
document.getElementById('fee-toggle').addEventListener('change', e => {
  state.applyFee = e.target.checked;
  try { localStorage.setItem('applyFee', state.applyFee ? '1' : '0'); } catch {}
  if (state.raw.length) recompute();
});

let rt;
addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(() => { if (state.rows.length) render(); }, 160);
});

load().catch(err => {
  const e = document.getElementById('empty');
  e.hidden = false;
  e.innerHTML = `<h2>데이터를 못 읽었습니다</h2><pre></pre>
    <p><code>file://</code>로 열면 fetch가 막힙니다. <code>python3 -m http.server</code> 로 여세요.</p>`;
  e.querySelector('pre').textContent = String(err);
});
