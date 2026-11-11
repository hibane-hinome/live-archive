/**
 * 火羽 · 录播字幕
 *
 * 在 B 站录播页上叠一层双语字幕：日文原文（上）＋ 中文翻译（下），逐句跟着画面。
 * 字幕来自直播当时的逐句翻译数据库，导成 subs/<场次>.json 挂在 GitHub Pages 上。
 *
 * 三件事最难，这里分开处理：
 *   1. 这场录播是哪一场直播  → pickSession()，五层兜底
 *   2. 画面 0:00 对应开播的第几秒 → offset，用户手动推，按稿件记住
 *   3. 每帧该显示哪一句 → 二分查找 + rAF，不用 timeupdate（一秒四次，太糙）
 */
(function () {
  'use strict';
  if (window.__HBS__) return;
  window.__HBS__ = true;

  var DEFAULT_BASE = 'https://hibane-hinome.github.io/live-archive/';

  var DEFAULTS = {
    on: true,
    size: 30,      // 中文字号（px，会按播放器宽度缩放）
    mode: 'both',  // both | zh | jp
    pos: 9,        // 距播放区底部百分比
    base: DEFAULT_BASE
  };

  var S = Object.assign({}, DEFAULTS);

  var st = {
    index: null, indexAt: 0, indexErr: '', source: '',
    blocks: [], trackKey: '', trackInfo: null,
    video: null, wrap: null, layer: null, zhEl: null, jpEl: null,
    cur: -1, raf: 0, scale: 1, paused: false,
    key: '', how: '', bvid: '',
    offset: 0, manualKey: '',
    panel: null, sel: null, offv: null, toastEl: null,
    lastUrl: location.href, booted: false
  };

  // ---------------------------------------------------------------- 存储

  var HAS_EXT = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  function storeGet(keys) {
    if (HAS_EXT && chrome.storage && chrome.storage.local) {
      return chrome.storage.local.get(keys);
    }
    var out = {};
    keys.forEach(function (k) {
      var v = localStorage.getItem('hbs:' + k);
      if (v != null) { try { out[k] = JSON.parse(v); } catch (e) { /* 坏数据当没有 */ } }
    });
    return Promise.resolve(out);
  }

  function storeSet(obj) {
    if (HAS_EXT && chrome.storage && chrome.storage.local) {
      return chrome.storage.local.set(obj);
    }
    Object.keys(obj).forEach(function (k) {
      localStorage.setItem('hbs:' + k, JSON.stringify(obj[k]));
    });
    return Promise.resolve();
  }

  function directFetch(url, force) {
    // 和 background 一样设上限：连不上时不能一直挂着
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : 0;
    return fetch(url, { cache: force ? 'reload' : 'default', signal: ctrl && ctrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function fetchJSON(url, force) {
    if (HAS_EXT && chrome.runtime.sendMessage) {
      return chrome.runtime.sendMessage({ type: 'hbs:fetch', url: url, force: !!force })
        .then(function (res) {
          if (res && res.ok) return res.data;
          throw new Error((res && res.error) || '取数失败');
        })
        .catch(function () {
          // 中转失败就自己试一次，别让一次偶发错误把字幕钉死
          return directFetch(url, force);
        });
    }
    return directFetch(url, force);
  }

  function base() {
    var b = (S.base || DEFAULT_BASE).trim();
    return b.charAt(b.length - 1) === '/' ? b : b + '/';
  }

  // 同一个文件的三处副本。GitHub Pages 偶尔部署失败、国内偶尔连不上，
  // 多试一处比直接报 404 强。只有用默认源时才挂镜像——用户自己填了地址，
  // 说明他清楚要什么，别背着他去别处取。
  var GH = 'hibane-hinome/live-archive';

  function sources() {
    var b = base();
    if (b !== DEFAULT_BASE) return [{ name: '自定义', url: b + 'subs/' }];
    return [
      { name: 'Pages', url: b + 'subs/' },
      { name: 'jsDelivr', url: 'https://cdn.jsdelivr.net/gh/' + GH + '@main/site/data/subs/' },
      { name: 'GitHub', url: 'https://raw.githubusercontent.com/' + GH + '/main/site/data/subs/' }
    ];
  }

  /** 按顺序试各处副本，第一个取到的就用。全挂了才报错，并说清是什么情况。 */
  function loadFile(file, force) {
    var list = sources(), lastErr = null;

    function step(i) {
      if (i >= list.length) {
        var msg = String((lastErr && lastErr.message) || '取数失败');
        // 404 是最常见的一种，而且它几乎总是「数据还没发出去」，不该让人以为坏了
        if (/404/.test(msg)) {
          msg = '线上还没有字幕数据（HTTP 404）。' +
                (list.length > 1 ? '三处副本都没有。' : '') +
                '要么发布还没跑完，要么这批字幕还没推上去。';
        }
        throw new Error(msg);
      }
      var src = list[i];
      return fetchJSON(src.url + file, force).then(function (d) {
        st.source = src.name;
        return d;
      }).catch(function (e) {
        lastErr = e;
        return step(i + 1);
      });
    }

    return step(0);
  }

  // ---------------------------------------------------------------- 场次匹配

  function urlBvid() {
    var m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    return m ? m[1] : '';
  }

  function readInfo() {
    var info = { bvid: urlBvid(), title: '', desc: '', pubdate: 0, duration: 0 };
    var s = window.__INITIAL_STATE__;
    var vd = null;
    if (s) {
      vd = s.videoData || (s.video && s.video.videoData) || (s.viewInfo && s.viewInfo.videoData) || null;
      if (!vd && s.aid && s.videoInfo) vd = s.videoInfo;
    }
    if (vd) {
      info.bvid = info.bvid || vd.bvid || '';
      info.title = vd.title || '';
      info.desc = vd.desc || '';
      info.pubdate = Number(vd.pubdate) || 0;
      info.duration = Number(vd.duration) || 0;
    }
    if (!info.title) {
      var h = document.querySelector('h1.video-title, h1[title]');
      if (h) info.title = h.getAttribute('title') || h.textContent || '';
    }
    return info;
  }

  function pickSession(info) {
    var idx = st.index;
    if (!idx) return null;
    var list = idx.sessions || [];

    if (st.manualKey) {
      var m = list.filter(function (s) { return s.key === st.manualKey; })[0];
      if (m) return { s: m, how: '手动选的' };
    }

    var mapped = idx.videos && idx.videos[info.bvid];
    if (mapped) {
      var hit = list.filter(function (s) { return s.key === mapped; })[0];
      if (hit) return { s: hit, how: '稿件映射' };
    }

    // 简介里写一句 HBS:2026-11-11_0904 就能钉死，上传时顺手写最省事
    var tag = (info.title + ' ' + info.desc).match(/HBS:\s*(\d{4}-\d{2}-\d{2}_\d{4})/i);
    if (tag) {
      var t = list.filter(function (s) { return s.key === tag[1]; })[0];
      if (t) return { s: t, how: '简介标记' };
    }

    // 按发布时间倒推：取"结束时刻在发布时刻之前"的最近一场
    if (info.pubdate) {
      var best = null;
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var end = s.at + s.dur * 60;
        if (end <= info.pubdate + 3600 && (!best || s.at > best.at)) best = s;
      }
      if (best && info.pubdate - (best.at + best.dur * 60) < 7 * 86400) {
        return { s: best, how: '按发布时间推测' };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 数据加载

  function loadIndex(force) {
    if (st.index && !force && Date.now() - st.indexAt < 3 * 3600 * 1000) {
      return Promise.resolve(st.index);
    }
    return loadFile('index.json', force).then(function (d) {
      st.index = d;
      st.indexAt = Date.now();
      st.indexErr = '';
      return d;
    }).catch(function (e) {
      st.indexErr = String(e.message || e);
      return null;
    });
  }

  function loadTrack(key) {
    if (st.trackKey === key && st.blocks.length) return Promise.resolve();
    st.trackKey = key;
    st.blocks = [];
    st.cur = -1;
    return loadFile(key + '.json').then(function (d) {
      if (st.trackKey !== key) return; // 期间又换场了
      st.blocks = d.blocks || [];
      st.trackInfo = d;
    }).catch(function (e) {
      st.blocks = [];
      toast('这场字幕没取到：' + (e.message || e));
    });
  }

  // ---------------------------------------------------------------- 定位与渲染

  function findAt(t) {
    var bl = st.blocks;
    if (!bl.length) return -1;
    var lo = 0, hi = bl.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (bl[mid][0] <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans < 0) return -1;
    return t < bl[ans][1] ? ans : -1;
  }

  function setCur(i) {
    st.cur = i;
    if (!st.layer) return;
    var b = i >= 0 ? st.blocks[i] : null;
    if (!b) { st.layer.classList.remove('is-on'); return; }
    var jp = b[3] || '';
    var zh = b[2] || '';
    var showJp = (S.mode === 'both' || S.mode === 'jp') && !!jp;
    var showZh = S.mode !== 'jp' || !jp;
    st.zhEl.textContent = showZh ? zh : '';
    st.jpEl.textContent = showJp ? jp : '';
    st.zhEl.style.display = showZh ? '' : 'none';
    st.jpEl.style.display = showJp ? '' : 'none';
    st.layer.classList.add('is-on');
  }

  function loop() {
    if (st.paused) { st.raf = 0; return; }
    st.raf = requestAnimationFrame(loop);
    var v = st.video;
    if (!v || !st.blocks.length || !S.on) {
      if (st.cur !== -1) setCur(-1);
      return;
    }
    var i = findAt(v.currentTime + st.offset);
    if (i !== st.cur) setCur(i);
  }

  function applyStyle() {
    var w = st.wrap ? st.wrap.clientWidth : 0;
    // 小窗里 30px 会顶满屏，按播放区宽度缩：960 宽是基准
    st.scale = w ? Math.min(1, Math.max(0.55, w / 960)) : 1;
    var root = st.layer;
    if (!root) return;
    root.style.setProperty('--hbs-size', (S.size * st.scale).toFixed(1) + 'px');
    root.style.setProperty('--hbs-bot', S.pos + '%');
    root.style.display = S.on ? '' : 'none';
  }

  // ---------------------------------------------------------------- DOM

  function ensureLayer() {
    var v = st.video;
    if (!v) return false;
    var wrap = v.closest('.bpx-player-video-wrap') ||
               v.closest('.bpx-player-video-area') ||
               v.closest('#bilibili-player') ||
               v.parentElement;
    if (!wrap) return false;

    if (st.wrap !== wrap || !st.layer || !st.layer.isConnected) {
      st.wrap = wrap;
      if (st.layer) st.layer.remove();
      if (getComputedStyle(wrap).position === 'static') {
        wrap.style.position = 'relative';
      }
      var layer = document.createElement('div');
      layer.className = 'hbs-layer';
      var box = document.createElement('div');
      box.className = 'hbs-box';
      var jpEl = document.createElement('div');
      jpEl.className = 'hbs-jp';
      var zhEl = document.createElement('div');
      zhEl.className = 'hbs-zh';
      box.appendChild(jpEl);
      box.appendChild(zhEl);
      layer.appendChild(box);
      wrap.appendChild(layer);
      st.layer = layer;
      st.zhEl = zhEl;
      st.jpEl = jpEl;
      st.cur = -1;
      if (window.ResizeObserver) {
        new ResizeObserver(applyStyle).observe(wrap);
      }
    }
    applyStyle();
    return true;
  }

  function toast(msg) {
    if (!st.toastEl) {
      st.toastEl = document.createElement('div');
      st.toastEl.className = 'hbs-toast';
      document.body.appendChild(st.toastEl);
    }
    st.toastEl.textContent = msg;
    st.toastEl.classList.add('is-on');
    clearTimeout(st.toastEl._t);
    st.toastEl._t = setTimeout(function () {
      st.toastEl.classList.remove('is-on');
    }, 2600);
  }

  // ---------------------------------------------------------------- 面板

  function buildPanel() {
    var el = document.createElement('div');
    el.className = 'hbs-panel';
    el.innerHTML =
      '<button class="hbs-fab" title="录播字幕"><span>译</span><i></i></button>' +
      '<div class="hbs-card">' +
        '<div class="hbs-head"><span>录播字幕</span>' +
          '<button class="hbs-x" title="收起">关闭</button></div>' +
        '<div class="hbs-row"><label class="hbs-k">场次</label>' +
          '<select class="hbs-sel"></select></div>' +
        '<div class="hbs-hint hbs-hint-sel"></div>' +
        '<div class="hbs-row hbs-k-inline"><label class="hbs-k">对时</label>' +
          '<div class="hbs-off">' +
            '<button data-off="-10" title="字幕太早，往后退 10 秒">−10</button>' +
            '<button data-off="-1">−1</button>' +
            '<b class="hbs-offv">0.0s</b>' +
            '<button data-off="1">+1</button>' +
            '<button data-off="10" title="字幕太晚，往前推 10 秒">+10</button>' +
          '</div></div>' +
        '<div class="hbs-hint">字幕和画面差开时，点这几个按钮把它推回去；调好一次就记住了</div>' +
        '<div class="hbs-row hbs-k-inline"><label class="hbs-k">显示</label>' +
          '<div class="hbs-seg">' +
            '<button data-mode="both">双语</button>' +
            '<button data-mode="zh">中文</button>' +
            '<button data-mode="jp">原文</button>' +
          '</div></div>' +
        '<div class="hbs-row hbs-k-inline"><label class="hbs-k">字号</label>' +
          '<input class="hbs-range hbs-size" type="range" min="16" max="52" step="1"></div>' +
        '<div class="hbs-row hbs-k-inline"><label class="hbs-k">高度</label>' +
          '<input class="hbs-range hbs-pos" type="range" min="2" max="45" step="1"></div>' +
        '<div class="hbs-foot">' +
          '<label class="hbs-switch"><input type="checkbox" class="hbs-on"> 显示字幕</label>' +
          '<a class="hbs-diary" target="_blank" rel="noopener">看这场的日记 →</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    st.panel = el;
    st.sel = el.querySelector('.hbs-sel');
    st.offv = el.querySelector('.hbs-offv');

    el.querySelector('.hbs-fab').addEventListener('click', function () {
      el.classList.toggle('is-open');
    });
    el.querySelector('.hbs-x').addEventListener('click', function () {
      el.classList.remove('is-open');
    });

    st.sel.addEventListener('change', function () {
      st.manualKey = st.sel.value || '';
      storeSet({ manual: st.manualKey });
      // 手动选过之后就不再让"按发布时间推测"覆盖它
      if (st.manualKey) storeSet({['pick:' + (st.bvid || 'x')]: st.manualKey});
      refresh(true);
    });

    el.querySelectorAll('[data-off]').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = parseFloat(b.getAttribute('data-off'));
        st.offset = Math.round((st.offset + d) * 10) / 10;
        saveOffset();
        st.cur = -2; // 强制重算当前句
        syncPanel();
        toast('对时 ' + (st.offset > 0 ? '+' : '') + st.offset.toFixed(1) + 's');
      });
    });

    el.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.mode = b.getAttribute('data-mode');
        saveSettings();
        st.cur = -2;
        syncPanel();
      });
    });

    var sizeEl = el.querySelector('.hbs-size');
    sizeEl.addEventListener('input', function () {
      S.size = parseInt(sizeEl.value, 10) || DEFAULTS.size;
      applyStyle();
      saveSettings();
    });

    var posEl = el.querySelector('.hbs-pos');
    posEl.addEventListener('input', function () {
      S.pos = parseInt(posEl.value, 10) || DEFAULTS.pos;
      applyStyle();
      saveSettings();
    });

    var onEl = el.querySelector('.hbs-on');
    onEl.addEventListener('change', function () {
      S.on = onEl.checked;
      applyStyle();
      saveSettings();
      st.cur = -2;
    });

    // 全屏时把面板挪进全屏元素，否则看不见
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        var host = fs || document.body;
        if (st.panel && st.panel.parentElement !== host) host.appendChild(st.panel);
      });
    });
  }

  function syncPanel() {
    if (!st.panel) return;
    var idx = st.index;
    st.panel.classList.toggle('is-empty', !st.blocks.length);
    st.panel.classList.toggle('is-ok', !!st.blocks.length);

    // 场次下拉
    if (idx && st.sel.dataset.v !== String(st.indexAt)) {
      st.sel.dataset.v = String(st.indexAt);
      var html = '<option value="">自动 / 未匹配</option>';
      (idx.sessions || []).slice().reverse().forEach(function (s) {
        html += '<option value="' + s.key + '">' + s.label + ' · ' + s.dur + '分钟 · ' +
                s.blocks + '句</option>';
      });
      st.sel.innerHTML = html;
    }
    if (st.sel.value !== (st.manualKey || '')) st.sel.value = st.manualKey || '';

    st.offv.textContent = (st.offset > 0 ? '+' : '') + st.offset.toFixed(1) + 's';

    st.panel.querySelectorAll('[data-mode]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-mode') === S.mode);
    });
    st.panel.querySelector('.hbs-size').value = S.size;
    st.panel.querySelector('.hbs-pos').value = S.pos;
    st.panel.querySelector('.hbs-on').checked = !!S.on;

    var hintEl = st.panel.querySelector('.hbs-hint-sel');
    if (!idx) {
      hintEl.textContent = st.indexErr ? ('字幕数据取不到：' + st.indexErr) : '正在取字幕数据…';
    } else if (st.blocks.length) {
      var sess = (idx.sessions || []).filter(function (s) { return s.key === st.trackKey; })[0];
      // 老数据的时间戳是翻译回来的时刻，比开口晚约 1 秒，明说一句省得用户以为坏了
      var lag = (sess && sess.precise === false) ? ' · 时间按入库估的（约晚 1 秒）' : '';
      hintEl.textContent = (sess ? sess.label : st.trackKey) + ' · ' +
        st.blocks.length + ' 句 · ' + st.how + lag;
    } else if (st.key) {
      hintEl.textContent = '这场还没字幕数据';
    } else {
      hintEl.textContent = '没认出是那一场，手动选一个';
    }

    var diary = st.panel.querySelector('.hbs-diary');
    var sess2 = idx && (idx.sessions || []).filter(function (s) { return s.key === st.trackKey; })[0];
    if (sess2 && sess2.diary) {
      diary.style.display = '';
      diary.href = base() + '#/diary/' + st.trackKey;
      diary.textContent = '看这场的日记 →';
    } else {
      diary.style.display = 'none';
    }
  }

  function saveSettings() {
    var o = {};
    o.settings = S;
    storeSet(o);
  }

  function saveOffset() {
    var k = 'offset:' + (st.bvid || st.trackKey || 'default');
    var o = {};
    o[k] = st.offset;
    storeSet(o);
  }

  // ---------------------------------------------------------------- 主流程

  var refreshing = false;

  function refresh(force) {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    var info = readInfo();
    st.bvid = info.bvid;
    syncPanel();

    return loadIndex(force).then(function () {
      var hit = pickSession(info);
      st.how = hit ? hit.how : '';
      st.key = hit ? hit.s.key : '';
      syncPanel();

      if (!hit) {
        st.blocks = [];
        st.trackKey = '';
        st.cur = -1;
        setCur(-1);
        syncPanel();
        return;
      }
      var k = 'offset:' + (info.bvid || hit.s.key);
      return storeGet([k, 'pick:' + (info.bvid || 'x')]).then(function (v) {
        if (typeof v[k] === 'number') {
          st.offset = v[k];
        } else {
          // 没手动对过时给个起步值：老数据的时间戳是「翻译回来」的时刻，
          // 比开口晚约 1 秒（实测 VAD 静音 0.4 + ASR 0.4 + 翻译 0.3），
          // 默认往前推一点；带开口时刻的新场次则不需要补偿。
          st.offset = (hit.s && hit.s.precise === false) ? -1 : 0;
        }
        if (!st.manualKey && v['pick:' + (info.bvid || 'x')]) {
          st.manualKey = v['pick:' + (info.bvid || 'x')];
        }
        return loadTrack(hit.s.key);
      }).then(function () {
        st.cur = -2;
        syncPanel();
        applyStyle();
      });
    }).catch(function (e) {
      st.indexErr = String((e && e.message) || e);
      syncPanel();
    }).then(function () {
      refreshing = false;
    });
  }

  function attach() {
    var v = document.querySelector('.bpx-player-video-wrap video, #bilibili-player video, video');
    if (!v || v === st.video) return;
    st.video = v;
    st.wrap = null;
    ensureLayer();
    if (!st.raf) st.raf = requestAnimationFrame(loop);
    refresh(false);
  }

  function watchUrl() {
    setInterval(function () {
      if (location.href !== st.lastUrl) {
        st.lastUrl = location.href;
        st.blocks = [];
        st.trackKey = '';
        st.key = '';
        st.how = '';
        st.cur = -1;
        st.video = null;
        st.wrap = null;
        if (st.layer) { st.layer.remove(); st.layer = null; }
        setTimeout(attach, 600);
      }
    }, 700);
  }

  function boot() {
    if (st.booted) return;
    st.booted = true;

    storeGet(['settings', 'manual']).then(function (v) {
      if (v.settings) S = Object.assign({}, DEFAULTS, v.settings);
      if (v.manual) st.manualKey = v.manual;
      buildPanel();
      syncPanel();
      attach();
      watchUrl();
      // 播放器是懒加载的，头几秒可能还没出来，多试几次
      var tries = 0;
      var t = setInterval(function () {
        attach();
        if (st.video || ++tries > 20) clearInterval(t);
      }, 800);
    });
  }

  // 给本地预览页 / 调试用
  window.__HBS_API__ = {
    state: st,
    settings: function () { return S; },
    refresh: refresh,
    seekTo: function (t) { if (st.video) st.video.currentTime = t; },
    renderAt: function (t) {
      // 不经过视频时钟、直接按给定时间渲染一次（预览页截图 / 自动化验证用）
      var i = findAt(t + st.offset);
      setCur(i);
      return i;
    },
    stopLoop: function () {
      st.paused = true;
      if (st.raf) cancelAnimationFrame(st.raf);
    },
    current: function () {
      return { i: st.cur, block: st.cur >= 0 ? st.blocks[st.cur] : null, key: st.trackKey, how: st.how };
    }
  };

  // 弹窗来问状态 / 强制刷新
  if (HAS_EXT && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      if (!msg) return false;
      if (msg.type === 'hbs:status') {
        var idx = st.index || {};
        sendResponse({
          video: !!st.video,
          key: st.trackKey || '',
          how: st.how || '',
          blocks: st.blocks.length,
          count: idx.count || 0,
          total: idx.blocks || 0,
          updated: idx.updated || '',
          updatedAt: st.indexAt || 0,
          offset: st.offset,
          err: st.indexErr || ''
        });
        return true;
      }
      if (msg.type === 'hbs:reload') {
        st.indexAt = 0;
        refresh(true);
        sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
