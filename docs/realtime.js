/* 실시간 뷰 — docs/data/realtime.json 만 읽는다.
 *
 * 보여주는 것은 하나다: 오늘 처음 앱을 연 사람들이 퍼널 어디까지 갔는가.
 * 인게임 뷰(완결 일별)와 데이터·로직이 완전히 분리돼 있고, 두 수치를 합치는 코드는 없다.
 */
(() => {
  const $ = s => document.querySelector(s);
  const num = n => Math.round(n || 0).toLocaleString('ko-KR');
  let loaded = false;

  window.__viewShown = view => {
    if (view === 'realtime' && !loaded) { loaded = true; load(); }
  };

  async function load() {
    let d;
    try {
      // no-store 는 브라우저 캐시만 건너뛴다 — Pages 앞단 CDN 은 600초를 쥐고 있어서
      // 갓 올라온 수집본이 '실시간' 뷰에 몇 분 늦게 뜬다. 분 단위 쿼리로 URL 을 갈라 준다.
      const res = await fetch(`data/realtime.json?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      d = await res.json();
    } catch { $('#rt-empty').hidden = false; return; }
    if (!d || !(d.tables || []).length) { $('#rt-empty').hidden = false; return; }

    const s = d.summary || {};
    $('#rt-meta').textContent =
      `수집 ${d.updated}` +
      (s.first_at ? `  ·  데이터 범위 ${s.first_at} ~ ${s.last_at} (KST)` : '') +
      (d.scan_mb != null ? `  ·  스캔 ${d.scan_mb}MB` : '');

    const users = d.users || [];
    const stuck = users.filter(u => u.far <= 1).length;   // 인트로도 못 넘긴 사람
    tiles([
      ['오늘 가입', num(d.cohort_n), '처음 앱을 연 사람'],
      ['인트로 전 이탈', num(stuck), d.cohort_n ? `${Math.round(100 * stuck / d.cohort_n)}%` : '', stuck > 0],
      // 60초 = 게임 시계로 한 달(2초/일 × 30일). 단계가 아니라 '첫 1분을 버텼나'다.
      ['60초 체류', num(d.stay60), d.cohort_n ? `${Math.round(100 * (d.stay60 || 0) / d.cohort_n)}%` : ''],
      ['활동 유저', num(s.users), '가입자 포함 전체'],
      ['결제', num(s.purchases), ''],
      ['예외', num(s.exceptions), 'app_exception', (s.exceptions || 0) > 0],
    ]);

    funnel(d.funnel || [], d.cohort_n || 0);
    table(d);
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

  /* 퍼널은 26단계라 세로 막대로는 라벨이 안 읽힌다 — 가로 막대 목록이 맞다.
     직전 단계 대비 낙폭을 같이 적어서 '어디서 막혔나'가 눈에 바로 띄게 한다. */
  function funnel(rows, n) {
    const host = $('#rt-funnel');
    host.textContent = '';
    if (!rows.length || !n) { host.innerHTML = '<div class="no-data">오늘 가입자가 없습니다</div>'; return; }

    // 낙폭은 '척추' 칸끼리만 잰다. 곁가지(첫매니저·첫금융)는 앞칸이 뒷칸을 함의하지 않아서
    // 직전 칸과 비교하면 숫자가 거짓말을 한다 — 건너뛰고 직전 척추와 잇는다.
    let lastSpine = null;
    rows.forEach((r, i) => {
      const side = r.kind === 'side';
      const prev = side ? null : lastSpine;
      const drop = prev && prev.n ? Math.round(100 * (prev.n - r.n) / prev.n) : 0;
      if (!side) lastSpine = r;

      const row = document.createElement('div');
      row.className = 'fn-row' + (side ? ' is-side' : '');
      // 곁가지 덩어리의 위아래로만 한 칸 띄운다 — 척추의 흐름이 눈으로 이어지게
      if (side && (i === 0 || rows[i - 1].kind !== 'side')) row.classList.add('side-top');
      if (side && (i === rows.length - 1 || rows[i + 1].kind !== 'side')) row.classList.add('side-bot');

      const lab = document.createElement('span'); lab.className = 'fn-label'; lab.textContent = r.label;
      const track = document.createElement('span'); track.className = 'fn-track';
      const fill = document.createElement('i');
      fill.style.width = (n ? 100 * r.n / n : 0) + '%';
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'fn-val';
      val.textContent = `${r.n}명 · ${r.pct}%`;
      const dr = document.createElement('span');
      dr.className = 'fn-drop' + (drop >= 30 ? ' is-big' : '');
      dr.textContent = prev && drop > 0 ? `-${drop}%` : '';

      row.append(lab, track, val, dr);
      host.appendChild(row);
    });
  }

  function table(d) {
    const labels = (d.stage_labels || []).map(x => x.label);
    const t = $('#rt-users');
    t.textContent = '';

    const hr = t.createTHead().insertRow();
    // 도달 단계·버전은 뺐다 — 도달 지점은 진행 막대가 이미 말하고, 버전은 지금 한 종류뿐이다.
    ['유저', '가입', '마지막', '머문시간', '진행', '국가'].forEach((h, i) => {
      const th = document.createElement('th');
      if (i === 1) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });

    const tb = t.createTBody();
    const users = d.users || [];
    if (!users.length) {
      const td = tb.insertRow().insertCell();
      td.colSpan = 6; td.textContent = '오늘 가입자가 없습니다';
      return;
    }

    for (const u of users) {
      const tr = tb.insertRow();
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      // 줄을 가리키는 꼬리표(해시 6자). 같은 사람은 늘 같은 값이라 새로고침해도 줄을 짚을 수 있다.
      c(u.tag || '—', 'uid');
      c(u.joined, 'date');
      c(u.last_seen);
      c(u.mins >= 60 ? `${Math.floor(u.mins / 60)}시간 ${u.mins % 60}분` : `${u.mins}분`);

      const strip = tr.insertCell();
      strip.className = 'rt-strip';
      (u.reached || []).forEach((v, i) => {
        const cell = document.createElement('i');
        cell.className = v ? 'on' : '';
        cell.title = `${i + 1}. ${labels[i] || ''} — ${v ? '도달' : '미도달'}`;
        strip.appendChild(cell);
      });

      c(u.country || '—');
    }
  }
})();
