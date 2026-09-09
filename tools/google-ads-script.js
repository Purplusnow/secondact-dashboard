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

function main() {
  var tz = AdsApp.currentAccount().getTimeZone();   // 계정 시간대 = 대시보드 기준(KST)
  var rows = [
    { date: dayOffset(0, tz), cost: costFor('TODAY') },
    { date: dayOffset(1, tz), cost: costFor('YESTERDAY') }
  ];

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
      payload: JSON.stringify({ event_type: 'ads-cost', client_payload: { rows: rows } }),
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
