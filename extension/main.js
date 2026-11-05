// 頁面環境：找 <video>、監聽播放事件、套用對方的操作、同步「選了哪部影片」
(() => {
  const H = location.hostname;
  const site = /netflix\.com$/.test(H) ? 'netflix' : /youtube\.com$/.test(H) ? 'youtube' : 'iqiyi';
  const root = H.split('.').slice(-2).join('.');
  const isTop = window === top;
  const videoPage = () => site === 'iqiyi' ? /\/(play|v_)/.test(location.pathname) : location.pathname.startsWith('/watch');
  const active = () => site === 'iqiyi' || videoPage();
  // 判斷「是不是同一部影片」：YouTube 看 v 參數，其他看網址路徑
  const key = (u) => {
    try {
      const x = new URL(u, location.href);
      return site === 'youtube' ? x.searchParams.get('v') || x.pathname : x.origin + x.pathname;
    } catch { return u; }
  };
  let video = null, applying = false, badge = null, lastKey = null, lastCount = 0, firstTick = true;
  let wantProgress = false;   // 等找到 <video> 後要向對方要目前進度
  // 剛載入的頁面：播放器自己會跳回上次位置、自動播放，這些不是使用者的操作。
  // 先不要把播放事件送出去，等連上房間、對完進度再說；最多等 8 秒（伺服器很慢時也不會卡住）。
  let hold = true, asking = false, holdTimer = setTimeout(() => release(), 8000);
  function release() { hold = false; asking = false; clearTimeout(holdTimer); }
  function holdFor(ms) { hold = true; clearTimeout(holdTimer); holdTimer = setTimeout(release, ms); }
  // 換頁前那一頁看的是哪部影片（每秒記一次）：一開始就讀，之後才會被這一頁覆蓋
  let prevKey = null;
  try { if (window === top) prevKey = sessionStorage.getItem('wsyncKey'); } catch {}

  // ---- 與 bridge.js 的私有通道（取代 window.postMessage，網頁上的其他腳本無法偷聽或偽造）----
  // 這段在 document_start 執行，網頁自己的腳本還沒跑，所以先把要用的函式抓住，之後被改寫也不影響。
  const chan = new MessageChannel();
  const portSend = MessagePort.prototype.postMessage.bind(chan.port1);
  const post = (m, start) => portSend({ m, start });
  // 同步派發：只有「此刻」已在聽的 bridge.js 收得到；bridge 收下會 preventDefault 回報
  const handOff = () => !document.dispatchEvent(new MessageEvent('wsync-init', { ports: [chan.port2], cancelable: true }));
  if (!handOff()) {
    // bridge.js 比我晚執行 → 等它的 wsync-ready 再交一次（只交這一次）
    const onReady = () => { document.removeEventListener('wsync-ready', onReady, true); handOff(); };
    document.addEventListener('wsync-ready', onReady, true);
  }

  function setBadge(text, ok) {
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText =
        'position:fixed;top:8px;left:8px;z-index:2147483647;padding:4px 8px;' +
        'border-radius:6px;font:12px sans-serif;color:#fff;pointer-events:none;opacity:.85';
      document.documentElement.appendChild(badge);
    }
    badge.textContent = '同步：' + text;
    badge.style.background = ok ? '#1a7f37' : '#b42318';
  }

  // Netflix 直接改 video.currentTime 會出錯，必須走它自己的 player API
  function nf() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      return vp.getVideoPlayerBySessionId(vp.getAllPlayerSessionIds()[0]);
    } catch { return null; }
  }
  const seek = (t) => { const p = site === 'netflix' && nf(); p ? p.seek(t * 1000) : (video.currentTime = t); };
  const play = () => {
    const p = site === 'netflix' && nf();
    Promise.resolve(p ? p.play() : video.play()).catch(() => console.log('[同步] play 被擋，請在頁面點一下'));
  };
  const pause = () => { const p = site === 'netflix' && nf(); p ? p.pause() : video.pause(); };

  function send(type) {
    if (!video || applying || hold) return;
    post({ type, time: video.currentTime });
  }

  function handle(m) {
    if (!video) return;
    release();          // 收到對方的進度 = 已對齊，之後自己的操作可以照常送出
    applying = true;
    if (typeof m.time === 'number' && Math.abs(video.currentTime - m.time) > 0.5) seek(m.time);
    if (m.type === 'play') play(); else pause();
    setTimeout(() => { applying = false; }, 1200);
  }

  // 只留下辨識影片需要的部分，其餘參數（追蹤碼、來源等）一律拿掉
  // YouTube → https://www.youtube.com/watch?v=ID；Netflix / 愛奇藝 → 網域 + 路徑
  function cleanUrl(u) {
    if (site === 'youtube') return 'https://www.youtube.com/watch?v=' + u.searchParams.get('v');
    return u.origin + u.pathname;
  }

  // 把我目前的影片網址告訴對方（只有最上層頁面負責）
  const sendNav = () => {
    if (!isTop || !videoPage()) return;
    const u = new URL(location.href);
    if (okVideoUrl(u)) post({ type: 'nav', url: cleanUrl(u) });
  };

  // 只允許跳到「真的是影片頁」的網址（https、指定網站、指定路徑）。
  // 避免有人送來登出、帳號設定、轉址之類的網址，把你導去不該去的地方。
  const HOSTS = {
    youtube: /^(www\.|m\.)?youtube\.com$/,
    netflix: /^(www\.)?netflix\.com$/,
    iqiyi: /^([\w-]+\.)?(iq\.com|iqiyi\.com)$/,
  };
  function okVideoUrl(u) {
    if (u.protocol !== 'https:' || !HOSTS[site].test(u.hostname)) return false;
    if (site === 'youtube') return u.pathname === '/watch' && /^[\w-]{11}$/.test(u.searchParams.get('v') || '');
    if (site === 'netflix') return /^\/watch\/\d+$/.test(u.pathname);
    return /^\/(play|v_)/.test(u.pathname);
  }

  // 對方選了影片 → 我跳過去
  function goTo(url) {
    if (!isTop) return;
    let u;
    try { u = new URL(url); } catch { return; }
    if (!okVideoUrl(u)) return;
    const clean = cleanUrl(u);   // 收到的網址也重組一次，對方塞的額外參數不會被帶進來
    if (key(clean) !== key(location.href)) {
      setBadge('跳轉到對方選的影片…', true);
      try { sessionStorage.setItem('wsyncFollow', clean); } catch {}   // 記號：跟隨而來的頁面重連時不要再推回去
      location.href = clean;
    }
  }

  // 向對方要目前進度；還沒找到 <video> 就先記著，找到後再送
  // 等回覆期間繼續擋住自己的播放事件（最多 3 秒，對方沒回就照常）
  function askProgress() {
    if (video) { wantProgress = false; post({ type: 'request' }); asking = true; holdFor(3000); } else wantProgress = true;
  }

  function bind(v) {
    v.addEventListener('play', () => send('play'));
    v.addEventListener('pause', () => send('pause'));
    v.addEventListener('seeked', () => send(v.paused ? 'pause' : 'play'));
  }

  chan.port1.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'status') {
      if (m.off) { if (badge) { badge.remove(); badge = null; } lastCount = 0; }   // 開關關閉 → 隱藏標籤
      else setBadge(m.text, m.ok);
    }
    else if (m.type === 'peers') {
      setBadge(m.count >= 2 ? `已連線（房內 ${m.count} 人）` : '已連線，等朋友加入', m.count >= 2);
      if (isTop && m.me && m.rejoin) {
        // 我只是換頁重連（不是新加入）
        let followed = null;
        try { followed = sessionStorage.getItem('wsyncFollow'); sessionStorage.removeItem('wsyncFollow'); } catch {}
        const here = videoPage() && okVideoUrl(new URL(location.href)) ? cleanUrl(new URL(location.href)) : null;
        if (here) {
          const k = key(here);
          // 注意：followed 是空的時候不能拿 '' 去比，key('') 會被當成「目前網址」而永遠相等
          if ((followed && k === key(followed)) || k === prevKey) {
            // 跟隨對方而來 / 同一部影片重新整理 → 不推，向對方要目前進度
            if (m.count >= 2) askProgress();
          } else {
            sendNav();   // 自己選了新影片 → 推給對方；不要進度（否則會把對方舊影片的秒數套到新影片）
          }
        }
      } else if (isTop && m.me && !m.rejoin && m.count >= 2) {
        askProgress();   // 第一次加入、房裡已經有人 → 要對方目前進度（對方若在別部影片，會先把我帶過去）
      } else if (isTop && !m.me && m.count > lastCount) sendNav();   // 有新朋友加入 → 把自己的影片推給新人
      // 我自己剛連上、而且不需要等對方進度 → 不用再擋自己的播放事件
      if (m.me && !wantProgress && !asking) release();
      lastCount = m.count;
    } else if (m.type === 'nav') goTo(m.url);
    else if (m.type === 'request') { if (video) send(video.paused ? 'pause' : 'play'); } // 新加入的人要進度 → 回報
    else if (m.type === 'play' || m.type === 'pause') handle(m);
  };

  // Alt+S：把我目前的進度推給對方
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 's' && video) { release(); send(video.paused ? 'pause' : 'play'); }   // 使用者明確要推，不再擋
  });

  // YouTube / Netflix 是單頁應用，所以持續輪詢
  setInterval(() => {
    if (isTop) {
      post(null, true); // 最上層頁面一進來就連線（還沒開影片也能收到對方的跳轉）
      if (videoPage()) {
        const k = key(location.href);
        if (k !== lastKey) { if (!firstTick) sendNav(); lastKey = k; } // 剛開頁面不推，之後換影片才推
        try { sessionStorage.setItem('wsyncKey', k); } catch {}       // 記下目前影片，給下一頁判斷「是不是同一部」
      }
      firstTick = false;
    }
    if (!active()) return;
    const v = document.querySelector('video');
    if (v && v !== video) {
      video = v;
      bind(v);
      post(null, true);
      if (wantProgress && isTop) askProgress();
    }
  }, 1000);
})();
