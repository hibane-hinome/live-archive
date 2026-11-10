# -*- coding: utf-8 -*-
"""把 site/ 与 site/data/ 合成可部署的 dist/。

  python tools/build.py           # 生成 dist/
  python tools/build.py --check   # 只校验数据能否构建（CI 用），照样生成 dist
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

COPY = ['index.html', 'assets/app.js', 'assets/style.css', 'brand']

# 构建时刻一律按北京时间算：CI 跑在 UTC，用本地时间会差 8 小时，页脚会看起来像没更新。
BUILD_TZ = timezone(timedelta(hours=8))


def build_stamp():
    """这次构建的时刻，形如 2026.11.10 22:10。

    每次构建自动生成，页面底部据此显示「更新于 …」，不需要手改，也不需要 git hook。
    环境变量 BUILD_TIME 可以覆盖它，用于复现某次构建或本地调试。
    """
    raw = os.environ.get('BUILD_TIME', '').strip()
    if raw:
        return raw
    return datetime.now(BUILD_TZ).strftime('%Y.%m.%d %H:%M')


def inside(t, start, end):
    """t / start / end 均为 HH:MM[:SS]，跨零点也能判断。"""
    def m(x):
        p = [int(v) for v in x.split(':')[:2]]
        return p[0] * 60 + p[1]
    t, s, e = m(t), m(start), m(end)
    if s <= e:
        return s <= t <= e
    return t >= s or t <= e


def load_sessions(site_dir):
    d = os.path.join(site_dir, 'data', 'sessions')
    out = []
    for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if not fn.endswith('.json'):
            continue
        with open(os.path.join(d, fn), encoding='utf-8') as f:
            s = json.load(f)
        s['_file'] = fn
        out.append(s)
    out.sort(key=lambda s: s['_file'])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config')
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()

    cfg = common.load_config(args.config)
    site_dir, dist = cfg['site']['dir'], cfg['site']['dist']

    with open(os.path.join(site_dir, 'data', 'profile.json'), encoding='utf-8') as f:
        profile = json.load(f)
    sessions = load_sessions(site_dir)
    if not sessions:
        print('!! site/data/sessions 为空，先跑 tools/export.py', file=sys.stderr)
        return 1

    with open(os.path.join(site_dir, 'data', 'quotes.json'), encoding='utf-8') as f:
        quotes_raw = json.load(f)

    # 直播日记：人工整理的每场摘要，按 date 挂到对应场次
    diary_raw = []
    diary_path = os.path.join(site_dir, 'data', 'diary.json')
    if os.path.exists(diary_path):
        with open(diary_path, encoding='utf-8') as f:
            diary_raw = json.load(f)

    sess_out, recs_out = [], []
    for i, s in enumerate(sessions):
        sess_out.append({
            'id': i,
            'date': s['date'], 'dateLong': s['dateLong'], 'week': s['week'],
            'start': s['start'], 'end': s['end'], 'dur': s['dur'], 'count': s['count'],
            'topics': s['topics'], 'ribbon': s['ribbon'], 'segs': s['segs'],
        })
        for t, jp, zh, tp in s['records']:
            recs_out.append({'s': i, 't': t, 'jp': jp, 'zh': zh, 'tp': tp})

    skipped, q_out = [], []
    for q in quotes_raw:
        cands = [s for s in sess_out if s['date'] == q['date']]
        hit = next((s for s in cands if inside(q['t'], s['start'], s['end'])), None)
        if not hit:
            skipped.append('%s %s' % (q['date'], q['t']))
            continue
        q_out.append({
            'id': 'q%d' % (len(q_out) + 1),
            's': hit['id'], 'date': hit['date'], 'week': hit['week'],
            't': q['t'], 'tag': q['tag'],
            'jp': q['jp'], 'zh': q['zh'], 'note': q.get('note', ''),
        })

    # 日记也按 date 找场次；文件顺序即展示顺序（最新的写在最前）
    skipped_diary, diary_out = [], []
    for d in diary_raw:
        hit = next((s for s in sess_out if s['date'] == d['date']), None)
        if not hit:
            skipped_diary.append(d['date'])
            continue
        diary_out.append({
            's': hit['id'], 'date': hit['date'], 'dateLong': hit['dateLong'],
            'week': hit['week'], 'start': hit['start'], 'end': hit['end'],
            'dur': hit['dur'], 'count': hit['count'],
            'title': d['title'], 'tagline': d.get('tagline', ''), 'body': d['body'],
        })

    data = {
        'meta': {
            'streamer': profile['streamer'],
            'title': profile['title'],
            'total': len(recs_out),
            'records': len(recs_out),
            'sessionCount': len(sess_out),
            'firstDate': sess_out[0]['dateLong'],
            'lastDate': sess_out[-1]['dateLong'],
            # 最后一场的结束时间：数据截止到哪儿，仍然只由数据决定
            'generated': sess_out[-1]['dateLong'] + ' ' + sess_out[-1]['end'],
            # 这次构建的时刻：由构建环境写入，同样的数据每次构建都会不同
            'built': build_stamp(),
            'quoteCount': len(q_out),
            'diaryCount': len(diary_out),
        },
        'topics': [[common.TOPIC_NAMES[i], common.TOPIC_COLORS[i]] for i in range(len(common.TOPIC_NAMES))],
        'sessions': sess_out,
        'records': recs_out,
        'quotes': q_out,
        'diary': diary_out,
    }
    js = 'window.DATA = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
    # 版本号覆盖 data / app / style 三者：任一改动都会让浏览器重新取，避免发布后看到旧缓存。
    # 构建时刻不计入哈希——它每次都不同，算进去会让版本号随每次构建变化，
    # 而版本号要表达的是「内容变没变」。
    hash_data = dict(data)
    hash_data['meta'] = dict(data['meta'])
    hash_data['meta']['built'] = ''
    hash_js = 'window.DATA = ' + json.dumps(hash_data, ensure_ascii=False, separators=(',', ':')) + ';\n'
    h = hashlib.sha256(hash_js.encode('utf-8'))
    for rel in ('assets/app.js', 'assets/style.css'):
        # 按 LF 归一化后再算：写出 dist 时就是 LF，若这里读原始字节，Windows 工作区
        # 的 CRLF 会让本地与 CI 算出不同的版本号，就没法拿它核对线上是否已更新。
        with open(os.path.join(site_dir, rel), encoding='utf-8') as f:
            h.update(f.read().replace('\r\n', '\n').encode('utf-8'))
    ver = h.hexdigest()[:10]

    # ---- 输出 dist ----
    if os.path.isdir(dist):
        shutil.rmtree(dist)
    for item in COPY:
        src = os.path.join(site_dir, item)
        dst = os.path.join(dist, item)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        elif item.endswith(('.js', '.css', '.html')):
            # 文本资源统一按 LF 写出：工作区若是 CRLF，本地与 CI 算出的版本号会不一致
            with open(src, encoding='utf-8') as f:
                text = f.read()
            with open(dst, 'w', encoding='utf-8', newline='\n') as f:
                f.write(text)
        else:
            shutil.copy2(src, dst)
    os.makedirs(os.path.join(dist, 'assets'), exist_ok=True)
    with open(os.path.join(dist, 'assets', 'data.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(js)

    idx = os.path.join(dist, 'index.html')
    with open(idx, encoding='utf-8') as f:
        html = f.read()
    html = (html.replace('{{TITLE}}', profile['title'])
                .replace('{{DESC}}', profile.get('desc', ''))
                .replace('{{STREAMER}}', profile['streamer'])
                .replace('{{V}}', ver))
    with open(idx, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    open(os.path.join(dist, '.nojekyll'), 'w').close()

    print('dist: %d 场 / %d 条 / %d 段摘录 / %d 篇日记 · data.js %d KB · v=%s'
          % (len(sess_out), len(recs_out), len(q_out), len(diary_out), len(js.encode('utf-8')) // 1024, ver))
    if skipped:
        print('!! 找不到对应场次的摘录:', ', '.join(skipped))
    if skipped_diary:
        print('!! 找不到对应场次的日记:', ', '.join(skipped_diary))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
