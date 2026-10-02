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
    ads(d.ads);
    country(d.by_country, d.cohort_n || 0);
    table(d);
  }

  /* 리워드 광고 — 결과 네 갈래(ads.gd rewarded_result)를 지점별로 펼친다.
     완주율과 공급 실패율은 원인이 달라서(유저 행동 vs 인벤토리) 한 숫자로 합치면 안 된다. */
  const AD_RES = [['earned', '완주'], ['dismissed', '중간이탈'], ['no_ad', '광고없음'], ['failed', '표시실패']];
  const AD_PLACE = {
    repair: '수리', offline: '방치보상', boost: '수익부스트', gem_ad: '보석광고',
    city_repair: '도시 수리', city_boost: '도시 부스트',
  };

  /* 국가별 — 추가 쿼리 없이 같은 코호트를 나라로 쪼갠 값이다.
     비율은 가입 대비. 5명 미만 나라는 묶었다(비율이 요동쳐서). */
  function country(c, total) {
    const card = $('#rt-ctry-card');
    if (!c || !(c.rows || []).length) { card.hidden = true; return; }
    card.hidden = false;
    $('#rt-ctry-count').textContent = `${c.rows.length}개 구간 · 가입 ${num(total)}명`;

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
      const cell = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      cell(r.country, 'date');
      cell(num(r.n));
      cell(total ? Math.round(100 * r.n / total) + '%' : '—');
      for (const m of c.marks) {
        const td = cell(`${num(r[m.key])} · ${r[m.key + '_pct']}%`);
        td.title = `${r.country} 가입 ${r.n}명 중 ${r[m.key]}명이 ${m.label}까지`;
      }
      cell(dur(r.med_min));
    }
  }

  function ads(a) {
    const card = $('#rt-ads-card');
    if (!a || !a.total) { card.hidden = true; return; }
    card.hidden = false;

    const host = $('#rt-ads-tiles');
    host.textContent = '';
    const put = (label, value, sub, warn) => {
      const el = document.createElement('div');
      el.className = 'tile';
      const l = document.createElement('div'); l.className = 'tile-label'; l.textContent = label;
      const v = document.createElement('div'); v.className = 'tile-value num'; v.textContent = value;
      if (warn) v.style.color = 'var(--bad)';
      const b = document.createElement('div'); b.className = 'tile-sub'; b.textContent = sub;
      el.append(l, v, b);
      host.appendChild(el);
    };
    const got = (k) => (a.by_result.find(x => x.result === k) || {}).n || 0;
    put('광고 요청', num(a.total), '보상 광고를 띄우려 한 횟수');
    put('완주', num(got('earned')), a.finish_pct != null ? `뜬 광고의 ${a.finish_pct}%` : '');
    put('공급 실패', num(got('no_ad') + got('failed')),
      a.supply_pct != null ? `요청의 ${a.supply_pct}%` : '', (a.supply_pct || 0) >= 20);
    put('시청 유저', num(a.viewers), '한 번이라도 본 사람');

    const t = $('#rt-ads');
    t.textContent = '';
    const hr = t.createTHead().insertRow();
    ['지점', ...AD_RES.map(x => x[1]), '합계'].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      hr.appendChild(th);
    });
    const tb = t.createTBody();
    for (const row of a.by_placement || []) {
      const tr = tb.insertRow();
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      c(AD_PLACE[row.placement] || row.placement, 'date');
      for (const [k] of AD_RES) {
        const cell = c(row[k] ? num(row[k]) : '—');
        // 공급 쪽 실패는 매출이 그대로 증발하는 칸이라 눈에 띄게 둔다
        if ((k === 'no_ad' || k === 'failed') && row[k]) cell.className = 'neg';
      }
      c(num(row.total), 'sum');
    }

    // 국가별 — fill rate 는 지역마다 갈려서 전체 평균 하나로는 어디를 손볼지 안 보인다
    const ct = $('#rt-ads-country');
    ct.textContent = '';
    const rows = a.by_country || [];
    if (!rows.length) return;
    const chr = ct.createTHead().insertRow();
    ['국가', '요청', '완주', '완주율', '광고없음', '표시실패', '공급실패율', '유저'].forEach((h, i) => {
      const th = document.createElement('th');
      if (!i) th.className = 'date';
      th.textContent = h;
      chr.appendChild(th);
    });
    const ctb = ct.createTBody();
    for (const r of rows) {
      const tr = ctb.insertRow();
      const c = (txt, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; td.textContent = txt; return td; };
      c(r.country, 'date');
      c(num(r.total));
      c(num(r.earned));
      c(r.finish_pct != null ? r.finish_pct + '%' : '—');
      c(r.no_ad ? num(r.no_ad) : '—');
      c(r.failed ? num(r.failed) : '—');
      // 공급실패 20% 넘으면 붉게 — 그 시장에서 광고 매출이 1/5씩 증발하고 있다는 뜻
      const sp = c(r.supply_pct != null ? r.supply_pct + '%' : '—');
      if ((r.supply_pct || 0) >= 20) sp.className = 'neg';
      c(num(r.users));
    }
  }

  const { dur, progCell, fillStrip, spineLen } = window.UserRow;

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

      row.append(lab, track, val, dr);
      host.appendChild(row);
    });
  }

  function table(d) {
    const stages = d.stage_labels || [];
    const spineN = spineLen(stages);
    const t = $('#rt-users');
    t.textContent = '';

    const hr = t.createTHead().insertRow();
    // 도달 단계·버전은 뺐다 — 도달 지점은 진행 막대가 이미 말하고, 버전은 지금 한 종류뿐이다.
    ['유저', '가입', '마지막', '체류', '추월%', '진행', '국가'].forEach((h, i) => {
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
      td.colSpan = 7; td.textContent = '최근 24시간 안에 가입자가 없습니다';
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
        + (u.sessions > 1 ? ` · 세션 ${u.sessions}회(다시 들어옴)` : '')
        + `\n체류는 화면을 보고 있던 시간입니다 — 앱을 꺼 둔 동안은 빠집니다.`;

      progCell(tr.insertCell(), u.prog);

      fillStrip(tr.insertCell(), u.reached || [], stages, u.far, spineN);

      c(u.country || '—');
    }

    draw();
  }
})();
