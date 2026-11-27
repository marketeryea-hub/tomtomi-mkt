/* 톰토미 대시보드 v6 — 데이터 불러오기
 *
 * 저장소는 v5와 같은 Supabase 표(tomtomi_data)를 그대로 읽는다.
 * v6가 쓰는 것: 원가표(skuCost, 올릴 때마다 새 판으로 추가), 파일 올리기((채널, 날짜) 한 줄씩 덮어쓰기), 프로모션(promo, 프로모션 1개 = 한 줄).
 */
(function (root) {
  'use strict';
  var SUPABASE_URL = 'https://ctyhisrbisqaescnpxbx.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0eWhpc3JiaXNxYWVzY25weGJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNjU0NzIsImV4cCI6MjA5MTg0MTQ3Mn0.v4SuezDeg3n8PDkHID1UinvZTH1dGFmqSAmYqtD4R8c';
  var PAGE = 1000;
  var SKIP = { slackConfig: 1 }; // 웹훅 주소는 화면에 필요 없으므로 읽지 않는다

  /* ───────── 로그인 (Supabase Auth, 2026-11-27 보안 작업) ─────────
   * 이메일 + 비밀번호로 로그인하면 1시간짜리 출입증(access token)과 연장용 토큰(refresh token)을 받는다.
   * 모든 데이터 요청은 출입증을 붙여 보낸다(sb). 만료 1분 전이면 알아서 연장한다.
   * '로그인 유지'를 켜면 localStorage, 끄면 sessionStorage(브라우저를 닫으면 사라짐)에 둔다.
   * 역할(tt_role)은 Supabase 계정의 app_metadata에 넣는다: editor(마스터, 수정 가능) / viewer(열람용) / script(메타 스크립트).
   * 진짜 권한은 Supabase의 RLS 규칙이 막고, 화면은 역할에 맞춰 버튼을 숨길 뿐이다.
   */
  var SKEY = 'tt6_session', SES = null, REFRESHING = null, onLost = null;
  function readSes() {
    try { SES = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { SES = null; }
    if (!SES) { try { SES = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); } catch (e) { SES = null; } }
  }
  function writeSes(s) {
    SES = s;
    try { localStorage.removeItem(SKEY); sessionStorage.removeItem(SKEY); } catch (e) { /* 무시 */ }
    if (!s) return;
    try { (s.keep ? localStorage : sessionStorage).setItem(SKEY, JSON.stringify(s)); } catch (e) { /* 저장 못 해도 이번 탭에서는 동작 */ }
  }
  function jwtBody(t) { try { var b = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))))); } catch (e) { return {}; } }
  function authErr(j, status) {
    var m = (j && (j.error_description || j.msg || j.message || j.error)) || ('HTTP ' + status);
    if (/invalid login credentials|invalid_grant/i.test(m)) return '이메일이나 비밀번호가 맞지 않아요';
    if (/email not confirmed/i.test(m)) return '이메일 인증이 안 된 계정이에요 (Supabase에서 계정을 확인해 주세요)';
    if (/refresh token/i.test(m)) return '로그인이 만료됐어요. 다시 로그인해 주세요';
    return m;
  }
  function tokenCall(grant, body, keep) {
    return fetch(SUPABASE_URL + '/auth/v1/token?grant_type=' + grant, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok || !j.access_token) throw new Error(authErr(j, res.status));
        var s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), keep: keep };
        writeSes(s); return s;
      }); });
  }
  function signIn(email, password, keep) { return tokenCall('password', { email: String(email || '').trim(), password: password }, keep !== false); }
  function refresh() {
    if (!SES || !SES.refresh_token) return Promise.reject(new Error('로그인이 필요해요'));
    if (!REFRESHING) REFRESHING = tokenCall('refresh_token', { refresh_token: SES.refresh_token }, SES.keep).then(function (s) { REFRESHING = null; return s; }, function (e) { REFRESHING = null; throw e; });
    return REFRESHING;
  }
  function token() {
    if (!SES) return Promise.resolve(null);
    if (SES.expires_at - Math.floor(Date.now() / 1000) > 60) return Promise.resolve(SES.access_token);
    return refresh().then(function (s) { return s.access_token; }, function () { writeSes(null); if (onLost) onLost(); return null; });
  }
  function signOut() {
    var t = SES && SES.access_token;
    writeSes(null);
    if (!t) return Promise.resolve();
    return fetch(SUPABASE_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + t } }).catch(function () { /* 이미 나간 상태여도 괜찮음 */ });
  }
  function user() {
    if (!SES) return null;
    var b = jwtBody(SES.access_token), am = b.app_metadata || {};
    return { email: b.email || '', role: am.tt_role === 'editor' || am.tt_role === 'viewer' || am.tt_role === 'script' ? am.tt_role : 'viewer' };
  }
  // 데이터 요청: 로그인했으면 출입증, 아니면 공개 키(잠금 뒤에는 아무것도 못 읽음)
  function sb(url, opts) {
    return token().then(function (t) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers || {}, { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (t || SUPABASE_ANON_KEY) });
      return fetch(url, opts).then(function (res) {
        if (res.status === 401 && t) { writeSes(null); if (onLost) onLost(); }
        if ((res.status === 401 || res.status === 403) && opts.method === 'POST') return res.text().then(function (tx) { throw new Error((user() && user().role === 'viewer' ? '열람용 계정은 저장할 수 없어요. ' : '저장 권한이 없어요 (다시 로그인해 보세요). ') + 'HTTP ' + res.status + ' ' + String(tx).slice(0, 80)); });
        return res;
      });
    });
  }
  readSes();

  function loadSupabase() {
    var all = [];
    function page(offset) {
      var url = SUPABASE_URL + '/rest/v1/tomtomi_data?select=channel,date,data&channel=not.in.(itemImg,feedback,supplyImg,metaAdImg)&order=channel,date&limit=' + PAGE + '&offset=' + offset; // 상품 이미지와 제보(캡처 포함)는 무거워서 그 화면에서만 따로 불러온다
      return sb(url)
        .then(function (res) { if (!res.ok) throw new Error('데이터 서버 응답 오류 (HTTP ' + res.status + ')'); return res.json(); })
        .then(function (rows) {
          all = all.concat(rows || []);
          if (rows && rows.length === PAGE) return page(offset + PAGE);
          return all;
        });
    }
    return page(0).then(function (rows) {
      var raw = {}, meta = {}, by = {};
      rows.forEach(function (r) {
        if (!r || SKIP[r.channel] || !Array.isArray(r.data)) return;
        (by[r.channel] = by[r.channel] || {})[r.date] = r.data; // 클라우드의 줄(채널, 날짜) 그대로: 백업과 복원에 쓴다
        (raw[r.channel] = raw[r.channel] || []).push.apply(raw[r.channel], r.data);
        // 저장 구조 점검용: 한 줄(채널, 날짜)에 다른 날짜 데이터가 섞여 있으면 odd로 센다
        var m = meta[r.channel] || (meta[r.channel] = { rows: 0, odd: 0 });
        m.rows++;
        if (r.data.some(function (e) { return e && (e.d || e.date) !== r.date; })) m.odd++;
      });
      raw._meta = meta;
      raw._rowsBy = by;
      raw._rows = rows.length;
      return raw;
    });
  }

  function load() {
    // 기타몰은 2026-11-27부터 구글 시트를 읽지 않는다 (관리 > 기타몰 매출 입력 + 카카오 주문 파일, 둘 다 클라우드에 있음)
    return loadSupabase().then(function (raw) { raw.other = []; raw._otherOk = true; return raw; });
  }

  // 원가표 저장: channel=skuCost, date=판 번호(저장 시각). 같은 판 번호가 이미 있으면 실패하게 둔다(덮어쓰기 방지).
  function saveCost(ver) {
    return sb(SUPABASE_URL + '/rest/v1/tomtomi_data', {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify([{ channel: 'skuCost', date: ver.ver, data: [ver] }])
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('저장 실패 (HTTP ' + res.status + ') ' + String(t).slice(0, 120)); });
      return true;
    });
  }

  // 상품 이미지 (channel=itemImg, date=품목코드, 줄여서 저장한 작은 사진): 상품 관리 화면에서만 불러온다
  // 소모품, 비품 이미지 (channel=supplyImg, date=비품 id): 소모품, 비품 관리 화면에서만 불러온다
  function loadSupplyImages() {
    return sb(SUPABASE_URL + '/rest/v1/tomtomi_data?select=date,data&channel=eq.supplyImg', { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } })
      .then(function (res) { if (!res.ok) throw new Error('이미지를 불러오지 못했습니다 (HTTP ' + res.status + ')'); return res.json(); })
      .then(function (rows) { var m = {}; (rows || []).forEach(function (r) { var e = (r.data || [])[0]; if (e && e.img) m[r.date] = e.img; }); return m; });
  }
  function loadMetaImages() {
    return sb(SUPABASE_URL + '/rest/v1/tomtomi_data?select=date,data&channel=eq.metaAdImg', { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } })
      .then(function (res) { if (!res.ok) throw new Error('이미지를 불러오지 못했습니다 (HTTP ' + res.status + ')'); return res.json(); })
      .then(function (rows) { var m = {}; (rows || []).forEach(function (r) { var e = (r.data || [])[0]; if (e && e.img) m[r.date] = e.img; }); return m; });
  }
  function loadImages() {
    return sb(SUPABASE_URL + '/rest/v1/tomtomi_data?select=date,data&channel=eq.itemImg', { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } })
      .then(function (res) { if (!res.ok) throw new Error('이미지를 불러오지 못했습니다 (HTTP ' + res.status + ')'); return res.json(); })
      .then(function (rows) { var m = {}; (rows || []).forEach(function (r) { var e = (r.data || [])[0]; if (e && e.img) m[r.date] = e.img; }); return m; });
  }

  // 제보 목록 (channel=feedback, date=제보 id): 관리 > 제보 목록에서만 불러온다
  function loadFeedback() {
    return sb(SUPABASE_URL + '/rest/v1/tomtomi_data?select=date,data&channel=eq.feedback&order=date.desc', { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } })
      .then(function (res) { if (!res.ok) throw new Error('제보를 불러오지 못했습니다 (HTTP ' + res.status + ')'); return res.json(); })
      .then(function (rows) { return (rows || []).map(function (r) { return (r.data || [])[0]; }).filter(function (e) { return e && e.id; }); });
  }

  // 백업과 복원용: 클라우드의 모든 줄(웹훅, 상품 이미지 포함)을 (채널, 날짜, 데이터) 그대로 읽는다
  function snapshot() {
    var all = [];
    function page(offset) {
      return sb(SUPABASE_URL + '/rest/v1/tomtomi_data?select=channel,date,data&order=channel,date&limit=' + PAGE + '&offset=' + offset, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } })
        .then(function (res) { if (!res.ok) throw new Error('클라우드를 읽지 못했습니다 (HTTP ' + res.status + ')'); return res.json(); })
        .then(function (rows) { all = all.concat(rows || []); return rows && rows.length === PAGE ? page(offset + PAGE) : all.filter(function (r) { return r && r.channel && Array.isArray(r.data); }); });
    }
    return page(0);
  }

  // 파일 올리기 저장: (채널, 날짜) 한 줄씩 덮어쓰기(upsert). v5의 클라우드 동기화와 같은 방식
  function saveRows(rows) {
    var i = 0, CH = 50, MAXB = 800000; // 한 번에 50줄, 또는 약 0.8MB까지 (상품 이미지처럼 큰 줄은 나눠 보낸다)
    function next() {
      if (i >= rows.length) return Promise.resolve(rows.length);
      var part = [], size = 0, start = i;
      while (i < rows.length && part.length < CH) { var sz = JSON.stringify(rows[i]).length; if (part.length && size + sz > MAXB) break; part.push(rows[i]); size += sz; i++; }
      return sb(SUPABASE_URL + '/rest/v1/tomtomi_data?on_conflict=channel,date', {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(part)
      }).then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw new Error('저장 실패 (HTTP ' + res.status + ', ' + (start + 1) + '번째 줄부터) ' + String(t).slice(0, 120)); });
        return next();
      });
    }
    return next();
  }

  // 새 줄만 넣기 (덮어쓰지 않음): 제보처럼 열람용 계정도 남길 수 있는 것
  function insertRows(rows) {
    return sb(SUPABASE_URL + '/rest/v1/tomtomi_data', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(rows) })
      .then(function (res) { if (!res.ok) return res.text().then(function (t) { throw new Error('저장 실패 (HTTP ' + res.status + ') ' + String(t).slice(0, 120)); }); return rows.length; });
  }
  // 슬랙 웹훅 주소: v5와 같은 곳(브라우저 저장 → 없으면 클라우드 slackConfig)에서 읽는다. 화면에는 보여주지 않는다
  function loadWebhook() {
    var local = ''; try { local = localStorage.getItem('tt_slack_webhook') || ''; } catch (e) { /* 무시 */ }
    if (local) return Promise.resolve(local);
    var url = SUPABASE_URL + '/rest/v1/tomtomi_data?select=data&channel=eq.slackConfig&date=eq.webhook';
    return sb(url)
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (rows) { var u = ''; (rows || []).forEach(function (r) { (r.data || []).forEach(function (x) { if (x && x.url) u = x.url; }); }); return u; })
      .catch(function () { return ''; });
  }
  // 온라인 대시보드 구글 시트: SNS 팔로워(시트1), 경쟁사 검색량(competitor) — v5와 같은 시트
  var ONLINE_GSHEET_ID = '1vuyz2V0I6KgJ0vrpH2cwJ_5XzOcqj12opLRGM4irtu0';
  function csvLine(r) { var out = [], cur = '', q = false; for (var i = 0; i < r.length; i++) { var ch = r[i]; if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; }
  function sheetCsv(sheet) {
    return fetch('https://docs.google.com/spreadsheets/d/' + ONLINE_GSHEET_ID + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(sheet))
      .then(function (res) { return res.text(); }).then(function (t) { return t.trim().split('\n').map(csvLine); });
  }
  function ymd(v) { var m = String(v || '').match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/); return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null; }
  function numv(v) { var n = parseFloat(String(v || '').replace(/,/g, '')); return isNaN(n) ? 0 : n; }
  function loadOnline() {
    var out = { crm: null, competitor: null };
    var a = sheetCsv('시트1').then(function (rows) {
      if (rows.length < 2) return;
      var hd = rows[0].map(function (h) { return String(h || '').toLowerCase().trim(); });
      function ix(names, def) { var i = hd.findIndex(function (h) { return names.indexOf(h) >= 0; }); return i >= 0 ? i : def; }
      var ci = { d: ix(['date'], 0), naver: ix(['naver', '알림받기', 'smartstore'], 1), insta: ix(['insta', 'instagram'], 2), tiktok: ix(['tiktok', '틱톡'], 3), threads: ix(['threads', '쓰레드'], 4) }, crm = { naver: [], insta: [], tiktok: [], threads: [] };
      rows.slice(1).forEach(function (r) { var d = ymd(r[ci.d]); if (!d) return; ['naver', 'insta', 'tiktok', 'threads'].forEach(function (k) { var v = parseInt(String(r[ci[k]] || '').replace(/,/g, ''), 10); if (v > 0) crm[k].push({ date: d, val: v }); }); });
      Object.keys(crm).forEach(function (k) { crm[k].sort(function (x, y) { return x.date < y.date ? -1 : 1; }); });
      out.crm = crm;
    }).catch(function () { /* 못 읽으면 SNS 줄을 뺀다 */ });
    var b = sheetCsv('competitor').then(function (rows) {
      if (rows.length < 2) return;
      var hd = rows[0].map(function (h) { return String(h || '').toLowerCase().trim(); });
      function fi(f, def) { var i = hd.findIndex(f); return i >= 0 ? i : def; }
      var ci = { m: fi(function (h) { return h.indexOf('month') >= 0 || h.indexOf('월') >= 0; }, 0), b: fi(function (h) { return h.indexOf('brand') >= 0 || h.indexOf('브랜드') >= 0; }, 1), mo: fi(function (h) { return h === 'mo' || h === '모바일'; }, 2), pc: fi(function (h) { return h === 'pc'; }, 3), t: fi(function (h) { return h.indexOf('합계') >= 0 || h === 'total'; }, 4) }, bs = {};
      rows.slice(1).forEach(function (r) {
        var mm = String(r[ci.m] || '').trim().match(/^(\d{4})[-./](\d{1,2})/), brand = String(r[ci.b] || '').trim(); if (!mm || !brand) return;
        var month = mm[1] + '-' + ('0' + mm[2]).slice(-2), tot = numv(r[ci.t]) || numv(r[ci.mo]) + numv(r[ci.pc]);
        var o = bs[brand] || (bs[brand] = { dates: [], vals: [] }); o.dates.push(month); o.vals.push(tot);
      });
      Object.keys(bs).forEach(function (k) { var z = bs[k].dates.map(function (d, i) { return { d: d, v: bs[k].vals[i] }; }).sort(function (x, y) { return x.d < y.d ? -1 : 1; }); bs[k].dates = z.map(function (x) { return x.d; }); bs[k].vals = z.map(function (x) { return x.v; }); });
      out.competitor = bs;
    }).catch(function () { /* 못 읽으면 경쟁사 줄을 뺀다 */ });
    return Promise.all([a, b]).then(function () { return out; });
  }
  // 슬랙 보내기: v5와 같은 방식(본문만 JSON 문자열로, 브라우저 사전 확인 없이)
  // 제보 알림을 받을 곳 (리포트 채널과 따로): slackConfig 채널의 'feedback' 줄 { fbUrl }
  function loadFeedbackHook() {
    return sb(SUPABASE_URL + '/rest/v1/tomtomi_data?select=data&channel=eq.slackConfig&date=eq.feedback')
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (rows) { var u = ''; (rows || []).forEach(function (r) { (r.data || []).forEach(function (x) { if (x && x.fbUrl) u = x.fbUrl; }); }); return u; })
      .catch(function () { return ''; });
  }
  function sendSlack(webhook, text) {
    return fetch(webhook, { method: 'POST', body: JSON.stringify({ text: text }) }).then(function (res) {
      return res.text().then(function (t) { if (!res.ok) throw new Error('HTTP ' + res.status + (t ? ' (' + t + ')' : '')); return true; });
    });
  }

  root.TTAuth = { signIn: signIn, signOut: signOut, user: user, token: token, hasSession: function () { return !!SES; }, onLost: function (fn) { onLost = fn; } };
  root.TTData = { load: load, saveCost: saveCost, saveRows: saveRows, insertRows: insertRows, loadImages: loadImages, loadSupplyImages: loadSupplyImages, loadMetaImages: loadMetaImages, snapshot: snapshot, loadFeedback: loadFeedback, loadFeedbackHook: loadFeedbackHook, loadWebhook: loadWebhook, loadOnline: loadOnline, sendSlack: sendSlack };
})(window);
