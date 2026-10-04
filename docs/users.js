/* 전체 가입자 뷰 — docs/data/users/ 의 가입일별 파일을 최신 코호트부터 당겨 읽는다.
 *
 * 한 줄 = 한 유저의 **지금까지의 최종 상태**다(가입 당일이 아니라 평생 누적).
 * 파일이 가입일로 묶여 있을 뿐, 줄에 적힌 값은 전부 '지금까지'다.
 *
 * 1.6만 명을 한 파일에 담으면 2MB를 매번 다시 받게 된다. 가입일로 쪼개서 필요한 만큼만 당긴다.
 */
(() => {
  const $ = s => document.querySelector(s);
  const num = n => Math.round(n || 0).toLocaleString('ko-KR');
  const { dur, progCell, unpack, spineLen, fillStrip } = window.UserRow;

  const HEAD = ['가입일', '유저', '가입시각', '최근 접속', '접속일', '체류 합계', '추월%', '환생', '진행', '빌드', '국가'];

  let newest = '';

  let idx = null, stages = [], spineN = 0, dayAt = 0, tbody = null, shown = 0;
  let loaded = false, busy = false, dateKey = '';

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
    newest = idx.newest_build || '';

    const R = idx.reach || {};
    $('#us-meta').textContent =
      `수집 ${idx.updated || '—'}  ·  누적 ${num(idx.total)}명 / ${idx.days.length}일치`
      + (R['1'] != null
          ? `  ·  추월 1%+ ${num(R['1'])} · 10%+ ${num(R['10'])} · 50%+ ${num(R['50'])}`
            + ` · 90%+ ${num(R['90'])} · 100% ${num(R['100'])}`
          : '')
      + (idx.newest_build && (idx.versions || []).length
          ? '  ·  ' + idx.versions.slice(0, 3).map(v =>
              `${v.ver.replace(/^1\.0 \((.*)\)$/, '$1')} ${Math.round(100 * v.n / idx.total)}%`).join(' · ')
          : '')
      + (idx.scan_mb != null ? `  ·  스캔 ${idx.scan_mb}MB` : '');

    const t = $('#us-users');
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    HEAD.forEach((h, i) => {
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

    dateKey = day.date;
    const frag = document.createDocumentFragment();
    // 날짜는 줄마다 다 찍는다. 첫 줄에만 찍으면 스크롤 중간에서 지금 보는 게 며칠인지
    // 알 수 없고, 어차피 그 칸은 비어 있었다. 묶음 경계는 윗선(us-daytop)이 따로 말한다.
    rows.forEach((u, i) => frag.appendChild(row(u, day.date, i === 0)));
    tbody.appendChild(frag);
    shown += rows.length;

    $('#us-shown').textContent =
      `${num(shown)}명 표시 중 · ${dayAt}/${idx.days.length}일`;

    busy = false;
    btn.disabled = false;

    // IntersectionObserver 는 '걸쳤다/벗어났다'가 바뀔 때만 부른다. 방금 붙인 하루가 짧아서
    // 버튼이 계속 화면 안에 있으면 상태가 안 바뀌어 두 번 다시 안 불린다 — 거기서 멈춘다.
    // 그래서 붙인 뒤 직접 한 번 더 확인한다.
    if (shown < autoUntil && dayAt < idx.days.length
        && btn.getBoundingClientRect().top < window.innerHeight + 300) {
      requestAnimationFrame(loadNext);
    }

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

  /* 압축 레코드(users.py) → 한 줄. 값은 전부 **지금까지의 누적**이다. 키가 한 글자인 건 용량 때문:
     t=tag j=가입시각 l=최근접속일 d=접속일수 m=체류합계분 p=최고추월% rb=환생 r=단계비트 f=far b=결제 c=국가 */
  function row(u, dateLabel, first) {
    const tr = document.createElement('tr');
    if (first) tr.className = 'us-daytop';
    const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };

    c(dateLabel, 'date');
    c(u.t || '—', 'uid');
    c(u.j, 'date');
    // 최근 접속일 — 가입일과 같으면 '당일'로 적는다. 날짜 두 개가 나란히 있으면 눈이 비교하느라 느려진다.
    const back = u.l && u.l !== dateKey;
    const lc = c(back ? u.l : '당일');
    if (!back) lc.className = 'dim';

    const dc = c(`${u.d || 1}일`);
    if ((u.d || 1) === 1) dc.className = 'dim';

    const stay = c(dur(u.m));
    stay.title = '화면을 보고 있던 시간의 합계입니다 — 앱을 꺼 둔 동안은 빠집니다.';

    progCell(tr.insertCell(), u.p);

    const rc = c(u.rb ? `${u.rb}회` : '—');
    if (!u.rb) rc.className = 'dim';

    fillStrip(tr.insertCell(), unpack(u.r || 0, stages.length), stages, u.f, spineN);

    // 지금 쓰고 있는 빌드. 최신 정식 빌드가 아니면 눌러 둔다 — 롤아웃 중에 '아직 구버전인
    // 사람'이 눈에 걸려야 한다(2부처럼 새 빌드에만 있는 콘텐츠를 볼 수 있는지가 여기서 갈린다).
    const bv = (u.v || '').match(/v(\d+)/);
    const bc = c(bv ? 'v' + bv[1] : '—', 'uid');
    if (u.v !== newest) bc.classList.add('dim');
    bc.title = u.v || '';

    // 결제한 줄은 표시해 둔다 — 전체 목록에서 결제자를 눈으로 찾을 수 있는 유일한 단서다
    const ct = c((u.b ? '💳 ' : '') + (u.c || '—'));
    if (u.b) ct.title = `결제 ${u.b}건`;
    return tr;
  }
})();
