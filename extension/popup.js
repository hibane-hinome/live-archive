/**
 * 扩展图标的弹窗：显示当前页面匹配到哪一场、数据有多新。
 * 真正调字幕的地方是播放器右下角那个「译」按钮，这里只做状态检查和强制刷新。
 */

const $ = (s) => document.querySelector(s);

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function rows(pairs) {
  return pairs
    .filter(Boolean)
    .map(([k, v, cls]) => `<div class="row"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`)
    .join('');
}

function specHint() {
  return `<div class="hint">要把字幕对上某一场：<br>
    1. 在简介里写 <b>HBS:2026-11-11_0904</b><br>
    2. 或在播放器右下角的「译」里手动选场次<br>
    3. 字幕跟画面错位时，用那里的「对时」推一推</div>`;
}

function renderOff() {
  $('#body').innerHTML =
    '<div class="skeleton">这不是 B 站视频页。</div>' +
    specHint();
}

function renderNoScript() {
  $('#body').innerHTML =
    '<div class="skeleton">页面里没有字幕脚本。</div>' +
    '<div class="hint">刷新一下视频页就好；如果刚装上扩展，也要刷新已打开的页面。</div>';
}

function render(s) {
  if (!s) return renderNoScript();
  const lines = [];

  if (s.key) {
    lines.push(['当前场次', s.key, 'ok']);
    lines.push(['手上有', `${s.blocks} 句 · ${s.how || '自动'}`, '']);
  } else if (s.err) {
    lines.push(['字幕数据', '取不到', 'bad']);
  } else {
    lines.push(['当前场次', '没匹配上', 'warn']);
  }

  if (s.err) lines.push(['错误', s.err, 'bad']);

  lines.push(['对时', (s.offset > 0 ? '+' : '') + (s.offset || 0).toFixed(1) + 's', '']);

  const data = [];
  if (s.count) data.push(['数据', `${s.count} 场 / ${s.total} 句`, '']);
  if (s.updated) data.push(['导出时间', s.updated, '']);
  if (s.updatedAt) data.push(['本地取得', fmtTime(s.updatedAt), '']);

  $('#body').innerHTML =
    rows(lines) +
    (data.length ? '<div class="hint">' + data.map(([k, v, c]) =>
      `<div class="row"><span class="k">${k}</span><span class="v ${c || ''}">${v}</span></div>`).join('') + '</div>' : '') +
    (s.key ? '' : specHint());
}

async function main() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    return renderOff();
  }
  const url = (tab && tab.url) || '';
  if (!/^https?:\/\/[^/]*bilibili\.com\/(video|list)\//.test(url)) {
    return renderOff();
  }
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'hbs:status' });
    render(s);
  } catch (e) {
    renderNoScript();
  }
}

$('#reload').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const btn = $('#reload');
  btn.disabled = true;
  btn.textContent = '正在刷新…';
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'hbs:reload' });
    btn.textContent = '已刷新';
  } catch (e) {
    btn.textContent = '刷新失败';
  }
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '刷新字幕数据';
    main();
  }, 1200);
});

main();
