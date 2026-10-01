/* 인게임 분석 뷰 — docs/data/ingame.json 을 읽어 렌더.
 * 매출 뷰(app.js)와 독립. 상단 매출|인게임 토글로 전환. 외부 라이브러리 없음. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const num = n => Math.round(n).toLocaleString('ko-KR');
  const esc = s => String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

  // ── 신분(class_up) 계측 시작 버전 ─────────────────────────────
  // v819 진단 릴리스부터 class_up 로깅 → 그 미만 코호트의 신분2~7은 과소집계(업데이트 후 도달분만).
  // 오독 방지: 계측 시작 미만 버전의 신분 셀은 '—'(계측전)로 표시.
  const CLASS_INSTR_VER = 819;
  const vcode = v => { const m = String(v).match(/v(\d+)/); return m ? +m[1] : 0; };
  const isClassKey = k => /^class\d/.test(k);
  const classNA = (key, version) => isClassKey(key) && vcode(version) < CLASS_INSTR_VER;

  // ── 셀 표시 모드(숫자/퍼센트) — 표마다 개별 토글 ──────────
  // 토글 호스트 id ↔ 모드 키 매핑. 각 표가 자기 키의 모드만 사용(독립 동작).
  const MODE_TOGGLES = [
    { host: 'ig-vmode', key: 'onb' },         // 스텝×버전 도달(ig-onbv-table)
    { host: 'ig-vmode-reach', key: 'reach' }, // 추월% 도달 생존(ig-reachv)
  ];
  let _data = null;                 // 마지막 로드 데이터(토글 재그림용)
  const _cellModes = { onb: 'num', reach: 'num' };  // 키별 'num' | 'pct'
  const cellText = (n, pct, mode) => mode === 'pct'
    ? (pct != null ? pct + '%' : '—')
    : num(n);
  function buildModeToggle(hostId, key) {
    const host = $('#' + hostId); if (!host) return;
    const m = _cellModes[key];
    host.innerHTML =
      `<button class="mchip${m === 'num' ? ' on' : ''}" data-m="num">숫자</button>` +
      `<button class="mchip${m === 'pct' ? ' on' : ''}" data-m="pct">%</button>`;
    host.querySelectorAll('.mchip').forEach(b => b.addEventListener('click', () => {
      _cellModes[key] = b.getAttribute('data-m'); redrawAll();
    }));
  }
  function buildAllToggles() { MODE_TOGGLES.forEach(t => buildModeToggle(t.host, t.key)); }
  function redrawAll() {
    if (!_data) return;
    buildAllToggles();
    drawVV(_data);
  }

  // ── 뷰 토글 ────────────────────────────────────────────────
  let loaded = false;
  /* 뷰가 셋 이상으로 늘어 일반화했다. 다른 뷰는 window.__viewShown 으로 전환을 전달받는다. */
  const VIEWS = ['revenue', 'ingame', 'realtime', 'users'];
  function show(view) {
    VIEWS.forEach(v => { const el = $('#view-' + v); if (el) el.hidden = v !== view; });
    const db = $('#demo-banner'); if (view !== 'revenue' && db) db.hidden = true;
    document.querySelectorAll('.vtab').forEach(b => b.classList.toggle('is-on', b.dataset.view === view));
    if (view === 'ingame' && !loaded) { loaded = true; load(); }
    if (typeof window.__viewShown === 'function') window.__viewShown(view);
  }
  document.querySelectorAll('.vtab').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));

  // ── 데이터 로드 ────────────────────────────────────────────
  async function load() {
    let d;
    try {
      const res = await fetch('data/ingame.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      d = await res.json();
    } catch (e) { $('#ig-empty').hidden = false; return; }
    if (!d || !d.rebirth_funnel) { $('#ig-empty').hidden = false; return; }
    const up = $('#updated'); if (up && d.updated) { up.textContent = '데이터 기준 ' + d.updated; up.title = 'BigQuery 수집 시각(매일 11:20 KST 자동). 페이지 배포 시각과 다를 수 있음'; }
    _data = d;
    renderKpi(d); renderFunnel(d); renderVersions(d); renderPacing(d);
    renderRetentionCohort(d); renderProgressHeatmap(d);
    renderCityKpi(d); renderCityFunnel(d); renderCityDeci(d); renderCityPacing(d);
    renderVersionViews(d);
    buildAllToggles();
  }

  // ── 버전 선택(체크박스) 뷰: 온보딩 퍼널 + 단계×버전 + 추월% 도달분포 ──
  // 전체 기간 데이터(onb_versions / reach_versions). 기본 전체 선택, 체크한 버전만.
  let _vvSel = null;  // Set<version> — 선택 상태(첫 로드 시 전체)
  function renderVersionViews(d) {
    const onbV = d.onb_versions || [];
    const host = $('#ig-vsel'); if (!host) return;
    if (!onbV.length) { host.innerHTML = '<span class="card-sub">데이터 없음(다음 수집 후 채워짐)</span>'; return; }
    const versions = onbV.map(v => v.version);
    if (_vvSel === null) _vvSel = new Set(versions);  // 기본: 전체 선택
    // 체크박스 바(스크롤)
    host.innerHTML = versions.map(v =>
      `<label class="vchip${_vvSel.has(v) ? ' on' : ''}"><input type="checkbox" data-v="${esc(v)}"${_vvSel.has(v) ? ' checked' : ''}> ${esc(vshort(v))}</label>`
    ).join('') +
      `<button class="vchip-all" data-all="1">전체</button><button class="vchip-all" data-all="0">해제</button>`;
    host.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
      const v = cb.getAttribute('data-v');
      if (cb.checked) _vvSel.add(v); else _vvSel.delete(v);
      drawVV(d);
    }));
    host.querySelectorAll('.vchip-all').forEach(b => b.addEventListener('click', () => {
      _vvSel = b.getAttribute('data-all') === '1' ? new Set(versions) : new Set();
      renderVersionViews(d);  // 체크박스 상태 갱신 + 재그림
    }));
    drawVV(d);
  }

  function drawVV(d) {
    const onbV = (d.onb_versions || []).filter(v => _vvSel.has(v.version));
    const labels = d.stage_labels || [];
    // 단계 × 버전 테이블 (행=단계, 열=선택 버전, 셀=도달 유저 + %) — 셀 색이 도달률(드롭)을 표현
    const t = $('#ig-onbv-table');
    if (t) {
      if (!onbV.length) { t.innerHTML = '<tr><td class="vt-empty">버전을 선택하세요</td></tr>'; }
      else {
        const cellCol = pct => `hsl(${Math.round(1.2 * pct)},62%,${(93 - pct * 0.1).toFixed(0)}%)`;
        let h = '<thead><tr><th class="stick">단계</th>' +
          onbV.map(v => `<th>${esc(vshort(v.version))}<span class="vt-u">${num(v.users)}</span></th>`).join('') + '</tr></thead><tbody>';
        labels.forEach(l => {
          h += `<tr><td class="stick vt-ver">${esc(l.label)}</td>` +
            onbV.map(v => {
              const s = v.steps.find(x => x.key === l.key); if (!s) return '<td class="num">—</td>';
              if (classNA(l.key, v.version)) return `<td class="num cell-na" title="v${CLASS_INSTR_VER}부터 신분 계측 — 이전 버전은 과소집계">—</td>`;
              return `<td class="num fcell" style="background:${cellCol(s.pct)}" title="${num(s.n)}명 · ${s.pct}%">${cellText(s.n, s.pct, _cellModes.onb)}</td>`;
            }).join('') + '</tr>';
        });
        t.innerHTML = h + '</tbody>';
      }
    }
    // ③ 추월% 도달 생존 × 버전 (행=%, 열=버전, 셀="그 % 이상 도달한 유저" — 위→아래 단조 하강)
    const rv = $('#ig-reachv');
    if (rv) {
      const R = d.reach_versions || { buckets: [], versions: [], cap: 20 };
      const rverV = (R.versions || []).filter(v => _vvSel.has(v.version));
      if (!rverV.length || !(R.buckets || []).length) { rv.innerHTML = '<tr><td class="vt-empty">데이터 없음</td></tr>'; }
      else {
        const cap = R.cap != null ? R.cap : 20;
        // 각 버전 열: 최고점 분포(dist)를 위(높은 %)에서부터 누적 → survival(≥b). %가 오를수록 숫자는 줄기만 함.
        const surv = {}, colMax = {};
        rverV.forEach(v => {
          const s = {}; let acc = 0;
          for (let b = R.buckets.length - 1; b >= 0; b--) { acc += (v.dist[String(b)] || 0); s[b] = acc; }
          surv[v.version] = s;
          colMax[v.version] = Math.max(1, s[0] || 0);   // survival(≥0)=전체
        });
        let h = '<thead><tr><th class="stick">추월%</th>' +
          rverV.map(v => `<th>${esc(vshort(v.version))}<span class="vt-u">${num(v.users)}</span></th>`).join('') + '</tr></thead><tbody>';
        R.buckets.forEach((b, i) => {
          const lab = b > cap ? (cap + 1) + '+' : (b + '%');
          h += `<tr><td class="stick vt-ver">${lab}</td>` +
            rverV.map(v => {
              const n = surv[v.version][b] || 0;
              const pct = v.users ? Math.round(1000 * n / v.users) / 10 : 0;   // 그 버전 전체 대비 도달율
              const sh = 96 - Math.round(46 * n / colMax[v.version]);
              return `<td class="num fcell" style="background:hsl(214,70%,${sh}%)" title="${num(n)}명 · ${pct}% 도달">${n ? cellText(n, pct, _cellModes.reach) : '·'}</td>`;
            }).join('') + '</tr>';
        });
        rv.innerHTML = h + '</tbody>';
      }
    }
  }

  // ── 2부(도시) 뷰 — 진입 퍼널 · 초반 이탈곡선 · 진행 페이싱 ──────────────
  function renderCityKpi(d) {
    const host = $('#ig-city-kpi'); if (!host) return; host.innerHTML = '';
    const k = d.city_kpi || {};
    host.appendChild(tile('도시 진입', num(k.entered || 0), '2부 도달 유저'));
    host.appendChild(tile('도시 완성(엔딩)', num(k.completed || 0), '100% 완성'));
    host.appendChild(tile('완주율', (k.completion_pct != null ? k.completion_pct + '%' : '—'), '진입 대비 완성'));
  }

  function renderCityFunnel(d) {
    const host = $('#ig-city-funnel'); if (!host) return;
    const rows = d.city_entry_funnel || [];
    if (!rows.length || !(rows[0].users)) { host.innerHTML = '<p class="card-sub">데이터 없음(2부 계측 출시·landing 대기)</p>'; return; }
    host.innerHTML = '';
    const top = rows[0].users || 1;
    let worstI = -1, worstD = -1;
    for (let i = 1; i < rows.length; i++) {
      const dr = rows[i - 1].users ? (rows[i - 1].users - rows[i].users) / rows[i - 1].users : 0;
      if (dr > worstD) { worstD = dr; worstI = i; }
    }
    rows.forEach((r, i) => {
      const pctTop = top ? (100 * r.users / top) : 0;
      const drop = i > 0 && rows[i - 1].users ? Math.round(100 * (rows[i - 1].users - r.users) / rows[i - 1].users) : null;
      const hot = i === worstI;
      const wrap = el('div', 'fbar');
      wrap.innerHTML =
        `<div class="fbar-head"><span>${esc(r.stage)}</span>` +
        `<span class="num">${num(r.users)} · ${pctTop.toFixed(0)}%` +
        (drop != null && drop > 0 ? ` <span class="drop">▼${drop}%${hot ? ' ⚠' : ''}</span>` : '') + `</span></div>` +
        `<div class="fbar-track"><div class="fbar-fill${hot ? ' fbar-fill-hot' : ''}" style="width:${Math.max(pctTop, 1.5)}%"></div></div>`;
      host.appendChild(wrap);
    });
    if (worstI > 0) {
      host.appendChild(el('p', 'chart-note',
        `최대 이탈: <b class="drop">${esc(rows[worstI - 1].stage)} → ${esc(rows[worstI].stage)} (▼${Math.round(worstD * 100)}%)</b> — 2부 초반 벽`));
    }
  }

  function renderCityDeci(d) {
    const host = $('#ig-city-deci'); if (!host) return; host.innerHTML = '';
    const c = d.city_deci_curve || [];
    if (c.length < 2) { host.innerHTML = '<p class="card-sub">데이터 없음(2부 계측 출시·landing 대기)</p>'; return; }
    let worst = null;
    c.forEach(x => { if (x.step_drop_pct != null && (!worst || x.step_drop_pct > worst.step_drop_pct)) worst = x; });
    host.innerHTML = lineChart(c.map(x => ({ x: x.deci, y: x.users })), { mark: worst ? worst.deci : -1, xlab: '완성도(0.1%)', ylab: '유저' });
    if (worst) {
      host.appendChild(el('p', 'chart-note',
        `최대 절벽: <b>${worst.pct}%</b> 지점 <b class="drop">−${worst.step_drop_pct}%</b>` +
        (worst.median_days != null ? ` · 도달 중앙값 ${worst.median_days}일` : '')));
    }
  }

  function renderCityPacing(d) {
    const host = $('#ig-city-pacing'); if (!host) return; host.innerHTML = '';
    const p = (d.city_pacing || []).filter(x => x.median_days != null).sort((a, b) => a.pct - b.pct);
    if (p.length < 2) { host.innerHTML = '<p class="card-sub">데이터 없음(2부 계측 출시·landing 대기)</p>'; return; }
    host.innerHTML = lineChart(p.map(x => ({ x: x.pct, y: x.median_days })), { xlab: '완성도(%)', ylab: '경과일(중앙값)' });
    const last = p[p.length - 1];
    host.appendChild(el('p', 'chart-note',
      `완성도 %별 진입 후 경과일(중앙값). 최고 ${last.pct}% · ${last.median_days}일 · 캘린더라 대기·수면 포함`));
  }

  const vshort = v => String(v).replace(/^1\.0\s*\(v?/i, 'v').replace(/\)$/, '');

  // ── 버전 비교: 표 ─────────────────────
  function renderVersions(d) {
    const rows = (d.by_version || []).filter(r => r.conv_retire_to_rebirth != null);
    renderVersionTable(rows);
  }

  // 구간 도달율 히트맵(넓은 표, 좌우 스크롤, 첫 열 고정)
  function renderVersionTable(rows) {
    const host = $('#ig-versions'); if (!host) return;
    if (!rows.length) { host.innerHTML = '<tr><td class="vt-empty">버전 데이터 없음</td></tr>'; return; }
    const best = Math.max(...rows.map(r => r.conv_retire_to_rebirth), 0);
    let html = '<thead><tr><th>버전</th><th>유저</th><th>은퇴</th><th>첫환생</th>' +
      '<th>신규→은퇴</th><th>은퇴→환생</th><th>신규→환생</th><th>나이</th></tr></thead><tbody>';
    rows.forEach(r => {
      const c = r.conv_retire_to_rebirth;
      const hot = c === best && rows.length > 1 ? ' class="vt-best"' : '';
      // 신규→환생 = 전체 여정 전환(첫환생/유저). 두 전환의 곱, 최종 성과 지표.
      const n2r = r.users ? +(100 * r.rebirthed / r.users).toFixed(1) : null;
      html += `<tr><td class="vt-ver">${esc(vshort(r.version))}</td><td class="num">${num(r.users)}</td>` +
        `<td class="num">${num(r.retired)}</td><td class="num">${num(r.rebirthed)}</td>` +
        `<td class="num">${r.conv_new_to_retire != null ? r.conv_new_to_retire + '%' : '—'}</td>` +
        `<td class="num"${hot}>${c != null ? c + '%' : '—'}</td>` +
        `<td class="num">${n2r != null ? n2r + '%' : '—'}</td>` +
        `<td class="num vt-age">${r.cohort_age_days != null ? r.cohort_age_days + '일' : '—'}</td></tr>`;
    });
    host.innerHTML = html + '</tbody>';
  }

  // ── KPI 타일 ──────────────────────────────────────────────
  function tile(label, value, sub) {
    const t = el('div', 'tile');
    t.appendChild(el('div', 'tile-label', esc(label)));
    t.appendChild(el('div', 'tile-value num', value));
    if (sub) t.appendChild(el('div', 'tile-sub', esc(sub)));
    return t;
  }
  function renderKpi(d) {
    const host = $('#ig-kpi'); host.innerHTML = '';
    const k = d.kpi || {};
    const pctT = (v, base) => v != null ? v + '%' : (base ? '0%' : '—');
    host.appendChild(tile('DAU', num(k.dau || 0), `일간 활성 (${d.last_table || '최신'})`));
    host.appendChild(tile('WAU', num(k.wau || 0), '주간 활성 (최근 7일)'));
    host.appendChild(tile('신규 (7일)', num(k.new_7d || 0), '최근 7일 첫 설치'));
    host.appendChild(tile('누적 유저', num(k.cumulative || 0), '전체 설치'));
    host.appendChild(tile('추월 1% 돌파', pctT(k.reach1, k.reach1_base), `은퇴 후 1%+ 도달 · 최대 누수 · 모수 ${num(k.reach1_base || 0)}`));
    host.appendChild(tile('D1 리텐션', pctT(k.d1, k.d1_base), `설치 다음날 복귀 · 모수 ${num(k.d1_base || 0)}`));
    host.appendChild(tile('D7 리텐션', pctT(k.d7, k.d7_base), `설치 7일뒤 복귀 · 모수 ${num(k.d7_base || 0)}`));
    host.appendChild(tile('D30 리텐션', pctT(k.d30, k.d30_base), `설치 30일뒤 복귀 · 모수 ${num(k.d30_base || 0)}`));
  }


  // ── 코호트 리텐션 삼각(설치일 × Day n 히트맵) ─────────────
  function renderRetentionCohort(d) {
    const host = $('#ig-retention-cohort'); if (!host) return; host.innerHTML = '';
    const c = d.retention_cohort;
    if (!c || !c.rows || !c.rows.length) { host.innerHTML = '<p class="card-sub">데이터 없음</p>'; return; }
    const N = c.n;
    // 리텐션 히트맵: 0%→옅은 노랑, 높을수록 주황→빨강(50%에서 포화). null=관측불가(회색).
    const heat = p => {
      if (p == null) return 'transparent';
      const t = Math.min(p / 50, 1);
      const hue = 55 - 55 * t;           // 노랑(55)→빨강(0)
      const lig = 90 - 42 * t;           // 옅음→진함
      return `hsl(${hue.toFixed(0)},95%,${lig.toFixed(0)}%)`;
    };
    let h = '<thead><tr><th class="stick">설치일</th><th>신규</th>';
    for (let n = 1; n <= N; n++) h += `<th>D${n}</th>`;
    h += '</tr></thead><tbody>';
    // 최신 코호트가 위로 오도록 역순
    c.rows.slice().reverse().forEach(r => {
      h += `<tr><td class="stick vt-ver">${esc(r.date)}</td><td class="num">${num(r.new)}</td>`;
      r.days.forEach(p => {
        if (p == null) { h += '<td class="num coh-na">·</td>'; return; }
        const lg = 90 - 42 * Math.min(p / 50, 1);
        h += `<td class="num fcell" style="background:${heat(p)};color:${lg < 55 ? '#fff' : '#333'}">${p}%</td>`;
      });
      h += '</tr>';
    });
    h += '</tbody>';
    const tbl = el('table', 'vftable coh-table', h);
    const scroll = el('div', 'table-scroll'); scroll.appendChild(tbl);
    host.appendChild(scroll);
    host.appendChild(el('p', 'chart-note', `설치일 코호트 × Day1~D${N} 복귀율 · 셀=그 코호트 중 정확히 n일 뒤 접속 비율 · 회색(·)=아직 관측 불가 · 최신 설치일이 위`));
  }

  // ── 은퇴→환생 퍼널 + 원인 3분할 ───────────────────────────
  function renderFunnel(d) {
    const host = $('#ig-funnel'); host.innerHTML = '';
    const rows = d.rebirth_funnel || [];
    const top = rows.length ? rows[0].users : 0;
    // 이벤트 발화 결함으로 0인 중간 단계 → 회색+"계측 결함", 드롭배지는 직전 신뢰단계 기준.
    const BROKEN = new Set(['환생자격', '화면방문']);
    let lastGood = top;
    rows.forEach((r, i) => {
      const broken = BROKEN.has(r.stage) && r.users === 0;
      const pctTop = top ? (100 * r.users / top) : 0;
      let badge = '';
      if (!broken && i > 0) {
        const drop = lastGood ? Math.round(100 * (lastGood - r.users) / lastGood) : null;
        if (drop != null && drop > 0) badge = ` <span class="drop">▼${drop}%</span>`;
      }
      const wrap = el('div', 'fbar' + (broken ? ' fbar-muted' : ''));
      wrap.innerHTML =
        `<div class="fbar-head"><span>${esc(r.stage)}${broken ? '<span class="fbar-tag">계측 결함</span>' : ''}</span>` +
        `<span class="num">${broken ? '—' : num(r.users) + ' · ' + pctTop.toFixed(0) + '%'}${badge}</span></div>` +
        `<div class="fbar-track"><div class="fbar-fill" style="width:${Math.max(pctTop, 1.5)}%"></div></div>`;
      host.appendChild(wrap);
      if (!broken) lastGood = r.users;
    });
    const sub = $('#ig-funnel-sub');
    if (sub) {
      const st = (rows.find(x => x.stage === '새게임') || {}).users || 0;
      const ret = (rows.find(x => x.stage === '은퇴') || {}).users || 0;
      const reb = (rows.find(x => x.stage === '첫환생') || {}).users || 0;
      const r1 = st ? Math.round(100 * ret / st) : 0;   // 시작→은퇴
      const r2 = ret ? Math.round(100 * reb / ret) : 0; // 은퇴→첫환생
      sub.textContent = `시작 중 ${r1}%만 은퇴 도달 · 은퇴자 중 ${r2}%만 첫 환생 · 전체기간 누적`;
    }
    const rz = d.rebirth_reasons || {};
    const total = (rz.slow_climb || 0) + (rz.discoverability || 0) + (rz.reset_shock || 0);
    if (total) {
      const cap = el('p', 'card-sub', '미환생 은퇴자 원인 분할');
      cap.style.marginTop = '14px'; host.appendChild(cap);
      const grid = el('div', 'reasons');
      const parts = [
        ['등반 느림', rz.slow_climb, '#e2504b'],
        ['화면 미발견', rz.discoverability, '#e0a020'],
        ['리셋 쇼크', rz.reset_shock, '#4b74e2'],
      ];
      parts.forEach(([lab, v, c]) => {
        v = v || 0;
        const p = total ? Math.round(100 * v / total) : 0;
        const box = el('div', 'reason');
        box.innerHTML = `<div class="reason-bar" style="background:${c};width:${Math.max(p, 3)}%"></div>` +
          `<div class="reason-lab">${esc(lab)}<b class="num"> ${p}%</b> <span class="reason-n">(${num(v)})</span></div>`;
        grid.appendChild(box);
      });
      host.appendChild(grid);
    }
  }

  // ── 라인차트 헬퍼(인라인 SVG) ─────────────────────────────
  function lineChart(pts, { w = 640, h = 180, pad = 28, mark = -1, xlab = '', ylab = '' } = {}) {
    if (!pts.length) return '';
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymax = Math.max(...ys, 1);
    const X = x => pad + (xmax === xmin ? 0 : (x - xmin) / (xmax - xmin)) * (w - pad * 2);
    const Y = y => h - pad - (y / ymax) * (h - pad * 2);
    const path = pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1)).join(' ');
    const area = `M${X(xmin).toFixed(1)},${(h - pad).toFixed(1)} ` +
      pts.map(p => 'L' + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1)).join(' ') +
      ` L${X(xmax).toFixed(1)},${(h - pad).toFixed(1)} Z`;
    let dots = '';
    if (mark >= 0) { const p = pts.find(p => p.x === mark); if (p) dots = `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4" fill="#e2504b"/>`; }
    return `<svg class="lc" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">` +
      `<path d="${area}" fill="rgba(75,116,226,.10)"/>` +
      `<path d="${path}" fill="none" stroke="#4b74e2" stroke-width="2"/>` + dots +
      `<text x="${pad}" y="${h - 6}" class="lc-ax">${esc(String(xmin) + xlab)}</text>` +
      `<text x="${w - pad}" y="${h - 6}" class="lc-ax" text-anchor="end">${esc(String(xmax) + xlab)}</text>` +
      `<text x="${pad}" y="14" class="lc-ax">${esc(ylab)} ${num(ymax)}</text>` +
      `</svg>`;
  }

  // ── 진행 분포 히트맵 (날짜 × 추월% 프론티어, 밀도=진하기) ────────
  function renderProgressHeatmap(d) {
    const host = $('#ig-progress-heatmap'); if (!host) return; host.innerHTML = '';
    const H = d.progress_heatmap;
    if (!H || !H.dates || !H.dates.length || !H.cells || !H.cells.length) {
      host.innerHTML = '<p class="card-sub">데이터 없음(progress_pct landing 대기)</p>'; return;
    }
    const BK = H.bucket, dates = H.dates, nRows = Math.round(100 / BK);
    const dIdx = {}; dates.forEach((s, i) => dIdx[s] = i);
    let maxN = 1;
    H.cells.forEach(c => { if (c.n > maxN) maxN = c.n; });
    // 밀도색: 로그스케일 t → 옅은 남색→진한 남색(겹칠수록 진함).
    const col = n => { const t = Math.log(n + 1) / Math.log(maxN + 1); return `hsl(222,72%,${(94 - 64 * t).toFixed(0)}%)`; };
    const w = 680, h = 320, padL = 40, padR = 12, padT = 10, padB = 56;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const cw = plotW / dates.length, ch = plotH / nRows;
    let rects = '';
    H.cells.forEach(c => {
      const xi = dIdx[c.date]; if (xi == null) return;
      const row = nRows - 1 - Math.floor(c.bucket / BK);   // 높은 %가 위
      const x = padL + xi * cw, y = padT + row * ch;
      rects += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cw + 0.6).toFixed(1)}" height="${(ch + 0.6).toFixed(1)}" fill="${col(c.n)}"><title>${esc(c.date)} · ${c.bucket}~${c.bucket + BK}% · ${c.n}명</title></rect>`;
    });
    // y축 라벨(0/25/50/75/100%)
    let yax = '';
    [0, 25, 50, 75, 100].forEach(p => {
      const yy = padT + (1 - p / 100) * plotH;
      yax += `<text x="${padL - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end" class="lc-ax">${p}%</text>`;
    });
    // x축 날짜(최대 7개 균등, MM-DD)
    let xax = '';
    const step = Math.max(1, Math.ceil(dates.length / 7));
    for (let i = 0; i < dates.length; i += step) {
      const x = padL + (i + 0.5) * cw;
      xax += `<text x="${x.toFixed(1)}" y="${h - padB + 16}" text-anchor="end" class="lc-ax" transform="rotate(-45 ${x.toFixed(1)} ${h - padB + 16})">${esc(dates[i].slice(5))}</text>`;
    }
    host.innerHTML = `<svg class="lc" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">` +
      rects + yax + xax +
      `<text x="${padL}" y="${h - 6}" class="lc-ax">날짜(MM-DD) →</text>` +
      `</svg>`;
    // 밀도 범례
    const leg = el('div', 'chart-note');
    leg.innerHTML = `세로=그날 도달한 추월% · 셀 진할수록 그 지점 유저 많음(최대 ${maxN}명) · <b>progress_pct(1%↑ 크로싱) 기준이라 1% 미돌파는 제외</b> · 무리가 날짜따라 위로 오르면 진행 개선`;
    host.appendChild(leg);
  }

  // ── 페이싱: 구간당 소요시간(시간/%) 막대 + 표본 N게이팅 ────────
  const N_MIN = 30;
  function renderPacing(d) {
    const host = $('#ig-pacing'); host.innerHTML = '';
    const p = (d.pacing || []).filter(x => x.median_hours != null).sort((a, b) => a.pct - b.pct);
    if (p.length < 2) { host.innerHTML = '<p class="card-sub">데이터 없음</p>'; return; }
    // 신뢰 구간: 처음부터 표본 N≥N_MIN 인 동안만(뒤로 갈수록 N 급감 → 생존자편향 컷)
    const kept = [];
    for (const x of p) { if (x.users >= N_MIN) kept.push(x); else break; }
    if (kept.length < 2) { host.innerHTML = '<p class="card-sub">표본 부족(N≥' + N_MIN + ' 구간 없음)</p>'; return; }
    // 구간당 시간(시간/%): 0→1%(진입)부터 연속 구간의 미분값
    const segs = []; let pp = 0, ph = 0;
    kept.forEach(x => { const dp = x.pct - pp; if (dp > 0) segs.push({ from: pp, to: x.pct, cost: (x.median_hours - ph) / dp }); pp = x.pct; ph = x.median_hours; });
    host.innerHTML = barsChart(segs);
    const lastPct = kept[kept.length - 1].pct;
    // 봉우리(벽) = 중앙값의 2배 넘는 구간. 반복 패턴을 그대로 보여줌.
    const sorted = segs.map(s => s.cost).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 1;
    const spikes = segs.filter(s => s.cost > Math.max(2 * med, 6)).map(s => `${s.from}~${s.to}%`);
    host.appendChild(el('p', 'chart-note',
      (spikes.length
        ? `<b class="drop">벽(봉우리): ${spikes.join(', ')}</b> — 약 3%마다 반복 = <b>환생 경계마다 정체</b>. `
        : '') +
      `사이 구간은 저렴. 신뢰 ${lastPct}%까지(N≥${N_MIN}) · 캘린더라 대기·수면 포함`));
  }

  // 세로 막대(SVG): 각 구간의 시간/%. 최대=붉게.
  function barsChart(segs, { w = 640, h = 190, pad = 30 } = {}) {
    if (!segs.length) return '';
    const maxC = Math.max(...segs.map(s => s.cost), 0.1);
    const first = segs[0].from, last = segs[segs.length - 1].to, span = (last - first) || 1;
    const X = p => pad + ((p - first) / span) * (w - pad * 2);
    const Y = c => h - pad - (c / maxC) * (h - pad * 2);
    const peak = segs.reduce((a, b) => b.cost > a.cost ? b : a, segs[0]);
    let bars = '';
    segs.forEach(s => {
      const x0 = X(s.from), x1 = X(s.to), bw = Math.max(x1 - x0 - 1, 1), y = Y(s.cost), hot = s === peak;
      bars += `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad - y).toFixed(1)}" fill="${hot ? '#e2504b' : '#4b74e2'}" fill-opacity="${hot ? 0.9 : 0.6}"/>`;
    });
    return `<svg class="lc" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">` +
      `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--axis)" stroke-width="1"/>` + bars +
      `<text x="${pad}" y="14" class="lc-ax">시간/% (최대 ${maxC.toFixed(1)}h)</text>` +
      `<text x="${pad}" y="${h - 6}" class="lc-ax">${first}%</text>` +
      `<text x="${w - pad}" y="${h - 6}" class="lc-ax" text-anchor="end">${last}%</text></svg>`;
  }
})();
