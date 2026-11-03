(function () {
  'use strict';

  var D = window.DATA;
  var app = document.getElementById('app');

  var state = { q: '', hideEmpty: false, tag: '全部' };

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
    return { view: seg[0] || 'home', sid: seg[1] != null ? parseInt(seg[1], 10) : null, q: query };
  }

  function setNav(view) {
    document.querySelectorAll('.nav a').forEach(function (a) {
      a.classList.toggle('on', a.getAttribute('data-nav') === view);
    });
  }

  function route() {
    var r = parseHash();
    state.q = '';
    state.hideEmpty = false;
    if (r.view === 'quotes') { setNav('quotes'); renderQuotes(); }
    else if (r.view === 'archive') { setNav('archive'); renderArchive(r.sid, r.q.t); }
    else if (r.view === 'diary') { setNav('diary'); renderDiary(); }
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
  function renderHome() {
    var last = D.sessions[D.sessions.length - 1];
    var lastQuotes = D.quotes.filter(function (q) { return q.s === last.id; }).slice(0, 3);
    var maxT = topicCount[topicRank[0]];
    var latestDiary = (D.diary && D.diary.length) ? D.diary[0] : null;

    var bars = topicRank.slice(0, 12).map(function (k) {
      var i = parseInt(k, 10);
      // 平方根刻度：最多与最少相差近百倍，线性刻度会让除首项外的柱子几乎不可见
      var w = Math.sqrt(topicCount[k] / maxT) * 100;
      return '<div class="tbar"><span class="name">' + esc(tname(i)) + '</span>' +
        '<span class="track"><i class="fill" style="width:' + w.toFixed(1) +
        '%;background:' + tcolor(i) + '"></i></span>' +
        '<span class="n">' + topicCount[k] + '</span></div>';
    }).join('');

    var mini = lastQuotes.map(function (q) {
      // 摘录是整段对话，首页只摘要她自己的那句：去掉开头的观众提问，再截断
      var lines = q.zh.split('\n').filter(function (l, i) {
        return !(i === 0 && l.charAt(0) === '「');
      });
      var txt = lines.join(' ').replace(/^——/, '');
      if (txt.length > 92) txt = txt.slice(0, 92).replace(/[，、]$/, '') + '…';
      return '<div class="qmini"><p>' + esc(txt) + '</p><span>' + esc(q.t) + '</span></div>';
    }).join('');

    app.innerHTML =
      '<section class="hero">' +
        '<div class="kicker">LIVE TRANSCRIPT ARCHIVE</div>' +
        '<h1><span class="accent">' + esc(D.meta.streamer) + '</span><span class="thin">的</span>深夜<span class="thin">。</span></h1>' +
        '<p class="lead">' + D.meta.sessionCount + ' 场直播的逐字稿，从 <b>' + D.meta.firstDate + '</b> 到 <b>' + D.meta.lastDate +
        '</b>，共 ' + num(D.meta.total) + ' 条。内容包括夜间杂谈、SC 回应、问答与科普段落；' +
        '全部中日对照，可按场次浏览，也可全文检索。</p>' +
        '<div class="stats">' +
          '<div class="stat"><b>' + D.meta.sessionCount + '<i>场</i></b><span>直播记录</span></div>' +
          '<div class="stat"><b>' + num(D.meta.total) + '<i>条</i></b><span>逐字记录</span></div>' +
          '<div class="stat"><b>' + D.meta.quoteCount + '<i>段</i></b><span>摘录段落</span></div>' +
          '<div class="stat"><b>' + D.topics.length + '<i>类</i></b><span>话题标签</span></div>' +
        '</div>' +
        '<div class="hero-cta">' +
          '<a class="btn primary" href="#/quotes">读摘录 →</a>' +
          '<a class="btn" href="#/archive">进档案库</a>' +
        '</div>' +
        '<div class="notice">' +
          '<h4>这是机器翻译，不是人工同传</h4>' +
          '<p>这里的每一条译文，都由本机运行的小型模型（Qwen3.5-4B）在直播当时逐条自动生成，' +
          '没有人工同传参与，也不涉及任何付费翻译服务，从头到尾没有人校对过。' +
          '机器确实会错：抽检 80 条，15 条意思明显偏差，个别译反，半句和专名最容易错。' +
          '<b>日记与摘录经人工核对，可作引用；逐字稿只作索引，要确认她到底说了什么，请以原直播为准。</b>' +
          ' <a href="#/about">技术说明与误差来源 →</a></p>' +
        '</div>' +
      '</section>' +

      '<section class="sec">' +
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
          '<div class="latest-r">' + (mini || '<div class="qmini"><p>这一场暂无摘录。</p></div>') + '</div>' +
        '</div>' +
      '</section>' +

      '<section class="sec">' +
        '<div class="sec-head"><h2><i>02</i>今日直播</h2><a class="more" href="#/diary">全部日记 →</a></div>' +
        (latestDiary ? latestDiaryCard(latestDiary) : '<div class="empty">还没有日记。</div>') +
      '</section>' +

      '<section class="sec">' +
        '<div class="sec-head"><h2><i>03</i>话题分布</h2><span class="more">' + num(D.meta.total) + ' 条记录的关键词归类</span></div>' +
        '<div class="tbars">' + bars + '</div>' +
      '</section>' +

      '<section class="sec">' +
        '<div class="sec-head"><h2><i>04</i>全部场次</h2><a class="more" href="#/archive">档案库 →</a></div>' +
        '<div class="qgrid">' + D.sessions.slice().reverse().map(sessionCard).join('') + '</div>' +
      '</section>';

    document.getElementById('footMeta').textContent = '更新于 ' + D.meta.generated;
  }

  /* ---------- diary ---------- */
  function latestDiaryCard(d) {
    var qn = D.quotes.filter(function (q) { return q.s === d.s; }).length;
    return '<article class="dcard">' +
      '<div class="dhead">' +
        '<div class="ddate">' + esc(d.dateLong) + ' <em>' + esc(d.week) + '</em></div>' +
        '<div class="dinfo">' + esc(d.start) + ' – ' + esc(d.end) + ' · ' + d.count + ' 条记录' +
          (qn ? ' · ' + qn + ' 段摘录' : '') + '</div>' +
      '</div>' +
      '<h3 class="dtitle">' + esc(d.title) + '</h3>' +
      (d.tagline ? '<div class="dtag">' + esc(d.tagline) + '</div>' : '') +
      '<p class="dexcerpt">' + esc(d.body[0] || '') + '</p>' +
      '<div class="dlinks"><a href="#/diary">读全文 →</a><a href="#/archive/' + d.s + '">逐字稿 →</a></div>' +
    '</article>';
  }

  function renderDiary() {
    var list = D.diary || [];
    var html = list.map(function (d) {
      var qn = D.quotes.filter(function (q) { return q.s === d.s; }).length;
      return '<article class="dentry">' +
        '<div class="dhead">' +
          '<div class="ddate">' + esc(d.dateLong) + ' <em>' + esc(d.week) + '</em></div>' +
          '<div class="dinfo">' + esc(d.start) + ' – ' + esc(d.end) + ' · ' + d.dur + ' 分钟 · ' + d.count + ' 条记录' +
            (qn ? ' · ' + qn + ' 段摘录' : '') + '</div>' +
        '</div>' +
        '<h3 class="dtitle">' + esc(d.title) + '</h3>' +
        (d.tagline ? '<div class="dtag">' + esc(d.tagline) + '</div>' : '') +
        '<div class="dbody">' + d.body.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div>' +
        '<div class="dlinks"><a href="#/archive/' + d.s + '">看这一场的逐字稿 →</a></div>' +
      '</article>';
    }).join('');

    app.innerHTML =
      '<section class="hero" style="padding-bottom:26px">' +
        '<div class="kicker">STREAM DIARY</div>' +
        '<h1 style="font-size:clamp(38px,5.4vw,64px)">今日<span class="thin">，</span>播了<span class="accent">什么</span></h1>' +
        '<p class="lead">每场直播后整理的记录摘要：聊了什么、回应了谁、讲了哪些冷知识。' +
        '只做事实性归纳，不做评价；日记之外随时可以点进对应场次的逐字稿核对原文。当前共 ' +
        list.length + ' 篇。</p>' +
      '</section>' +
      '<div class="dlist">' + (html || '<div class="empty">还没有日记。</div>') + '</div>';
    document.getElementById('footMeta').textContent = '更新于 ' + D.meta.generated;
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
      '<div class="meta"><span>' + s.count + ' 条 · ' + s.dur + ' 分钟</span><span>阅读 →</span></div>' +
      '</a>';
  }

  /* ---------- quotes ---------- */
  function renderQuotes() {
    var tags = ['全部'];
    D.quotes.forEach(function (q) { if (tags.indexOf(q.tag) < 0) tags.push(q.tag); });
    var counts = {};
    D.quotes.forEach(function (q) { counts[q.tag] = (counts[q.tag] || 0) + 1; });

    var chips = tags.map(function (t) {
      var n = t === '全部' ? D.quotes.length : counts[t];
      return '<button class="chip' + (t === state.tag ? ' on' : '') + '" data-tag="' + esc(t) + '">' +
        esc(t) + '<span class="n">' + n + '</span></button>';
    }).join('');

    app.innerHTML =
      '<section class="hero" style="padding-bottom:30px">' +
        '<div class="kicker">TRANSCRIPT EXCERPTS</div>' +
        '<h1 style="font-size:clamp(38px,5.4vw,64px)">摘录<span class="thin">，</span><span class="accent">' + D.meta.quoteCount + '</span> 段</h1>' +
        '<p class="lead">从 ' + num(D.meta.total) + ' 条记录中选出 ' + D.meta.quoteCount + ' 段，按话题分类。' +
        '每段都保留引出它的那句话或那件事，脱离上下文不容易读懂的，宁可长一点也不截断。' +
        '文本以语音识别稿为基础，只做断句、明显错字与语序错乱的校正，不做润色；原始记录见对应场次的逐字稿。</p>' +
      '</section>' +
      '<div class="filters" id="filters">' + chips + '</div>' +
      '<div class="qgrid" id="qlist"></div>';

    document.getElementById('filters').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      state.tag = b.getAttribute('data-tag');
      document.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('on', c.getAttribute('data-tag') === state.tag);
      });
      renderQuoteList();
    });
    renderQuoteList();
    document.getElementById('footMeta').textContent = '更新于 ' + D.meta.generated;
  }

  function renderQuoteList() {
    var list = D.quotes.filter(function (q) { return state.tag === '全部' || q.tag === state.tag; });
    var html = list.map(function (q) {
      return '<article class="qcard' + (q.tag === '劝解' || q.tag === '人生' ? ' big' : '') + '">' +
        '<span class="tag">' + esc(q.tag) + '</span>' +
        '<p class="jp">' + esc(q.jp) + '</p>' +
        '<p class="zh">' + esc(q.zh) + '</p>' +
        (q.note ? '<p class="note">' + esc(q.note) + '</p>' : '') +
        '<div class="meta">' +
          '<a href="#/archive/' + q.s + '?t=' + encodeURIComponent(q.t) + '">' + esc(q.date.replace('-', '.')) + ' ' + esc(q.t) + ' →</a>' +
          '<button class="copy" data-id="' + q.id + '">复制</button>' +
        '</div>' +
      '</article>';
    }).join('');
    document.getElementById('qlist').innerHTML = html || '<div class="empty">这个标签下还没有摘录。</div>';
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

  /* ---------- archive ---------- */
  function renderArchive(sid, jumpT) {
    if (sid == null || !D.sessions[sid]) sid = D.sessions.length - 1;
    var cur = sess(sid);
    var startH = parseInt(cur.start.split(':')[0], 10);
    var startM = startH * 60 + parseInt(cur.start.split(':')[1], 10);

    // 跨零点场次：把 00:xx 视为 24:xx，保证时间比较正确
    function absMin(hms) {
      var p = hms.split(':');
      var m = parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
      if (startH >= 12 && m < 12 * 60) m += 1440;
      return m;
    }

    function jump(t, flash) {
      var rows = document.querySelectorAll('#trlist .tr');
      var want = absMin(t), target = null;
      for (var i = 0; i < rows.length; i++) {
        if (absMin(rows[i].getAttribute('data-t')) >= want) { target = rows[i]; break; }
      }
      if (!target) return;
      var y = target.getBoundingClientRect().top + window.pageYOffset - 130;
      window.scrollTo({ top: y, behavior: 'smooth' });
      if (flash) {
        target.classList.add('hit');
        setTimeout(function () { target.classList.remove('hit'); }, 2600);
      }
    }

    var side = D.sessions.map(function (s) {
      var mini = s.ribbon.slice(0, 60).map(function (t) {
        return '<i style="flex:1;background:' + (t < 0 ? '#2a2521' : tcolor(t)) + '"></i>';
      }).join('');
      return '<button class="sitem' + (s.id === sid ? ' on' : '') + '" data-sid="' + s.id + '">' +
        '<span class="d">' + esc(s.date.replace('-', '.')) + ' ' + esc(s.week) + '</span>' +
        '<span class="m">' + esc(s.start) + '–' + esc(s.end) + ' · ' + s.count + ' 条</span>' +
        '<span class="mini">' + mini + '</span></button>';
    }).join('');

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

    app.innerHTML =
      '<div class="arch">' +
        '<aside class="slist">' + side + '</aside>' +
        '<div class="col">' +
          '<div class="shead">' +
            '<h2>' + esc(cur.date.replace('-', '.')) + ' <small>' + esc(cur.week) + '</small></h2>' +
            '<div class="meta"><span><b>' + esc(cur.start) + ' – ' + esc(cur.end) + '</b></span>' +
              '<span><b>' + cur.count + '</b> 条记录</span><span>约 <b>' + cur.dur + '</b> 分钟</span>' +
              (qn ? '<span><b>' + qn + '</b> 段摘录</span>' : '') +
              '<span>' + topT + '</span></div>' +
          '</div>' +
          '<div class="arch-note">以下是<b>机器识别 + 机器翻译</b>的原始记录，逐条自动生成、未经校对。' +
            '错字、错译、把话译反的情况都有，只作检索用——引用前请回原直播核对。</div>' +
          '<div class="ribbon-wrap"><div class="ribbon">' + ribbon + '</div>' +
            '<div class="ribbon-legend">' + legend + '</div></div>' +
          (toc ? '<div class="toc">' + toc + '</div>' : '') +
          '<div class="tools">' +
            '<label class="search"><span class="ico">⌕</span><input id="q" placeholder="搜索这一场，或直接全库检索…" autocomplete="off"></label>' +
            '<label class="toggle"><input type="checkbox" id="hideEmpty"' + (state.hideEmpty ? ' checked' : '') + '>只看有译文</label>' +
          '</div>' +
          '<div class="count" id="count"></div>' +
          '<div class="trlist" id="trlist"></div>' +
        '</div>' +
      '</div>';

    var input = document.getElementById('q');
    input.addEventListener('input', function () {
      state.q = input.value.trim();
      renderList(sid);
    });
    document.getElementById('hideEmpty').addEventListener('change', function (e) {
      state.hideEmpty = e.target.checked;
      renderList(sid);
    });
    document.querySelector('.slist').addEventListener('click', function (e) {
      var b = e.target.closest('.sitem');
      if (b) location.hash = '#/archive/' + b.getAttribute('data-sid');
    });
    var tocEl = document.querySelector('.toc');
    if (tocEl) tocEl.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) jump(b.getAttribute('data-jump'));
    });

    renderList(sid);
    if (jumpT) setTimeout(function () { jump(jumpT, true); }, 80);
    document.getElementById('footMeta').textContent = '更新于 ' + D.meta.generated;
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

  /* ---------- about ---------- */
  function renderAbout() {
    app.innerHTML =
      '<section class="about">' +
        '<div class="kicker">ABOUT THIS ARCHIVE</div>' +
        '<h2>关于这份档案</h2>' +
        '<p>这里收录的是 <b>' + esc(D.meta.streamer) + '</b> 在 B 站直播时的中日对照记录，' +
        '时间范围 <b>' + D.meta.firstDate + ' — ' + D.meta.lastDate + '</b>，共 <b>' + D.meta.sessionCount +
        ' 场、' + num(D.meta.total) + ' 条</b>。每条都是一句日语原文配一句中文译文，按出现时间排列；' +
        '页面上的逐字稿就是这些记录本身，没有再做过编辑。</p>' +
        '<div class="box"><h3>记录是怎么来的</h3>' +
          '<p><b>语音识别</b>：用 Windows 11 系统自带的「实时辅助字幕」（Live Captions）把直播里的日语语音转成文字。' +
          '识别在本机完成，音频不上传；需要事先在系统设置里装好日语语音包。</p>' +
          '<p><b>抓取字幕</b>：用开源工具 LiveCaptions-Translator 从字幕窗口逐条读出文本，' +
          '读到的每条再送去翻译。字幕是流式出现的，同一句话常被拆成两三段陆续到达，这也是逐字稿里句子偏短的原因。</p>' +
          '<p><b>翻译</b>：本地运行的大语言模型 <b>Qwen3.5-4B</b>（通义千问 3.5 的 40 亿参数版本），' +
          '用 LM Studio 在本机加载，通过 OpenAI 兼容接口调用，温度为 0.3。' +
          '每次送给模型的是「前面 5 条原文 + 当前这一条」，要求只输出一行中文译文，不解释、不补全。' +
          '翻译同样在本机完成，全程没有调用云端服务，也不产生费用。</p>' +
          '<p><b>整理</b>：直播结束后按时间把记录切成场次，去掉测试跑和录播片段，只保留完整直播。</p>' +
        '</div>' +
        '<div class="box"><h3>这份记录的误差在哪</h3>' +
          '<p><b>识别会错</b>：人名、作品名、生词和网络梗最容易错，同一个词还可能在几秒内被识别成两种写法；' +
          '唱歌、多人同时说话、音效盖过人声的段落基本不可用。' +
          '常出现的几个错误已经用术语表兜住了（「ビリビリ」= B站、「スパチャ」= SC），但表外的照样会漏。</p>' +
          '<p><b>翻译会错</b>：字幕经常在半句时就送出去，这时模型只能按不完整的意思翻；' +
          '提供的上文只有 5 条，话题一岔开就接不上。所以译文偶有主语错位、把反问翻成陈述、把专有名词意译掉的情况。</p>' +
          '<p><b>时间会偏</b>：时间戳是字幕出现的时刻，不是她开口的时刻，通常晚几秒；' +
          '跨场的收尾也未必精确到最后一句。</p>' +
          '<p><b>实测的出错率</b>：随机抽取 80 条逐条核对，15 条意思明显偏差（约五分之一），其中 3 条整条没译出来。' +
          '错得最多的是三类：半句被硬翻、人名与作品名、缩略语——「スパチャ」曾被译成「体育」「超级聊天」，' +
          '「ビリビリ」被译成「电击」。反过来，有明确主谓的完整长句基本都读得通，' +
          '所以这份记录的问题不在「整体不可用」，而在「碎片段基本不可信」。</p>' +
          '<p>换句话说：<b>逐字稿是机器记录，可以当索引和检索用，不适合当引文</b>；' +
          '要判断她到底说了什么，去听原直播的那一段。</p></div>' +
        '<div class="box"><h3>人工做了哪些整理</h3>' +
          '<p>只有两处：一是每场直播结束后的<b>日记</b>，写的是这场聊了什么、回应了谁、讲了哪些冷知识，' +
          '属于事实性归纳，不做评价；二是<b>摘录</b>，从逐字稿里挑出成段的话，连同引出它的那句观众发言一起保留，' +
          '只做断句、明显错字与语序的校正，不做润色，也不对说话人作评价——判断留给读者。</p>' +
          '<p>逐字稿本身保留了识别原文，所以同一条内容在摘录里和在逐字稿里可能略有差异。</p></div>' +
        '<div class="box"><h3>数据概览</h3>' +
          '<p>' + D.sessions.map(function (s) {
            return '<a href="#/archive/' + s.id + '" style="color:var(--ink-2);border-bottom:1px solid var(--line)">' +
              esc(s.date.replace('-', '.')) + '（' + s.count + ' 条）</a>';
          }).join('　') + '</p></div>' +
      '</section>';
    document.getElementById('footMeta').textContent = '更新于 ' + D.meta.generated;
  }

  route();
})();
