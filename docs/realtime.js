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

    const users = d.users || [];
    const stuck = users.filter(u => u.far <= 1).length;   // 인트로도 못 넘긴 사람
    tiles([
      ['오늘 가입', num(d.cohort_n), '처음 앱을 연 사람'],
      ['인트로 전 이탈', num(stuck), d.cohort_n ? `${Math.round(100 * stuck / d.cohort_n)}%` : '', stuck > 0],
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

    rows.forEach((r, i) => {
      const prev = i ? rows[i - 1].n : r.n;
      const drop = prev ? Math.round(100 * (prev - r.n) / prev) : 0;

      const row = document.createElement('div');
      row.className = 'fn-row';

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
      dr.textContent = i && drop > 0 ? `-${drop}%` : '';

      row.append(lab, track, val, dr);
      host.appendChild(row);
    });
  }

  function table(d) {
    const labels = (d.stage_labels || []).map(x => x.label);
    const t = $('#rt-users');
    t.textContent = '';

    const hr = t.createTHead().insertRow();
    ['가입', '마지막', '머문시간', '도달 단계', '진행', '버전', '국가'].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });

    const tb = t.createTBody();
    const users = d.users || [];
    if (!users.length) {
      const td = tb.insertRow().insertCell();
      td.colSpan = 7; td.textContent = '오늘 가입자가 없습니다';
      return;
    }

    for (const u of users) {
      const tr = tb.insertRow();
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      c(u.joined, 'date');
      c(u.last_seen);
      c(u.mins >= 60 ? `${Math.floor(u.mins / 60)}시간 ${u.mins % 60}분` : `${u.mins}분`);
      const far = c(u.far_label);
      if (u.far <= 1) far.className = 'neg';

      const strip = tr.insertCell();
      strip.className = 'rt-strip';
      (u.reached || []).forEach((v, i) => {
        const cell = document.createElement('i');
        cell.className = v ? 'on' : '';
        cell.title = `${i + 1}. ${labels[i] || ''} — ${v ? '도달' : '미도달'}`;
        strip.appendChild(cell);
      });

      c(u.ver || '—');
      c(u.country || '—');
    }
  }
})();
