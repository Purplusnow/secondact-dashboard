/**
 * SECONDACT BOARD — 마케팅비 자동 전송
 *
 * Google Ads → 도구 및 설정 → 일괄 작업 → 스크립트 → 새 스크립트에 이 파일을 붙여넣고
 * 아래 GITHUB_TOKEN 만 채운 뒤 빈도를 "매시간"으로 잡으면 끝이다.
 *
 * Google Ads API가 아니라 계정에 내장된 스크립트라 개발자 토큰 승인이 필요 없다.
 *
 * 오늘과 어제를 함께 보내는 이유: 구글이 확정 비용을 하루 뒤에 상향 조정한다(실측으로
 * 9/6 56,008→56,820, 9/7 54,124→55,200). 어제 값을 계속 덮어써야 장부가 맞는다.
 */
var GITHUB_OWNER = 'Purplusnow';
var GITHUB_REPO  = 'secondact-dashboard';
var GITHUB_TOKEN = 'PASTE_YOUR_TOKEN_HERE';   // fine-grained PAT · 이 저장소 · Contents: Read and write

/* ★과거치 백필 — 평소엔 0 이다.
 * 스크립트는 매시간 '오늘·어제'만 보낸다(구글이 확정치를 하루 뒤 상향하므로 그 둘만 덮어쓰면 된다).
 * 그래서 붙이기 **전** 기간의 국가별 내역은 비어 있다. 한 번 채우려면 여기에 일수를 넣고
 * 수동 실행한 뒤 **다시 0 으로 되돌린다**(안 되돌리면 매시간 60일치를 재전송한다).
 *
 * 날짜를 쪼개 보내는 이유: GitHub client_payload 가 크면 거부된다.
 * 60일 × 30개국 ≈ 1,800행 ≈ 160KB 라 통째로는 안 들어간다. CHUNK_DAYS 씩 나눠 여러 번 보낸다. */
var BACKFILL_DAYS = 0;
var CHUNK_DAYS = 10;

function main() {
  var tz = AdsApp.currentAccount().getTimeZone();   // 계정 시간대 = 대시보드 기준(KST)

  if (BACKFILL_DAYS > 0) { backfill(tz); return; }   // 끝나면 BACKFILL_DAYS 를 0 으로 되돌릴 것
  var rows = [
    { date: dayOffset(0, tz), cost: costFor('TODAY') },
    { date: dayOffset(1, tz), cost: costFor('YESTERDAY') }
  ];

  // 국가별 분해(2026-10-20 추가). ★기존 rows 경로와 완전히 분리한다 —
  // 여기서 뭐가 터져도 마케팅비 총액 전송은 그대로 가야 한다.
  var geo = [];
  try {
    geo = geoRows(tz);
    Logger.log('국가별 ' + geo.length + '행');
  } catch (e) {
    Logger.log('⚠ 국가별 수집 실패(총액은 정상 전송): ' + e);
  }

  Logger.log('보낼 값: ' + JSON.stringify(rows));

  var res = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/dispatches',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      payload: JSON.stringify({ event_type: 'ads-cost', client_payload: { rows: rows, geo: geo } }),
      muteHttpExceptions: true
    });

  var code = res.getResponseCode();
  // dispatches 는 성공 시 204 No Content 를 준다
  if (code !== 204) {
    throw new Error('GitHub 전송 실패 ' + code + ': ' + res.getContentText());
  }
  Logger.log('전송 완료');
}

function costFor(range) {
  return Math.round(AdsApp.currentAccount().getStatsFor(range).getCost());
}

function dayOffset(daysAgo, tz) {
  var d = new Date(new Date().getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}


/**
 * 국가별 비용·전환 — geographic_view 를 GAQL 로 조회한다.
 *
 * 국가는 **숫자 criterion id** 로 나온다(예: 2410=KR). 이름 변환은 대시보드 쪽에서
 * tools/geo_targets_countries.json 으로 한다 — 스크립트가 매핑을 들고 있으면
 * 구글이 ID 를 늘릴 때마다 스크립트를 다시 붙여넣어야 한다.
 *
 * 총액(rows)과 합이 정확히 맞지는 않는다. 위치를 특정하지 못한 노출이 빠지기 때문이다.
 * 그래서 geo 는 **비율을 보는 용도**이고 장부의 기준은 여전히 rows 다.
 */
function geoRows(tz, fromDaysAgo, toDaysAgo) {
  var from = dayOffset(fromDaysAgo === undefined ? 1 : fromDaysAgo, tz).replace(/-/g, '');
  var to = dayOffset(toDaysAgo === undefined ? 0 : toDaysAgo, tz).replace(/-/g, '');
  var q =
    'SELECT segments.date, geographic_view.country_criterion_id, ' +
    'metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions ' +
    'FROM geographic_view ' +
    'WHERE segments.date BETWEEN "' + from + '" AND "' + to + '"';
  var out = [];
  var it = AdsApp.report(q).rows();
  while (it.hasNext()) {
    var r = it.next();
    var cost = Math.round(Number(r['metrics.cost_micros'] || 0) / 1000000);
    var clicks = Number(r['metrics.clicks'] || 0);
    if (cost === 0 && clicks === 0) continue;        // 빈 행은 보내지 않는다
    out.push({
      date: String(r['segments.date']),
      geo: String(r['geographic_view.country_criterion_id']).replace(/^.*\//, ''),
      cost: cost,
      conv: Number(r['metrics.conversions'] || 0),
      clicks: clicks,
      impr: Number(r['metrics.impressions'] || 0)
    });
  }
  return out;
}


/**
 * 과거 국가별 내역을 CHUNK_DAYS 씩 나눠 보낸다. 한 번만 돌리고 BACKFILL_DAYS 를 0 으로.
 *
 * 총액(rows)은 보내지 않는다 — 일별 마케팅비는 이미 몇 달치가 장부에 있고,
 * 여기서 다시 쓰면 확정 전 수치로 덮어쓸 위험만 있다. 국가별만 채운다.
 */
function backfill(tz) {
  var sent = 0, chunks = 0;
  for (var start = BACKFILL_DAYS; start > 0; start -= CHUNK_DAYS) {
    var end = Math.max(0, start - CHUNK_DAYS + 1);
    var geo = geoRows(tz, start, end);
    if (!geo.length) continue;
    post({ rows: [], geo: geo });
    sent += geo.length; chunks++;
    Logger.log('백필 ' + dayOffset(start, tz) + '~' + dayOffset(end, tz) + ' : ' + geo.length + '행');
    Utilities.sleep(3000);   // 워크플로가 순서대로 커밋하도록 간격을 둔다
  }
  Logger.log('백필 완료 — ' + chunks + '회 전송, ' + sent + '행. ★BACKFILL_DAYS 를 0 으로 되돌리세요.');
}


/** GitHub repository_dispatch 전송 — main 과 backfill 이 공유한다. */
function post(payload) {
  var res = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/dispatches',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      payload: JSON.stringify({ event_type: 'ads-cost', client_payload: payload }),
      muteHttpExceptions: true
    });
  var code = res.getResponseCode();
  if (code !== 204) throw new Error('GitHub 전송 실패 ' + code + ': ' + res.getContentText());
}
