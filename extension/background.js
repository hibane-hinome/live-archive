/**
 * 取数据的中转站。
 *
 * 为什么不直接在 content script 里 fetch：内容脚本的请求带着 bilibili 的 origin，
 * 会受页面 CSP 和 CORS 约束。放在这边取，只受 host_permissions 管，稳。
 * 另外这里有一层内存缓存，来回切视频不会重复下载同一场字幕。
 */

const mem = new Map(); // url -> { at, data }
const TTL = 10 * 60 * 1000;
// 单个源最多等这么久。国内连 GitHub raw / jsDelivr 经常是「不报错也不返回」，
// 不设上限的话插件会一直转圈，用户只能以为坏了。
const TIMEOUT = 12000;

function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  return fetch(url, { cache: 'no-cache', signal: ctrl.signal })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .finally(() => clearTimeout(timer));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'hbs:fetch') return false;

  const url = String(msg.url || '');
  if (!/^https:\/\//.test(url)) {
    sendResponse({ ok: false, error: '只接受 https 地址' });
    return false;
  }

  if (!msg.force) {
    const hit = mem.get(url);
    if (hit && Date.now() - hit.at < TTL) {
      sendResponse({ ok: true, data: hit.data, cached: true });
      return false;
    }
  }

  getJSON(url)
    .then((data) => {
      mem.set(url, { at: Date.now(), data });
      sendResponse({ ok: true, data });
    })
    .catch((err) => {
      const name = (err && err.name) || '';
      sendResponse({ ok: false, error: name === 'AbortError' ? '超时（12 秒没有回应）' : String(err && err.message || err) });
    });

  return true; // 异步 sendResponse
});

chrome.runtime.onInstalled.addListener(() => mem.clear());
