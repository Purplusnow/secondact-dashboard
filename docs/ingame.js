/* 인게임 분석 뷰 — docs/data/ingame.json 을 읽어 렌더.
 * 매출 뷰(app.js)와 독립. 상단 매출|인게임 토글로 전환. 외부 라이브러리 없음. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const num = n => Math.round(n).toLocaleString('ko-KR');
  const esc = s => String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

  // ── 뷰 토글 ────────────────────────────────────────────────
  let loaded = false;
  function show(view) {
    const ig = view === 'ingame';
    $('#view-revenue').hidden = ig;
    $('#view-ingame').hidden = !ig;
    const db = $('#demo-banner'); if (ig && db) db.hidden = true;
    document.querySelectorAll('.vtab').forEach(b => b.classList.toggle('is-on', b.dataset.view === view));
    if (ig && !loaded) { loaded = true; load(); }
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
    const up = $('#updated'); if (up && d.updated) up.textContent = '갱신 ' + d.updated;
    renderKpi(d); renderFunnel(d); renderVersions(d); renderDeci(d); renderOnb(d); renderPacing(d);
  }

  const MATURE_D = 7;  // 이 나이(일) 미만 코호트 = 미성숙(전환율 착시)
  const vshort = v => String(v).replace(/^1\.0\s*\(v?/i, 'v').replace(/\)$/, '');

  // ── 버전 비교: 산점도 + A/B 비교 + 표 ─────────────────────
  function renderVersions(d) {
    const rows = (d.by_version || []).filter(r => r.conv_retire_to_rebirth != null);
    const viz = $('#ig-versions-viz');
    if (!rows.length) { if (viz) viz.innerHTML = '<p class="card-sub">버전 데이터 없음</p>'; renderVersionTable([]); return; }

    // ① 산점도(전환% vs 나이)
    let html = '<div class="vscatter-wrap"><div class="vhint">전환% vs 코호트나이 — 우상향이 자연(나이↑=전환↑). <b>추세 위로 튄 점 = 진짜 개선</b></div>' +
      scatterConvAge(rows) + '</div>';

    // ② A/B 선택 비교
    const opt = (sel) => rows.map((r, i) =>
      `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(vshort(r.version))} · ${r.cohort_age_days}일</option>`).join('');
    const bIdx = rows.length > 1 ? 1 : 0;
    html += '<div class="vcmp">' +
      '<div class="vcmp-pick">' +
      `<label>A <select id="vcmp-a">${opt(0)}</select></label>` +
      `<span class="vcmp-vs">vs</span>` +
      `<label>B <select id="vcmp-b">${opt(bIdx)}</select></label>` +
      '</div><div id="vcmp-out"></div></div>';
    viz.innerHTML = html;

    const a = $('#vcmp-a'), b = $('#vcmp-b');
    const upd = () => renderCompare(rows[+a.value], rows[+b.value]);
    a.addEventListener('change', upd); b.addEventListener('change', upd);
    upd();
    renderVersionTable(rows);
    renderFunnelTable(rows, d.stage_labels || []);
  }

  // 구간 도달율 히트맵(넓은 표, 좌우 스크롤, 첫 열 고정)
  function renderFunnelTable(rows, labels) {
    const host = $('#ig-versions-funnel'); if (!host) return;
    if (!rows.length || !labels.length) { host.innerHTML = '<tr><td class="vt-empty">데이터 없음</td></tr>'; return; }
    const cell = pct => `hsl(${Math.round(1.2 * pct)},62%,${(93 - pct * 0.1).toFixed(0)}%)`;
    let h = '<thead><tr><th class="stick">버전</th><th>나이</th>' +
      labels.map(l => `<th>${esc(l.label)}</th>`).join('') + '</tr></thead><tbody>';
    rows.forEach(r => {
      const by = {}; (r.stages || []).forEach(s => by[s.key] = s);
      h += `<tr><td class="stick vt-ver">${esc(vshort(r.version))}</td>` +
        `<td class="num vt-age">${r.cohort_age_days != null ? r.cohort_age_days + '일' : '—'}</td>` +
        labels.map(l => {
          const s = by[l.key]; if (!s) return '<td class="num">—</td>';
          return `<td class="num fcell" style="background:${cell(s.pct)}" title="${esc(l.label)}: ${num(s.n)}명">${s.pct}%</td>`;
        }).join('') + '</tr>';
    });
    host.innerHTML = h + '</tbody>';
  }

  // 산점도(SVG): x=나이, y=은퇴→환생%. 미성숙=주황, 성숙=파랑.
  function scatterConvAge(rows) {
    const w = 640, h = 210, pad = 34;
    const ages = rows.map(r => r.cohort_age_days || 0), cs = rows.map(r => r.conv_retire_to_rebirth);
    const axmax = Math.max(...ages, 1), cymax = Math.max(...cs, 1) * 1.15;
    const X = a => pad + (a / axmax) * (w - pad * 2);
    const Y = c => h - pad - (c / cymax) * (h - pad * 2);
    let dots = '';
    rows.forEach(r => {
      const young = (r.cohort_age_days || 0) < MATURE_D;
      const col = young ? '#e0a020' : '#4b74e2';
      dots += `<circle cx="${X(r.cohort_age_days).toFixed(1)}" cy="${Y(r.conv_retire_to_rebirth).toFixed(1)}" r="5" fill="${col}" fill-opacity=".85"/>` +
        `<text x="${X(r.cohort_age_days).toFixed(1)}" y="${(Y(r.conv_retire_to_rebirth) - 9).toFixed(1)}" class="lc-ax" text-anchor="middle">${esc(vshort(r.version))}</text>`;
    });
    return `<svg class="lc vscatter" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">` +
      `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--axis)" stroke-width="1"/>` +
      `<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="var(--axis)" stroke-width="1"/>` +
      dots +
      `<text x="${w - pad}" y="${h - pad + 16}" class="lc-ax" text-anchor="end">나이 ${axmax}일 →</text>` +
      `<text x="${pad}" y="${pad - 8}" class="lc-ax">↑ 은퇴→환생 ${Math.round(cymax)}%</text>` +
      `</svg>`;
  }

  // A vs B head-to-head
  function renderCompare(A, B) {
    const out = $('#vcmp-out'); if (!out) return;
    const metric = (lab, av, bv, unit, higher = true) => {
      const d = (av != null && bv != null) ? +(av - bv).toFixed(1) : null;
      const good = d == null ? '' : ((higher ? d > 0 : d < 0) ? 'up' : (d === 0 ? '' : 'down'));
      const ds = d == null ? '' : `<span class="delta ${good}">${d > 0 ? '+' : ''}${d}${unit === '%' ? '%p' : unit}</span>`;
      return `<div class="cmp-row"><div class="cmp-lab">${lab}</div>` +
        `<div class="cmp-a num">${av != null ? av + unit : '—'}</div>` +
        `<div class="cmp-d">${ds}</div>` +
        `<div class="cmp-b num">${bv != null ? bv + unit : '—'}</div></div>`;
    };
    const ageWarn = (A.cohort_age_days != null && B.cohort_age_days != null &&
      Math.abs(A.cohort_age_days - B.cohort_age_days) >= 3)
      ? `<p class="chart-note">⚠️ 코호트 나이차 ${Math.abs(+(A.cohort_age_days - B.cohort_age_days).toFixed(1))}일 — 은퇴→환생 차이는 성숙도 영향 포함(참고만). 신규→은퇴는 나이 영향 적음.</p>` : '';
    out.innerHTML =
      `<div class="cmp-head"><div></div><div class="cmp-a">${esc(vshort(A.version))}<span class="cmp-age">${A.cohort_age_days}일·${num(A.users)}명</span></div><div class="cmp-d">Δ</div><div class="cmp-b">${esc(vshort(B.version))}<span class="cmp-age">${B.cohort_age_days}일·${num(B.users)}명</span></div></div>` +
      metric('신규→은퇴', A.conv_new_to_retire, B.conv_new_to_retire, '%') +
      metric('은퇴→환생', A.conv_retire_to_rebirth, B.conv_retire_to_rebirth, '%') +
      metric('은퇴 유저', A.retired, B.retired, '', true) +
      metric('첫환생 유저', A.rebirthed, B.rebirthed, '', true) +
      ageWarn;
  }

  function renderVersionTable(rows) {
    const host = $('#ig-versions'); if (!host) return;
    if (!rows.length) { host.innerHTML = '<tr><td class="vt-empty">버전 데이터 없음</td></tr>'; return; }
    const best = Math.max(...rows.map(r => r.conv_retire_to_rebirth), 0);
    let html = '<thead><tr><th>버전</th><th>유저</th><th>은퇴</th><th>첫환생</th>' +
      '<th>은퇴→환생</th><th>신규→은퇴</th><th>나이</th></tr></thead><tbody>';
    rows.forEach(r => {
      const c = r.conv_retire_to_rebirth;
      const hot = c === best && rows.length > 1 ? ' class="vt-best"' : '';
      html += `<tr><td class="vt-ver">${esc(vshort(r.version))}</td><td class="num">${num(r.users)}</td>` +
        `<td class="num">${num(r.retired)}</td><td class="num">${num(r.rebirthed)}</td>` +
        `<td class="num"${hot}>${c != null ? c + '%' : '—'}</td>` +
        `<td class="num">${r.conv_new_to_retire != null ? r.conv_new_to_retire + '%' : '—'}</td>` +
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
    const f = d.rebirth_funnel || [];
    const retired = (f.find(x => x.stage === '은퇴') || {}).users || 0;
    const reborn = (f.find(x => x.stage === '첫환생') || {}).users || 0;
    const conv = retired ? (100 * reborn / retired).toFixed(1) + '%' : '—';
    host.appendChild(tile('신규 유저', num(k.new_users_win || 0), `최근 ${d.window_days}일`));
    host.appendChild(tile('활성 유저', num(k.active_users_win || 0), `최근 ${d.window_days}일`));
    host.appendChild(tile('은퇴 → 첫환생', conv, `${num(reborn)} / ${num(retired)}`));
    host.appendChild(tile('데이터 최신', d.last_table || '—', '일별 테이블'));
  }

  // ── 은퇴→환생 퍼널 + 원인 3분할 ───────────────────────────
  function renderFunnel(d) {
    const host = $('#ig-funnel'); host.innerHTML = '';
    const rows = d.rebirth_funnel || [];
    const top = rows.length ? rows[0].users : 0;
    rows.forEach((r, i) => {
      const pctTop = top ? (100 * r.users / top) : 0;
      const wrap = el('div', 'fbar');
      const step = i > 0 && rows[i - 1].users ? Math.round(100 * (rows[i - 1].users - r.users) / rows[i - 1].users) : null;
      wrap.innerHTML =
        `<div class="fbar-head"><span>${esc(r.stage)}</span>` +
        `<span class="num">${num(r.users)} · ${pctTop.toFixed(0)}%` +
        (step != null && step > 0 ? ` <span class="drop">▼${step}%</span>` : '') + `</span></div>` +
        `<div class="fbar-track"><div class="fbar-fill" style="width:${Math.max(pctTop, 1.5)}%"></div></div>`;
      host.appendChild(wrap);
    });
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

  // ── deci 이탈곡선 ─────────────────────────────────────────
  function renderDeci(d) {
    const host = $('#ig-deci'); host.innerHTML = '';
    const c = d.deci_curve || [];
    if (!c.length) { host.innerHTML = '<p class="card-sub">데이터 없음(진단이벤트 landing 대기)</p>'; return; }
    let worst = null;
    c.forEach(x => { if (x.step_drop_pct != null && (!worst || x.step_drop_pct > worst.step_drop_pct)) worst = x; });
    host.innerHTML = lineChart(c.map(x => ({ x: x.deci, y: x.users })), { mark: worst ? worst.deci : -1, xlab: '', ylab: '유저' });
    if (worst) {
      host.appendChild(el('p', 'chart-note',
        `최대 절벽: <b>${worst.pct}%</b> 지점에서 <b class="drop">−${worst.step_drop_pct}%</b>` +
        (worst.median_hours != null ? ` · 도달 중앙값 ${worst.median_hours}h` : '') +
        (worst.median_class != null ? ` · 신분 ${worst.median_class}` : '')));
    }
  }

  // ── 온보딩 퍼널(막대) ─────────────────────────────────────
  function renderOnb(d) {
    const host = $('#ig-onb'); host.innerHTML = '';
    const rows = d.onboarding_funnel || [];
    if (!rows.length) { host.innerHTML = '<p class="card-sub">데이터 없음</p>'; return; }
    const top = rows[0].users || 1;
    rows.forEach((r, i) => {
      const p = 100 * r.users / top;
      const step = i > 0 && rows[i - 1].users ? Math.round(100 * (rows[i - 1].users - r.users) / rows[i - 1].users) : null;
      const big = step != null && step >= 20;
      const bar = el('div', 'obar' + (big ? ' obar-hot' : ''));
      bar.innerHTML =
        `<div class="obar-lab">${esc(r.step)}</div>` +
        `<div class="obar-track"><div class="obar-fill" style="width:${Math.max(p, 1)}%"></div></div>` +
        `<div class="obar-n num">${num(r.users)}${step != null && step > 0 ? ` <span class="drop">▼${step}%</span>` : ''}</div>`;
      host.appendChild(bar);
    });
  }

  // ── 페이싱 커브 ───────────────────────────────────────────
  function renderPacing(d) {
    const host = $('#ig-pacing'); host.innerHTML = '';
    const p = (d.pacing || []).filter(x => x.median_hours != null);
    if (!p.length) { host.innerHTML = '<p class="card-sub">데이터 없음</p>'; return; }
    host.innerHTML = lineChart(p.map(x => ({ x: x.pct, y: x.median_hours })), { xlab: '%', ylab: 'h' });
    const at = q => (p.find(x => x.pct === q) || {}).median_hours;
    host.appendChild(el('p', 'chart-note',
      `1% ${at(1) ?? '—'}h · 3% ${at(3) ?? '—'}h · 10% ${at(10) ?? '—'}h · 50% ${at(50) ?? '—'}h · 100% ${at(100) ?? '—'}h`));
  }
})();
