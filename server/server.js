const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ---- 可用環境變數調整（Render → Environment）----
const PORT = process.env.PORT || 8080;
const MIN_ROOM_LEN = parseInt(process.env.MIN_ROOM_LEN || '8', 10);        // 房間代碼最短長度
const MAX_PER_ROOM = parseInt(process.env.MAX_PER_ROOM || '20', 10);       // 每個房間最多連線數
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || '300', 10); // 伺服器總連線上限
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP || '20', 10);           // 每個 IP 同時最多幾條連線（防止一個人佔滿全部名額）
// 只允許這些來源連線，逗號分隔，可用 * 當萬用字元。
// 沒設定 = 用下面的預設（Chrome 擴充 + 愛奇藝網頁上的 iOS 腳本）。
// 建議把 chrome-extension://* 換成你自己的擴充 ID，例如 chrome-extension://abcdefghijklmnop...
// 設成 ALLOWED_ORIGINS=* 代表完全不檢查（不建議）。伺服器自己的網頁（iPhone YouTube 網頁版）永遠允許。
const DEFAULT_ORIGINS = 'chrome-extension://*,https://*.iqiyi.com,https://*.iq.com,https://iqiyi.com,https://iq.com';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
const CHECK_ORIGIN = !(ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === '*');
// 每個 IP 在時間窗內最多加入幾次（含成功），防止有人一直開新連線猜房間代碼
const JOIN_LIMIT = parseInt(process.env.JOIN_LIMIT || '30', 10);
const JOIN_WINDOW_MS = parseInt(process.env.JOIN_WINDOW_MIN || '10', 10) * 60000;
// 前面有幾層會加 X-Forwarded-For 的代理（Render = 1；直接對外 / cloudflared 本機 = 0 就用連線位址）
const PROXY_HOPS = parseInt(process.env.PROXY_HOPS || '0', 10);
// 同一個人斷線後幾秒內重連，視為「沒離開過」（換頁、重新整理、背景程式重啟）
const REJOIN_GRACE_MS = parseInt(process.env.REJOIN_GRACE_SEC || '10', 10) * 1000;

const TYPES = new Set(['play', 'pause', 'nav', 'request']);

// ---- HTTP：只提供網頁版首頁與健康檢查，並加上基本安全標頭 ----
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',                              // 禁止被別的網站用 iframe 嵌入（防點擊劫持）
  'Referrer-Policy': 'strict-origin-when-cross-origin',   // YouTube 內嵌播放器需要 referrer，不能用 no-referrer
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const srv = http.createServer((req, res) => {
  let p = '/';
  try { p = new URL(req.url, 'http://x').pathname; } catch {}
  if (p === '/healthz') { res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p !== '/' && p !== '/index.html') { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
    if (err) { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server: srv, maxPayload: 4096 }); // 訊息最大 4KB（預設是 100MB）
const rooms = new Map();
const away = new Map(); // room -> Map(peer -> 計時器)：斷線但還在緩衝時間內的人

// 人數 = 在線的 peer ∪ 暫時離開（緩衝中）的 peer
function peerCount(room) {
  const ids = new Set([...(rooms.get(room) || [])].map((c) => c.peer));
  for (const p of (away.get(room) || new Map()).keys()) ids.add(p);
  return ids.size;
}

function matchOrigin(pattern, origin) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\w.-]+'); // * 只能代表網域名稱的字元
  return new RegExp('^' + esc + '$').test(origin);
}
function originAllowed(origin, host) {
  if (!CHECK_ORIGIN) return true;
  if (!origin) return false;
  try { if (new URL(origin).host === host) return true; } catch { return false; }
  return ALLOWED_ORIGINS.some((p) => matchOrigin(p, origin));
}

function safeUrl(s) {
  if (typeof s !== 'string' || s.length > 2000) return null;
  try { const u = new URL(s); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

// 取得真實 IP：X-Forwarded-For 最左邊可以被使用者偽造，所以從右邊數 PROXY_HOPS 個
function clientIp(req) {
  if (PROXY_HOPS > 0) {
    const list = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length >= PROXY_HOPS) return list[list.length - PROXY_HOPS];
  }
  return req.socket.remoteAddress || '?';
}
const ipConns = new Map(); // ip -> 目前連線數
const joinLog = new Map(); // ip -> { n, t }
function joinAllowed(ip) {
  const now = Date.now();
  let r = joinLog.get(ip);
  if (!r || now - r.t > JOIN_WINDOW_MS) { r = { n: 0, t: now }; joinLog.set(ip, r); }
  return ++r.n <= JOIN_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of joinLog) if (now - r.t > JOIN_WINDOW_MS) joinLog.delete(ip);
}, 60000);

// count 算「人數」(不重複的 peer)，不是連線數；me 標出誰是剛加入的
function broadcastPeers(room, joiner) {
  const set = rooms.get(room);
  if (!set) return;
  const count = peerCount(room);
  for (const c of set) {
    if (c.readyState === 1) c.send(JSON.stringify({ type: 'peers', count, me: !!joiner && c.peer === joiner.peer }));
  }
}
const status = (ws, text) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'status', text, ok: false }));

wss.on('connection', (ws, req) => {
  if (!originAllowed(req.headers.origin, req.headers.host)) {
    console.log('[拒絕] 來源不符:', String(req.headers.origin).slice(0, 80));
    return ws.close(1008, 'origin');
  }
  if (wss.clients.size > MAX_CONNECTIONS) return ws.close(1013, 'busy');

  ws.ip = clientIp(req);
  const n = (ipConns.get(ws.ip) || 0) + 1;
  if (n > MAX_PER_IP) {
    console.log('[拒絕] 同一個 IP 連線太多');
    status(ws, '同一個網路的連線太多，請關掉一些分頁');
    return ws.close(1013, 'per-ip');   // 1013：客戶端 30 秒後再試
  }
  ipConns.set(ws.ip, n);
  ws.once('close', () => {
    const left = (ipConns.get(ws.ip) || 1) - 1;
    if (left > 0) ipConns.set(ws.ip, left); else ipConns.delete(ws.ip);
  });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.bucket = { n: 0, t: Date.now() };
  // 連上後 10 秒內沒送 join 就斷線，避免有人佔著連線不用
  const joinTimer = setTimeout(() => { if (!ws.room) ws.close(1008, 'no join'); }, 10000);

  ws.on('message', (raw) => {
    // 速率限制：每 10 秒最多 60 則，超過直接斷線
    const now = Date.now();
    if (now - ws.bucket.t > 10000) ws.bucket = { n: 0, t: now };
    if (++ws.bucket.n > 60) return ws.close(1008, 'rate');

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.type === 'join') {
      if (ws.room) return;                                   // 已經加入過，不能中途換房間
      // 每條連線只有一次加入機會：失敗就斷線，不能在同一條連線上反覆猜房間代碼
      const fail = (text, code) => { status(ws, text); ws.close(code, 'join'); };
      if (!joinAllowed(ws.ip)) {
        console.log('[拒絕] 加入太頻繁');
        return fail('加入太頻繁，請稍等幾分鐘再試', 1008);
      }
      const room = typeof m.room === 'string' ? m.room.trim().slice(0, 64) : '';
      if (room.length < MIN_ROOM_LEN) return fail(`房間代碼至少 ${MIN_ROOM_LEN} 個字元，請換長一點的`, 1008);
      const set = rooms.get(room) || new Set();
      if (set.size >= MAX_PER_ROOM) return fail('房間人數已滿', 1013);
      clearTimeout(joinTimer);                               // 驗證都通過才取消「10 秒內要加入」的計時
      ws.peer = (typeof m.peer === 'string' && m.peer ? m.peer : crypto.randomUUID()).slice(0, 80);
      ws.room = room;
      set.add(ws);
      rooms.set(room, set);
      // 紀錄只留代碼的雜湊前 6 碼，不把房間代碼寫進日誌
      console.log(`[加入] 房間#${crypto.createHash('sha256').update(room).digest('hex').slice(0, 6)}，目前 ${set.size} 條連線`);
      const aw = away.get(room);
      const rejoin = !!(aw && aw.has(ws.peer)) || [...set].some((c) => c !== ws && c.peer === ws.peer);
      if (aw && aw.has(ws.peer)) { clearTimeout(aw.get(ws.peer)); aw.delete(ws.peer); if (!aw.size) away.delete(room); }
      if (rejoin) {
        // 重連：人數沒變，不打擾其他人，只告訴本人
        ws.send(JSON.stringify({ type: 'peers', count: peerCount(room), me: true, rejoin: true }));
      } else {
        broadcastPeers(room, ws);   // 真正的新加入：維持原行為
      }
      return;
    }

    if (!ws.room || !TYPES.has(m.type)) return;

    // 只轉發驗證過的欄位，其餘一律丟掉
    const out = { type: m.type };
    if (m.type === 'play' || m.type === 'pause') {
      if (typeof m.time !== 'number' || !Number.isFinite(m.time) || m.time < 0 || m.time > 1e6) return;
      out.time = m.time;
    }
    if (m.type === 'nav') {
      const url = safeUrl(m.url);
      if (!url) return;
      out.url = url;
    }
    if (typeof m.vid === 'string' && /^[\w-]{11}$/.test(m.vid)) out.vid = m.vid;

    const msg = JSON.stringify(out);
    for (const c of rooms.get(ws.room)) if (c.peer !== ws.peer && c.readyState === 1) c.send(msg);
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    const room = ws.room;
    const s = room && rooms.get(room);
    if (!s) return;
    s.delete(ws);
    if (!s.size) rooms.delete(room);
    if ([...s].some((c) => c.peer === ws.peer)) return;   // 同一個人還有別條連線（例如 iframe）→ 人數沒變
    // 先不通知，放進緩衝名單；時間到還沒回來才算離開
    let aw = away.get(room);
    if (!aw) { aw = new Map(); away.set(room, aw); }
    clearTimeout(aw.get(ws.peer));
    const peer = ws.peer;
    aw.set(peer, setTimeout(() => {
      aw.delete(peer);
      if (!aw.size && away.get(room) === aw) away.delete(room);
      broadcastPeers(room);
    }, REJOIN_GRACE_MS));
  });
  ws.on('error', () => {});
});

// 每 20 秒送一次心跳：避免 Render 閒置斷線，也讓 Chrome 背景程式不被休眠
setInterval(() => {
  for (const c of wss.clients) if (c.readyState === 1) c.send('{"type":"hb"}');
}, 20000);

// 每 30 秒檢查死連線：沒回應 ping 的直接清掉
setInterval(() => {
  for (const c of wss.clients) {
    if (!c.isAlive) { c.terminate(); continue; }
    c.isAlive = false;
    c.ping();
  }
}, 30000);

srv.listen(PORT, () => console.log('sync server running on port ' + PORT));
