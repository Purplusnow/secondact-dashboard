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

    // 구간별 과대표집 — 전체 비율만 보면 '작으니 무시'로 가는데, 깊은 구간에선 몇 배가 된다.
    const seg = $('#risk-seg');
    seg.textContent = '';
    for (const r of d.segments || []) {
      if (!r.users) continue;
      const row = document.createElement('div');
      row.className = 'fn-row';
      const lab = document.createElement('span');
      lab.className = 'fn-label'; lab.style.width = '84px'; lab.textContent = r.seg;
      const track = document.createElement('span'); track.className = 'fn-track';
      const fill = document.createElement('i');
      // 눈금은 10% 고정 — 구간끼리 길이를 바로 비교하려면 축이 같아야 한다
      fill.style.width = Math.min(100, r.pct * 10) + '%';
      if (r.mult && r.mult >= 3) fill.style.background = 'var(--bad)';
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'fn-val';
      val.textContent = `${num(r.fake)}/${num(r.users)}명 · ${r.pct}%`;
      const mult = document.createElement('span');
      mult.className = 'fn-drop' + (r.mult && r.mult >= 3 ? ' is-big' : '');
      mult.textContent = r.mult && r.mult > 1 ? `${r.mult}배` : '';
      row.append(lab, track, val, mult);
      seg.appendChild(row);
    }

    // 반사실 — '결제 이력 없으니 손실 아님'을 막는 두 줄
    const c = d.compare || {};
    const cmp = $('#risk-cmp');
    cmp.textContent = '';
    if (c.fake && c.normal) {
      const t = document.createElement('table');
      t.className = 'ledger';
      const hr = t.createTHead().insertRow();
      ['', '유저', '결제자', '결제율', '광고', '접속일', '체류'].forEach((h, i) => {
        const th = document.createElement('th');
        if (!i) th.className = 'date';
        th.textContent = h;
        hr.appendChild(th);
      });
      const tb = t.createTBody();
      for (const [key, label] of [['fake', '위조 유저'], ['normal', '일반 유저']]) {
        const x = c[key], tr = tb.insertRow();
        const cell = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
        cell(label, 'date');
        cell(num(x.users));
        cell(num(x.payers));
        const pc = cell(x.pay_pct + '%');
        if (key === 'fake') pc.className = 'neg';
        cell(x.ads + '회');
        cell(x.days + '일');
        cell(x.mins + '분');
      }
      cmp.appendChild(t);
      const note = document.createElement('p');
      note.className = 'card-sub';
      const ratio = c.normal.pay_pct ? (c.fake.pay_pct / c.normal.pay_pct).toFixed(0) : '—';
      note.textContent = `위조 유저의 결제율이 일반의 ${ratio}배입니다 — 비지출자가 아니라 `
        + '돈 쓸 성향이 있는 유저층입니다. "결제 이력이 없으니 손실이 아니다"로 읽으면 안 됩니다. '
        + `광고는 ${c.fake.ads}회로 일반(${c.normal.ads}회)의 일부만 봅니다(보석이 무한하니 볼 이유가 없음).`;
      cmp.appendChild(note);
    }

    // 사유별 — no_price 는 정상 결제에서도 난다. 갈라 두지 않으면 전부 치터로 읽힌다.
    const rs = $('#risk-reason');
    rs.textContent = (d.reasons || []).length
      ? (d.reasons || []).map(r => `${r.reason} ${num(r.users)}명/${num(r.events)}건`).join('  ·  ')
        + '   (no_price 는 가격 조회 전에 결제가 끝난 정상 케이스가 섞입니다 — 차단 대상 아님)'
      : '';

    const list = $('#risk-users');
    list.textContent = '';
    const us = (d.users || []).slice(0, 20);
    if (!us.length) { list.textContent = '해당 유저가 없습니다.'; return; }
    for (const u of us) {
      const row = document.createElement('div');
      row.className = 'risk-row';
      row.textContent = `${u.day}  ${u.tag}  `
        + u.kinds.map(k => k === 'clock_drift' ? `시계 +${u.drift_h}시간`
            : k === 'fake_purchase' ? `결제 위조 ${u.fake}건(지급됨 ${u.fake_granted})`
            : `추월% 1초에 ${u.burst}칸 건너뜀`).join(' · ')
        + (u.max_pct ? `  (최고 ${u.max_pct}%)` : '');
      list.appendChild(row);
    }
  }
})();
