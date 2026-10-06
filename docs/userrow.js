/* 가입자 한 줄을 그리는 공용 조각 — 실시간 뷰(realtime.js)와 전체 가입자 뷰(users.js)가 같이 쓴다.
 *
 * 두 화면이 같은 모양이어야 비교가 된다. 한쪽에만 손대면 금세 갈라지므로 여기 모아 둔다.
 * 다른 건 범위뿐이다: 실시간은 최근 24시간(스트리밍), 전체는 하루 단위 확정본.
 */
window.UserRow = (() => {

  /* 분 단위 시간. 10분 밑에서는 소수 한 자리를 남긴다 — 초반 유저는 대부분 1분 미만이라
     정수로 끊으면 "30초 하고 나감"과 "아예 안 함"이 똑같이 0분이 된다. */
  function dur(m) {
    const v = +m || 0;
    if (v >= 60) return `${Math.floor(v / 60)}시간 ${Math.round(v % 60)}분`;
    if (v >= 10) return `${Math.round(v)}분`;
    return `${v.toFixed(1)}분`;
  }

  /* 추월%. 0 은 '진행 없음'이 아니라 '0.1% 미만'이다 — 가장 고운 눈금(progress_deci 의 1)이
     0.1% 라 그 아래는 애초에 못 잰다. '—' 로 적으면 기록이 없는 것처럼 보여서 다르게 쓴다. */
  function progText(v) {
    const p = +v || 0;
    if (!p) return '<0.1%';
    return (p < 10 ? p.toFixed(1) : Math.round(p)) + '%';
  }

  /* 추월% 칸 — 숫자 옆에 막대를 같이 둔다. 숫자만 있으면 빠르게 스크롤하면서
     '몇 % 넘은 사람'을 골라낼 수가 없다. 길이가 일정한 자리에 있어야 눈이 훑는다.

     눈금은 로그다. 값이 0.1%부터 100%까지 세 자릿수에 걸쳐 있고 그중 대부분이 1% 아래라,
     선형으로 그리면 거의 모든 막대가 보이지 않는 선이 된다.
       0.1% → 왼쪽 끝 · 1% → 1/3 · 10% → 2/3 · 100% → 오른쪽 끝
     세로로 쌓였을 때 자릿수가 바뀌는 지점이 일정한 간격으로 보이는 게 스캔에 유리하다. */
  const HI = 50;   // 여기를 넘으면 색이 바뀐다 — 로그 눈금이라 길이만으로는 경계가 안 읽힌다

  function progCell(td, v) {
    const p = +v || 0;
    const hi = p >= HI;
    td.className = 'pg-cell' + (hi ? ' is-hi' : '');
    const track = document.createElement('span');
    track.className = 'pg';
    if (p > 0) {
      const fill = document.createElement('i');
      // 0.1% 도 눈에 걸리도록 최소 폭을 준다 — 0 과 '아주 작음'은 구분돼야 한다
      fill.style.width = Math.max(5, Math.min(100, (Math.log10(p) + 1) / 3 * 100)) + '%';
      track.appendChild(fill);
    }
    const txt = document.createElement('span');
    txt.className = 'pg-val' + (p ? '' : ' dim');
    txt.textContent = progText(p);
    td.append(track, txt);
    td.title = `추월% — 막대는 로그 눈금입니다(0.1 · 1 · 10 · 100%가 고른 간격).`
      + `\n${HI}% 이상은 녹색입니다.`;
    return td;
  }


  /* 재방문 칸. 값은 '세션 수 − 1' 이다 — 처음 들어온 한 번은 재방문이 아니다.

     세션 경계는 GA4 기준(마지막 활동에서 30분이 지나면 새 세션)이다. 방치형이라 이 눈금이
     오히려 맞는다: 잠깐 홈으로 내렸다 바로 돌아온 건 한 번 논 거고, 몇 시간 뒤 다시 켠 게
     진짜 재방문이다. 다만 **30분 안의 껐다 켜기는 안 잡힌다** — 그걸 세려면 빌드가
     포그라운드 복귀를 직접 보내야 한다.

     0 을 흐리게 두는 건, 이 줄에서 눈에 걸려야 하는 쪽이 '돌아온 사람'이기 때문이다. */
  const BACK_HI = 2;   // 2회 이상 돌아왔으면 색을 준다

  function visitCell(td, sessions) {
    const n = Math.max(0, (+sessions || 0) - 1);
    td.className = 'bk-cell' + (n === 0 ? ' dim' : n >= BACK_HI ? ' is-hi' : '');
    td.textContent = n;
    td.title = n === 0
      ? '처음 들어온 뒤 다시 들어오지 않았습니다.'
      : `${n}번 다시 들어왔습니다(세션 ${+sessions || 0}회).`;
    td.title += '\n세션 경계는 30분입니다 — 그보다 짧게 껐다 켠 건 세지 않습니다.';
    return td;
  }


  /* 방치 보상 수령 칸. 0원 수령은 세지 않는 게 아니라 **애초에 없다** —
     게임이 offline_reward <= 0 이면 팝업을 안 띄우고, 수령은 그 팝업에서만 일어난다.

     배수를 쓴 횟수(광고×2 · 보석×3)를 위첨자로 같이 적는다. 방치형에서 "몇 번 돌아와
     받았나"와 "받을 때 더 들였나"는 다른 질문이고, 뒤쪽이 수익화에 더 가깝다. */
  const OFF_HI = 3;   // 이만큼 받았으면 그날 루프를 제대로 돈 것이다

  function offlineCell(td, n, boost) {
    const c = +n || 0, b = +boost || 0;
    td.className = 'of-cell' + (c === 0 ? ' dim' : c >= OFF_HI ? ' is-hi' : '');
    td.textContent = c;
    if (b > 0) {
      const sup = document.createElement('sup');
      sup.className = 'of-boost';
      sup.textContent = '+' + b;
      td.appendChild(sup);
    }
    td.title = c === 0
      ? '방치 보상을 한 번도 받지 않았습니다.'
      : `방치 보상을 ${c}번 받았습니다` + (b > 0 ? `, 그중 ${b}번은 광고·보석으로 배수를 썼습니다.` : '.');
    td.title += '\n0원 수령은 집계에서 뺀 게 아니라 게임이 아예 만들지 않습니다'
      + '(쌓인 보상이 없으면 팝업이 뜨지 않습니다).';
    return td;
  }

  /* 비트마스크 → 단계별 0/1 배열. 전체 뷰는 한 명이 25칸 배열을 들고 다니면 용량이 커져서
     정수 하나로 접어 보낸다(216바이트 → 130바이트). 실시간 뷰는 배열 그대로 쓴다. */
  const unpack = (mask, n) => Array.from({ length: n }, (_, i) => (mask >> i) & 1);

  /* 곁가지는 목록 꼬리에 모여 있다 — 첫 곁가지 인덱스가 곧 척추의 길이다. */
  function spineLen(stages) {
    const i = stages.findIndex(x => x.kind === 'side');
    return i < 0 ? stages.length : i;
  }

  /* 진행 스트립. 채워진 칸이 그 유저가 밟은 단계다. */
  function fillStrip(td, reached, stages, far, spineN) {
    td.className = 'rt-strip';
    const sn = spineN != null ? spineN : spineLen(stages);
    reached.forEach((v, i) => {
      const side = (stages[i] || {}).kind === 'side';
      // 척추에서 far 아래인데 기록이 없는 칸 = '안 갔다'가 아니라 '기록이 없다'.
      // 계측이 현재값만 찍는 칸(부동산N)이거나 후처리 전 유실이다 — 옅게 채워 구분해 둔다.
      const implied = !v && !side && i < sn && i <= far;
      const cell = document.createElement('i');
      cell.className = (v ? (side ? 'on side' : 'on') : implied ? 'imp' : '');
      cell.title = `${i + 1}. ${(stages[i] || {}).label || ''} — `
        + (v ? '도달' : implied ? '도달(기록 없음 — 뒤 단계로 추정)' : '미도달')
        + (side ? ' · 독립 단계' : '');
      if (side && (i === 0 || (stages[i - 1] || {}).kind !== 'side')) cell.classList.add('gap');
      td.appendChild(cell);
    });
  }

  return { dur, progText, progCell, visitCell, offlineCell, unpack, spineLen, fillStrip };
})();
