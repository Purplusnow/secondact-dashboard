/* 실시간(스트리밍) 뷰 — docs/data/realtime.json 만 읽는다.
 *
 * 인게임 뷰(완결 일별)와 데이터도 로직도 완전히 분리돼 있다. 두 값을 합치거나 비교하는
 * 코드는 여기에도 저기에도 없어야 한다 — intraday 는 '하루가 덜 찬' 값이라 섞는 순간 거짓이 된다.
 */
(() => {
  const $ = s => document.querySelector(s);
  const num = n => Math.round(n || 0).toLocaleString('ko-KR');
  let loaded = false;

  /* ingame.js 의 show() 가 뷰 전환 때 불러준다 */
  window.__viewShown = view => {
    if (view === 'realtime' && !loaded) { loaded = true; load(); }
  };

  async function load() {
    let d;
    try {
      const res = await fetch('data/realtime.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      d = await res.json();
    } catch { $('#rt-empty').hidden = false; return; }

    if (!d || !(d.tables || []).length) { $('#rt-empty').hidden = false; return; }

    const s = d.summary || {};
    $('#rt-meta').textContent =
      `수집 ${d.updated}` +
      (s.first_at ? `  ·  데이터 범위 ${s.first_at} ~ ${s.last_at} (KST)` : '') +
      (d.scan_mb != null ? `  ·  스캔 ${d.scan_mb}MB` : '');

    tiles([
      ['접속 유저', num(s.users), '스트리밍 켠 뒤 누적'],
      ['이벤트', num(s.events), ''],
      ['신규 설치', num(s.new_users), 'first_open'],
      ['결제', num(s.purchases), 'purchase 이벤트'],
      ['예외', num(s.exceptions), 'app_exception', (s.exceptions || 0) > 0],
    ]);

    hourly(d.hourly || []);
    table('#rt-events', ['이벤트', '건수', '유저'], (d.events || []).map(r => [r.name, num(r.n), num(r.users)]));
    table('#rt-versions', ['버전', '유저', '이벤트'], (d.versions || []).map(r => [r.v, num(r.users), num(r.events)]));
    table('#rt-countries', ['국가', '유저'], (d.countries || []).map(r => [r.c, num(r.users)]));
  }

  function tiles(rows) {
    const host = $('#rt-tiles');
    host.textContent = '';
    for (const [label, value, sub, warn] of rows) {
      const el = document.createElement('div');
      el.className = 'tile';
      const l = document.createElement('div'); l.className = 'tile-label'; l.textContent = label;
      const v = document.createElement('div'); v.className = 'tile-value num'; v.textContent = value;
      if (warn) v.style.color = 'var(--bad)';
      const b = document.createElement('div'); b.className = 'tile-sub'; b.textContent = sub;
      el.append(l, v, b);
      host.appendChild(el);
    }
  }

  function table(sel, head, rows) {
    const t = $(sel);
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    head.forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });
    const tb = t.createTBody();
    if (!rows.length) {
      const td = tb.insertRow().insertCell();
      td.colSpan = head.length; td.textContent = '없음';
      return;
    }
    rows.forEach(r => {
      const tr = tb.insertRow();
      r.forEach((c, i) => { const td = tr.insertCell(); if (!i) td.className = 'date'; td.textContent = c; });
    });
  }

  /* 막대는 인게임·매출 뷰와 같은 규격을 따른다 — 데이터 끝만 둥글게, 그리드는 실선 헤어라인 */
  function hourly(rows) {
    const host = $('#rt-hourly');
    host.textContent = '';
    if (!rows.length) { host.innerHTML = '<div class="no-data">데이터 없음</div>'; return; }

    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, a) => { const n = document.createElementNS(NS, tag);
      for (const k in a) if (a[k] != null) n.setAttribute(k, a[k]); return n; };

    const H = 220, ML = 54, MR = 12, MT = 18, MB = 34;
    const w = Math.max(host.clientWidth || 640, 300);
    const svg = el('svg', { viewBox: `0 0 ${w} ${H}`, style: `height:${H}px` });
    host.appendChild(svg);

    const iw = w - ML - MR, ih = H - MT - MB;
    const cap = Math.max(1, ...rows.map(r => r.events));
    const band = iw / rows.length, bw = Math.max(3, Math.min(26, band * 0.6));
    const x = i => ML + band * (i + 0.5);
    const y = v => MT + ih * (1 - v / cap);

    [0, 0.5, 1].forEach(f => {
      const v = cap * f;
      svg.appendChild(el('line', { class: 'g-line', x1: ML, x2: w - MR, y1: y(v), y2: y(v) }));
      const lb = el('text', { class: 'g-label', x: ML - 8, y: y(v) + 4, 'text-anchor': 'end' });
      lb.textContent = num(v);
      svg.appendChild(lb);
    });
    rows.forEach((r, i) => {
      const h = Math.max(1, ih - (y(r.events) - MT));
      svg.appendChild(el('rect', { x: x(i) - bw / 2, y: y(r.events), width: bw, height: h,
        fill: '#2a78d6', rx: 3 }));
      const t = el('title'); t.textContent = `${r.h}시  유저 ${num(r.users)} · 이벤트 ${num(r.events)}`;
      svg.lastChild.appendChild(t);
    });
    const step = Math.max(1, Math.ceil(rows.length / 10));
    rows.forEach((r, i) => {
      if (i % step && i !== rows.length - 1) return;
      const tx = el('text', { class: 'x-label', x: x(i), y: H - 10 });
      tx.textContent = r.h.slice(-2) + '시';
      svg.appendChild(tx);
    });
  }
})();
