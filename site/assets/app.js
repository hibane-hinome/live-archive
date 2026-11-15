(function () {
  'use strict';

  var D = window.DATA;
  var app = document.getElementById('app');

  var state = { q: '', hideEmpty: false, tag: '全部', qs: 'all', qShown: 0, dpage: 1, spage: 1, counted: false };
  var QBATCH = 12;   // 摘录每次渲染的条数
  var DPAGE = 4;     // 日记每页篇数
  var SPAGE = 6;     // 首页「全部场次」每页场数

  /* ---------- utils ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) { return n.toLocaleString('en-US'); }
  function tname(i) { return D.topics[i] ? D.topics[i][0] : '杂聊'; }
  function tcolor(i) { return D.topics[i] ? D.topics[i][1] : '#4a4f5e'; }
  function sess(id) { return D.sessions[id]; }
  function dateLabel(s) { return s.date.replace('-', '.') + ' ' + s.week; }

  // 摘录标签不设白名单，按内容自由增加；颜色从名称做稳定 hash，
  // 同一个标签在任何页面、任何一次构建里都是同一个颜色。
  var TAG_PALETTE = ['#ffa172', '#e8c489', '#f49a8c', '#f0bd8e', '#dd8f6e',
                     '#e5a9a0', '#d9b06a', '#f2a98f', '#c9b28e', '#e6a07a'];
  function tagColor(t) {
    var h = 0, s = String(t || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return TAG_PALETTE[h % TAG_PALETTE.length];
  }
  function tagStyle(t) { return ' style="--tagc:' + tagColor(t) + '"'; }

  /* 页脚元信息：built 是这次构建的时刻（由 tools/build.py 写入），generated 是
     数据截止到的那一场结束时间。两者都有就都显示——只写「更新于」容易让人以为
     那一分钟刚开过播。 */
  function setFoot() {
    var m = D.meta;
    var text = '更新于 ' + (m.built || m.generated);
    if (m.built && m.generated && m.built !== m.generated) {
      text += ' · 数据截至 ' + m.generated;
    }
    document.getElementById('footMeta').textContent = text;
  }

  /* ---------- 进场：淡入与数字滚动 ---------- */
  var quiet = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canObserve = typeof IntersectionObserver === 'function';
  var revealIO = null;

  // 给带 .rv 的元素在进入视口时补 .in（CSS 里负责淡入上移）
  function playReveal() {
    var els = app.querySelectorAll('.rv');
    if (quiet || !canObserve) {
      for (var i = 0; i < els.length; i++) els[i].classList.add('in');
      return;
    }
    if (revealIO) revealIO.disconnect();
    revealIO = new IntersectionObserver(function (list) {
      list.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        revealIO.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
    for (var j = 0; j < els.length; j++) revealIO.observe(els[j]);
  }

  // 统计数字从 0 滚到目标值；翻页重渲染时不重复播
  function countUp() {
    var els = app.querySelectorAll('.cv');
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        var to = parseInt(el.getAttribute('data-n'), 10) || 0;
        if (quiet) { el.textContent = num(to); return; }
        var t0 = 0;
        function step(ts) {
          if (!t0) t0 = ts;
          var p = Math.min(1, (ts - t0) / 850);
          var k = 1 - Math.pow(1 - p, 3);          // easeOutCubic
          el.textContent = num(Math.round(to * k));
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      })(els[i]);
    }
  }

  // 页码条：第 n 页 / 共 m 页 · 共 total 条
  function pagerHTML(page, pages, total, unit) {
    if (pages <= 1) return '';
    var nums = [];
    for (var i = 1; i <= pages; i++) {
      nums.push('<button data-p="' + i + '"' + (i === page ? ' class="on"' : '') + '>' + i + '</button>');
    }
    return '<div class="pager">' +
      '<button data-p="' + (page - 1) + '"' + (page === 1 ? ' disabled' : '') + '>← 上一页</button>' +
      nums.join('') +
      '<button data-p="' + (page + 1) + '"' + (page === pages ? ' disabled' : '') + '>下一页 →</button>' +
      '<span class="pinfo">第 ' + page + ' / ' + pages + ' 页 · 共 ' + total + ' ' + unit + '</span>' +
    '</div>';
  }

  // 绑定翻页后回到锚点，避免重新渲染把用户甩回页顶
  function bindPager(onPick, anchorId) {
    var pager = app.querySelector('.pager');
    if (!pager) return;
    pager.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      var n = parseInt(b.getAttribute('data-p'), 10);
      if (!n) return;
      onPick(n);
      var el = document.getElementById(anchorId);
      if (!el) return;
      var y = el.getBoundingClientRect().top + window.pageYOffset - 110;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    });
  }

  function mark(text, q) {
    var safe = esc(text);
    if (!q) return safe;
    try {
      var re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      return safe.replace(re, '<mark>$1</mark>');
    } catch (e) { return safe; }
  }

  /* ---------- global topic counts ---------- */
  var topicCount = {};
  D.records.forEach(function (r) { topicCount[r.tp] = (topicCount[r.tp] || 0) + 1; });
  var topicRank = Object.keys(topicCount).sort(function (a, b) { return topicCount[b] - topicCount[a]; });

  /* ---------- 存档日历索引 ----------
     用 dateLong 建索引：同一天可能开两场（白天场 + 深夜场），不能按日期一对一。
     月份只保留「有场次的月」，翻月就在这些月份之间跳，不会翻出空月。 */
  function dayKey(s) { return s.dateLong.replace(/\./g, '-'); }   // 2026.11.15 → 2026-11-15
  var byDay = {}, dayKeys = [], monthKeys = [];
  D.sessions.forEach(function (s) {
    var k = dayKey(s);
    if (!byDay[k]) { byDay[k] = []; dayKeys.push(k); }
    byDay[k].push(s);
  });
  dayKeys.sort();
  dayKeys.forEach(function (k) {
    var m = k.slice(0, 7);
    if (monthKeys.indexOf(m) < 0) monthKeys.push(m);
  });

  function monthLabel(m) { var p = m.split('-'); return p[0] + ' 年 ' + (+p[1]) + ' 月'; }
  function pad2(n) { return String(n).padStart(2, '0'); }

  /* ---------- router ---------- */
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('?');
    var seg = parts[0].split('/').filter(Boolean);
    var query = {};
    if (parts[1]) {
      parts[1].split('&').forEach(function (kv) {
        var p = kv.split('=');
        query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
    }
    return {
      view: seg[0] || 'home',
      // 第二段原样保留：存档用数字 id，日记用场次文件名（2026-11-11_0904）
      seg1: seg[1] != null ? decodeURIComponent(seg[1]) : null,
      sid: seg[1] != null ? parseInt(seg[1], 10) : null,
      q: query
    };
  }

  function setNav(view) {
    document.querySelectorAll('.nav a').forEach(function (a) {
      a.classList.toggle('on', a.getAttribute('data-nav') === view);
    });
    // 首页换一张专属夜景，离开首页立刻切回原插画
    document.body.classList.toggle('is-home', view === 'home');
  }

  function route() {
    var r = parseHash();
    state.q = '';
    state.hideEmpty = false;
    if (r.view === 'quotes') { setNav('quotes'); renderQuotes(); }
    // 存档只有一个页面：日历选日 → 选场次 → 同页展开逐字稿
    else if (r.view === 'archive') {
      setNav('archive');
      renderArchivePage({
        month: r.q.m || '', day: r.q.d || '', sid: r.sid,
        jumpT: r.q.t, initialQ: r.q.q || ''
      });
    }
    else if (r.view === 'diary') { setNav('diary'); renderDiary(r.seg1); }
    else if (r.view === 'tools') { setNav('tools'); renderTools(r.seg1); }
    else if (r.view === 'about') { setNav('about'); renderAbout(); }
    else { setNav('home'); renderHome(); }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  window.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA/.test(tag)) return;
    var el = document.getElementById('q');
    if (el) { e.preventDefault(); el.focus(); }
  });

  /* ---------- home ---------- */
  // 把一场压成一条连续色带：横轴是这一场的时长，颜色是当分钟的话题。
  // 连续同色的分钟先并成一块，否则整条是碎噪点。
  function stripHTML(s) {
    var rb = s.ribbon, n = rb.length;
    if (!n) return '';
    var blocks = [], i = 0;
    while (i < n) {
      var j = i;
      while (j + 1 < n && rb[j + 1] === rb[i]) j++;
      blocks.push({ from: i, to: j, tp: rb[i] });
      i = j + 1;
    }
    return blocks.map(function (b) {
      var left = b.from / n * 100, w = (b.to - b.from + 1) / n * 100;
      var col = b.tp < 0 ? '#1c1815' : tcolor(b.tp);
      return '<i style="left:' + left.toFixed(2) + '%;width:' + w.toFixed(2) + '%;background:' + col +
        '" title="' + (b.tp < 0 ? '无记录' : esc(tname(b.tp))) + '"></i>';
    }).join('');
  }

  // 话题分布：分类增长慢，条数基本恒定，适合常驻一栏；
  // 场次列表会一直涨，所以不放固定的面板里
  function topicBarsHTML() {
    var maxT = topicCount[topicRank[0]] || 1;
    return topicRank.map(function (k) {
      var i = parseInt(k, 10);
      // 平方根刻度：最多与最少相差近百倍，线性刻度会让除首项外的柱子几乎不可见
      var w = Math.sqrt(topicCount[k] / maxT) * 100;
      // 宽度靠 CSS 变量交给进场动画，进入视口后从 0 长出来
      return '<div class="tbar"><span class="name">' + esc(tname(i)) + '</span>' +
        '<span class="track"><i class="fill" style="--w:' + w.toFixed(1) +
        '%;background:' + tcolor(i) + '"></i></span>' +
        '<span class="n">' + topicCount[k] + '</span></div>';
    }).join('');
  }

  function renderHome() {
    var last = D.sessions[D.sessions.length - 1];
    var lastQuotes = D.quotes.filter(function (q) { return q.s === last.id; }).slice(0, 3);
    var latestDiary = (D.diary && D.diary.length) ? D.diary[0] : null;

    // 全部场次（新的在前）按每页 SPAGE 场分页
    var allSessions = D.sessions.slice().reverse();
    var spages = Math.max(1, Math.ceil(allSessions.length / SPAGE));
    if (state.spage < 1 || state.spage > spages) state.spage = 1;
    var sfrom = (state.spage - 1) * SPAGE;

    var mini = lastQuotes.map(function (q) {
      // 摘录是整段对话，首页只摘要她自己的那句：去掉开头的观众提问，再截断
      var lines = q.zh.split('\n').filter(function (l, i) {
        return !(i === 0 && l.charAt(0) === '「');
      });
      var txt = lines.join(' ').replace(/^——/, '');
      if (txt.length > 92) txt = txt.slice(0, 92).replace(/[，、]$/, '') + '…';
      return '<a class="qmini" href="#/archive/' + q.s + '?t=' + encodeURIComponent(q.t) + '">' +
        '<p>' + esc(txt) + '</p><span>' + esc(q.t) + ' →</span></a>';
    }).join('');

    // 每次打开随机一句：129 段里筛一遍 + 取模，微秒级，不构成性能负担
    // 长度上限按首屏能容纳的高度卡：太长会把引言压到折叠线以下
    var dq = (function () {
      var pool = D.quotes.filter(function (q) {
        var t = q.zh.replace(/\s/g, '');
        return t.length >= 55 && t.length <= 120;
      });
      if (!pool.length) pool = D.quotes;
      if (!pool.length) return null;
      return pool[Math.floor(Math.random() * pool.length)];
    })();
    // 摘录常按语音停顿断成多行、每行行首带「——」；直接 join 会连出「————」，
    // 这里剥掉行首行尾的破折号，同一处停顿只在行间补回一个
    var dqText = dq ? dq.zh.split('\n')
      .filter(function (l) { return l.charAt(0) !== '「'; })
      .map(function (l) { return l.replace(/^\s*——\s*/, '').replace(/\s*——\s*$/, '').trim(); })
      .filter(Boolean)
      .join('——') : '';

    // 首屏已经滚完数字就不再重播
    function cv(n) { return '<span class="cv" data-n="' + n + '">' + (state.counted ? num(n) : '0') + '</span>'; }

    app.innerHTML =
      '<section class="hero">' +
        // 主播入口放在首屏最上面：想看现场、想核对记录，第一眼就能出去
        // 直播间块用直播封面，主页块用主播头像，不再额外写一行说明
        '<div class="hero-links">' +
          '<a class="hl live" href="https://live.bilibili.com/22748536" target="_blank" rel="noopener">' +
            '<img class="thumb" src="brand/live-cover.jpg" alt="" width="116" height="65" decoding="async">' +
            '<span class="hl-cap"><b><i class="hl-dot" aria-hidden="true"></i>直播间</b>' +
              '<em>live.bilibili.com/22748536</em></span>' +
            '<i class="hl-arrow" aria-hidden="true">↗</i></a>' +
          '<a class="hl" href="https://space.bilibili.com/2094031249" target="_blank" rel="noopener"' +
            ' title="' + esc(D.meta.streamer) + ' · B 站主页">' +
            '<img class="thumb round" src="brand/face.jpg" alt="' + esc(D.meta.streamer) + '"' +
            ' width="52" height="52" decoding="async">' +
            '<span class="hl-cap"><b>主页</b><em>space.bilibili.com/2094031249</em></span>' +
            '<i class="hl-arrow" aria-hidden="true">↗</i></a>' +
        '</div>' +
        '<div class="hero-copy">' +
          '<div class="kicker">LIVE TRANSCRIPT ARCHIVE</div>' +
          '<h1><span class="accent">' + esc(D.meta.streamer) + '</span><span class="thin">的</span>深夜<span class="thin">。</span></h1>' +
          '<p class="lead">' + D.meta.sessionCount + ' 场直播的逐字稿，从 <b>' + D.meta.firstDate + '</b> 到 <b>' + D.meta.lastDate +
          '</b>，共 ' + num(D.meta.total) + ' 条。内容包括夜间杂谈、SC 回应、问答与科普段落；' +
          '全部中日对照，可按场次浏览，也可全文检索。</p>' +
          '<div class="stats">' +
            '<div class="stat"><b>' + cv(D.meta.sessionCount) + '<i>场</i></b><span>直播记录</span></div>' +
            '<div class="stat"><b>' + cv(D.meta.total) + '<i>条</i></b><span>逐字记录</span></div>' +
            '<div class="stat"><b>' + cv(D.meta.quoteCount) + '<i>段</i></b><span>摘录段落</span></div>' +
            '<div class="stat"><b>' + cv(D.topics.length) + '<i>类</i></b><span>话题标签</span></div>' +
          '</div>' +
          '<div class="hero-cta">' +
            '<a class="btn primary" href="#/quotes">读摘录 →</a>' +
            '<a class="btn" href="#/archive">进存档</a>' +
          '</div>' +
        '</div>' +
        '<aside class="hero-side rv" id="topicSide">' +
          '<div class="hs-tilt">' +
            '<div class="hs-head"><b>话题分布</b><em>' + D.topics.length + ' 类</em></div>' +
            '<div class="tbars">' + topicBarsHTML() + '</div>' +
            '<div class="hs-foot">' + num(D.meta.total) + ' 条记录的关键词归类 · 按条数排序</div>' +
          '</div>' +
        '</aside>' +

        // 首屏收在一段大引言上：一进来就能看到一句真正的原话
        (dq && dqText
          ? '<figure class="pull rv">' +
              '<blockquote>' + esc(dqText) + '</blockquote>' +
              '<figcaption>' +
                '<span' + tagStyle(dq.tag) + '>' + esc(dq.tag) + '</span>' +
                '<a href="#/archive/' + dq.s + '?t=' + encodeURIComponent(dq.t) + '">' +
                  esc(dq.date.replace('-', '.')) + ' ' + esc(dq.t) + ' 回原稿 →</a>' +
                '<em>从 ' + D.meta.quoteCount + ' 段摘录里随机一句</em>' +
              '</figcaption>' +
            '</figure>'
          : '') +
      '</section>' +

      '<div class="notice">' +
        '<h4>引用前请留意</h4>' +
        '<p>逐字稿与译文由自动识别、自动翻译生成；11 月 16 日起的场次已逐条人工校对，更早场次未逐条校对，仍可能有少量误听、断句和专名偏差。' +
        '<b>日记与摘录经人工整理，可作引用；逐字稿只作检索索引，要确认原话请回原直播。</b>' +
        ' <a href="#/about">免责声明 →</a></p>' +
      '</div>' +

      '<section class="sec rv">' +
        '<div class="sec-head"><h2><i>01</i>最近一场</h2><a class="more" href="#/archive/' + last.id + '">完整逐字稿 →</a></div>' +
        '<div class="latest">' +
          '<div class="latest-l">' +
            '<div class="date">' + esc(last.dateLong) + ' ' + esc(last.week) + '</div>' +
            '<h3>' + esc(last.start) + ' — ' + esc(last.end) + '</h3>' +
            '<div class="sub">' + (last.dur >= 60 ? '约 ' + (last.dur / 60).toFixed(1) + ' 小时' : '约 ' + last.dur + ' 分钟') +
              ' · ' + (last.start >= '12:00' ? '傍晚特别场' : '深夜档') + '</div>' +
            '<div class="nums">' +
              '<div><b>' + last.count + '</b><span>记录</span></div>' +
              '<div><b>' + Object.keys(last.topics).length + '</b><span>话题</span></div>' +
              '<div><b>' + last.segs.length + '</b><span>段落</span></div>' +
            '</div>' +
            '<a class="btn" href="#/archive/' + last.id + '">打开这一场</a>' +
          '</div>' +
          '<div class="latest-r">' +
            (mini
              ? '<div class="lr-head">这一场说了什么<em>点时间回到原稿</em></div>' + mini
              : '<div class="qmini"><p>这一场暂无摘录。</p></div>') +
          '</div>' +
        '</div>' +
      '</section>' +

      '<section class="sec rv">' +
        '<div class="sec-head"><h2><i>02</i>日记</h2><a class="more" href="#/diary">全部日记 →</a></div>' +
        (latestDiary
          ? '<div class="dgrid">' + latestDiaryCard(latestDiary) +
              '<aside class="dside">' +
                '<div class="ds-head">更早的日记</div>' +
                (D.diary.slice(1, 6).map(function (d) {
                  return '<a class="ds-item" href="' + diaryHref(d) + '">' +
                    '<em>' + esc(d.date.replace('-', '.')) + '</em>' +
                    '<b>' + esc(d.title) + '</b></a>';
                }).join('') || '<span class="ds-empty">这是第一篇。</span>') +
                '<a class="ds-more" href="#/diary">全部 ' + D.diary.length + ' 篇 →</a>' +
              '</aside>' +
            '</div>'
          : '<div class="empty">还没有日记。</div>') +
      '</section>' +
      // 窄屏没有右栏，话题分布在这里补一份；桌面由 hero 侧栏承担
      '<section class="sec rv sec-narrow">' +
        '<div class="sec-head"><h2>话题分布</h2><span class="more">' + num(D.meta.total) + ' 条记录的关键词归类</span></div>' +
        '<div class="tbars">' + topicBarsHTML() + '</div>' +
      '</section>' +

      '<section class="sec rv" id="allSessions">' +
        '<div class="sec-head"><h2><i>03</i>全部场次</h2><a class="more" href="#/archive">存档 →</a></div>' +
        '<div class="sgrid">' + allSessions.slice(sfrom, sfrom + SPAGE).map(sessionCard).join('') + '</div>' +
        pagerHTML(state.spage, spages, allSessions.length, '场') +
      '</section>';

    bindPager(function (n) { state.spage = n; renderHome(); }, 'allSessions');
    if (!state.counted) { countUp(); state.counted = true; }
    playReveal();

    setFoot();
  }

  /* ---------- diary ---------- */
  function diaryInfo(d) {
    var qn = D.quotes.filter(function (q) { return q.s === d.s; }).length;
    return esc(d.start) + ' – ' + esc(d.end) + ' · ' + d.dur + ' 分钟 · ' + d.count + ' 条记录' +
      (qn ? ' · ' + qn + ' 段摘录' : '');
  }

  function diaryHref(d) {
    return '#/diary/' + encodeURIComponent(d.key);
  }

  function latestDiaryCard(d) {
    return '<article class="dcard">' +
      '<div class="dhead">' +
        '<div class="ddate">' + esc(d.dateLong) + ' <em>' + esc(d.week) + '</em></div>' +
        '<div class="dinfo">' + diaryInfo(d) + '</div>' +
      '</div>' +
      '<h3 class="dtitle">' + esc(d.title) + '</h3>' +
      (d.tagline ? '<div class="dtag">' + esc(d.tagline) + '</div>' : '') +
      '<p class="dexcerpt">' + esc(d.summary || d.body[0] || '') + '</p>' +
      '<div class="dlinks"><a href="' + diaryHref(d) + '">读全文 →</a>' +
        '<a href="#/archive/' + d.s + '">逐字稿 →</a></div>' +
    '</article>';
  }

  function renderDiary(key) {
    var list = D.diary || [];
    var one = key ? list.filter(function (d) { return d.key === key; })[0] : null;
    // 键对不上（旧链接、手改过的地址）就退回列表，别给一个空页面
    if (key && !one) { location.replace('#/diary'); return; }
    if (one) { renderDiaryPage(one); return; }

    var pages = Math.max(1, Math.ceil(list.length / DPAGE));
    if (state.dpage < 1 || state.dpage > pages) state.dpage = 1;
    var from = (state.dpage - 1) * DPAGE;
    var cur = list.slice(from, from + DPAGE);

    var html = cur.map(diaryEntry).join('');
    var btns = pagerHTML(state.dpage, pages, list.length, '篇');

    app.innerHTML =
      '<section class="hero hero-sm">' +
        '<div class="hero-copy">' +
          '<div class="kicker">STREAM DIARY</div>' +
          '<h1>今日<span class="thin">，</span>播了<span class="accent">什么</span></h1>' +
          '<p class="lead">按场次记录当晚的话题、观众来信与随口讲到的冷知识。共 ' +
          list.length + ' 篇。</p>' +
        '</div>' +
      '</section>' +
      '<div class="dlist" id="dlist">' + (html || '<div class="empty">还没有日记。</div>') + '</div>' +
      btns;

    bindPager(function (n) { state.dpage = n; renderDiary(); }, 'dlist');

    setFoot();
  }

  // 列表里的一条：日期 / 场次信息 / 标题 / 摘要，点整块进全文
  function diaryEntry(d) {
    var sum = d.summary || d.body[0] || '';
    return '<a class="dentry dmini" href="' + diaryHref(d) + '">' +
      '<div class="dhead">' +
        '<div class="ddate">' + esc(d.dateLong) + ' <em>' + esc(d.week) + '</em></div>' +
        '<div class="dinfo">' + diaryInfo(d) + '</div>' +
      '</div>' +
      '<h3 class="dtitle">' + esc(d.title) + '</h3>' +
      (d.tagline ? '<div class="dtag">' + esc(d.tagline) + '</div>' : '') +
      '<p class="dsum">' + esc(sum) + '</p>' +
      '<div class="dlinks"><span class="dmore">读全文 →</span>' +
        '<span class="dcount">' + d.body.length + ' 段</span></div>' +
    '</a>';
  }

  // 详情页：全文 + 场次信息 + 上下篇，正文按段落排
  function renderDiaryPage(d) {
    var i = D.diary.indexOf(d);
    var newer = i > 0 ? D.diary[i - 1] : null;
    var older = i < D.diary.length - 1 ? D.diary[i + 1] : null;

    var body = d.body.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    var nav =
      '<nav class="dnav">' +
        (older
          ? '<a class="dnav-i" href="' + diaryHref(older) + '"><em>更早一篇</em><b>' + esc(older.title) + '</b></a>'
          : '<span class="dnav-i dnav-off"></span>') +
        (newer
          ? '<a class="dnav-i dnav-r" href="' + diaryHref(newer) + '"><em>更新一篇</em><b>' + esc(newer.title) + '</b></a>'
          : '<span class="dnav-i dnav-off"></span>') +
      '</nav>';

    app.innerHTML =
      '<section class="hero hero-sm">' +
        '<div class="hero-copy dwrap">' +
          '<a class="back" href="#/diary">← 全部日记</a>' +
          '<div class="kicker">STREAM DIARY</div>' +
          '<h1 class="dtitle-lg">' + esc(d.title) + '</h1>' +
          (d.tagline ? '<p class="lead">' + esc(d.tagline) + '</p>' : '') +
          '<div class="dinfo dmeta-row">' + esc(d.dateLong) + ' <em>' + esc(d.week) + '</em> · ' + diaryInfo(d) + '</div>' +
        '</div>' +
      '</section>' +
      '<article class="dfull">' +
        '<div class="dbody">' + body + '</div>' +
        '<div class="dlinks">' +
          '<a href="#/archive/' + d.s + '">这一场的逐字稿 →</a>' +
          '<a href="#/diary">全部日记</a>' +
        '</div>' +
      '</article>' +
      nav;

    setFoot();
  }

  function sessionCard(s) {
    // 按出现次数排序后再取前三，否则每张卡片都只会显示同一组「最早出现」的话题
    var top = Object.keys(s.topics)
      .sort(function (a, b) { return s.topics[b] - s.topics[a]; })
      .slice(0, 3).map(function (k) {
      return '<span style="color:' + tcolor(parseInt(k, 10)) + '">' + esc(tname(parseInt(k, 10))) + '</span>';
    }).join(' · ');
    return '<a class="qcard" href="#/archive/' + s.id + '">' +
      '<div class="tag">' + esc(s.date.replace('-', '.')) + ' ' + esc(s.week) + '</div>' +
      '<p class="zh">' + esc(s.start) + ' — ' + esc(s.end) + '</p>' +
      '<p class="note">' + top + '</p>' +
      // 这一场的话题走向：横轴是时长，颜色是当分钟的话题
      '<span class="hb" title="这一场的话题走向">' + stripHTML(s) + '</span>' +
      '<div class="meta"><span>' + s.count + ' 条 · ' + s.dur + ' 分钟</span><span>阅读 →</span></div>' +
      '</a>';
  }

  /* ---------- quotes ---------- */
  function renderQuotes() {
    // 全站搜索跳到某段摘录时，放开筛选并保证目标那一条已经渲染出来
    var focusId = parseHash().q.focus || '';
    var focusQ = focusId ? D.quotes.filter(function (x) { return x.id === focusId; })[0] : null;
    if (focusQ) { state.tag = '全部'; state.qs = 'all'; }
    var tags = ['全部'];
    D.quotes.forEach(function (q) { if (tags.indexOf(q.tag) < 0) tags.push(q.tag); });
    var counts = {};
    D.quotes.forEach(function (q) { counts[q.tag] = (counts[q.tag] || 0) + 1; });
    // 标签会随内容增长，按条数降序排（同数按名称），「全部」固定首位
    tags = ['全部'].concat(tags.slice(1).sort(function (a, b) {
      return (counts[b] - counts[a]) || a.localeCompare(b, 'zh');
    }));

    var chips = tags.map(function (t) {
      var n = t === '全部' ? D.quotes.length : counts[t];
      return '<button class="chip' + (t === state.tag ? ' on' : '') + '" data-tag="' + esc(t) + '"' +
        (t === '全部' ? '' : tagStyle(t)) + '>' +
        esc(t) + '<span class="n">' + n + '</span></button>';
    }).join('');

    var sess = D.sessions.filter(function (s) {
      return D.quotes.some(function (q) { return q.s === s.id; });
    }).reverse();
    var schips = '<button class="chip' + (state.qs === 'all' ? ' on' : '') + '" data-s="all">全部<span class="n">' + D.quotes.length + '</span></button>' +
      sess.map(function (s) {
        var n = D.quotes.filter(function (q) { return q.s === s.id; }).length;
        return '<button class="chip' + (state.qs === String(s.id) ? ' on' : '') + '" data-s="' + esc(s.id) + '">' +
          esc(s.date.replace('-', '.')) + '<span class="n">' + n + '</span></button>';
      }).join('');

    app.innerHTML =
      '<section class="hero hero-sm">' +
        '<div class="hero-copy">' +
          '<div class="kicker">TRANSCRIPT EXCERPTS</div>' +
          '<h1>摘录<span class="thin">，</span><span class="accent">' + D.meta.quoteCount + '</span> 段</h1>' +
          '<p class="lead">从 ' + num(D.meta.total) + ' 条记录里挑出的 ' + D.meta.quoteCount + ' 段，' +
          '中日对照，按话题分类。每段连同引出它的那句话一起保留，措辞不做润色。</p>' +
        '</div>' +
      '</section>' +
      '<div class="filters" id="filters">' + chips + '</div>' +
      '<div class="filters" id="sfilters"><span class="flabel">场次</span>' + schips + '</div>' +
      '<div class="qlist" id="qlist"></div>' +
      '<div class="qmore" id="qmore"></div>';

    document.getElementById('filters').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      state.tag = b.getAttribute('data-tag');
      document.querySelectorAll('#filters .chip').forEach(function (c) {
        c.classList.toggle('on', c.getAttribute('data-tag') === state.tag);
      });
      renderQuoteList(true);
    });
    document.getElementById('sfilters').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      state.qs = b.getAttribute('data-s');
      document.querySelectorAll('#sfilters .chip').forEach(function (c) {
        c.classList.toggle('on', c.getAttribute('data-s') === state.qs);
      });
      renderQuoteList(true);
    });
    renderQuoteList(true);
    if (focusQ) {
      state.qShown = Math.max(QBATCH, D.quotes.indexOf(focusQ) + 1);
      renderQuoteList(false);
      // route() 末尾会把页面滚回顶部，等下一帧再落到目标摘录上
      requestAnimationFrame(function () {
        var el = document.getElementById(focusId);
        if (el) { el.classList.add('hit'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      });
    }
    setFoot();
  }

  function quoteCard(q) {
    return '<article class="quote" id="' + q.id + '">' +
      '<div class="qside">' +
        '<span class="tag"' + tagStyle(q.tag) + '>' + esc(q.tag) + '</span>' +
        '<a class="qtime" href="#/archive/' + q.s + '?t=' + encodeURIComponent(q.t) + '">' +
          esc(q.date.replace('-', '.')) + '<i>' + esc(q.t) + '</i>' +
        '</a>' +
      '</div>' +
      '<div class="qbody">' +
        '<p class="jp">' + esc(q.jp) + '</p>' +
        '<p class="zh">' + esc(q.zh) + '</p>' +
        (q.note ? '<p class="note">' + esc(q.note) + '</p>' : '') +
      '</div>' +
      '<button class="copy" data-id="' + q.id + '">复制</button>' +
    '</article>';
  }

  // reset=true 时回到第一批：切换筛选后从顶部重新铺，避免停在一个空的批次上
  function renderQuoteList(reset) {
    if (reset) state.qShown = QBATCH;
    var list = D.quotes.filter(function (q) {
      return (state.tag === '全部' || q.tag === state.tag) &&
             (state.qs === 'all' || String(q.s) === state.qs);
    });
    var shown = list.slice(0, state.qShown);
    var box = document.getElementById('qlist');
    var more = document.getElementById('qmore');
    if (!box || !more) return;

    box.innerHTML = shown.map(quoteCard).join('') ||
      '<div class="empty">这个筛选组合下还没有摘录。</div>';

    if (list.length > state.qShown) {
      more.innerHTML = '<button class="morebtn" id="qloadmore">加载更多 ↓</button>' +
        '<span class="mhint">已显示 ' + shown.length + ' / ' + list.length + ' 段</span>';
      document.getElementById('qloadmore').addEventListener('click', function () {
        state.qShown += QBATCH;
        renderQuoteList(false);
      });
    } else {
      more.innerHTML = list.length ? '<span class="mhint">已全部显示 · 共 ' + list.length + ' 段</span>' : '';
    }
  }

  app.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy');
    if (!btn) return;
    var q = D.quotes.filter(function (x) { return x.id === btn.getAttribute('data-id'); })[0];
    if (!q) return;
    var text = q.zh + '\n' + q.jp + '\n—— ' + D.meta.streamer + ' ' + q.date + ' ' + q.t;
    var done = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) {}
      document.body.removeChild(ta); done();
    }
  });

  /* ---------- 存档：年月日选择 → 当日场次 → 逐字稿，全在同一个页面 ----------
     顶部是标准的年 / 月 / 日下拉输入框，下面配一个紧凑的小月历做索引。
     选中日期才在右侧列出当天场次，再选一场就地把逐字稿渲染进同页下方。
     全程不换 hash、不跳路由；外部旧链接 #/archive/<sid> 仍作为「直接选中这一场」的深链。 */
  function renderArchivePage(opts) {
    var month = monthKeys.indexOf(opts.month) >= 0 ? opts.month : monthKeys[monthKeys.length - 1];
    var day = (byDay[opts.day] && opts.day.slice(0, 7) === month) ? opts.day : '';
    var sid = (opts.sid != null && D.sessions[opts.sid]) ? opts.sid : null;
    if (sid != null) {                 // 深链直接打开某场：把日历翻到那一天
      day = dayKey(D.sessions[sid]);
      month = day.slice(0, 7);
    }

    var now = new Date();
    var today = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());

    // 年份只取有场次的年份；月份列出 12 个月，暂无记录的月份禁用；
    // 日期列出当月每一天，只让有直播的日子可选，选项里直接带场数。
    var years = [];
    monthKeys.forEach(function (k) {
      var y = k.slice(0, 4);
      if (years.indexOf(y) < 0) years.push(y);
    });

    function countOf(k) {
      return D.sessions.filter(function (s) { return dayKey(s).slice(0, 7) === k; }).length;
    }
    function monthCount() { return countOf(month); }

    function yearOptions() {
      return years.map(function (y) {
        return '<option value="' + y + '"' + (month.slice(0, 4) === y ? ' selected' : '') +
               '>' + y + ' 年</option>';
      }).join('');
    }
    function monthOptions() {
      var out = '';
      for (var m = 1; m <= 12; m++) {
        var k = month.slice(0, 4) + '-' + pad2(m);
        var n = countOf(k);
        out += '<option value="' + pad2(m) + '"' + (+month.slice(5) === m ? ' selected' : '') +
               (n ? '' : ' disabled') + '>' + m + ' 月' + (n ? ' · ' + n + ' 场' : ' · 暂无') + '</option>';
      }
      return out;
    }
    function dayOptions() {
      var p = month.split('-'), y = +p[0], m = +p[1];
      var days = new Date(y, m, 0).getDate();
      var out = '<option value=""' + (day ? '' : ' selected') + '>选择日期</option>';
      for (var i = 1; i <= days; i++) {
        var k = month + '-' + pad2(i);
        var n = byDay[k] ? byDay[k].length : 0;
        out += '<option value="' + k + '"' + (day === k ? ' selected' : '') +
               (n ? '' : ' disabled') + '>' + i + ' 日' + (n ? ' · ' + n + ' 场' : '') +
               (k === today ? ' · 今天' : '') + '</option>';
      }
      return out;
    }

    function gridHTML() {
      var p = month.split('-'), y = +p[0], m = +p[1];
      var lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;   // 周一开头
      var days = new Date(y, m, 0).getDate();
      var cells = Math.ceil((lead + days) / 7) * 7;
      var out = '';
      for (var i = 0; i < cells; i++) {
        var n = i - lead + 1, inMonth = n >= 1 && n <= days;
        var key = inMonth ? month + '-' + pad2(n) : '';
        var k = key && byDay[key] ? byDay[key].length : 0;
        var cls = 'cal-cell' + (inMonth ? '' : ' cal-out') + (k ? ' has' : '') +
                  (key && key === day ? ' sel' : '') + (key === today ? ' is-today' : '');
        out += '<div class="' + cls + '"' + (key ? ' data-day="' + key + '"' : '') +
               (k ? ' role="button" tabindex="0" aria-label="' + (+key.slice(5, 7)) + ' 月 ' +
                 (+key.slice(8, 10)) + ' 日，' + k + ' 场"' : '') + '>' +
          '<span class="cal-n">' + (inMonth ? n : '') + '</span>' +
          (k ? '<span class="cal-mark"><i></i></span>' : '') +
        '</div>';
      }
      return out;
    }

    function pickerHTML() {
      var mi = monthKeys.indexOf(month);
      var prevM = monthKeys[mi - 1] || '', nextM = monthKeys[mi + 1] || '';
      return '<div class="cal-picker">' +
          '<div class="cal-selects">' +
            '<label class="cal-field"><span>年</span><select id="calYear" aria-label="选择年份">' + yearOptions() + '</select></label>' +
            '<label class="cal-field"><span>月</span><select id="calMonth" aria-label="选择月份">' + monthOptions() + '</select></label>' +
            '<label class="cal-field wide"><span>日</span><select id="calDay" aria-label="选择日期">' + dayOptions() + '</select></label>' +
          '</div>' +
          '<div class="cal-nav">' +
            '<button class="cal-arrow" type="button" data-goto="' + prevM + '"' +
              (prevM ? '' : ' disabled') + ' aria-label="上一场所在月">‹</button>' +
            '<h3>' + monthLabel(month) + '<em>' + monthCount() + ' 场</em></h3>' +
            '<button class="cal-arrow" type="button" data-goto="' + nextM + '"' +
              (nextM ? '' : ' disabled') + ' aria-label="下一场所在月">›</button>' +
          '</div>' +
          '<div class="cal-grid"><div class="cal-dow">' +
            ['一', '二', '三', '四', '五', '六', '日'].map(function (w, idx) {
              return '<span' + (idx >= 5 ? ' class="we"' : '') + '>' + w + '</span>';
            }).join('') +
          '</div><div class="cal-cells">' + gridHTML() + '</div></div>' +
          '<div class="cal-foot">' +
            '<span class="cal-legend"><i></i>有直播</span>' +
            '<button class="cal-jump" type="button" data-goto="latest">回到最新</button>' +
          '</div>' +
        '</div>';
    }

    function sessionCard(s) {
      var d = D.diary.filter(function (x) { return x.key === s.key; })[0];
      var qn = D.quotes.filter(function (x) { return x.s === s.id; }).length;
      var mini = s.ribbon.slice(0, 48).map(function (t) {
        return '<i style="background:' + (t < 0 ? '#2a2521' : tcolor(t)) + '"></i>';
      }).join('');
      return '<button class="cs-card' + (s.id === sid ? ' on' : '') + '" type="button" data-sid="' + s.id + '">' +
        '<span class="cs-day">' + esc(s.date.replace('-', '.')) + '<em>' + esc(s.week) + '</em></span>' +
        '<span class="cs-main">' +
          '<span class="cs-time">' + esc(s.start) + ' – ' + esc(s.end) +
            '<span>' + s.dur + ' 分钟 · ' + s.count + ' 条' + (qn ? ' · ' + qn + ' 段摘录' : '') + '</span></span>' +
          (d ? '<span class="cs-title">' + esc(d.title) + '</span>' +
               '<span class="cs-sub">' + esc(d.tagline || '') + '</span>' : '') +
          '<span class="cs-mini">' + mini + '</span>' +
        '</span>' +
        '<span class="cs-go">逐字稿 →</span>' +
      '</button>';
    }

    // 选中日期后，只列出这一天有几场；不选中时右侧留一个提示
    function paintDay() {
      var box = document.getElementById('dayPanel');
      if (!day) {
        box.innerHTML = '<div class="cal-empty"><p>选好年份、月份与日期，<br>这里会列出当天的直播场次。</p></div>';
        return;
      }
      var list = byDay[day] || [];
      box.innerHTML =
        '<section class="cal-day-panel">' +
          '<div class="cal-day-head"><h3>' + (+day.slice(5, 7)) + ' 月 ' + (+day.slice(8, 10)) +
            ' 日 <small>' + esc(list[0] ? list[0].week : '') + '</small></h3>' +
            '<span>' + list.length + ' 场</span></div>' +
          '<div class="cs-list">' + list.map(sessionCard).join('') + '</div>' +
        '</section>';
    }

    function setDay(k) {
      day = k || '';
      sid = null;
      document.getElementById('transcriptBox').innerHTML = '';
      document.querySelectorAll('.cal-cell.sel').forEach(function (c) { c.classList.remove('sel'); });
      if (day) {
        var cell = document.querySelector('.cal-cell[data-day="' + day + '"]');
        if (cell) cell.classList.add('sel');
      }
      var sel = document.getElementById('calDay');
      if (sel) sel.value = day;
      paintDay();
    }

    function chooseSession(id) {
      sid = id;
      paintDay();
      paintTranscript(sid, null, '');   // 后面那个函数声明会提升到这里
      var box = document.getElementById('transcriptBox');
      var y = box.getBoundingClientRect().top + window.pageYOffset - 90;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }

    app.innerHTML =
      '<section class="cal">' +
        '<div class="cal-head">' +
          '<div class="kicker">ARCHIVE CALENDAR</div>' +
          '<h2 class="cal-title">存档日历</h2>' +
          '<p class="cal-lead">自 ' + esc(D.meta.firstDate) + ' 起的直播逐字稿，按开播日归档。</p>' +
          '<div class="cal-facts">' +
            '<span><b>' + D.sessions.length + '</b> 场</span>' +
            '<span><b>' + dayKeys.length + '</b> 天</span>' +
            '<span><b>' + num(D.meta.total || D.records.length) + '</b> 条记录</span>' +
          '</div>' +
        '</div>' +
        '<div class="cal-top">' +
          '<div id="calBody">' + pickerHTML() + '</div>' +
          '<div id="dayPanel"></div>' +
        '</div>' +
        '<div id="transcriptBox"></div>' +
      '</section>';

    function goMonth(g) {
      if (!g || g === month || monthKeys.indexOf(g) < 0) return;
      month = g; day = ''; sid = null;
      document.getElementById('transcriptBox').innerHTML = '';
      document.getElementById('calBody').innerHTML = pickerHTML();
      paintDay();
    }

    // 「回到最新」不能只翻月份：已经在最新月时 goMonth 会直接 return，
    // 而且翻月后 day 为空，右侧仍是空白。这里直接定位到最新一天的场次并展开最新一场。
    function latestSid() {
      var k = dayKeys[dayKeys.length - 1];
      var list = k ? (byDay[k] || []) : [];
      if (!list.length) return null;
      var s = list.reduce(function (a, b) { return b.start >= a.start ? b : a; }, list[0]);
      var id = D.sessions.indexOf(s);
      return id >= 0 ? id : null;
    }
    function goLatest() {
      var k = dayKeys[dayKeys.length - 1];
      if (!k) return;
      var lm = k.slice(0, 7);
      if (month !== lm) {
        month = lm; day = ''; sid = null;
        document.getElementById('transcriptBox').innerHTML = '';
        document.getElementById('calBody').innerHTML = pickerHTML();
      }
      setDay(k);
      var id = latestSid();
      if (id != null) chooseSession(id);
    }

    var calBody = document.getElementById('calBody');
    calBody.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-goto]');
      if (b && !b.disabled) {
        var g = b.getAttribute('data-goto');
        if (g === 'latest') goLatest();
        else goMonth(g);
        return;
      }
      var cell = e.target.closest('.cal-cell.has');
      if (cell) setDay(cell.getAttribute('data-day'));
    });
    calBody.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var cell = e.target.closest && e.target.closest('.cal-cell.has');
      if (!cell) return;
      e.preventDefault();
      setDay(cell.getAttribute('data-day'));
    });
    // 三个下拉都是页面内状态，换了年月只重绘选择器，不动 hash
    calBody.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'calYear') {
        var ys = monthKeys.filter(function (k) { return k.slice(0, 4) === t.value; });
        goMonth(ys[ys.length - 1]);
      } else if (t.id === 'calMonth') {
        goMonth(month.slice(0, 4) + '-' + t.value);
      } else if (t.id === 'calDay') {
        setDay(t.value);
      }
    });
    document.getElementById('dayPanel').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-sid]');
      if (b) chooseSession(parseInt(b.getAttribute('data-sid'), 10));
    });

    paintDay();
    if (sid != null) paintTranscript(sid, opts.jumpT, opts.initialQ);
    setFoot();
  }

  /* ---------- 逐字稿区块：由存档页就地渲染进 #transcriptBox ---------- */
  function paintTranscript(sid, jumpT, initialQ) {
    if (sid == null || !D.sessions[sid]) return;
    // 换场次时清掉上一场的检索词与筛选，别把旧状态带过来
    state.q = initialQ || '';
    state.hideEmpty = false;
    var cur = sess(sid);
    var startH = parseInt(cur.start.split(':')[0], 10);

    // 跨零点场次：把 00:xx 视为 24:xx，保证时间比较正确。
    // 秒要算进去——只比到分钟的话，00:49:43 会落到 00:49:00 那条，前后差出十几行。
    function absMin(hms) {
      var p = hms.split(':');
      var m = parseInt(p[0], 10) * 60 + parseInt(p[1], 10) + (parseInt(p[2], 10) || 0) / 60;
      if (startH >= 12 && m < 12 * 60) m += 1440;
      return m;
    }

    // 让目标条停在吸顶导航下方，而不是被它盖住
    function topPad() {
      var top = document.querySelector('.top');
      return (top ? top.offsetHeight : 62) + 20;
    }

    // 摘录里记的时间，常常落在「那句话被识别切断的前半句」上：比如 01:09:00 只有
    // 「初めてビリビリと歴史。」，真正那句要到 13 秒后的下一行才有。只按时间落位，
    // 人看到的就是一句对不上的话，会以为跳错了。所以带 ?t= 时先按时间定个大概位置，
    // 再在这一小段里找正文最贴近摘录的那一行。
    function quoteAt(t) {
      for (var i = 0; i < D.quotes.length; i++) {
        if (D.quotes[i].s === sid && D.quotes[i].t === t) return D.quotes[i];
      }
      return null;
    }
    function normJP(s) {
      return s.replace(/[^\w\u3040-\u30ff\u4e00-\u9fff]/g, '');
    }
    function grams(s) {
      var g = {}, i;
      for (i = 0; i < s.length - 1; i++) g[s.slice(i, i + 2)] = 1;
      return g;
    }
    function dice(a, b) {
      var ka = Object.keys(a), kb = Object.keys(b), hit = 0, i;
      for (i = 0; i < ka.length; i++) if (b[ka[i]]) hit++;
      return (ka.length && kb.length) ? 2 * hit / (ka.length + kb.length) : 0;
    }
    // 取摘录正文的第一句（跳过开头的观众提问）当比对键
    function quoteKey(q) {
      if (!q) return '';
      var lines = q.jp.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].replace(/^[\s—]+/, '').trim();
        if (!l || l.charAt(0) === '「') continue;
        var k = normJP(l);
        if (k.length >= 8) return k.slice(0, 40);
      }
      return '';
    }

    function jump(t, flash) {
      var rows = document.querySelectorAll('#trlist .tr');
      var want = absMin(t), start = -1;
      for (var i = 0; i < rows.length; i++) {
        if (absMin(rows[i].getAttribute('data-t')) >= want) { start = i; break; }
      }
      if (start < 0) return;

      var idx = start;
      var key = quoteKey(quoteAt(t));
      if (key) {
        var qg = grams(key);
        var rowGrams = function (i) { return grams(normJP(rows[i].querySelector('.jp').textContent)); };
        var base = dice(qg, rowGrams(start)), best = 0, scored = [];
        // 窗口卡在前后各 60 行（约一分钟），防止被同一段话说两遍的别处带走
        var from = Math.max(0, start - 60), to = Math.min(rows.length, start + 61);
        for (var j = from; j < to; j++) {
          var sc = dice(qg, rowGrams(j));
          scored.push([sc, j]);
          if (sc > best) best = sc;
        }
        // 阈值兜底：没明显更贴近就仍按时间落位；够像时取最早的命中行
        // （一句话常被切成好几条，落在第一条才像「从这里开始」）
        if (best >= 0.45 && best - base >= 0.12) {
          for (var k = 0; k < scored.length; k++) {
            if (scored[k][0] >= best * 0.85) { idx = scored[k][1]; break; }
          }
        }
      }

      var target = rows[idx];
      // 深链常常要跨几万像素，平滑滚动太久还会被后续布局打断，这里直接落位
      var y = target.getBoundingClientRect().top + window.pageYOffset - topPad();
      window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
      if (flash) {
        target.classList.add('hit');
        setTimeout(function () { target.classList.remove('hit'); }, 3000);
      }
    }

    var hm = cur.start.split(':');
    var baseMin = parseInt(hm[0], 10) * 60 + parseInt(hm[1], 10);
    var ribbon = cur.ribbon.map(function (t, i) {
      var c = t < 0 ? '#241f1b' : tcolor(t);
      var abs = (baseMin + i) % 1440;
      var clock = String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
      return '<i style="background:' + c + '" title="' + clock +
        ' · ' + (t < 0 ? '无记录' : esc(tname(t))) + '"></i>';
    }).join('');

    var legendSet = {};
    cur.ribbon.forEach(function (t) { if (t >= 0) legendSet[t] = 1; });
    var legend = Object.keys(legendSet).map(function (k) {
      var i = parseInt(k, 10);
      return '<span><i style="background:' + tcolor(i) + '"></i>' + esc(tname(i)) + '</span>';
    }).join('');

    var toc = cur.segs.map(function (g) {
      return '<button data-jump="' + esc(g.time.split('-')[0]) + '"><i style="background:' + tcolor(g.topic) +
        '"></i>' + esc(tname(g.topic)) + '<em>' + esc(g.time) + '</em></button>';
    }).join('');

    var topT = Object.keys(cur.topics)
      .sort(function (a, b) { return cur.topics[b] - cur.topics[a]; })
      .slice(0, 4).map(function (k) {
      var i = parseInt(k, 10);
      return '<span><b style="color:' + tcolor(i) + '">' + esc(tname(i)) + '</b> ' + cur.topics[k] + '</span>';
    }).join('');

    var qn = D.quotes.filter(function (q) { return q.s === sid; }).length;

    document.getElementById('transcriptBox').innerHTML =
      '<section class="arch-single">' +
        '<button class="cal-backtop" type="button" data-backtop="1">↑ 回到日历</button>' +
        '<div class="shead">' +
          '<h2>' + esc(cur.date.replace('-', '.')) + ' <small>' + esc(cur.week) + '</small></h2>' +
          '<div class="meta"><span><b>' + esc(cur.start) + ' – ' + esc(cur.end) + '</b></span>' +
            '<span><b>' + cur.count + '</b> 条记录</span><span>约 <b>' + cur.dur + '</b> 分钟</span>' +
            (qn ? '<span><b>' + qn + '</b> 段摘录</span>' : '') +
            '<span>' + topT + '</span></div>' +
        '</div>' +
        '<div class="arch-note">以下是<b>机器识别 + 机器翻译</b>的记录；11 月 16 日起的场次已逐条人工校对，更早场次未经校对。' +
          '只作检索用——引用前请回原直播核对。</div>' +
        '<div class="ribbon-wrap"><div class="ribbon">' + ribbon + '</div>' +
          '<div class="ribbon-legend">' + legend + '</div></div>' +
        (toc ? '<div class="toc">' + toc + '</div>' : '') +
        '<div class="tools">' +
          '<label class="search"><span class="ico">⌕</span><input id="q" placeholder="搜索这一场，或直接全库检索…" autocomplete="off"></label>' +
          '<label class="toggle"><input type="checkbox" id="hideEmpty">只看有译文</label>' +
        '</div>' +
        '<div class="count" id="count"></div>' +
        '<div class="trlist" id="trlist"></div>' +
      '</section>';

    var box = document.getElementById('transcriptBox');
    var input = document.getElementById('q');
    // 全站搜索的「查看全部逐字稿」会带上 ?q=；state.q 已在函数开头设好
    if (initialQ) input.value = initialQ;
    input.addEventListener('input', function () {
      state.q = input.value.trim();
      renderList(sid);
    });
    document.getElementById('hideEmpty').addEventListener('change', function (e) {
      state.hideEmpty = e.target.checked;
      renderList(sid);
    });
    box.querySelector('[data-backtop]').addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    var tocEl = box.querySelector('.toc');
    if (tocEl) tocEl.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) jump(b.getAttribute('data-jump'));
    });

    renderList(sid);
    if (jumpT) {
      // route() 末尾还会把页面滚到顶上，所以等它执行完（下一帧）再落位
      requestAnimationFrame(function () { jump(jumpT, true); });
      // 直接从外部链接打开时，浏览器可能在 load 之后再校正一次滚动位置，这里补一次
      window.addEventListener('load', function () {
        var hit = document.querySelector('#trlist .tr.hit');
        if (!hit) return;
        var y = hit.getBoundingClientRect().top + window.pageYOffset - topPad();
        if (Math.abs(window.pageYOffset - y) > 120) jump(jumpT, false);
      }, { once: true });
    }
    setFoot();
  }

  function rowHTML(r, q, showSession) {
    var s = sess(r.s);
    var prefix = showSession ? esc(s.date.replace('-', '.')) + ' ' : '';
    return '<div class="tr' + (r.zh ? '' : ' nozh') + '" data-t="' + esc(r.t) + '">' +
      '<div class="t">' + prefix + esc(r.t) + '</div>' +
      '<div class="dot" style="background:' + tcolor(r.tp) + '"></div>' +
      '<div><div class="jp">' + mark(r.jp, q) + '</div>' +
      (r.zh ? '<div class="zh">' + mark(r.zh, q) + '</div>' : '') + '</div>' +
    '</div>';
  }

  function renderList(sid) {
    var box = document.getElementById('trlist');
    var cnt = document.getElementById('count');
    var q = state.q;

    if (!q) {
      var rows = D.records.filter(function (r) {
        return r.s === sid && (!state.hideEmpty || r.zh);
      });
      cnt.textContent = rows.length + ' 条' + (state.hideEmpty ? '（已隐藏无译文）' : '');
      box.innerHTML = rows.map(function (r) { return rowHTML(r, '', false); }).join('') ||
        '<div class="empty">没有符合条件的记录。</div>';
      return;
    }

    var ql = q.toLowerCase();
    var hits = [];
    for (var i = 0; i < D.records.length; i++) {
      var r = D.records[i];
      if (state.hideEmpty && !r.zh) continue;
      if (r.jp.toLowerCase().indexOf(ql) >= 0 || (r.zh && r.zh.toLowerCase().indexOf(ql) >= 0)) {
        hits.push(r);
        if (hits.length >= 400) break;
      }
    }
    cnt.textContent = '全库检索「' + q + '」：' + hits.length + (hits.length >= 400 ? '+' : '') + ' 条';
    box.innerHTML = hits.map(function (r) { return rowHTML(r, q, true); }).join('') ||
      '<div class="empty">没有找到包含「' + esc(q) + '」的记录。</div>';
  }

  /* ---------- tools ---------- */
  // 工具做成「条目 → 详情页」，和日记一个结构：列表页放摘要卡片，点进去才是全文。
  // 以后加工具就在 TOOLS 里添一个对象：id 决定链接 #/tools/<id>，
  // summary 给列表页，page() 给详情页。数字一律从构建产物（meta）拿，不在前端写死。
  function toolSubsFacts() {
    var sub = D.meta.subs || {};
    var ext = D.meta.ext || {};
    var latestKey = (sub.latest || '').replace('_', ' ');
    return [
      [(sub.sessions || 0) + '<i>场</i>', '已配字幕'],
      [num(sub.blocks || 0) + '<i>条</i>', '双语字幕'],
      [latestKey ? esc(latestKey.slice(5)) : '—', '最新一场'],
      [sub.updated ? esc(sub.updated) : '—', '数据更新']
    ];
  }
  function toolSubsHead(t, extraBtn) {
    extraBtn = extraBtn || '';
    var ext = D.meta.ext || {};
    var icon = (t && t.icon) || 'brand/ext-icon.png';
    var sizeTxt = ext.size ? (ext.size < 1024 * 1024
      ? Math.round(ext.size / 1024) + ' KB'
      : (ext.size / 1048576).toFixed(1) + ' MB') : '';
    var btn = ext.file
      ? '<a class="dlbtn" href="' + esc(ext.file) + '" download>' +
          '<i aria-hidden="true">↓</i>下载插件' +
          (sizeTxt ? '<s>' + sizeTxt + '</s>' : '') + '</a>'
      : '<span class="dlbtn off">安装包未生成</span>';
    return '<div class="tool-head">' +
      '<img class="tool-icon" src="' + icon + '" alt="" width="60" height="60" decoding="async">' +
      '<div class="tool-name">' +
        '<b>录播字幕</b>' +
        '<span class="tool-ver">v' + esc(ext.ver || '—') + '</span>' +
        '<em>Chrome / Edge 浏览器插件</em>' +
      '</div>' + btn + extraBtn + '</div>';
  }
  function toolSubsFactsHtml() {
    return '<ul class="tool-facts">' + toolSubsFacts().map(function (f) {
      return '<li><b>' + f[0] + '</b><span>' + f[1] + '</span></li>';
    }).join('') + '</ul>';
  }

  var TOOLS = [
    {
      id: 'subs',
      name: '录播字幕',
      kind: 'Chrome / Edge 浏览器插件',
      icon: 'brand/ext-icon.png',
      summary: '把当时逐句翻出来的中日对照，重新贴回录播画面上——录播本身没字幕，字幕在这儿。' +
        '日文原文在上、中文译文在下，跟着画面逐句走，和逐字稿、摘录完全对得上。',
      facts: toolSubsFacts,
      page: function (t) {
        var sub = D.meta.subs || {};
        var ext = D.meta.ext || {};
        return '<article class="tool">' + toolSubsHead(t) +
          '<p class="tool-desc">看 B 站录播时，在播放器下方叠一行双语字幕：<b>日文原文在上、中文译文在下</b>，' +
            '跟着画面逐句走。字幕不是听译出来的，就是这场直播当时的那份记录，所以和逐字稿、摘录完全对得上。</p>' +
          toolSubsFactsHtml() +
        '</article>' +
        '<div class="box"><h3>安装</h3>' +
          '<ol class="steps">' +
            '<li><b>下载</b>　点上面的按钮拿到 <code>.zip</code>，解压到一个你不会随手删掉的文件夹' +
              '（插件就从这个文件夹跑，删了就得重装）。</li>' +
            '<li><b>打开扩展管理</b>　地址栏输 <code>chrome://extensions</code>（Edge 是 <code>edge://extensions</code>）。</li>' +
            '<li><b>开启开发者模式</b>　页面右上角的开关打开，左侧会多出「加载已解压的扩展程序」。</li>' +
            '<li><b>选中文件夹</b>　选解压出来的那个目录（里面有 <code>manifest.json</code> 的那层），装完就好。</li>' +
          '</ol>' +
        '</div>' +
        '<div class="box"><h3>用法</h3>' +
          '<p><b>打开任意一个录播视频页</b>，播放器右下角会出现一个「译」按钮，点开是控制面板。' +
            '剩下的基本不用管：</p>' +
          '<p><b>场次自动认</b>　按稿件映射、简介里的 <code>HBS:场次</code> 标记、投稿时间倒推，三道兜底；' +
            '实在认不出就在面板里手动选一场。</p>' +
          '<p><b>对时</b>　录播的开头往往不是开播那一刻（提前开录、切成黑屏开头），差多少用面板里的 ' +
            '<code>−10 / −1 / +1 / +10</code> 推一下，按稿件记住，下次不用再调。</p>' +
          '<p><b>显示</b>　双语 / 仅中文 / 仅原文三种模式，字号和高度都能拖；进全屏也跟着走。</p>' +
        '</div>' +
        '<div class="box"><h3>数据从哪来</h3>' +
          '<p>字幕轨跟本站同源：<code>translation_history.db</code> 里每一行「日文原文 + 中文译文 + 时间」' +
            '直接切成字幕块，碎句按停顿合并（不然一句一闪过看不清），ASR 重述的重复句去掉。' +
            '共 <b>' + (sub.sessions || 0) + '</b> 场、<b>' + num(sub.blocks || 0) + '</b> 条。</p>' +
          '<p>每次存档更新，字幕包一起更新，插件最多三小时自动取到新的，也可以在弹窗里强制刷新。' +
            '想单独拿数据的话，索引在 <a href="subs/index.json" target="_blank" rel="noopener">subs/index.json</a>，' +
            '单场文件是 <code>subs/场次.json</code>。</p>' +
          '<p>本页的插件包会随发布重新打包，固定链接 ' +
            '<a href="' + esc(ext.latest || 'download/hibane-subs-latest.zip') + '">hibane-subs-latest.zip</a>' +
            ' 永远指向最新版。</p>' +
        '</div>' +
        '<div class="box warn"><h3>先说清楚</h3>' +
          '<p><b>只在 B 站视频页生效</b>，直播间里不叠（直播时用的是另一套实时字幕）。</p>' +
          '<p><b>时间是推出来的，不是打点打出来的。</b>老场次的记录时间是「这句话翻完」的时刻，' +
            '导出时按语速把句长估回去，误差中位 0.7 秒左右——听感上够用，做逐帧校对不够。</p>' +
          '<p>字幕内容就是逐字稿原文，<b>机器识别与机器翻译；11 月 16 日起的场次已逐条人工校对，更早场次未校对</b>，仍可能有错误，别当引文用。' +
            '插件是个人做的，与主播本人、B 站官方无关。</p>' +
        '</div>';
      }
    }
  ];

  function toolEntry(t) {
    var facts = (t.facts ? t.facts() : []).slice(0, 3).map(function (f) {
      return '<li><b>' + f[0] + '</b><span>' + f[1] + '</span></li>';
    }).join('');
    return '<article class="dentry tentry">' +
      '<div class="dhead">' +
        '<div class="twho">' +
          '<img class="tool-icon" src="' + t.icon + '" alt="" width="48" height="48" decoding="async">' +
          '<div class="tool-name"><b>' + esc(t.name) + '</b><em>' + esc(t.kind) + '</em></div>' +
        '</div>' +
        '<div class="tlinks"><a class="topen" href="#/tools/' + t.id + '">查看详情 →</a></div>' +
      '</div>' +
      '<p class="dsum">' + esc(t.summary) + '</p>' +
      (facts ? '<ul class="tool-facts tmini">' + facts + '</ul>' : '') +
    '</article>';
  }

  function renderTools(id) {
    var one = id ? TOOLS.filter(function (t) { return t.id === id; })[0] : null;
    // 键对不上（旧链接、手改过的地址）就退回列表，别给一个空页面
    if (id && !one) { location.replace('#/tools'); return; }

    if (one) {
      app.innerHTML =
        '<section class="about tools">' +
          '<div class="kicker">TOOLS</div>' +
          '<p class="tback"><a href="#/tools">← 全部工具</a></p>' +
          '<h2>' + esc(one.name) + '<span class="accent">·</span>' + esc(one.kind) + '</h2>' +
          one.page(one) +
        '</section>';
    } else {
      app.innerHTML =
        '<section class="hero hero-sm">' +
          '<div class="hero-copy">' +
            '<div class="kicker">TOOLS</div>' +
            '<h1>工具</h1>' +
            '<p class="lead">当前共 ' + TOOLS.length + ' 件。</p>' +
          '</div>' +
        '</section>' +
        '<div class="dlist">' + TOOLS.map(toolEntry).join('') +
          (TOOLS.length ? '' : '<div class="empty">还没有工具。</div>') + '</div>';
    }
    setFoot();
  }

  /* ---------- about ---------- */
  function renderAbout() {
    var diaryN = D.meta.diaryCount || (D.diary ? D.diary.length : 0);
    app.innerHTML =
      '<section class="about">' +
        '<div class="kicker">ABOUT THIS ARCHIVE</div>' +
        '<h2>关于<span class="accent">这份存档</span></h2>' +
        '<p class="about-lead">把 <b>' + esc(D.meta.streamer) + '</b> 直播里说过的话留下来：逐字稿、每场日记、' +
          '值得单独记下的段落。中日对照，按场次整理，可全文检索。</p>' +
        '<div class="facts">' +
          '<div><b>' + D.meta.sessionCount + '</b><span>场直播</span></div>' +
          '<div><b>' + num(D.meta.total) + '</b><span>条记录</span></div>' +
          '<div><b>' + D.meta.quoteCount + '</b><span>段摘录</span></div>' +
          '<div><b>' + diaryN + '</b><span>篇日记</span></div>' +
          '<div class="range">' + D.meta.firstDate + ' — ' + D.meta.lastDate + '</div>' +
        '</div>' +

        '<div class="box"><h3>主播与直播</h3>' +
          '<p>主播 <b>' + esc(D.meta.streamer) + '</b>　B 站主页：' +
            '<a href="https://space.bilibili.com/2094031249" target="_blank" rel="noopener">space.bilibili.com/2094031249</a></p>' +
          '<p>直播间：' +
            '<a href="https://live.bilibili.com/22748536" target="_blank" rel="noopener">live.bilibili.com/22748536</a></p>' +
          '<p>本站是个人维护的非官方记录，与主播本人、B 站官方均无关。</p>' +
        '</div>' +

        '<div class="box"><h3>这里有什么</h3>' +
          '<p><b>逐字稿</b>　按场次排列的中日对照记录，可全文检索。</p>' +
          '<p><b>日记</b>　每场一篇，记当晚的话题、观众来信与随口讲到的小知识。</p>' +
          '<p><b>摘录</b>　从各场挑出的完整段落，保留中日原文与语境说明。</p>' +
        '</div>' +

        '<div class="box warn"><h3>引用前请留意</h3>' +
          '<p>逐字稿与译文由自动识别、自动翻译生成；11 月 16 日起的场次已逐条人工校对，更早场次尚未逐条校对，仍可能有误听、断句和专名偏差。' +
            '逐字稿适合当检索索引，不是可靠引文。</p>' +
          '<p>日记与摘录经人工整理，仍可能与原话有出入。要确认她到底说了什么，请回原直播核对。</p>' +
          '<p>直播内容的著作权归主播所有。若主播或相关权利人要求，本站会删除相应内容。</p>' +
        '</div>' +
      '</section>';
    setFoot();
  }

  route();
})();

/* ---------- 氛围视差 / 伪 3D（性能版） ----------
   鼠标位置经一阶低通后，每帧只写几个 fixed 层的 inline transform：
   · 不写 :root 自定义属性 —— 那会让整棵文档树每帧重新计算样式；
   · 光晕用位移而不是改渐变中心 —— 后者每帧都要重绘整屏渐变；
   · 卡片倾斜每 6 帧更新一次（自带 .22s transition，肉眼无差别）；
   · 变换只落在 will-change:transform 的合成层上，不触发布局与重绘。
   精确指针 + 未开启「减少动态效果」时才运行，鼠标停下即停 rAF。 */
(function () {
  'use strict';
  var mq = window.matchMedia ? window.matchMedia.bind(window) : null;
  var reduce = mq && mq('(prefers-reduced-motion: reduce)').matches;
  var fine = mq && mq('(hover: hover) and (pointer: fine)').matches;
  if (reduce || !fine) return;

  var amb = document.querySelector('.ambient');
  if (!amb) return;
  var far = amb.querySelector('.amb-far');
  var scene = amb.querySelector('.amb-scene');
  var light = amb.querySelector('.amb-light');
  var embers = amb.querySelector('.amb-embers');

  // 首页卡片由 hash 路由动态渲染，DOM 换掉后要重新抓引用
  var cards = [];
  function collect() {
    cards = [];
    var a = document.querySelector('.hero-links');
    var b = document.querySelector('.hs-tilt');
    if (a) cards.push({ el: a, k: -0.3 });
    if (b) cards.push({ el: b, k: -0.45 });
  }
  collect();
  var appEl = document.getElementById('app');
  if (appEl && window.MutationObserver) {
    new MutationObserver(collect).observe(appEl, { childList: true });
  } else {
    window.addEventListener('hashchange', collect);
  }

  var W = window.innerWidth, H = window.innerHeight;
  window.addEventListener('resize', function () {
    W = window.innerWidth; H = window.innerHeight;
  }, { passive: true });

  var tx = 0, ty = 0, cx = 0, cy = 0, raf = 0, tick = 0;
  function f(n) { return n.toFixed(2); }

  function apply() {
    var dx = -cx * 16, dy = -cy * 11, rx = -cy * 2.6, ry = cx * 3.4;
    scene.style.transform =
      'perspective(1100px) rotateX(' + f(rx * 0.55) + 'deg) rotateY(' + f(ry * 0.55) + 'deg) ' +
      'translate3d(' + f(dx) + 'px,' + f(dy) + 'px,0) scale(1.08)';
    far.style.transform =
      'perspective(1400px) rotateX(' + f(rx * 0.3) + 'deg) rotateY(' + f(ry * 0.3) + 'deg) ' +
      'translate3d(' + f(dx * 0.32) + 'px,' + f(dy * 0.26) + 'px,0) scale(1.2)';
    embers.style.transform = 'translate3d(' + f(dx * 3) + 'px,' + f(dy * 2) + 'px,0)';
    light.style.transform = 'translate3d(' + f(cx * 0.48 * W) + 'px,' + f(cy * 0.42 * H) + 'px,0)';

    // 卡片降频：约 100ms 一次，中间由 CSS transition 补齐
    if (++tick % 6 === 0) {
      for (var i = 0; i < cards.length; i++) {
        cards[i].el.style.transform =
          'perspective(900px) rotateX(' + f(rx * cards[i].k) + 'deg) rotateY(' + f(ry * cards[i].k) + 'deg)';
      }
    }
  }
  function frame() {
    cx += (tx - cx) * 0.13;
    cy += (ty - cy) * 0.13;
    apply();
    if (Math.abs(tx - cx) > 0.005 || Math.abs(ty - cy) > 0.005) raf = requestAnimationFrame(frame);
    else raf = 0;
  }
  window.addEventListener('pointermove', function (e) {
    tx = (e.clientX / W - 0.5) * 2;
    ty = (e.clientY / H - 0.5) * 2;
    if (!raf) raf = requestAnimationFrame(frame);
  }, { passive: true });
})();

/* ---------- 悬浮背景音乐 ----------
   默认循环播放；浏览器拦下自动播放时，等页面第一次点击/按键再起播。
   折叠状态、音量、循环开关与用户主动暂停都记在 localStorage。 */
(function () {
  'use strict';
  var box = document.getElementById('bgm');
  var audio = document.getElementById('bgmAudio');
  if (!box || !audio) return;
  function $(id) { return document.getElementById(id); }
  var fold = $('bgmFold'), panel = $('bgmPanel'), play = $('bgmPlay'), loop = $('bgmLoop');
  var bar = $('bgmBar'), vol = $('bgmVol'), now = $('bgmNow'), dur = $('bgmDur');
  var chev = fold.querySelector('.bgm-chev'), artist = box.querySelector('.bgm-meta em');
  var KEY = 'hibane-bgm-v1';
  var st = { collapsed: false, paused: false, vol: 40, loop: true };
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (saved && typeof saved === 'object') {
    st.collapsed = !!saved.collapsed;
    st.paused = !!saved.paused;
    st.loop = saved.loop !== false;
    if (typeof saved.vol === 'number') st.vol = Math.max(0, Math.min(100, saved.vol));
  } else if (window.innerWidth < 720) {
    st.collapsed = true;                 // 窄屏先收起，别压住正文
  }

  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fill(el, ratio) { el.style.setProperty('--p', (ratio * 100).toFixed(2) + '%'); }

  var waiting = null;
  function disarm() {
    if (!waiting) return;
    window.removeEventListener('pointerdown', waiting);
    window.removeEventListener('keydown', waiting);
    waiting = null;
    box.classList.remove('is-waiting');
    if (artist) artist.textContent = 'MATSU';
  }
  function arm() {
    if (waiting) return;
    waiting = function (e) {
      // 点播放器本身不算「页面交互」，交给对应按钮自己处理
      if (e.target && e.target.closest && e.target.closest('.bgm')) return;
      disarm();
      if (!st.paused) start();
    };
    window.addEventListener('pointerdown', waiting);
    window.addEventListener('keydown', waiting);
    box.classList.add('is-waiting');
    if (artist) artist.textContent = '点按页面任意处开始播放';
  }
  function start() {
    disarm();
    try {
      var p = audio.play();
      if (p && p.catch) p.catch(function () { if (!st.paused) arm(); });
    } catch (e) { if (!st.paused) arm(); }
  }

  function paint() {
    box.classList.toggle('is-collapsed', st.collapsed);
    box.classList.toggle('is-playing', !audio.paused);
    fold.setAttribute('aria-expanded', String(!st.collapsed));
    chev.textContent = st.collapsed ? '<' : '>';
    fold.title = st.collapsed ? '展开播放器' : '收起播放器';
    panel.setAttribute('aria-hidden', String(st.collapsed));
    if ('inert' in panel) panel.inert = st.collapsed;
    play.setAttribute('aria-label', audio.paused ? '播放' : '暂停');
    play.setAttribute('aria-pressed', String(!audio.paused));
    loop.classList.toggle('is-on', st.loop);
    loop.setAttribute('aria-pressed', String(st.loop));
    audio.loop = st.loop;
    audio.volume = st.vol / 100;
    vol.value = st.vol;
    fill(vol, st.vol / 100);
  }
  function tick() {
    var d = audio.duration;
    now.textContent = fmt(audio.currentTime);
    if (d && isFinite(d)) {
      dur.textContent = fmt(d);
      bar.value = Math.round(audio.currentTime / d * 1000);
      fill(bar, audio.currentTime / d);
    }
  }

  fold.addEventListener('click', function () { st.collapsed = !st.collapsed; save(); paint(); });
  play.addEventListener('click', function () {
    if (audio.paused) { st.paused = false; save(); start(); }
    else { st.paused = true; save(); audio.pause(); }
    paint();
  });
  loop.addEventListener('click', function () { st.loop = !st.loop; save(); paint(); });
  vol.addEventListener('input', function () {
    st.vol = Number(vol.value);
    audio.volume = st.vol / 100;
    fill(vol, st.vol / 100);
    save();
  });
  bar.addEventListener('input', function () {
    var d = audio.duration;
    if (!d || !isFinite(d)) return;
    audio.currentTime = Number(bar.value) / 1000 * d;
    fill(bar, Number(bar.value) / 1000);
    now.textContent = fmt(audio.currentTime);
  });
  audio.addEventListener('timeupdate', tick);
  audio.addEventListener('loadedmetadata', tick);
  audio.addEventListener('play', paint);
  audio.addEventListener('pause', paint);

  paint();
  tick();
  fill(bar, 0);
  if (!st.paused) start();
})();

/* ---------- 全站搜索 ----------
   独立于 hash 路由的浮层：一次遍历 window.DATA，跨逐字稿 / 摘录 / 日记 / 场次
   做不区分大小写的子串匹配。逐字稿一万多条，输入做 120ms 防抖、每组只渲染
   前几条，避免边打字边拼大量 DOM；结果直接跳到对应页面并带上定位参数。 */
(function () {
  'use strict';
  var D = window.DATA;
  var openBtn = document.getElementById('searchOpen');
  var dlg = document.getElementById('searchDlg');
  var mask = document.getElementById('searchMask');
  var input = document.getElementById('searchInput');
  var box = document.getElementById('searchResults');
  var cnt = document.getElementById('searchCount');
  var scope = document.getElementById('searchScope');
  if (!D || !openBtn || !dlg || !mask || !input || !box) return;

  var LIMIT = { rec: 8, quote: 6, diary: 5, session: 4 };
  var items = [], sel = -1, timer = 0;

  function escS(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function markEsc(s, q) {
    var out = '', lower = s.toLowerCase(), ql = q.toLowerCase(), p = 0, i;
    while (ql && (i = lower.indexOf(ql, p)) >= 0) {
      out += s.slice(p, i) + '<mark>' + s.slice(i, i + ql.length) + '</mark>';
      p = i + ql.length;
    }
    return out + s.slice(p);
  }
  function snip(text, q, len) {
    var s = String(text || '').replace(/\s+/g, ' ');
    var i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return s.slice(0, len);
    var from = Math.max(0, i - 22);
    return (from ? '…' : '') + s.slice(from, from + len) + (s.length > from + len ? '…' : '');
  }
  function has(text, ql) { return String(text || '').toLowerCase().indexOf(ql) >= 0; }
  function sessOf(i) { return D.sessions[i] || { date: '', dateLong: '', week: '' }; }
  function dText(d) { return [d.title, d.tagline, d.summary, (d.body || []).join(' ')].join(' '); }

  if (scope) {
    scope.textContent = D.meta.total.toLocaleString('en-US') + ' 条逐字稿 · ' +
      D.meta.quoteCount + ' 段摘录 · ' + D.meta.diaryCount + ' 篇日记';
  }

  function collect(q) {
    var ql = q.toLowerCase(), groups = [], recTotal = 0;

    var recRows = [];
    for (var i = D.records.length - 1; i >= 0; i--) {   // 新场次优先
      var r = D.records[i];
      if (has(r.jp, ql) || has(r.zh, ql)) {
        recTotal++;
        if (recRows.length < LIMIT.rec) {
          var s = sessOf(r.s);
          // 命中日文就主显示日文，命中译文就主显示译文，避免高亮落在看不见的地方
          var main = has(r.zh, ql) ? r.zh : (r.jp || r.zh || '');
          var sub = has(r.zh, ql) ? (r.jp || '') : (r.zh || '');
          recRows.push({
            label: '逐字稿', meta: s.date + ' ' + r.t,
            text: snip(main, q, 68), sub: sub ? snip(sub, q, 68) : '',
            href: '#/archive/' + r.s + '?t=' + encodeURIComponent(r.t)
          });
        }
      }
    }
    if (recTotal) groups.push({ name: '逐字稿', total: recTotal, rows: recRows });

    var qRows = [], qTotal = 0;
    D.quotes.forEach(function (x) {
      if (!has(x.jp + ' ' + x.zh + ' ' + x.note + ' ' + x.tag, ql)) return;
      qTotal++;
      if (qRows.length < LIMIT.quote) {
        var qmain = has(x.zh, ql) ? x.zh : (has(x.jp, ql) ? x.jp : x.zh);
        var qsub = qmain === x.zh ? x.jp : x.zh;
        qRows.push({
          label: '摘录 · ' + x.tag, meta: x.date + ' ' + x.t,
          text: snip(qmain, q, 68), sub: snip(qsub, q, 68),
          href: '#/quotes?focus=' + encodeURIComponent(x.id)
        });
      }
    });
    if (qTotal) groups.push({ name: '摘录', total: qTotal, rows: qRows });

    var dRows = [], dTotal = 0;
    D.diary.forEach(function (d) {
      if (!has(dText(d), ql)) return;
      dTotal++;
      if (dRows.length < LIMIT.diary) dRows.push({
        label: '日记', meta: d.dateLong + ' ' + d.week,
        text: snip(d.title + ' — ' + (d.summary || (d.body || [])[0] || ''), q, 68),
        sub: '', href: '#/diary/' + encodeURIComponent(d.key)
      });
    });
    if (dTotal) groups.push({ name: '日记', total: dTotal, rows: dRows });

    var sRows = [], sTotal = 0;
    D.sessions.forEach(function (s) {
      if (!has(s.date + ' ' + s.dateLong + ' ' + s.week + ' ' + s.start + ' ' + s.end, ql)) return;
      sTotal++;
      if (sRows.length < LIMIT.session) sRows.push({
        label: '场次', meta: s.week,
        text: s.dateLong + ' · ' + s.start + ' – ' + s.end + ' · ' + s.count + ' 条记录',
        sub: '', href: '#/archive/' + s.id
      });
    });
    if (sTotal) groups.push({ name: '场次', total: sTotal, rows: sRows });

    return { groups: groups, recTotal: recTotal };
  }

  function render(q) {
    items = []; sel = -1;
    if (!q) {
      box.innerHTML = '<div class="sd-empty">输入关键词，检索逐字稿、摘录、日记与场次。</div>';
      if (cnt) cnt.textContent = '输入关键词开始检索';
      return;
    }
    var res = collect(q), html = '', total = 0;
    res.groups.forEach(function (g) {
      total += g.total;
      html += '<div class="sd-group"><div class="sd-gtitle"><b>' + escS(g.name) + '</b>' +
        '<span>' + g.total + ' 条' + (g.total > g.rows.length ? ' · 显示前 ' + g.rows.length + ' 条' : '') + '</span></div>';
      g.rows.forEach(function (row) {
        var idx = items.length;
        items.push(row);
        html += '<button class="sd-item" data-i="' + idx + '" type="button">' +
          '<div class="si-top"><em>' + escS(row.label) + '</em>' + escS(row.meta) + '</div>' +
          '<div class="si-text">' + markEsc(escS(row.text), q) + '</div>' +
          (row.sub ? '<div class="si-sub">' + markEsc(escS(row.sub), q) + '</div>' : '') + '</button>';
      });
      html += '</div>';
    });
    if (res.recTotal > LIMIT.rec) {
      var k = items.length;
      items.push({ href: '#/archive/' + D.sessions[D.sessions.length - 1].id + '?q=' + encodeURIComponent(q) });
      html += '<div class="sd-group"><button class="sd-item" data-i="' + k + '" type="button">' +
        '<div class="si-text">在逐字稿里查看全部 ' + res.recTotal + ' 条结果 →</div></button></div>';
    }
    box.innerHTML = html || '<div class="sd-empty">没有找到「' + escS(q) + '」。</div>';
    if (cnt) cnt.textContent = '共 ' + total + ' 条结果';
  }

  function highlight() {
    var els = box.querySelectorAll('.sd-item');
    for (var i = 0; i < els.length; i++) els[i].classList.toggle('on', i === sel);
    if (sel >= 0 && els[sel]) els[sel].scrollIntoView({ block: 'nearest' });
  }
  function open() {
    dlg.hidden = false; mask.hidden = false;
    document.body.classList.add('search-open');
    input.value = ''; render('');
    setTimeout(function () { input.focus(); }, 0);
  }
  function close() {
    dlg.hidden = true; mask.hidden = true;
    document.body.classList.remove('search-open');
    input.blur();
  }
  function go(it) {
    close();
    location.hash = it.href;
  }

  openBtn.addEventListener('click', open);
  mask.addEventListener('click', close);
  var closeBtn = document.getElementById('searchClose');
  if (closeBtn) closeBtn.addEventListener('click', close);
  input.addEventListener('input', function () {
    clearTimeout(timer);
    var v = input.value.trim();
    timer = setTimeout(function () { render(v); }, 120);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      sel = e.key === 'ArrowDown' ? (sel + 1) % items.length : (sel - 1 + items.length) % items.length;
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var it = items[sel >= 0 ? sel : 0];
      if (it) go(it);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  box.addEventListener('click', function (e) {
    var b = e.target.closest('.sd-item');
    if (!b) return;
    var it = items[parseInt(b.getAttribute('data-i'), 10)];
    if (it) go(it);
  });
  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      dlg.hidden ? open() : close();
      return;
    }
    if (e.key === 'Escape' && !dlg.hidden) { close(); return; }
    if (e.key !== '/' || e.metaKey || e.ctrlKey || !dlg.hidden) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA/.test(tag)) return;
    if (document.getElementById('q')) return;   // 存档页有自己的搜索框
    e.preventDefault();
    open();
  });
})();

/* ---------- 回到顶部 ----------
   滚过一屏才出现（首屏不占位），点击回顶；开关状态用 class + aria 同步，
   隐藏时不进 Tab 序列。滚动监听 passive，并合到一次 rAF 里处理。 */
(function () {
  'use strict';
  var btn = document.getElementById('toTop');
  if (!btn) return;
  var quiet = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var THRESHOLD = 480;
  var shown = false, ticking = false;

  function setShown(on) {
    if (on === shown) return;
    shown = on;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-hidden', String(!on));
    btn.tabIndex = on ? 0 : -1;
  }
  function update() {
    ticking = false;
    setShown((window.pageYOffset || document.documentElement.scrollTop) > THRESHOLD);
  }
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  }, { passive: true });

  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: quiet ? 'auto' : 'smooth' });
    btn.blur();   // 回顶后按钮会隐藏，焦点别留在看不见的元素上
  });

  update();
})();
