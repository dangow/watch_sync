# 修正「換頁被拉回朋友的影片」：修改流程與測試步驟（A + B）

## 問題回顧

在愛奇藝 / Netflix 換頁（整頁重新載入）時：

1. 舊頁面關閉 → 背景的 WebSocket 斷線 → 伺服器通知朋友「房內 1 人」
2. 新頁面載入 → 重新加入 → 伺服器通知朋友「房內 2 人、不是你」
3. 朋友誤以為「新朋友加入」→ 把自己的影片推過來 → 你被拉回去
4. 連帶問題：你選了新影片（也是重新載入）時，「剛開頁面不推」讓你不會推出新影片，反而被拉回舊的

伺服器模擬已重現，朋友依序收到 `count:2` → `count:1` → `count:2 me:false`。

## 修改總覽

| 步驟 | 檔案 | 內容 |
|---|---|---|
| A | `server/server.js` | 同一個人斷線後 N 秒內重連 = 沒離開過：不通知人數變化，只回給本人 `rejoin: true` |
| B1 | `extension/background.js` | `peers` 訊息放行 `rejoin` 欄位 |
| B2 | `extension/main.js` | 收到 `rejoin` → 我現在的影片推給對方（跟隨對方而來的不推，防止互推迴圈） |
| B3 | `ios/watch-sync-iqiyi.user.js` | 同上；另外決定重連後要不要跟對方要進度 |
| — | `README.md` | 補 `REJOIN_GRACE_SEC` 說明 |

不需要改：`bridge.js`、`popup.*`、`public/index.html`（iPhone YouTube 網頁版不會整頁重新載入）。

---

## 步驟 A：伺服器的重連緩衝（`server/server.js`）

### A-1 新增設定

```js
// 同一個人斷線後幾秒內重連，視為「沒離開過」（換頁、重新整理、背景程式重啟）
const REJOIN_GRACE_MS = parseInt(process.env.REJOIN_GRACE_SEC || '10', 10) * 1000;
```

### A-2 新增「暫時離開」名單

```js
const away = new Map(); // room -> Map(peer -> 計時器)：斷線但還在緩衝時間內的人
```

### A-3 人數計算要把「暫時離開」的人算進去

`broadcastPeers` 裡的 `count` 改成：在線的 peer ∪ 暫時離開的 peer。抽成一個函式共用：

```js
function peerCount(room) {
  const ids = new Set([...(rooms.get(room) || [])].map((c) => c.peer));
  for (const p of (away.get(room) || new Map()).keys()) ids.add(p);
  return ids.size;
}
```

### A-4 斷線時（`ws.on('close')`）

1. 照舊從 `set` 移除這條連線
2. 如果**同一個 peer 還有其他連線在線**（例如愛奇藝的 iframe）→ 人數沒變，什麼都不通知
3. 否則把 peer 放進 `away`，啟動 `REJOIN_GRACE_MS` 計時器，**先不通知**
4. 計時器到期 → 從 `away` 移除 → 這時才 `broadcastPeers`（朋友看到人數減少）；房間沒人也沒暫離者就清掉 `rooms` / `away` 的項目
5. `set` 空了照舊 `rooms.delete`，但 `away` 保留到計時器到期

### A-5 加入時（`join` 分支）

在 `set.add(ws)` 之後判斷：

```js
const aw = away.get(room);
const rejoin = !!(aw && aw.has(ws.peer)) || [...set].some((c) => c !== ws && c.peer === ws.peer);
if (aw && aw.has(ws.peer)) { clearTimeout(aw.get(ws.peer)); aw.delete(ws.peer); if (!aw.size) away.delete(room); }
if (rejoin) {
  // 重連：人數沒變，不打擾其他人，只告訴本人
  ws.send(JSON.stringify({ type: 'peers', count: peerCount(room), me: true, rejoin: true }));
} else {
  broadcastPeers(room, ws);   // 真正的新加入：維持原行為
}
```

### A-6 注意事項

- 只有知道房間代碼和 peer id 的人才能偽裝成重連；peer id 從不轉發給別人，所以沒有新的攻擊面
- `MAX_PER_ROOM` 仍以在線連線數計算，暫離者不佔名額
- 計時器要在 `away` 清掉時一起清，避免記憶體殘留

---

## 步驟 B1：背景放行 `rejoin`（`extension/background.js`）

`cleanIn` 的 `peers` 那行加上 `rejoin`：

```js
if (m.type === 'peers') return { type: 'peers', count: Number(m.count) || 0, me: !!m.me, rejoin: !!m.rejoin };
```

---

## 步驟 B2：擴充功能重連後推出自己的影片（`extension/main.js`）

### B2-1 跳轉前做記號（防止互推迴圈）

`goTo()` 在 `location.href = clean` 之前：

```js
try { sessionStorage.setItem('wsyncFollow', clean); } catch {}
```

這樣跟隨對方而來的頁面重連時，不會再把同一部影片推回去，避免兩邊互相推。

> sessionStorage 在網頁環境，網頁腳本能改，但最多只能讓你「少推一次」，不會造成跳轉，可接受。

### B2-2 處理 `peers`

```js
else if (m.type === 'peers') {
  setBadge(...);  // 照舊
  if (isTop && m.me && m.rejoin) {
    // 我只是換頁重連（不是新加入）
    let followed = null;
    try { followed = sessionStorage.getItem('wsyncFollow'); sessionStorage.removeItem('wsyncFollow'); } catch {}
    const here = videoPage() && okVideoUrl(new URL(location.href)) ? cleanUrl(new URL(location.href)) : null;
    if (here && key(here) !== key(followed || '')) sendNav();   // 自己選的新影片 → 推給對方
  } else if (isTop && !m.me && m.count > lastCount) sendNav();  // 原本的「新朋友加入 → 推給他」
  lastCount = m.count;
}
```

結果：

| 情境 | 行為 |
|---|---|
| 在首頁 / 搜尋頁換頁 | 不推、朋友也不推 → **不會被拉回** |
| 自己點進新影片 | 推出新影片 → 朋友跟過來 |
| 在同一部影片按 F5 | 推出同一部 → 朋友網址相同，不跳 |
| 跟隨朋友跳過來 | 不推（有記號）→ 不會互推 |
| 第一次加入 / 離開超過緩衝時間 | 不是 rejoin → 維持原行為（朋友推影片給你） |

---

## 步驟 B3：iOS 腳本（`ios/watch-sync-iqiyi.user.js`）

1. `goTo()` 已經用 `sessionStorage` 的 `wsyncGo` 記錄跳轉，直接拿來當「跟隨記號」
2. 每次輪詢時記下目前影片：`sessionStorage.setItem('wsyncKey', key(location.href))`（在換頁前記下的是舊影片）
3. `peers` 處理加上 rejoin 分支：
   - **跟隨對方而來** → 不推；向對方要進度（`request`）
   - **同一部影片重新整理**（目前 key 等於換頁前的 `wsyncKey`）→ 不推；向對方要進度
   - **自己選了新影片** → 推出新影片；**不要**要進度（否則會拿到對方舊影片的秒數，套到新影片上）
   - 都設 `requested = true`，避免原本「新加入就要進度」的邏輯再跑一次

---

## 步驟 C：README

「可選設定」表加一列：

| `REJOIN_GRACE_SEC` | `10` | 同一個人斷線後幾秒內重連視為沒離開（換頁、重新整理）。太短：換頁慢時仍會被拉回；太長：朋友真的離開後要等比較久才顯示 |

---

# 測試步驟

## 一、伺服器自動測試（不需要瀏覽器）

用 `REJOIN_GRACE_SEC=2` 啟動，以 WebSocket 小程式模擬兩個人（同上次 `sim.js` 的作法）：

| # | 操作 | 朋友 B 應收到 | 我 A 應收到 |
|---|---|---|---|
| S1 | B 加入、A 加入 | `count:2 me:false` | `count:2 me:true`（無 rejoin） |
| S2 | A 斷線，1 秒內用同 peer 重連 | **什麼都沒有** | `count:2 me:true rejoin:true` |
| S3 | A 斷線，等 3 秒後重連 | 先 `count:1`，再 `count:2 me:false` | `count:2 me:true`（無 rejoin） |
| S4 | A 開兩條同 peer 連線，關掉其中一條 | 什麼都沒有 | — |
| S5 | A、B 都斷線，等緩衝過後，新的 C 加入同房間 | — | C 收到 `count:1`（房間已清空，沒有殘留） |
| S6 | 回歸：短房間代碼、錯誤來源、加入過頻 | — | 仍分別被 `1008` 拒絕 |

## 二、手動測試（兩個瀏覽器）

### 準備

1. 本機啟動伺服器：`cd server`、`npm start`（`ws://localhost:8080`）
2. 兩個 Chrome 設定檔（或 Chrome + Edge），各自在 `chrome://extensions` 重新載入擴充功能
3. 兩邊都填 `ws://localhost:8080` 和同一個房間代碼
4. 下面「我」= 瀏覽器 A，「朋友」= 瀏覽器 B

### 主要情境（愛奇藝為主，Netflix 再跑一次）

| # | 步驟 | 預期結果 |
|---|---|---|
| M1 | 兩邊都在影片 X，A 回到首頁、搜尋、點分類頁 | **A 停在 A 自己的頁面，不會被拉回 X**；B 不受影響，標籤維持「房內 2 人」 |
| M2 | A 從搜尋結果點進影片 Y | A 停在 Y；**B 自動跳到 Y** |
| M3 | 接 M2，B 跳到 Y 之後 | 不會再互相跳來跳去（觀察 10 秒） |
| M4 | 兩邊都在 Y，A 按 F5 重新整理 | 兩邊都不跳轉 |
| M5 | A 關掉分頁，等 15 秒 | B 標籤變成「已連線，等朋友加入」 |
| M6 | 接 M5，A 重新開影片 Z | 這是「新加入」：**A 被帶到 B 的 Y**（原本行為） |
| M7 | 兩邊在同一部影片，A 播放、暫停、拖進度 | B 同步 |
| M8 | A 按 **Alt+S** | B 跳到 A 的秒數 |

### YouTube 回歸（不會整頁重新載入）

| # | 步驟 | 預期結果 |
|---|---|---|
| Y1 | 兩邊在影片 X，A 點側欄的影片 Y | B 跟到 Y |
| Y2 | A 回首頁瀏覽 | A 不會被拉回 |
| Y3 | A 在影片頁按 F5 | 兩邊都不跳轉 |

### iPhone（iOS 腳本，愛奇藝）

| # | 步驟 | 預期結果 |
|---|---|---|
| I1 | 電腦、手機都在影片 X，手機回首頁瀏覽 | 手機不會被拉回 |
| I2 | 手機點進影片 Y | 電腦跟到 Y；手機進度**不會**被設成 X 的秒數 |
| I3 | 手機在 X 重新整理 | 手機跳到電腦目前的秒數（向對方要進度） |
| I4 | 電腦換到 Z | 手機跟到 Z，之後不互推 |

### 背景程式重啟

| # | 步驟 | 預期結果 |
|---|---|---|
| R1 | 在 `chrome://extensions` 對 A 按「重新載入」，再重新整理影片頁 | 視為重連，B 不推影片、不跳 |

## 三、已知限制

- 兩個人**同一秒**各自選了不同影片：會互換到對方的影片（各推各的，再各自跟隨）。再選一次即可，機率很低
- 換頁超過 `REJOIN_GRACE_SEC`（例如網路很慢）仍會被當成新加入
