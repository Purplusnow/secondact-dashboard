/* 국가 뷰 — 어디에 돈을 쓸지 정하는 화면.
 *
 * 왜 별도 탭인가: '광고' 탭은 AdMob **수익**(버는 돈)이고 여기는 Google Ads **비용**(쓰는 돈)이다.
 * 축이 반대라 한 화면에 두면 읽는 사람이 반드시 헷갈린다.
 *
 * 핵심은 유저 수가 아니라 **1천명당 결제자**다. 2026-10-20 실측으로 순서가 통째로 뒤집혔다 —
 * 인도가 유입 1위(2,526명)인데 결제자 6명, 한국은 975명인데 36명. 한국 1명 ≈ 인도 15명이다.
 * 유저 수로 정렬한 표를 먼저 보여주면 그 함정에 그대로 빠지므로 **효율순이 기본**이다.
 *
 * 광고비(geo_cost.json)는 Google Ads 스크립트를 붙여넣어야 들어온다. 없으면 유저 쪽만 보여주고
 * 비용 열을 아예 감춘다 — 빈 칸으로 두면 '0원 썼다'로 읽힌다.
 */
(() => {
  const $ = s => document.querySelector(s);
  const num = n => Math.round(n || 0).toLocaleString('ko-KR');
  let loaded = false;

  const prev = window.__viewShown;
  window.__viewShown = view => {
    if (typeof prev === 'function') prev(view);
    if (view === 'geo' && !loaded) { loaded = true; load(); }
  };

  /* ISO 2글자 → 국기. 유니코드 지역표시기호라 표가 한눈에 들어온다. */
  const flag = cc => (cc && cc.length === 2)
    ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
    : '　';

  /* 국가명 한글화 — ISO 코드만 있으면 브라우저가 해 준다(데이터에 한글을 안 들고 다녀도 된다).
     GA4 가 주는 이름은 영어라 그대로 쓰면 한국어 화면에 영어만 늘어선다.
     Intl 이 없거나 코드가 없는 건 원래 이름으로 떨어뜨린다. */
  let RN = null;
  try { RN = new Intl.DisplayNames(['ko'], { type: 'region' }); } catch { /* 구형 브라우저 */ }
  const koName = r => { try { return (r.cc && RN && RN.of(r.cc)) || r.country; } catch { return r.country; } };

  /* 최소 유저 수 — 이 아래는 1천명당 수치가 요동쳐서 순위가 무의미하다.
     (10명 중 1명이 결제하면 100명/1천명이 되어 한국을 3배 앞선다) */
  const MIN_USERS = 100;
  /* 이 미만으로 쓴 국가는 CPI·예상치를 순위에 넣지 않는다(표에는 남긴다). */
  const MIN_COST = 500;

  async function load() {
    let d;
    try {
      const res = await fetch(`data/geo_roi.json?t=${Math.floor(Date.now() / 3600000)}`);
      if (!res.ok) throw new Error(res.status);
      d = await res.json();
    } catch { $('#geo-empty').hidden = false; return; }

    /* ★비용이 있으면 '예상 결제자당' 오름차순이 의사결정 순서다.
       CPI 만 보면 인도가 1위고 전환만 보면 한국이 1위인데, 합치면 또 다르다.
       비용이 너무 적은 국가(MIN_COST 미만)는 CPI 가 요동쳐서 순위에서 뒤로 뺀다
       — 인도네시아가 총 2원 써서 '결제자당 1,667원'으로 1위에 올라왔다. */
    const rows = (d.rows || []).filter(r => r.users >= MIN_USERS);
    const rank = r => (r.exp_cost_per_payer && r.cost >= MIN_COST) ? r.exp_cost_per_payer : Infinity;
    if (d.has_cost) rows.sort((a, b) => rank(a) - rank(b) || b.payers_per_1k - a.payers_per_1k);
    else rows.sort((a, b) => b.payers_per_1k - a.payers_per_1k);
    if (!rows.length) { $('#geo-empty').hidden = false; return; }

    const when = d.updated ? new Date(d.updated).toLocaleString('ko-KR', { hour12: false }) : '-';
    $('#geo-meta').textContent =
      `최근 ${d.days}일 · 유저 ${MIN_USERS}명 이상 ${rows.length}개국 · ${when} 기준`
      + (d.has_cost ? ` · 광고비 ${d.cost_from}~${d.cost_to}` : ' · 광고비 미수집');
    if (d.has_cost) $('#geo-window').hidden = false;

    if (!d.has_cost) $('#geo-nocost').hidden = false;

    const tot = rows.reduce((a, r) => a + r.users, 0);
    const totP = rows.reduce((a, r) => a + r.payers, 0);
    $('#geo-tiles').innerHTML = [
      ['유저', num(tot)],
      ['결제자', num(totP)],
      ['평균 1천명당', (totP * 1000 / tot).toFixed(1) + '명'],
      ['국가', num(rows.length)],
    ].map(([k, v]) => `<div class="tile"><b>${v}</b><span>${k}</span></div>`).join('');

    // 최고 효율을 100%로 둔 막대 — 절대값보다 '몇 배 차이냐'가 의사결정에 쓰인다.
    const top = rows[0].payers_per_1k || 1;
    const head = ['', '국가', '유저', '결제자', '1천명당']
      .concat(d.has_cost ? ['광고비', 'CPI', '예상 결제자당'] : []);
    const body = rows.map(r => {
      const w = Math.max(2, Math.round(r.payers_per_1k / top * 100));
      const cells = [
        `<td class="geo-flag">${flag(r.cc)}</td>`,
        `<td>${koName(r)}</td>`,
        `<td class="n">${num(r.users)}</td>`,
        `<td class="n">${num(r.payers)}</td>`,
        `<td class="n geo-bar"><i style="width:${w}%"></i><b>${r.payers_per_1k.toFixed(1)}</b></td>`,
      ];
      if (d.has_cost) {
        const weak = r.cost && r.cost < MIN_COST;   // 표본이 얇아 순위에 못 쓰는 행
        cells.push(
          `<td class="n">${r.cost ? num(r.cost) : '-'}</td>`,
          `<td class="n">${r.cpi ? num(r.cpi) : '-'}</td>`,
          `<td class="n${weak ? ' geo-weak' : ''}">${r.exp_cost_per_payer ? num(r.exp_cost_per_payer) : '-'}</td>`);
      }
      return `<tr>${cells.join('')}</tr>`;
    }).join('');
    $('#geo-table').innerHTML =
      `<thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;
    $('#geo-card').hidden = false;
  }
})();
