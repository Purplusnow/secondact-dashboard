/* 위험 신호 — docs/data/anomaly.json.
 *
 * 탭과 무관하게 항상 읽는다. 어느 화면을 보고 있든 눈에 들어와야 하는 종류라서,
 * 경고 단계일 때만 상단에 띠를 띄운다. 평소(ok)에는 아무것도 그리지 않는다 —
 * 늘 떠 있는 경고는 며칠이면 안 보이게 된다.
 */
(() => {
  const $ = s => document.querySelector(s);
  const num = n => Math.round(n || 0).toLocaleString('ko-KR');

  load();

  async function load() {
    let d;
    try {
      const res = await fetch(`data/anomaly.json?t=${Math.floor(Date.now() / 3600000)}`);
      if (!res.ok) return;
      d = await res.json();
    } catch { return; }
    if (!d || !d.signals) return;

    render(d);
  }

  function render(d) {
    const host = $('#risk');
    if (!host) return;
    host.textContent = '';
    host.className = 'risk is-' + (d.level || 'ok');

    // ok 면 띠를 안 띄운다. 대신 인게임 뷰 하단에 조용한 한 줄로만 남긴다.
    const quiet = d.level === 'ok';
    host.hidden = quiet;

    const on = (d.signals || []).filter(s => s.recent > 0);
    const head = document.createElement('b');
    head.textContent = d.level === 'alert' ? '위험 — 조작 유저가 번지고 있습니다'
      : '주의 — 조작 의심 유저가 늘고 있습니다';
    const body = document.createElement('span');
    body.textContent =
      ` 최근 ${d.window_days}일 ${num(d.recent)}명`
      + (d.recent_base ? ` / 신규 ${num(d.recent_base)}명 (${d.recent_rate}%)` : '')
      + (on.length ? ' · ' + on.map(s => `${s.label} ${s.recent}`).join(' · ') : '')
      + ` · 누적 ${num(d.total)}명`;
    host.append(head, body);

    detail(d);
  }

  /* 자세한 내역은 인게임 뷰에 둔다 — 밸런스 숫자를 보는 자리에서 "이만큼은 가짜"를
     같이 봐야 판단이 선다. 여긴 ok 여도 항상 그린다. */
  function detail(d) {
    const card = $('#risk-card');
    if (!card) return;
    card.hidden = false;
    $('#risk-sub').textContent =
      `수집 ${d.updated} · 누적 ${num(d.total)}명 · 최근 ${d.window_days}일 ${num(d.recent)}명`
      + (d.recent_base ? ` (신규의 ${d.recent_rate}%)` : '')
      + ` · 경고선 ${d.thresholds.warn_n}명 또는 ${d.thresholds.warn_rate}%`;

    const t = $('#risk-table');
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    ['신호', '누적', `최근 ${d.window_days}일`, '무엇을 잡나'].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i || i === 3) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });
    const tb = t.createTBody();
    for (const s of d.signals || []) {
      const tr = tb.insertRow();
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      c(s.label, 'date');
      c(num(s.total));
      const r = c(num(s.recent));
      if (s.recent > 0) r.className = 'neg';
      c(s.desc, 'date');
    }

    const list = $('#risk-users');
    list.textContent = '';
    const us = (d.users || []).slice(0, 20);
    if (!us.length) { list.textContent = '해당 유저가 없습니다.'; return; }
    for (const u of us) {
      const row = document.createElement('div');
      row.className = 'risk-row';
      row.textContent = `${u.day}  ${u.tag}  `
        + u.kinds.map(k => k === 'clock_drift'
            ? `시계 +${u.drift_h}시간`
            : `설치 1시간 내 ${u.early_pct}%`).join(' · ')
        + (u.max_pct ? `  (최고 ${u.max_pct}%)` : '');
      list.appendChild(row);
    }
  }
})();
