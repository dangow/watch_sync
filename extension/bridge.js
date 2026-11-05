// 隔離環境：只負責在頁面(main.js)與背景(background.js)之間傳話
//
// 安全：不用 window.postMessage 傳話，因為網頁上的任何腳本（廣告、第三方程式）都能偷聽和偽造。
// 改成 main.js 建一條私有的 MessageChannel，在 document_start 時用「同步派發」的事件把一端交給這裡。
// document_start 時網頁自己的腳本都還沒執行，所以只有我們兩個拿得到這條通道。
(() => {
  let port = null;   // 到背景的連線
  let page = null;   // 到 main.js 的私有通道
  const toMain = (m) => { if (page) page.postMessage(m); };

  // 擴充功能被重新載入或移除後，這個頁面上的舊程式就再也連不到背景了
  const extAlive = () => { try { return !!chrome.runtime.id; } catch { return false; } };
  let deadNotified = false;
  function dead() {
    if (deadNotified) return;
    deadNotified = true;
    toMain({ type: 'status', text: '擴充功能已更新，請重新整理頁面', ok: false });
  }

  function open() {
    if (!extAlive()) return dead();
    try { port = chrome.runtime.connect({ name: 'sync' }); } catch { port = null; return dead(); }
    port.onMessage.addListener(toMain);
    port.onDisconnect.addListener(() => {
      port = null;
      // 背景程式閒置時會被瀏覽器暫停（開關關閉時約 30 秒就會發生），這是正常的：
      // 不顯示任何訊息，main.js 下一秒輪詢時會自動重新連上。
      if (!extAlive()) dead();
    });
  }

  function onInit(e) {
    if (page || !e.ports || !e.ports[0]) return;   // 只接受第一條通道
    document.removeEventListener('wsync-init', onInit, true);
    e.preventDefault();                             // 告訴 main.js「我收到了」（同步回報）
    page = e.ports[0];
    page.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.start) { if (!port) open(); return; }
      if (port && d.m) port.postMessage(d.m);
    };
  }
  document.addEventListener('wsync-init', onInit, true);
  // 如果 main.js 比我早執行，它會在聽這個事件，聽到後再把通道交過來
  document.dispatchEvent(new Event('wsync-ready'));
})();
