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
      return '<div class="qmini"><p>' + esc(q.zh) + '</p><span>' + esc(q.t) + '</span></div>';
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
          '<div class="stat"><b>' + D.meta.quoteCount + '<i>句</i></b><span>精选金句</span></div>' +
          '<div class="stat"><b>' + D.topics.length + '<i>类</i></b><span>话题标签</span></div>' +
        '</div>' +
        '<div class="hero-cta">' +
          '<a class="btn primary" href="#/quotes">读金句 →</a>' +
          '<a class="btn" href="#/archive">进档案库</a>' +
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
          '<div class="latest-r">' + (mini || '<div class="qmini"><p>这一场暂无收录金句。</p></div>') + '</div>' +
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
          (qn ? ' · ' + qn + ' 句金句' : '') + '</div>' +
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
            (qn ? ' · ' + qn + ' 句金句' : '') + '</div>' +
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
        '<div class="kicker">SELECTED QUOTES</div>' +
        '<h1 style="font-size:clamp(38px,5.4vw,64px)">金句<span class="thin">，</span><span class="accent">' + D.meta.quoteCount + '</span> 句</h1>' +
        '<p class="lead">从 ' + num(D.meta.total) + ' 条记录中选出 ' + D.meta.quoteCount + ' 句，按话题分类；' +
        '多数出自回应观众 SC 的段落。文本以语音识别稿为基础，只做断句与明显错字的整理，' +
        '原始记录见对应场次的逐字稿。</p>' +
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
    document.getElementById('qlist').innerHTML = html || '<div class="empty">这个标签下还没有句子。</div>';
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
              (qn ? '<span><b>' + qn + '</b> 句金句</span>' : '') +
              '<span>' + topT + '</span></div>' +
          '</div>' +
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
        '<p>这里收录的是 <b>' + esc(D.meta.streamer) + '</b> 在 B 站直播的本地字幕记录：日语语音识别 + 自动翻译，' +
        '时间范围 <b>' + D.meta.firstDate + ' — ' + D.meta.lastDate + '</b>，共 <b>' + D.meta.sessionCount +
        ' 场、' + num(D.meta.total) + ' 条</b>。</p>' +
        '<p>原始数据来自 <code>translation_history.db</code>，筛掉了测试跑、播放录播与切片片段，' +
        '只保留完整直播场次。选句与注释为人工整理：只做断句和明显错字的校正，不做润色，' +
        '也不对说话人作评价——判断留给读者，原文可在逐字稿里逐条核对。</p>' +
        '<div class="box"><h3>阅读提示</h3>' +
          '<p>语音识别稿存在错漏：人名、专有名词、梗经常识别错误（例如「ビリビリ」= bilibili、「スパツ」= SC）。' +
          '金句卡里的日语已尽量还原成她实际说的句子，逐字稿里则保留了原始识别结果——所以两边会有细微差异。</p></div>' +
        '<div class="box"><h3>技术说明</h3>' +
          '<p>纯静态站点，无外部依赖，可离线打开。数据由 <code>build_site.py</code> 从数据库生成到 ' +
          '<code>assets/data.js</code>，重跑一次即可更新全站。</p></div>' +
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
