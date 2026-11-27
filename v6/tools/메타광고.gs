/**
 * 톰토미 SNS 대시보드: 메타 광고 소재 성과 가져오기 (메타광고.gs)
 *
 * 하는 일
 *  1) 메타 광고관리자 API에서 소재(광고)별 하루 성과를 가져온다
 *     (캠페인, 광고 세트, 소재 이름, 노출, 도달, 클릭(전체), 링크 클릭, 광고비, 랜딩 페이지 조회)
 *  2) 소재마다 최근 7일 빈도를 가져온다
 *  3) 소재 썸네일을 가져온다 (처음 보는 소재만)
 *  4) 톰토미 마케팅 대시보드 클라우드(Supabase)에 바로 넣는다
 *     → 대시보드 광고 > 메타 > 소재 효율에서 보임
 *
 * 저장 규칙
 *  - metaAdDetail: (날짜) 한 줄에 그날 소재 전부. 메타가 준 날짜만 새로 씀. 광고가 없던 날은 건드리지 않음
 *  - metaAdStat: 'last7' 한 줄 (소재별 최근 7일 빈도)
 *  - metaAdImg: (광고 ID) 한 줄에 썸네일 1장
 *  - 지우는 동작은 없음
 *
 * 다른 파일(Code.gs)과 이름이 겹치지 않게 함수와 변수는 모두 ma 로 시작한다.
 * 토큰은 스크립트 보관함에만 저장하고 시트에는 남기지 않는다.
 */

var MA_API = 'https://graph.facebook.com/v23.0';   // 메타 API 버전. 오래되어 막히면 숫자만 올리면 됨
var MA_SB_URL = 'https://ctyhisrbisqaescnpxbx.supabase.co';
var MA_SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0eWhpc3JiaXNxYWVzY25weGJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNjU0NzIsImV4cCI6MjA5MTg0MTQ3Mn0.v4SuezDeg3n8PDkHID1UinvZTH1dGFmqSAmYqtD4R8c'; // 공개 키(누구나 알아도 되는 키). 실제 권한은 '4. 대시보드 저장용 계정'으로 로그인해서 받는다
var MA_TZ = 'Asia/Seoul';

/* ---------------- 메뉴 ---------------- */

// 처음 한 번: 편집기에서 이 함수를 골라 [실행] → 시트를 열 때마다 '메타광고' 메뉴가 생김
function maInstallMenu() {
  var ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'maOnOpen') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('maOnOpen').forSpreadsheet(ss).onOpen().create();
  maOnOpen();
  ss.toast('메타광고 메뉴를 만들었어요. 시트를 새로고침하면 위쪽 메뉴에 보여요.');
}

function maOnOpen() {
  SpreadsheetApp.getUi().createMenu('메타광고')
    .addItem('1. 토큰과 광고계정 등록', 'maRegister')
    .addItem('2. 지난 기록 채우기', 'maBackfill')
    .addItem('3. 매일 아침 자동으로 가져오기 켜기', 'maInstallDaily')
    .addItem('4. 대시보드 저장용 계정 등록', 'maRegisterSb')
    .addSeparator()
    .addItem('지금 가져오기 (최근 3일)', 'maSyncNow')
    .addItem('자동 가져오기 끄기', 'maRemoveDaily')
    .addToUi();
}

/* ---------------- 등록 ---------------- */

function maRegister() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('메타광고 토큰', 'ads_read 권한이 있는 토큰을 붙여넣어 주세요.\n(시트에는 남지 않고 스크립트 보관함에만 저장돼요)', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var token = r1.getResponseText().trim();
  var r2 = ui.prompt('광고계정 ID', '광고관리자 주소창의 act= 뒤 숫자를 붙여넣어 주세요. (예: 1234567890)', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var acc = r2.getResponseText().replace(/[^0-9]/g, '');
  if (!token || !acc) { ui.alert('토큰과 광고계정 ID를 둘 다 넣어 주세요.'); return; }

  var test = maGet_(MA_API + '/act_' + acc + '?fields=name,currency,account_status&access_token=' + encodeURIComponent(token));
  if (!test.ok) { ui.alert('연결 확인 실패\n\n' + test.message + '\n\n토큰에 ads_read 권한이 있는지, 광고계정 ID가 맞는지 확인해 주세요.'); return; }

  var exp = '';
  var dbg = maGet_(MA_API + '/debug_token?input_token=' + encodeURIComponent(token) + '&access_token=' + encodeURIComponent(token));
  if (dbg.ok && dbg.data && dbg.data.data) {
    var e = dbg.data.data.expires_at;
    exp = !e ? '만료 없음' : Utilities.formatDate(new Date(e * 1000), MA_TZ, 'yyyy-MM-dd');
  }
  var P = PropertiesService.getScriptProperties();
  P.setProperty('MA_TOKEN', token); P.setProperty('MA_ACCOUNT', acc); P.setProperty('MA_EXPIRES', exp);
  maSetting_('연결됨: ' + test.data.name + (exp ? ' (토큰 만료: ' + exp + ')' : ''));
  ui.alert('"' + test.data.name + '" 광고계정 연결 완료!\n통화: ' + test.data.currency + (exp ? '\n토큰 만료: ' + exp : '') +
    (test.data.currency !== 'KRW' ? '\n\n⚠ 통화가 원화가 아니에요. 대시보드 금액이 원화가 아닐 수 있어요.' : '') +
    '\n\n다음: 메타광고 → 2. 지난 기록 채우기');
}

// 대시보드 잠금(로그인) 뒤에는 스크립트도 로그인해야 저장할 수 있다. 메타 데이터만 저장할 수 있는 스크립트 전용 계정을 쓴다
function maRegisterSb() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('대시보드 저장용 계정 (1/2)', '스크립트 전용 계정의 이메일을 넣어 주세요.', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var r2 = ui.prompt('대시보드 저장용 계정 (2/2)', '그 계정의 비밀번호를 넣어 주세요. (시트에는 남지 않고 스크립트 보관함에만 저장돼요)', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var email = r1.getResponseText().trim(), pw = r2.getResponseText();
  MA_TOKEN_CACHE = null;
  var t = maSbLogin_(email, pw);
  if (!t.ok) { ui.alert('로그인 실패: ' + t.message); return; }
  var P = PropertiesService.getScriptProperties(); P.setProperty('MA_SB_EMAIL', email); P.setProperty('MA_SB_PW', pw);
  ui.alert('대시보드 저장용 계정 연결 완료!\n이제 메타 데이터를 로그인해서 저장해요.');
}
var MA_TOKEN_CACHE = null;
function maSbLogin_(email, pw) {
  var res = UrlFetchApp.fetch(MA_SB_URL + '/auth/v1/token?grant_type=password', { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { apikey: MA_SB_KEY }, payload: JSON.stringify({ email: email, password: pw }) });
  var j = {}; try { j = JSON.parse(res.getContentText()); } catch (e) {}
  if (res.getResponseCode() !== 200 || !j.access_token) return { ok: false, message: (j.error_description || j.msg || j.error || ('HTTP ' + res.getResponseCode())) };
  MA_TOKEN_CACHE = j.access_token;
  return { ok: true, token: j.access_token };
}
// 저장할 때 붙일 출입증: 계정이 등록돼 있으면 로그인 출입증, 아니면 공개 키(잠금 전까지만 동작)
function maAuth_() {
  if (MA_TOKEN_CACHE) return MA_TOKEN_CACHE;
  var P = PropertiesService.getScriptProperties(), em = P.getProperty('MA_SB_EMAIL'), pw = P.getProperty('MA_SB_PW');
  if (!em || !pw) return MA_SB_KEY;
  var t = maSbLogin_(em, pw);
  if (!t.ok) throw new Error('대시보드 로그인 실패: ' + t.message + ' → 메타광고 → 4. 대시보드 저장용 계정 등록');
  return t.token;
}

/* ---------------- 가져오기 ---------------- */

function maSyncNow() { var r = maSync_(maDay_(-3), maDay_(-1), true); SpreadsheetApp.getActive().toast(r); }
function maDaily() { maSync_(maDay_(-3), maDay_(-1), true); }

// 지난 기록: 시작일부터 어제까지 15일씩. 5분이 넘으면 멈추고 다음 번에 이어서
function maBackfill() {
  var ui = SpreadsheetApp.getUi(), P = PropertiesService.getScriptProperties();
  var next = P.getProperty('MA_FILL_NEXT');
  var r = ui.prompt('지난 기록 채우기', '어느 날짜부터 가져올까요? (예: 2026-04-01)' + (next ? '\n지난번에 ' + next + '까지 왔어요. 이어서 하려면 비워두고 확인' : ''), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var from = r.getResponseText().trim() || next;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) { ui.alert('날짜를 2026-04-01 처럼 넣어 주세요.'); return; }
  var end = maDay_(-1), start = Date.now(), d = from, days = 0;
  while (d <= end) {
    var to = maAdd_(d, 14); if (to > end) to = end;
    var res = maSync_(d, to, false);
    if (/^실패/.test(res)) { ui.alert(d + ' ~ ' + to + ' 가져오기 실패\n\n' + res); return; }
    days++; d = maAdd_(to, 1); P.setProperty('MA_FILL_NEXT', d);
    if (Date.now() - start > 4.5 * 60 * 1000 && d <= end) { ui.alert('시간이 오래 걸려서 ' + d + ' 전까지 가져오고 멈췄어요.\n메뉴에서 "2. 지난 기록 채우기"를 한 번 더 누르고 비워둔 채 확인하면 이어서 해요.'); return; }
  }
  P.deleteProperty('MA_FILL_NEXT');
  maStat_(); maImages_(40);
  ui.alert(from + ' ~ ' + end + ' 가져오기 끝!\n대시보드에서 Cmd+Shift+R로 새로고침해 보세요.');
}

// since ~ until (yyyy-MM-dd) 소재별 하루 성과를 가져와 저장. 결과 문구를 돌려줌
function maSync_(since, until, withExtra) {
  var P = PropertiesService.getScriptProperties(), token = P.getProperty('MA_TOKEN'), acc = P.getProperty('MA_ACCOUNT');
  if (!token || !acc) { maLog_('실패', 0, '토큰이 등록되지 않았어요. 메타광고 → 1. 토큰과 광고계정 등록'); return '실패: 토큰 미등록'; }
  try {
    var fields = 'date_start,campaign_name,adset_name,ad_name,ad_id,impressions,reach,clicks,inline_link_clicks,spend,actions';
    var url = MA_API + '/act_' + acc + '/insights?level=ad&time_increment=1&limit=500' +
      '&fields=' + encodeURIComponent(fields) +
      '&time_range=' + encodeURIComponent(JSON.stringify({ since: since, until: until })) +
      '&access_token=' + encodeURIComponent(token);
    var all = maPaged_(url);
    var byDay = {};
    all.forEach(function (x) {
      var d = x.date_start; if (!d) return;
      var lpv = 0;
      (x.actions || []).forEach(function (a) { if (a.action_type === 'landing_page_view') lpv = Number(a.value) || 0; });
      var o = { d: d, camp: x.campaign_name || '', set: x.adset_name || '', ad: x.ad_name || '', adId: String(x.ad_id || ''),
        imp: Number(x.impressions) || 0, reach: Number(x.reach) || 0, clicks: Number(x.clicks) || 0,
        link: Number(x.inline_link_clicks) || 0, cost: Math.round(Number(x.spend) || 0), lpv: lpv, src: 'api' };
      if (!o.imp && !o.cost && !o.clicks) return;
      (byDay[d] = byDay[d] || []).push(o);
    });
    var rows = Object.keys(byDay).sort().map(function (d) { return { channel: 'metaAdDetail', date: d, data: byDay[d] }; });
    if (rows.length) maSave_(rows);
    var extra = '';
    if (withExtra) { extra = maStat_() + maImages_(20); maExpiryWarn_(); }
    var msg = since + ' ~ ' + until + ': ' + rows.length + '일, 소재 줄 ' + all.length + '개' + extra;
    maLog_('성공', all.length, msg);
    return msg;
  } catch (e) {
    var m = String(e && e.message ? e.message : e);
    maLog_('실패', 0, m);
    return '실패: ' + m;
  }
}

// 소재별 최근 7일 빈도
function maStat_() {
  var P = PropertiesService.getScriptProperties(), token = P.getProperty('MA_TOKEN'), acc = P.getProperty('MA_ACCOUNT');
  var url = MA_API + '/act_' + acc + '/insights?level=ad&date_preset=last_7d&limit=500&fields=' + encodeURIComponent('ad_id,frequency,reach,impressions') + '&access_token=' + encodeURIComponent(token);
  var list = maPaged_(url).map(function (x) { return { d: 'last7', adId: String(x.ad_id || ''), freq: Number(x.frequency) || 0, reach: Number(x.reach) || 0, imp: Number(x.impressions) || 0, upto: maDay_(-1) }; });
  if (list.length) maSave_([{ channel: 'metaAdStat', date: 'last7', data: list }]);
  return ', 7일 빈도 ' + list.length + '개';
}

// 처음 보는 소재의 썸네일 (한 번에 최대 limit개)
function maImages_(limit) {
  var P = PropertiesService.getScriptProperties(), token = P.getProperty('MA_TOKEN');
  var have = {};
  maSbGet_('/rest/v1/tomtomi_data?select=date&channel=eq.metaAdImg').forEach(function (r) { have[r.date] = 1; });
  var ids = {};
  maSbGet_('/rest/v1/tomtomi_data?select=data&channel=eq.metaAdDetail&order=date.desc&limit=120').forEach(function (r) {
    (r.data || []).forEach(function (e) { if (e.adId && !have[e.adId]) ids[e.adId] = 1; });
  });
  var todo = Object.keys(ids).slice(0, limit), saved = 0, rows = [];
  todo.forEach(function (id) {
    try {
      var ad = maGet_(MA_API + '/' + id + '?fields=creative&access_token=' + encodeURIComponent(token));
      if (!ad.ok || !ad.data.creative) return;
      var cr = maGet_(MA_API + '/' + ad.data.creative.id + '?fields=thumbnail_url&thumbnail_width=400&thumbnail_height=400&access_token=' + encodeURIComponent(token));
      if (!cr.ok || !cr.data.thumbnail_url) return;
      var blob = UrlFetchApp.fetch(cr.data.thumbnail_url, { muteHttpExceptions: true }).getBlob();
      var bytes = blob.getBytes(); if (!bytes.length || bytes.length > 400000) return;
      rows.push({ channel: 'metaAdImg', date: id, data: [{ d: id, img: 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(bytes) }] });
      saved++;
    } catch (e) { /* 썸네일 하나 실패는 넘어감 */ }
  });
  if (rows.length) maSave_(rows);
  return ', 새 썸네일 ' + saved + '개';
}

/* ---------------- 자동 실행 ---------------- */

function maInstallDaily() {
  maRemoveDaily(true);
  ScriptApp.newTrigger('maDaily').timeBased().everyDays(1).atHour(9).inTimezone(MA_TZ).create();
  SpreadsheetApp.getUi().alert('매일 아침 9시쯤 최근 3일 메타 광고 성과를 가져와요.\n(메타 숫자는 하루 이틀 뒤에 조금 바뀔 수 있어서 3일씩 다시 가져와요)');
}
function maRemoveDaily(silent) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'maDaily') ScriptApp.deleteTrigger(t); });
  if (silent !== true) SpreadsheetApp.getUi().alert('메타광고 자동 가져오기를 껐어요.');
}

/* ---------------- 도우미 ---------------- */

function maGet_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true }), code = res.getResponseCode(), body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  if (code !== 200) {
    var m = body && body.error ? body.error.message : 'HTTP ' + code;
    if (body && body.error && body.error.code === 190) m = '토큰이 만료됐거나 잘못됐어요. 메타광고 → 1. 토큰과 광고계정 등록 (' + m + ')';
    return { ok: false, message: m };
  }
  return { ok: true, data: body };
}
function maPaged_(url) {
  var out = [], guard = 0;
  while (url && guard++ < 60) {
    var r = maGet_(url);
    if (!r.ok) throw new Error(r.message);
    out = out.concat(r.data.data || []);
    url = r.data.paging && r.data.paging.next ? r.data.paging.next : null;
  }
  return out;
}
function maSave_(rows) {
  for (var i = 0; i < rows.length; i += 30) {
    var res = UrlFetchApp.fetch(MA_SB_URL + '/rest/v1/tomtomi_data?on_conflict=channel,date', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: MA_SB_KEY, Authorization: 'Bearer ' + maAuth_(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(rows.slice(i, i + 30))
    });
    var c = res.getResponseCode();
    if (c >= 300) throw new Error('대시보드 저장 실패 (HTTP ' + c + ') ' + res.getContentText().slice(0, 200));
  }
}
function maSbGet_(path) {
  var res = UrlFetchApp.fetch(MA_SB_URL + path, { muteHttpExceptions: true, headers: { apikey: MA_SB_KEY, Authorization: 'Bearer ' + maAuth_() } });
  if (res.getResponseCode() !== 200) return [];
  try { return JSON.parse(res.getContentText()) || []; } catch (e) { return []; }
}
function maExpiryWarn_() {
  var exp = PropertiesService.getScriptProperties().getProperty('MA_EXPIRES');
  if (!exp || exp === '만료 없음') return;
  var left = Math.round((new Date(exp + 'T00:00:00+09:00') - new Date()) / 86400000);
  if (left <= 10) maLog_('실패', 0, '메타광고 토큰이 ' + left + '일 뒤(' + exp + ') 만료돼요. 새 토큰을 받아 메타광고 → 1. 토큰과 광고계정 등록');
}
function maDay_(n) { var d = new Date(); d.setDate(d.getDate() + n); return Utilities.formatDate(d, MA_TZ, 'yyyy-MM-dd'); }
function maAdd_(ds, n) { var p = ds.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2] + n); return Utilities.formatDate(d, MA_TZ, 'yyyy-MM-dd'); }
function maLog_(status, count, memo) {
  var sh = SpreadsheetApp.getActive().getSheetByName('수집로그'); if (!sh) return;
  sh.appendRow([new Date(), '메타광고', status, count, memo]);
  var r = sh.getLastRow();
  sh.getRange(r, 1, 1, 5).setBackground(status === '실패' ? '#F8D7DA' : null);
}
function maSetting_(text) {
  var sh = SpreadsheetApp.getActive().getSheetByName('설정'); if (!sh) return;
  var v = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 0; i < v.length; i++) if (String(v[i][0]).trim() === '메타광고') { sh.getRange(i + 1, 2, 1, 2).setValues([[text, '메뉴 > 메타광고에서 관리. 토큰은 시트에 안 남음']]); return; }
}
