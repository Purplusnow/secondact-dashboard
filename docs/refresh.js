/* 새로고침 버튼.
 *
 * 그냥 F5 로는 모자란다 — 데이터 JSON 은 Pages 앞단 CDN 이 600초를 쥐고 있어서,
 * 수집이 방금 끝났어도 브라우저만 다시 읽으면 옛 파일이 그대로 온다
 * (fetch 의 cache:'no-store' 는 브라우저 캐시만 건너뛴다).
 *
 * 그래서 누를 때마다 새 값을 세션에 적어 두고, 다시 뜬 뒤 모든 data/* 요청에 그 값을
 * 쿼리로 붙인다. URL 이 갈라지면 CDN 도 원본을 다시 가져온다.
 *
 * fetch 를 한 번 감싸는 방식이라 각 뷰의 코드는 건드리지 않는다 — 뷰가 더 늘어도
 * 여기 한 군데로 계속 커버된다. 다른 스크립트보다 먼저 실행돼야 한다.
 */
(() => {
  const KEY = 'bust', VIEW = 'view';

  let bust = '';
  try { bust = sessionStorage.getItem(KEY) || ''; } catch { /* 프라이빗 모드 */ }

  if (bust) {
    const orig = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof input === 'string' && input.startsWith('data/')) {
        input += (input.includes('?') ? '&' : '?') + 'r=' + bust;
      }
      return orig(input, init);
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reload';
    btn.title = '수집된 데이터를 다시 받아옵니다 (CDN 캐시도 건너뜁니다)';
    btn.textContent = '새로고침';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '받는 중…';
      try {
        sessionStorage.setItem(KEY, String(Date.now()));
        // 보던 탭으로 돌아오게 — 새로고침했더니 첫 탭이면 매번 다시 찾아 들어가야 한다
        const on = document.querySelector('.vtab.is-on');
        if (on) sessionStorage.setItem(VIEW, on.dataset.view);
      } catch { /* 저장이 막혀도 새로고침 자체는 한다 */ }
      location.reload();
    });

    const up = document.getElementById('updated');
    (up ? up.parentNode : document.querySelector('.topbar'))
      .insertBefore(btn, up || null);

    // 새로고침 직후라면 보던 탭을 복원한다.
    let want = '';
    try {
      want = sessionStorage.getItem(VIEW) || '';
      sessionStorage.removeItem(VIEW);
    } catch { /* 무시 */ }
    if (want && want !== 'revenue') {
      const tab = document.querySelector(`.vtab[data-view="${want}"]`);
      if (tab) tab.click();
    }
  });
})();
