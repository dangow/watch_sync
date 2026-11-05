// ==UserScript==
// @name         同步觀影（愛奇藝 / iOS Safari）
// @description  和 watch-sync 電腦版互通：同步播放/暫停/進度，並自動跳到對方選的影片
// @version      2.0
// @match        https://*.iqiyi.com/*
// @match        https://*.iq.com/*
// @run-at       document-idle
// @noframes
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==

(function () {
  'use strict';
  if (window.__wsyncLoaded) return;
  window.__wsyncLoaded = true;

  var KEY_S = 'iqiyiSyncServer', KEY_R = 'iqiyiSyncRoom', KEY_U = 'wsyncUid';
  var sock = null, video = null, applying = false;
  var pending = false, requested = false, lastCount = 0, lastKey = null, firstTick = true;
  var bar = null, label = null;
  var prevKey = null;   // 換頁前的影片 key（用來判斷是不是同一部重新整理）
  try { prevKey = sessionStorage.getItem('wsyncKey'); } catch (e) {}
  var cfg = { server: '', room: '' };

  if (location.protocol !== 'https:') return;   // 多一層保險：http 頁面不執行

  // 用密碼學亂數產生 id（Math.random 可被預測）
  function randomId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16)), s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }
  // ---- 設定存放位置 ----
  // 優先存在腳本自己的空間（GM.getValue / GM.setValue），愛奇藝網頁上的其他腳本讀不到。
  // 腳本管理器不支援時，才退回網站的 localStorage（網頁上的腳本讀得到，安全性較低）。
  var hasGM = typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function' && typeof GM.setValue === 'function';
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function getVal(k) {
    if (!hasGM) return Promise.resolve(lsGet(k));
    return Promise.resolve(GM.getValue(k, '')).then(function (v) {
      var old = lsGet(k);
      if (!v && old) {   // 舊版存在 localStorage → 搬到腳本空間，再從網站上刪掉
        return Promise.resolve(GM.setValue(k, old)).then(function () { lsDel(k); return old; });
      }
      if (old) lsDel(k);
      return v || '';
    }).catch(function () { return lsGet(k); });
  }
  function setVal(k, v) {
    if (!hasGM) { lsSet(k, v); return; }
    Promise.resolve(GM.setValue(k, v)).catch(function () { lsSet(k, v); });
  }

  // 每支手機一個固定 id，伺服器才能算「幾個人」（init 時讀取）
  var peerId = '';

  // 只允許加密連線；ws:// 只限本機測試
  function serverOk(u) {
    try { var x = new URL(u); return x.protocol === 'wss:' || (x.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].indexOf(x.hostname) >= 0); } catch (e) { return false; }
  }
  // 只允許跳到愛奇藝的影片頁（https + 指定網站 + 指定路徑）
  function okVideoUrl(u) {
    return u.protocol === 'https:' && /^([\w-]+\.)?(iq\.com|iqiyi\.com)$/.test(u.hostname) && /^\/(play|v_)/.test(u.pathname);
  }
  function videoPage() { return /\/(play|v_)/.test(location.pathname); }
  function key(u) { try { return new URL(u, location.href).pathname; } catch (e) { return u; } }

  function loadCfg() {
    return Promise.all([getVal(KEY_S), getVal(KEY_R), getVal(KEY_U)]).then(function (r) {
      cfg.server = r[0]; cfg.room = r[1];
      peerId = r[2];
      if (!peerId) { peerId = randomId(); setVal(KEY_U, peerId); }
    });
  }
  function askCfg() {
    var s = prompt('伺服器網址（wss://...）', cfg.server);
    if (s === null) return false;
    var r = prompt('房間代碼（和朋友一樣）', cfg.room);
    if (r === null) return false;
    cfg.server = s.trim(); cfg.room = r.trim();
    setVal(KEY_S, cfg.server); setVal(KEY_R, cfg.room);
    return true;
  }

  function makeBar() {
    if (bar) return;
    bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;display:flex;gap:6px;font:13px sans-serif;color:#fff;opacity:.9';
    label = document.createElement('div');
    label.style.cssText = 'padding:6px 10px;border-radius:6px;background:#b42318';
    label.onclick = function () { if (askCfg()) connect(); };   // 點狀態文字 = 修改設定
    var push = document.createElement('div');
    push.textContent = '↻';
    push.style.cssText = 'padding:6px 10px;border-radius:6px;background:#444';
    push.onclick = function () { send(video && video.paused ? 'pause' : 'play', true); };
    bar.appendChild(label); bar.appendChild(push);
    document.documentElement.appendChild(bar);
  }
  function setBadge(text, ok) {
    makeBar();
    label.textContent = '同步：' + text;
    label.style.background = ok ? '#1a7f37' : '#b42318';
  }

  function raw(obj) { if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj)); }

  function connect() {
    if (sock) { sock.__stop = true; try { sock.close(); } catch (e) {} sock = null; }
    if (!cfg.server || !cfg.room) { setBadge('點我設定', false); return; }
    if (!serverOk(cfg.server)) { setBadge('請用 wss:// 網址（點我修改）', false); return; }
    var s;
    try { s = new WebSocket(cfg.server); } catch (e) { setBadge('網址格式錯誤（點我修改）', false); return; }
    sock = s; requested = false; lastCount = 0;
    setBadge('連線中…', false);
    s.onopen = function () { s.send(JSON.stringify({ type: 'join', room: cfg.room, peer: peerId })); };
    s.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'peers') {
        setBadge(m.count >= 2 ? '已連線（房內 ' + m.count + ' 人）' : '已連線，等朋友加入', m.count >= 2);
        if (m.me && m.rejoin) {
          // 我只是換頁重連（不是新加入）
          var followed = false, same = false;
          try {
            var g = JSON.parse(sessionStorage.getItem('wsyncGo') || 'null');
            followed = !!(g && Date.now() - g.t < 30000 && key(g.url) === key(location.href));
          } catch (err) {}
          same = prevKey !== null && prevKey === key(location.href);
          if (followed || same) {
            // 跟隨對方而來 / 同一部影片重新整理 → 不推，向對方要進度
            if (m.count >= 2 && !requested) raw({ type: 'request' });
          } else {
            sendNav();   // 自己選了新影片 → 推出去；不要進度（否則會把對方舊影片的秒數套到新影片）
          }
          requested = true;
        } else if (!m.me && m.count > lastCount) sendNav();   // 有新人加入 → 把我的影片推給他
        lastCount = m.count;
        if (m.count >= 2 && !requested && m.me !== false) { requested = true; raw({ type: 'request' }); }  // 我是新加入的 → 要對方目前進度
      } else if (m.type === 'request') {
        if (video) raw({ type: video.paused ? 'pause' : 'play', time: video.currentTime });
      } else if (m.type === 'status') {
        setBadge(String(m.text || '').slice(0, 100), !!m.ok);
      } else if (m.type === 'nav') {
        goTo(m.url);
      } else if (m.type === 'play' || m.type === 'pause') {
        handle(m);
      }                                                       // 其他（心跳 hb 等）一律忽略
    };
    s.onerror = function () { setBadge('連線失敗（點我修改）', false); };
    s.onclose = function (e) {
      if (s.__stop) return;
      if (e.code === 1008) return;   // 伺服器拒絕加入：不自動重連，保留伺服器訊息（點標籤可改設定）
      var wait = e.code === 1013 ? 30000 : 3000;   // 房間已滿：等久一點再試
      if (e.code !== 1013) setBadge('斷線，重連中…', false);
      setTimeout(function () { if (sock === s) connect(); }, wait);
    };
  }

  function send(type, force) {
    if (!video || (applying && !force)) return;
    raw({ type: type, time: video.currentTime });
  }

  function handle(m) {
    if (!video) return;
    applying = true;
    if (typeof m.time === 'number' && Math.abs(video.currentTime - m.time) > 0.5) video.currentTime = m.time;
    if (m.type === 'play') {
      var p = video.play();
      if (p && p.catch) p.catch(function () { pending = true; setBadge('點一下頁面即可加入同步', false); });
    } else { video.pause(); }
    setTimeout(function () { applying = false; }, 1200);
  }

  // iOS 擋自動播放：使用者點一下 → 先在手勢內啟動播放，再向對方要最新進度
  function flush() {
    if (!pending || !video) return;
    pending = false;
    video.play().catch(function () {});
    raw({ type: 'request' });
    setBadge('已加入同步', true);
  }
  document.addEventListener('click', flush, true);
  document.addEventListener('touchend', flush, true);

  // 把我目前的影片網址告訴對方
  // 只傳網域 + 路徑，不帶追蹤參數
  function sendNav() { if (videoPage()) raw({ type: 'nav', url: location.origin + location.pathname }); }

  // 對方選了影片 → 我跳過去（只允許同一個網站；加防迴圈）
  function goTo(url) {
    var u; try { u = new URL(url); } catch (e) { return; }
    if (!okVideoUrl(u)) return;
    url = u.origin + u.pathname;   // 收到的網址也重組，丟掉對方塞的額外參數
    if (key(url) === key(location.href)) return;
    try {
      var last = JSON.parse(sessionStorage.getItem('wsyncGo') || 'null');
      if (last && last.url === url && Date.now() - last.t < 30000) return;   // 30 秒內已跳過同一網址，不再重複
      sessionStorage.setItem('wsyncGo', JSON.stringify({ url: url, t: Date.now() }));
    } catch (e) {}
    setBadge('跳轉到對方選的影片…', true);
    location.href = url;
  }

  function bind(v) {
    v.addEventListener('play', function () { send('play'); });
    v.addEventListener('pause', function () { send('pause'); });
    v.addEventListener('seeked', function () { send(v.paused ? 'pause' : 'play'); });
  }

  loadCfg().then(function () {
    if (!cfg.server || !cfg.room) {
      var asked = false; try { asked = sessionStorage.getItem('wsyncAsked') === '1'; } catch (e) {}
      if (!asked) { try { sessionStorage.setItem('wsyncAsked', '1'); } catch (e) {} askCfg(); }
    }
    connect();   // 一進頁面就連線（還沒開影片也能收到對方的跳轉）
  });

  setInterval(function () {
    if (videoPage()) {
      var k = key(location.href);
      if (k !== lastKey) { if (!firstTick) sendNav(); lastKey = k; }   // 剛開頁面不推，之後換影片才推
    }
    try { sessionStorage.setItem('wsyncKey', key(location.href)); } catch (e) {}
    firstTick = false;
    var v = document.querySelector('video');
    if (v && v !== video) { video = v; bind(v); }
  }, 1000);
})();
