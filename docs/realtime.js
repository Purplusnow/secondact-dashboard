/* 실시간 뷰 — docs/data/realtime.json 만 읽는다.
 *
 * 보여주는 것은 하나다: 오늘 처음 앱을 연 사람들이 퍼널 어디까지 갔는가.
 * 광고는 여기 없다 — 광고 매출은 '오늘 가입자'가 아니라 전체 유저에서 나와서
 * 모수가 다르다. 같은 화면에 두면 24시간 코호트로 읽힌다(ads.js 로 뺐다).
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
      (d.excluded_nogeo ? `  ·  지역 미상 ${num(d.excluded_nogeo)}명 제외` : '')
      + (d.excluded_build ? `  ·  테스트 빌드 ${num(d.excluded_build)}명 제외` : '')
      + (d.scan_mb != null ? `  ·  스캔 ${d.scan_mb}MB` : '');

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
    versions(d.versions);
    cityView(d.city);
    certView(d.apk_cert);
    country(d.by_country, d.cohort_n || 0);
    table(d);
  }


  /* 국가별 — 추가 쿼리 없이 같은 코호트를 나라로 쪼갠 값이다.
     비율은 가입 대비. 표본이 작은 나라는 흐리게 눌러 둔다 — 비율이 한 칸에 수십 %p 씩
     움직이는데 같은 굵기로 보이면 큰 시장과 나란히 읽히면서 판단을 흔든다. */
  const THIN = 5;
  /* 버전별 — 새 빌드가 실제로 퍼지고 있는지 보는 자리. 라이브로 인정된 빌드만 코호트에
     들어가고, 한두 명짜리 테스트 빌드는 빠진다(빠진 줄도 같이 보여 준다 — 숨기면 롤아웃이
     시작된 걸 놓친다). */
  /* APK 서명 인증서 — v971 부터 변조본 결제를 차단한다.
     오탐(정상 유저가 막힘)은 돈 낸 사람이 물건을 못 받는 상황이라 어뷰징보다 훨씬 비싸다.
     1명만 나와도 화면 맨 위로 올린다. intraday 라 시간 단위로 보인다. */
  function certView(a) {
    const card = $('#rt-cert-card');
    if (!a || (!a.users && !(a.dist || []).some(x => x.cert !== '(미기록)'))) {
      card.hidden = true; return;
    }
    card.hidden = false;
    const fp = a.false_pos || 0;
    card.classList.toggle('is-alarm', fp > 0);
    $('#rt-cert-sub').innerHTML = fp > 0
      ? `<b style="color:var(--bad)">🚨 오탐 의심 ${num(fp)}명 — 정상 유저의 결제가 막히고 있습니다. 즉시 롤백 검토</b>`
        + `<br>차단 ${num(a.users)}명/${num(a.events)}건 · 위조 이력 있는 차단 ${num(a.known_bad)}명 · 판단 보류 ${num(a.unknown)}명`
      : `차단 <b>${num(a.users)}명 / ${num(a.events)}건</b>`
        + `  ·  오탐 의심 <b>${num(fp)}명</b>`
        + `  ·  위조 이력 있는 차단 ${num(a.known_bad)}명(정상 작동)`
        + `  ·  판단 보류 ${num(a.unknown)}명`;

    // 차단된 유저 목록 — 오탐이 뜨면 즉시 그 사람 로그를 까야 한다
    const bl = $('#rt-cert-blocked');
    bl.textContent = '';
    if ((a.blocked || []).length) {
      const bt = document.createElement('table');
      bt.className = 'ledger';
      const bh = bt.createTHead().insertRow();
      ['유저', '처음 본 시각', '판정', '인증서', '빌드', '건수', '국가'].forEach((h, i) => {
        const th = document.createElement('th');
        if (i < 1) th.className = 'date';
        th.textContent = h;
        bh.appendChild(th);
      });
      const bb = bt.createTBody();
      for (const b of a.blocked) {
        const tr = bb.insertRow();
        const cell = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
        cell(b.tag, 'uid');
        cell(b.seen, 'date');
        const kd = cell(b.kind);
        if (b.kind === '오탐 의심') kd.className = 'neg';
        cell(b.cert || '(미기록)', b.cert === a.good ? '' : 'neg');
        cell((b.ver || '').replace(/^1\.0 \((.*)\)$/, '$1'));
        cell(num(b.events));
        cell(b.country || '—');
      }
      bl.appendChild(bt);
    }

    const t = $('#rt-cert');
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    ['APK 서명 인증서', '유저', ''].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });
    const tb = t.createTBody();
    for (const r of a.dist || []) {
      const tr = tb.insertRow();
      const cell = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      const nm = cell(r.cert, r.ok ? 'date' : 'date neg');
      cell(num(r.users));
      cell(r.cert === a.good ? '정상' : r.cert === '(미기록)' ? 'v970 이전' : '변조본');
    }
  }

  /* 2부 — 오늘 도시에서 활동한 사람. 모수가 작을 때는 비율보다 '몇 명'이 중요하다. */
  function cityView(c) {
    const card = $('#rt-city-card');
    if (!c || !c.users) { card.hidden = true; return; }
    card.hidden = false;
    $('#rt-city-sub').textContent =
      `오늘 도시에서 활동한 사람 ${num(c.users)}명 · 진입 이벤트 ${num(c.enters)}회`
      + (c.done ? ` · 도시 완성 ${num(c.done)}명` : '');

    const host = $('#rt-city');
    host.textContent = '';
    for (const s of c.steps || []) {
      const row = document.createElement('div');
      row.className = 'fn-row';
      const lab = document.createElement('span');
      lab.className = 'fn-label'; lab.style.width = '96px'; lab.textContent = s.label;
      const track = document.createElement('span'); track.className = 'fn-track';
      const fill = document.createElement('i');
      fill.style.width = (c.users ? 100 * s.n / c.users : 0) + '%';
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'fn-val';
      val.textContent = `${num(s.n)}명 · ${s.pct}%`;
      row.append(lab, track, val);
      host.appendChild(row);
    }
  }

  function versions(v) {
    const card = $('#rt-ver-card');
    if (!v || !(v.rows || []).length) { card.hidden = true; return; }
    const rows = v.rows;
    // 라이브 빌드 하나뿐이고 테스트도 없으면 볼 게 없다
    if (rows.length < 2) { card.hidden = true; return; }
    card.hidden = false;
    const live = rows.filter(r => r.live).map(r => r.ver).join(', ') || '—';
    $('#rt-ver-sub').textContent = `라이브 ${live} · 그 외 ${rows.filter(r => !r.live).length}개 빌드`;

    const host = $('#rt-ver');
    host.textContent = '';
    const max = Math.max(...rows.map(r => r.n));
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'fn-row' + (r.live ? '' : ' is-side');
      const lab = document.createElement('span');
      lab.className = 'fn-label'; lab.style.width = '96px';
      lab.textContent = r.ver.replace(/^1\.0 \((.*)\)$/, '$1');
      const track = document.createElement('span'); track.className = 'fn-track';
      const fill = document.createElement('i');
      fill.style.width = (max ? 100 * r.n / max : 0) + '%';
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'fn-val'; val.textContent = `${num(r.n)}명`;
      const tag = document.createElement('span');
      tag.className = 'fn-drop'; tag.textContent = r.live ? '' : '테스트';
      row.append(lab, track, val, tag);
      host.appendChild(row);
    }
  }

  function country(c, total) {
    const card = $('#rt-ctry-card');
    if (!c || !(c.rows || []).length) { card.hidden = true; return; }
    card.hidden = false;
    $('#rt-ctry-count').textContent = `${c.rows.length}개 구간 · 가입 ${num(total)}명`;

    // 티어 합계 — 나라가 30개 가까이 깔리면 '비싼 시장이 전체로 얼마나 하나'가 안 보인다.
    // 유입 비중은 가로막대로, 성과는 같은 눈금으로 나란히. 시장 단가 기준이지 우리 성과
    // 기준이 아니다 — 그 어긋남(T1 인데 성과가 낮다)이 이 표의 핵심이다.
    const th = $('#rt-ctry-tier');
    th.textContent = '';
    const TIER_LABEL = { T1: 'T1 선진', T2: 'T2 중위', T3: 'T3 신흥' };
    for (const r of c.tiers || []) {
      const row = document.createElement('div');
      row.className = 'fn-row';
      const lab = document.createElement('span');
      lab.className = 'fn-label'; lab.style.width = '74px';
      lab.textContent = TIER_LABEL[r.country] || r.country;
      const track = document.createElement('span'); track.className = 'fn-track';
      const fill = document.createElement('i');
      fill.style.width = (total ? 100 * r.n / total : 0) + '%';
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'fn-val'; val.style.width = '116px';
      val.textContent = `${num(r.n)}명 · ${total ? Math.round(100 * r.n / total) : 0}%`;
      const perf = document.createElement('span');
      perf.className = 'fn-tier-perf';
      perf.textContent = c.marks.map(m => `${m.label} ${r[m.key + '_pct']}%`).join(' · ')
        + `  ·  체류 ${r.med_min}분`;
      row.append(lab, track, val, perf);
      th.appendChild(row);
    }

    const t = $('#rt-ctry');
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    ['국가', '가입', '비중', ...c.marks.map(m => m.label), '중앙 체류'].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });
    const tb = t.createTBody();
    for (const r of c.rows) {
      const tr = tb.insertRow();
      if (r.n < THIN) tr.className = 'thin';
      const cell = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      const nm = cell(r.country, 'date');
      if (r.n < THIN) nm.title = `가입 ${r.n}명 — 비율이 한 칸에 ${Math.round(100 / r.n)}%p 씩 움직입니다.`;
      cell(num(r.n));
      cell(total ? Math.round(100 * r.n / total) + '%' : '—');
      for (const m of c.marks) {
        const td = cell(`${num(r[m.key])} · ${r[m.key + '_pct']}%`);
        td.title = `${r.country} 가입 ${r.n}명 중 ${r[m.key]}명이 ${m.label}까지`;
      }
      cell(dur(r.med_min));
    }
  }


  const { dur, progCell, fillStrip, spineLen, visitCell, offlineCell } = window.UserRow;

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
      // 곁가지는 목록 꼬리에 모여 있다 — 척추와 만나는 첫 줄에만 경계선을 준다
      if (side && (i === 0 || rows[i - 1].kind !== 'side')) row.classList.add('side-top');

      const lab = document.createElement('span'); lab.className = 'fn-label'; lab.textContent = r.label;
      // 막대는 한 덩어리로 둔다 — 추론분은 옆의 (추정 N) 이 이미 말하고, 막대를 두 톤으로
      // 쪼개면 25줄이 전부 얼룩덜룩해져 정작 봐야 할 '어디서 꺾이나'가 안 보인다.
      const imp = Math.max(0, r.n - (r.rec != null ? r.rec : r.n));
      const track = document.createElement('span'); track.className = 'fn-track';
      const fill = document.createElement('i');
      fill.style.width = (n ? 100 * r.n / n : 0) + '%';
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'fn-val';
      val.textContent = `${r.n}명 · ${r.pct}%`;
      if (imp) {
        const g = document.createElement('b');
        g.className = 'fn-imp';
        g.textContent = ` (추정 ${imp})`;
        g.title = `기록이 남은 건 ${r.n - imp}명. ${imp}명은 뒤 단계를 밟은 걸로 보아 채운 값입니다.`;
        val.appendChild(g);
      }
      const dr = document.createElement('span');
      dr.className = 'fn-drop' + (drop >= 30 ? ' is-big' : '');
      dr.textContent = prev && drop > 0 ? `-${drop}%` : '';
      // 첫후원 앞에는 건물 매수 조건이 붙어 있고 그걸 채우려면 방치가 필요하다(v965~).
      // 당일 창에서는 원리상 낮게 나온다 — 회귀가 아니다.
      // ⚠ 꼬리표를 줄 안에 넣었더니 그 줄만 track(flex:1)이 좁아져 막대 끝이 어긋났다.
      //   퍼널은 길이를 세로로 비교하는 그림이라 한 줄만 축이 달라지면 차트가 깨진다.
      //   그래서 줄 구조는 건드리지 않고 라벨에 점선만 긋고, 설명은 차트 아래 각주로 뺀다.
      if (r.key === 'first_donate') {
        lab.classList.add('has-note');
        lab.title = '첫후원 앞 건물 매수 조건을 채우려면 방치 시간이 필요합니다(v965~). '
          + '유저가 앱을 닫았다 와야 해서 당일 창에서는 낮게 나옵니다 — 버전 비교는 '
          + '인게임 뷰의 코호트에서 은퇴→첫환생으로 보세요.';
      }

      row.append(lab, track, val, dr);
      host.appendChild(row);
    });

    // 각주 — 줄 안에 못 넣는 설명은 여기에. 차트 축을 안 건드린다.
    if (rows.some(r => r.key === 'first_donate')) {
      const fn = document.createElement('p');
      fn.className = 'chart-note';
      fn.innerHTML = '<b>첫후원</b>의 낙폭은 설계대로입니다 — 앞에 건물 매수 조건이 붙어 있고(v965~) '
        + '그걸 채우려면 방치 시간이 필요해, 유저가 앱을 닫았다 와야 합니다. '
        + '당일 창에서는 원리상 낮게 나옵니다. 버전 비교는 인게임 뷰의 코호트에서 <b>은퇴→첫환생</b>으로 보세요.';
      host.appendChild(fn);
    }
  }

  function table(d) {
    const stages = d.stage_labels || [];
    const spineN = spineLen(stages);
    const newest = d.newest_build || '';
    const t = $('#rt-users');
    t.textContent = '';

    const hr = t.createTHead().insertRow();
    // 도달 단계·버전은 뺐다 — 도달 지점은 진행 막대가 이미 말하고, 버전은 지금 한 종류뿐이다.
    ['유저', '가입', '마지막', '체류', '재방문', '방치수령', '추월%', '진행', '빌드', '국가'].forEach((h, i) => {
      const th = document.createElement('th');
      if (i === 1) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });

    const tb = t.createTBody();
    const users = d.users || [];
    // 제목 옆에 인원을 적는다. 위 카드들은 '오늘(KST)' 기준이라 이 목록과 숫자가 다른데,
    // 어느 쪽 숫자를 보고 있는지가 제목에 붙어 있어야 헷갈리지 않는다.
    $('#rt-count').textContent = users.length ? `최근 24시간 ${num(users.length)}명` : '';
    if (!users.length) {
      const td = tb.insertRow().insertCell();
      td.colSpan = 10; td.textContent = '최근 24시간 안에 가입자가 없습니다';
      return;
    }

    /* 줄마다 진행 스트립 25칸이 붙어서 한 줄이 DOM 노드 31개다. 1만 명이면 31만 개가 되고
       그 정도면 첫 렌더가 몇 초씩 걸리고 스크롤도 끊긴다. 한 번에 다 그리지 않고 끊어 그린다 —
       어차피 위에서부터 몇십 줄 보는 화면이라 나머지는 필요할 때 붙이면 된다. */
    const CHUNK = 300;
    let drawn = 0;

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'tab rt-more';

    const draw = () => {
      const frag = document.createDocumentFragment();
      for (const u of users.slice(drawn, drawn + CHUNK)) row(frag, u);
      tb.appendChild(frag);
      drawn += CHUNK;
      if (drawn >= users.length) {
        more.remove();
      } else {
        more.textContent = `더 보기 — ${users.length - drawn}명 남음`;
        t.after(more);
      }
    };
    more.addEventListener('click', draw);

    function row(into, u) {
      const tr = document.createElement('tr');
      into.appendChild(tr);
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      // 줄을 가리키는 꼬리표(해시 6자). 같은 사람은 늘 같은 값이라 새로고침해도 줄을 짚을 수 있다.
      c(u.tag || '—', 'uid');
      c(u.joined, 'date');
      c(u.last_seen);
      // 체류 = engagement_time_msec 합(화면을 보고 있던 시간).
      // 첫~마지막 간격은 앱을 꺼도 흐르므로 체류가 아니다 — 참고로 툴팁에만 남긴다.
      const stay = c(dur(u.mins));
      stay.title = `첫~마지막 ${dur(u.span)}`
        + `\n체류는 화면을 보고 있던 시간입니다 — 앱을 꺼 둔 동안은 빠집니다.`;

      // 재방문 — 방치형에서 체류만큼 중요한 축이다. 오늘 실측으로 2회 이상 돌아온 유저의
      // 체류 중앙값이 39.5분, 한 번만 들어온 유저가 8.6분이었다(4.6배).
      visitCell(tr.insertCell(), u.sessions);

      // 방치 보상 수령 횟수 — 방치형의 핵심 루프를 몇 바퀴 돌았는지.
      offlineCell(tr.insertCell(), u.off, u.off_boost);

      progCell(tr.insertCell(), u.prog);

      fillStrip(tr.insertCell(), u.reached || [], stages, u.far, spineN);

      // 빌드 번호만 짧게. 최신 라이브 빌드가 아니면 눌러 둔다 — 롤아웃 중에 '새 빌드로 들어온
      // 사람'이 눈에 걸려야 한다. 롤아웃이 끝나면 저절로 다수가 진해지고 옛 빌드가 눌린다.
      const bv = (u.ver || '').match(/v(\d+)/);
      const bc = c(bv ? 'v' + bv[1] : '—', 'uid');
      if (u.ver !== newest) bc.classList.add('dim');
      bc.title = u.ver || '';

      c(u.country || '—');
    }

    draw();
  }
})();
