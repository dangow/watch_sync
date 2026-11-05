const $ = (id) => document.getElementById(id);

function render(on) {
  $('enabled').checked = on;
  $('state').textContent = '同步：' + (on ? '開啟' : '關閉');
  $('fields').classList.toggle('off', !on);
}

chrome.storage.local.get(['server', 'room', 'enabled']).then((c) => {
  $('server').value = c.server || '';
  $('room').value = c.room || '';
  render(c.enabled !== false);          // 沒設定過 = 開啟
});

// 開關：切換後立刻生效，不需要按儲存
$('enabled').onchange = async () => {
  const on = $('enabled').checked;
  await chrome.storage.local.set({ enabled: on });
  render(on);
  $('msg').className = '';
  $('msg').textContent = on ? '已開啟，正在連線' : '已關閉，不會連線也不會同步（設定保留）';
};

$('save').onclick = async () => {
  const room = $('room').value.trim();
  await chrome.storage.local.set({ server: $('server').value.trim(), room });
  const short = room.length > 0 && room.length < 8;
  $('msg').className = short ? 'warn' : '';
  $('msg').textContent = short
    ? '已儲存，但房間代碼少於 8 個字元，新版伺服器會拒絕，建議換長一點'
    : '已儲存，回到影片頁面即可（不需重新整理）';
};
