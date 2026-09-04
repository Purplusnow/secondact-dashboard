/* SECONDACT BOARD — 광고매출 · 인앱매출 · 마케팅비
 *
 * 입력은 손으로 넣은 data/daily.json 한 장이 전부다. 화면이 하는 일은 셋뿐:
 *   (1) 구글플레이에 찍힌 각국 통화를 그날 환율로 원화로 바꾸고
 *   (2) 인앱매출에서 스토어 수수료를 떼고
 *   (3) 일별과 누적으로 그린다.
 *
 * 환율은 ECB 기준(api.frankfurter.dev)을 날짜별로 한 번에 받아 쓴다. 주말·공휴일은
 * 고시가 없으므로 직전 영업일 환율을 끌어다 쓰고, ECB가 안 다루는 통화(VND 등)와
 * API가 죽은 경우는 config.json 의 fx_fallback 고정환율로 떨어진다.
 */

const FX_API = 'https://api.frankfurter.dev/v1';
const FX_TTL = 6 * 3600e3;

const state = { cfg: null, rows: [], days: 0, fx: null };

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
  const fx = { byDate: {}, dates: [], live: [], fallback: [], asOf: null, error: null };
  if (!currencies.length || !daily.length) return fx;

  const start = daily[0].date;
  const key = `fx:${start}:${currencies.slice().sort().join(',')}`;

  let payload = null;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached && Date.now() - cached.t < FX_TTL) payload = cached.p;
  } catch { /* localStorage 없거나 깨진 캐시 — 그냥 새로 받는다 */ }

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

  /* EUR 기준 고시가를 원화 환산율로 바꾼다: 1통화 = (KRW/EUR) / (통화/EUR) 원 */
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

  const covered = new Set(fx.dates.length ? Object.keys(fx.byDate[fx.asOf]) : []);
  currencies.forEach(c => (covered.has(c) ? fx.live : fx.fallback).push(c));
  fx.missing = fx.fallback.filter(c => !(c in fb));
  state.fx = fx;
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
    (state.cfg.fee_applies_to || []).map(k => labelOf(k)).join(' · ') || '없음';

  const daily = (data.daily || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));

  const has = daily.length > 0;
  document.getElementById('empty').hidden = has;
  document.getElementById('content').hidden = !has;
  if (!has) return;

  await loadFx(daily, currenciesUsed(daily, state.cfg.series));
  renderFxNote();

  state.rows = derive(daily);
  render();
}

const labelOf = k => (state.cfg.series.find(s => s.key === k) || {}).label || k;

/* 누적은 항상 전체 기간 기준으로 미리 깔아둔다 — 7일 탭에서도 누적 위치는 진짜여야 한다. */
function derive(raw) {
  const { series, store_fee } = state.cfg;
  const feeKeys = new Set(state.cfg.fee_applies_to || []);
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

  renderKpis(rows, last);
  if (!rows.length) {
    const msg = '<div class="no-data">이 기간에는 기록이 없습니다</div>';
    ['chart-daily', 'chart-cum'].forEach(id => (document.getElementById(id).innerHTML = msg));
    ['legend-daily', 'legend-cum'].forEach(id => (document.getElementById(id).innerHTML = ''));
    document.getElementById('ledger').innerHTML = '';
    return;
  }
  drawDaily(rows);
  drawCum(rows);
  renderLedger(rows);
}

function renderKpis(rows, last) {
  const sum = k => rows.reduce((s, r) => s + (r.val[k] || 0), 0);
  const rev = rows.reduce((s, r) => s + r.rev, 0);
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const roas = spend > 0 ? rev / spend : null;

  const tiles = state.cfg.series.map(s => ({
    label: s.label, accent: s.color, value: short(sum(s.key)) + '원',
    sub: '누적 ' + short(last.cum[s.key] || 0) + '원',
  }));

  tiles.push({
    label: '기간 손익', value: short(rev - spend) + '원',
    accent: rev - spend >= 0 ? 'var(--rev)' : 'var(--loss)',
    sub: roas === null ? '마케팅비 없음' : 'ROAS ' + pct(roas),
  });
  tiles.push({
    label: '누적 손익', value: short(last.cumProfit) + '원',
    accent: last.cumProfit >= 0 ? 'var(--rev)' : 'var(--loss)',
    sub: last.cumProfit >= 0 ? '전 기간 회수 완료' : '회수까지 ' + short(-last.cumProfit) + '원',
  });

  document.getElementById('kpis').innerHTML = tiles.map(t => `
    <div class="kpi" style="--accent:${t.accent}">
      <div class="kpi-label">${t.label}</div>
      <div class="kpi-value">${t.value}</div>
      <div class="kpi-sub">${t.sub}</div>
    </div>`).join('');
}

function renderFxNote() {
  const fx = state.fx, el = document.getElementById('fx-note');
  if (!fx || (!fx.live.length && !fx.fallback.length)) { el.hidden = true; return; }
  el.hidden = false;

  const bits = [];
  if (fx.live.length) bits.push(`ECB 일별 고시 ${fx.live.join(', ')}${fx.asOf ? ` (~${fx.asOf})` : ''}`);
  if (fx.fallback.length) {
    const known = fx.fallback.filter(c => !fx.missing.includes(c));
    if (known.length) bits.push(`고정환율 ${known.join(', ')}`);
    if (fx.missing.length) bits.push(`<b class="warn">환율 없음 — 0원 처리: ${fx.missing.join(', ')}</b>`);
  }
  if (fx.error) bits.push(`<b class="warn">환율 API 실패(${fx.error}) — 고정환율로 계산됨</b>`);
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
const tip = (node, text) => (node.appendChild(el('title', {}, text)), node);

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
  host.innerHTML = '';
  const w = Math.max(host.clientWidth || 640, 300);
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, style: `height:${h}px`, role: 'img' });
  host.appendChild(svg);
  return { svg, w, h };
}

function xLabels(svg, rows, x, y) {
  const step = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach((r, i) => {
    if (i % step && i !== rows.length - 1) return;
    svg.appendChild(el('text', { class: 'x-label', x: x(i), y }, mmdd(r.date)));
  });
}

const swatch = (color, label, line) =>
  `<span class="key"><i class="sw${line ? ' line' : ''}" style="background:${color}"></i>${label}</span>`;

/* ── 일별: 0선 위 매출, 아래 마케팅비 ───────────── */
function drawDaily(rows) {
  const host = document.getElementById('chart-daily');
  const { series } = state.cfg;
  const rev = series.filter(s => s.type !== 'spend');
  const spd = series.filter(s => s.type === 'spend');

  const H = 300, ML = 58, MR = 10, MT = 14, MB = 26;
  const { svg, w } = frame(host, H);
  const iw = w - ML - MR, ih = H - MT - MB;
  const zeroY = MT + ih / 2;

  const cap = Math.max(1, ...rows.map(r => Math.max(r.rev, r.spend, Math.abs(r.profit))));
  const sc = v => (v / cap) * (ih / 2);
  const bw = Math.max(2, Math.min(26, (iw / rows.length) * 0.62));
  const x = i => ML + iw * ((i + 0.5) / rows.length);

  niceTicks(0, cap, 4).forEach(v => {
    if (v <= 0) return;
    [1, -1].forEach(sign => {
      const y = zeroY - sign * sc(v);
      svg.appendChild(el('line', { class: 'g-line', x1: ML, x2: w - MR, y1: y, y2: y }));
      svg.appendChild(el('text', { class: 'g-label', x: ML - 8, y: y + 3, 'text-anchor': 'end' },
        short(v)));
    });
  });

  const stack = (r, i, list, dir) => {
    let acc = 0;
    list.forEach(s => {
      const v = r.val[s.key] || 0;
      if (v <= 0) return;
      const h = sc(v);
      const y = dir > 0 ? zeroY - sc(acc) - h : zeroY + sc(acc);
      svg.appendChild(tip(el('rect', { x: x(i) - bw / 2, y, width: bw,
        height: Math.max(0.8, h), fill: s.color, opacity: .9, rx: 1.5 }),
        `${r.date} ${s.label} ${won(v)}${fxTip(r, s.key)}`));
      acc += v;
    });
  };

  rows.forEach((r, i) => { stack(r, i, rev, +1); stack(r, i, spd, -1); });

  svg.appendChild(el('line', { class: 'g-zero', x1: ML, x2: w - MR, y1: zeroY, y2: zeroY }));
  svg.appendChild(el('path', {
    d: rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${zeroY - sc(r.profit)}`).join(' '),
    fill: 'none', stroke: '#eef2f9', 'stroke-width': 1.6, 'stroke-linejoin': 'round', opacity: .85,
  }));

  xLabels(svg, rows, x, H - 8);

  const used = k => rows.some(r => (r.val[k] || 0) > 0);
  document.getElementById('legend-daily').innerHTML =
    series.filter(s => used(s.key)).map(s => swatch(s.color, s.label)).join('') +
    swatch('#eef2f9', '그날 손익', true);
}

/* ── 누적: 세 계열 + 누적 손익 ──────────────────── */
function drawCum(rows) {
  const host = document.getElementById('chart-cum');
  const { series } = state.cfg;

  const H = 280, ML = 58, MR = 10, MT = 16, MB = 26;
  const { svg, w } = frame(host, H);
  const iw = w - ML - MR, ih = H - MT - MB;

  const all = rows.flatMap(r => [...series.map(s => r.cum[s.key] || 0), r.cumProfit]);
  const lo = Math.min(0, ...all), hi = Math.max(1, ...all);
  const pad = (hi - lo) * 0.08;
  const y = v => MT + ih * (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad)));
  const x = i => ML + (rows.length === 1 ? iw / 2 : iw * (i / (rows.length - 1)));
  const zeroY = y(0);

  niceTicks(lo - pad, hi + pad, 4).forEach(v => {
    svg.appendChild(el('line', { class: 'g-line', x1: ML, x2: w - MR, y1: y(v), y2: y(v) }));
    svg.appendChild(el('text', { class: 'g-label', x: ML - 8, y: y(v) + 3, 'text-anchor': 'end' },
      short(v)));
  });
  svg.appendChild(el('line', { class: 'g-zero', x1: ML, x2: w - MR, y1: zeroY, y2: zeroY }));

  const path = pick => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${y(pick(r))}`).join(' ');

  series.forEach(s => {
    svg.appendChild(el('path', { d: path(r => r.cum[s.key] || 0), fill: 'none',
      stroke: s.color, 'stroke-width': 1.8, 'stroke-linejoin': 'round', opacity: .85 }));
  });

  /* 계열 색과 겹치면 안 되므로 손익은 일별 차트와 같은 흰 선으로 통일한다 */
  svg.appendChild(el('path', { d: path(r => r.cumProfit), fill: 'none', stroke: '#eef2f9',
    'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  rows.forEach((r, i) => {
    svg.appendChild(tip(el('rect', { x: x(i) - iw / rows.length / 2, y: MT,
      width: iw / rows.length, height: ih, fill: 'transparent' }),
      [`${r.date}`, ...series.map(s => `누적 ${s.label} ${won(r.cum[s.key] || 0)}`),
       `누적 손익 ${won(r.cumProfit)}`].join('\n')));
  });

  xLabels(svg, rows, x, H - 8);

  document.getElementById('legend-cum').innerHTML =
    series.map(s => swatch(s.color, '누적 ' + s.label)).join('') +
    swatch('#eef2f9', '누적 손익', true);
}

/* ── 원장 ────────────────────────────────────────── */
function fxTip(r, key) {
  const b = r.fx[key];
  if (!b) return '';
  return '\n' + b.map(p =>
    `${p.cur} ${p.amt.toLocaleString('ko-KR')} × ${trim(p.rate)}원` +
    (p.src === 'fallback' ? ' (고정환율)' : p.src === 'carry' ? ` (${p.on} 고시)` :
     p.src === 'unknown' ? ' (환율 없음)' : '')).join('\n');
}

function renderLedger(rows) {
  const { series } = state.cfg;
  const head = ['날짜', ...series.map(s => s.label), '손익', '누적 손익'];
  const money = v => (Math.round(v) ? num(v) : '·');

  const body = rows.slice().reverse().map(r => `<tr>
    <td class="date">${r.date}</td>
    ${series.map(s => `<td class="${s.type === 'spend' ? 'spend' : ''}"${
      r.fx[s.key] ? ` title="${fxTip(r, s.key).trim().replace(/"/g, '&quot;')}"` : ''
    }>${money(r.val[s.key] || 0)}${r.fx[s.key] ? '<i class="fx-mark">*</i>' : ''}</td>`).join('')}
    <td class="${r.profit >= 0 ? 'pos' : 'neg'}">${money(r.profit)}</td>
    <td class="${r.cumProfit >= 0 ? 'pos' : 'neg'}">${money(r.cumProfit)}</td>
  </tr>`).join('');

  const t = k => rows.reduce((s, r) => s + (r.val[k] || 0), 0);
  const tp = rows.reduce((s, r) => s + r.profit, 0);
  const foot = `<tr>
    <td class="date">합계</td>
    ${series.map(s => `<td class="${s.type === 'spend' ? 'spend' : ''}">${money(t(s.key))}</td>`).join('')}
    <td class="${tp >= 0 ? 'pos' : 'neg'}">${money(tp)}</td>
    <td>·</td>
  </tr>`;

  document.getElementById('ledger').innerHTML =
    `<thead><tr>${head.map((h, i) => `<th class="${i ? '' : 'date'}">${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${body}</tbody><tfoot>${foot}</tfoot>`;
}

/* ── 데모 데이터 (결정론적) ──────────────────────── */
function demoData() {
  let seed = 20260904;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const daily = [];
  for (let i = 59; i >= 0; i--) {
    const ramp = (60 - i) / 60;
    const scale = 0.7 + rnd() * 0.6;
    daily.push({
      date: daysAgo(i),
      admob: Math.round((2000 + 9000 * ramp) * scale / 10) * 10,
      iap: {
        KRW: Math.round((3000 + 12000 * ramp) * scale / 100) * 100,
        USD: +((2 + 9 * ramp) * scale).toFixed(2),
        JPY: Math.round((150 + 700 * ramp) * scale / 10) * 10,
      },
      ads: i > 42 ? 0 : Math.round((8000 + 26000 * ramp) * scale / 100) * 100,
    });
  }
  return { updated: todayKST(), daily };
}

/* ── 부팅 ────────────────────────────────────────── */
document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab');
  if (!b) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-on', t === b));
  state.days = +b.dataset.days;
  render();
});

let rt;
addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(() => { if (state.rows.length) render(); }, 160);
});

load().catch(err => {
  const e = document.getElementById('empty');
  e.hidden = false;
  e.innerHTML = `<h2>데이터를 못 읽었습니다</h2><pre>${err}</pre>
    <p><code>file://</code>로 열면 fetch가 막힙니다. <code>python3 -m http.server</code> 로 여세요.</p>`;
});
