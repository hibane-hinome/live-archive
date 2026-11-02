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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

COPY = ['index.html', 'assets/app.js', 'assets/style.css', 'brand']


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

    data = {
        'meta': {
            'streamer': profile['streamer'],
            'title': profile['title'],
            'total': len(recs_out),
            'records': len(recs_out),
            'sessionCount': len(sess_out),
            'firstDate': sess_out[0]['dateLong'],
            'lastDate': sess_out[-1]['dateLong'],
            # 用最后一场的结束时间，保证同样的数据永远构建出同样的结果
            'generated': sess_out[-1]['dateLong'] + ' ' + sess_out[-1]['end'],
            'quoteCount': len(q_out),
        },
        'topics': [[common.TOPIC_NAMES[i], common.TOPIC_COLORS[i]] for i in range(len(common.TOPIC_NAMES))],
        'sessions': sess_out,
        'records': recs_out,
        'quotes': q_out,
    }
    js = 'window.DATA = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
    # 版本号覆盖 data / app / style 三者：任一改动都会让浏览器重新取，避免发布后看到旧缓存
    h = hashlib.sha256(js.encode('utf-8'))
    for rel in ('assets/app.js', 'assets/style.css'):
        with open(os.path.join(site_dir, rel), 'rb') as f:
            h.update(f.read())
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

    print('dist: %d 场 / %d 条 / %d 句 · data.js %d KB · v=%s'
          % (len(sess_out), len(recs_out), len(q_out), len(js.encode('utf-8')) // 1024, ver))
    if skipped:
        print('!! 找不到对应场次的金句:', ', '.join(skipped))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
