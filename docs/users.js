/* 전체 가입자 뷰 — docs/data/users/ 의 날짜별 파일을 최신부터 당겨 읽는다.
 *
 * 실시간 뷰와 같은 모양으로 한 명씩 줄을 세운다. 다른 건 범위뿐이다:
 * 실시간은 최근 24시간(스트리밍·오늘 포함), 이쪽은 출시 이후 전부(하루 단위 확정본).
 *
 * 1.6만 명을 한 파일에 담으면 2MB를 매일 다시 받고 다시 커밋하게 된다. 날짜별로 쪼개서
 * 필요한 날만 당기고, 하루치 파일은 그날이 끝나면 다시는 안 바뀐다.
 */
(() => {
  const $ = s => document.querySelector(s);
  const num = n => Math.round(n || 0).toLocaleString('ko-KR');
  const { dur, progText, unpack, spineLen, fillStrip } = window.UserRow;

  let idx = null, stages = [], spineN = 0, dayAt = 0, tbody = null, shown = 0;
  let loaded = false, busy = false;

  /* 끝까지 내리면 알아서 다음 날짜를 붙인다. 다만 무한정 자동으로 쌓지는 않는다 —
     한 줄이 DOM 노드 31개라 1.5만 명을 다 붙이면 50만 개가 되고 브라우저가 멈춘다.
     이만큼까지만 자동이고, 그 뒤로는 버튼을 눌러야 더 간다(누르면 그만큼 다시 열린다). */
  const AUTO_STEP = 3000;
  let autoUntil = AUTO_STEP;

  const prev = window.__viewShown;
  window.__viewShown = view => {
    if (typeof prev === 'function') prev(view);
    if (view === 'users' && !loaded) { loaded = true; start(); }
  };

  async function start() {
    try {
      const res = await fetch(`data/users/index.json?t=${Math.floor(Date.now() / 3600000)}`);
      if (!res.ok) throw new Error(res.status);
      idx = await res.json();
    } catch { $('#us-empty').hidden = false; return; }
    if (!idx || !(idx.days || []).length) { $('#us-empty').hidden = false; return; }

    stages = idx.stage_labels || [];
    spineN = spineLen(stages);

    $('#us-meta').textContent =
      `수집 ${idx.updated || '—'}  ·  ${idx.days.length}일치  ·  누적 ${num(idx.total)}명`
      + (idx.scan_mb != null ? `  ·  마지막 스캔 ${idx.scan_mb}MB` : '');

    const t = $('#us-users');
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    ['날짜', '유저', '가입', '마지막', '체류', '추월%', '진행', '국가'].forEach((h, i) => {
      const th = document.createElement('th');
      if (i < 2) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });
    tbody = t.createTBody();

    const btn = $('#us-more');
    btn.addEventListener('click', () => { autoUntil = shown + AUTO_STEP; loadNext(); });

    // 버튼 자체를 감시 대상으로 쓴다 — 목록 끝에 늘 붙어 있어서 따로 표식을 둘 필요가 없다.
    // rootMargin 으로 화면에 닿기 300px 전에 미리 당긴다(스크롤이 끊기지 않게).
    if (window.IntersectionObserver) {
      new IntersectionObserver(es => {
        if (es.some(e => e.isIntersecting) && shown < autoUntil) loadNext();
      }, { rootMargin: '300px' }).observe(btn);
    }

    await loadNext();
  }

  /* 하루 파일 하나를 통째로 붙인다. 하루 400명 안팎이라 한 번에 그려도 부담이 없고,
     '더 보기'가 날짜 단위라 어디까지 봤는지도 분명하다. */
  async function loadNext() {
    if (busy || !idx || dayAt >= idx.days.length) return;
    busy = true;
    const btn = $('#us-more');
    btn.disabled = true;
    btn.textContent = '불러오는 중…';

    const day = idx.days[dayAt++];
    let rows = [];
    try {
      const res = await fetch(`data/users/${day.date}.json`);
      if (res.ok) rows = (await res.json()).users || [];
    } catch { /* 그 날 파일이 없으면 건너뛴다 — 다음 날짜로 이어 간다 */ }

    const frag = document.createDocumentFragment();
    rows.forEach((u, i) => frag.appendChild(row(u, i === 0 ? day.date : '')));
    tbody.appendChild(frag);
    shown += rows.length;

    $('#us-shown').textContent =
      `${num(shown)}명 표시 중 · ${dayAt}/${idx.days.length}일`;

    busy = false;
    btn.disabled = false;
    if (dayAt >= idx.days.length) {
      btn.hidden = true;
      $('#us-shown').textContent += ' · 전부 불러왔습니다';
    } else {
      const next = idx.days[dayAt];
      btn.textContent = shown < autoUntil
        ? `더 보기 — ${next.date} (${num(next.n)}명)`
        : `더 보기 — ${next.date} (${num(next.n)}명) · 자동 로딩은 ${num(AUTO_STEP)}줄마다 멈춥니다`;
    }
  }

  /* 압축 레코드(users.py) → 한 줄. 키가 한 글자인 건 용량 때문이다:
     t=tag j=joined l=last m=체류분 s=첫~마지막분 n=세션 p=추월% r=단계비트 f=far b=결제 c=국가 */
  function row(u, dateLabel) {
    const tr = document.createElement('tr');
    if (dateLabel) tr.className = 'us-daytop';
    const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };

    c(dateLabel, 'date');
    c(u.t || '—', 'uid');
    c(u.j, 'date');
    c(u.l);

    const stay = c(dur(u.m));
    stay.title = `첫~마지막 ${dur(u.s)}`
      + (u.n > 1 ? ` · 세션 ${u.n}회(다시 들어옴)` : '')
      + `\n체류는 화면을 보고 있던 시간입니다 — 앱을 꺼 둔 동안은 빠집니다.`;

    const pc = c(progText(u.p));
    if (!(+u.p)) pc.className = 'dim';

    fillStrip(tr.insertCell(), unpack(u.r || 0, stages.length), stages, u.f, spineN);

    // 결제한 줄은 표시해 둔다 — 전체 목록에서 결제자를 눈으로 찾을 수 있는 유일한 단서다
    const ct = c((u.b ? '💳 ' : '') + (u.c || '—'));
    if (u.b) ct.title = `결제 ${u.b}건`;
    return tr;
  }
})();
