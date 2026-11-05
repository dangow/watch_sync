// 伺服器重連緩衝測試：先 `REJOIN_GRACE_SEC=2 PORT=8099 node server.js`，再 `node sim.js`
const WebSocket = require('ws');
const URL_ = 'ws://localhost:' + (process.env.PORT || 8099);
const ROOM = 'room-' + Math.random().toString(36).slice(2, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;

function client(peer, room = ROOM) {
  return new Promise((res) => {
    const ws = new WebSocket(URL_, { origin: 'chrome-extension://abc' });
    ws.log = [];
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'peers') ws.log.push(m); });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'join', room, peer })); setTimeout(() => res(ws), 100); });
  });
}
const fmt = (l) => l.map((m) => `c${m.count}${m.me ? '/me' : ''}${m.rejoin ? '/rejoin' : ''}`).join(' ') || '(none)';
function check(name, got, want) {
  const ok = fmt(got) === want;
  if (!ok) fails++;
  console.log(ok ? 'PASS' : 'FAIL', name, '→', fmt(got), ok ? '' : `(want ${want})`);
}

(async () => {
  // S1
  const B = await client('B'); let A = await client('A');
  check('S1 B', B.log.slice(1), 'c2'); check('S1 A', A.log, 'c2/me');
  // S2
  B.log.length = 0; A.close(); await sleep(1000); A = await client('A');
  check('S2 B (nothing)', B.log, '(none)'); check('S2 A', A.log, 'c2/me/rejoin');
  // S3
  B.log.length = 0; A.close(); await sleep(3000); A = await client('A');
  check('S3 B', B.log, 'c1 c2'); check('S3 A', A.log, 'c2/me');
  // S4
  B.log.length = 0; const A2 = await client('A'); A2.close(); await sleep(300);
  check('S4 B (nothing)', B.log, '(none)');
  // S5
  A.close(); B.close(); await sleep(3000);
  const C = await client('C'); check('S5 C', C.log, 'c1/me');
  // S6
  const closeCode = (room, origin) => new Promise((res) => {
    const ws = new WebSocket(URL_, { origin });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, peer: 'X' })));
    ws.on('close', (c) => res(c));
  });
  const c1 = await closeCode('short', 'chrome-extension://abc');
  const c2 = await closeCode(ROOM, 'https://evil.example');
  console.log(c1 === 1008 && c2 === 1008 ? 'PASS' : 'FAIL', 'S6 short room/bad origin →', c1, c2);
  if (c1 !== 1008 || c2 !== 1008) fails++;
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
