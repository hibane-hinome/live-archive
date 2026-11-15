# -*- coding: utf-8 -*-
"""产出 Vite 构建需要的输入，全部落在 .build/ 下（不入库）。

  .build/public/assets/data.js   site/data/ 内联成 window.DATA
  .build/public/subs/*.json      插件用的双语字幕轨
  .build/public/download/*.zip   插件安装包
  .build/public/brand/           站点图片（app.js 里有运行时拼出来的引用，整目录复制）
  .build/public/audio/           背景音乐
  .build/manifest.json           版本号 + 页面模板要用的 profile

由 vite.config.mjs 在 dev 启动和 build 前调用，也可以单独跑：

  python tools/gen_data.py [--config config.toml] [--out .build]

版本号算法与旧的 build.py 一致：data（去掉构建时刻）+ app.js + style.css 的
sha256 前 10 位。同样的数据必然得到同样的版本号，用来判断线上是否已更新。
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
import export_subs
import pack_ext

ROOT = common.ROOT

# 构建时刻一律按北京时间算：CI 跑在 UTC，用本地时间会差 8 小时，页脚会看起来像没更新。
BUILD_TZ = timezone(timedelta(hours=8))


def build_stamp():
    """这次构建的时刻，形如 2026.11.10 22:10。"""
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


def collect(site_dir):
    """site/data/ 下的场次、摘录、日记合成页面用的数据结构。"""
    with open(os.path.join(site_dir, 'data', 'profile.json'), encoding='utf-8') as f:
        profile = json.load(f)
    sessions = load_sessions(site_dir)
    if not sessions:
        print('!! site/data/sessions 为空，先跑 tools/export.py', file=sys.stderr)
        raise SystemExit(1)

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
            # 场次文件名（2026-11-11_0904）：日记详情页用它做路由，比递增 id 稳
            'key': os.path.basename(s['_file'])[:-5],
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
    # 同一天有两场（比如凌晨场 + 白天场）时，光看 date 会全部绑到当天第一场，
    # 所以日记里可以写 "session": "2026-11-11_0904" 显式指定场次文件。
    by_file = {s['_file']: i for i, s in enumerate(sessions)}
    skipped_diary, diary_out = [], []
    for d in diary_raw:
        want = (d.get('session') or '').strip()
        wid = by_file.get(want + '.json') if want else None
        if wid is not None:
            hit = sess_out[wid]
        else:
            hit = next((s for s in sess_out if s['date'] == d['date']), None)
        if not hit:
            skipped_diary.append(d['date'] + (' / ' + want if want else ''))
            continue
        diary_out.append({
            's': hit['id'], 'key': hit['key'],
            'date': hit['date'], 'dateLong': hit['dateLong'],
            'week': hit['week'], 'start': hit['start'], 'end': hit['end'],
            'dur': hit['dur'], 'count': hit['count'],
            'title': d['title'], 'tagline': d.get('tagline', ''),
            # 列表页只显示 summary（一两句），全文放在详情页
            'summary': d.get('summary', ''),
            'body': d['body'],
        })

    return profile, sess_out, recs_out, q_out, diary_out, skipped, skipped_diary


def data_js(data):
    return 'window.DATA = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'


def content_version(data, site_dir):
    """版本号覆盖 data / app / style 三者：任一改动都会让浏览器重新取。"""
    # 构建时刻不计入哈希——它每次都不同，算进去会让版本号随每次构建变化，
    # 而版本号要表达的是「内容变没变」。
    hash_data = dict(data)
    hash_data['meta'] = dict(data['meta'])
    hash_data['meta']['built'] = ''
    # 字幕轨的「更新于」也是构建时刻，同样不计入版本
    if hash_data['meta'].get('subs'):
        hash_data['meta']['subs'] = dict(hash_data['meta']['subs'])
        hash_data['meta']['subs']['updated'] = ''
    hash_js = data_js(hash_data)
    h = hashlib.sha256(hash_js.encode('utf-8'))
    for rel in ('assets/app.js', 'assets/style.css'):
        # 按 LF 归一化后再算：工作区若是 CRLF，本地与 CI 算出的版本号会不一致
        with open(os.path.join(site_dir, rel), encoding='utf-8') as f:
            h.update(f.read().replace('\r\n', '\n').encode('utf-8'))
    return h.hexdigest()[:10]


def copy_static(site_dir, public_dir):
    """brand/ 与 audio/ 原样复制：app.js 运行时会拼 brand/xxx 的路径，不能只靠打包器。"""
    for name in ('brand', 'audio'):
        src = os.path.join(site_dir, name)
        if not os.path.isdir(src):
            continue
        dst = os.path.join(public_dir, name)
        os.makedirs(dst, exist_ok=True)
        shutil.copytree(src, dst, dirs_exist_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config')
    ap.add_argument('--out', default=os.path.join(ROOT, '.build'))
    args = ap.parse_args()

    os.chdir(ROOT)
    cfg = common.load_config(args.config)
    site_dir = cfg['site']['dir']

    out_dir = os.path.abspath(args.out)
    public_dir = os.path.join(out_dir, 'public')
    os.makedirs(os.path.join(public_dir, 'assets'), exist_ok=True)

    profile, sess_out, recs_out, q_out, diary_out, skipped, skipped_diary = collect(site_dir)

    # 工具页要摆出来的两块事实：字幕轨有多大、插件包多大。
    subs_meta = {}
    try:
        with open(os.path.join(site_dir, 'data', 'subs', 'index.json'), encoding='utf-8') as f:
            si = json.load(f)
        subs_meta = {
            'sessions': si.get('count', 0),
            'blocks': si.get('blocks', 0),
            'updated': si.get('updated', ''),
            'latest': (si['sessions'][-1]['key'] if si.get('sessions') else ''),
        }
    except Exception as exc:
        print('!! 读不到字幕索引（%s），工具页不显示字幕统计' % exc, file=sys.stderr)

    ext_meta, ext_blob, ext_name = {}, None, ''
    try:
        ext_name, ext_blob, ext_ver, ext_files = pack_ext.build(os.path.join(ROOT, 'extension'))
        ext_meta = {'file': 'download/' + ext_name, 'latest': 'download/hibane-subs-latest.zip',
                    'ver': ext_ver, 'size': len(ext_blob), 'files': ext_files}
    except Exception as exc:
        print('!! 插件打包失败（%s），工具页不显示下载按钮' % exc, file=sys.stderr)

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
            # 工具页的数据：字幕轨概况 + 插件包（版本/体积/下载路径）
            'subs': subs_meta,
            'ext': ext_meta,
        },
        'topics': [[common.TOPIC_NAMES[i], common.TOPIC_COLORS[i]] for i in range(len(common.TOPIC_NAMES))],
        'sessions': sess_out,
        'records': recs_out,
        'quotes': q_out,
        'diary': diary_out,
    }

    js = data_js(data)
    with open(os.path.join(public_dir, 'assets', 'data.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(js)
    ver = content_version(data, site_dir)

    copy_static(site_dir, public_dir)
    try:
        n_subs, n_blocks, sub_bytes = export_subs.emit_from_db(
            cfg, public_dir, site_dir, data['meta']['built'])
    except Exception as exc:  # 字幕挂了也不该拦着站点发布
        print('!! 字幕轨导出失败（%s），本站点照常发布' % exc, file=sys.stderr)
        n_subs, n_blocks, sub_bytes = 0, 0, 0
    if ext_blob:
        pack_ext.write(public_dir, ext_name, ext_blob)

    manifest = {
        'version': ver,
        'profile': {
            'title': profile['title'],
            'desc': profile.get('desc', ''),
            'streamer': profile['streamer'],
        },
        'built': data['meta']['built'],
    }
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print('data: %d 场 / %d 条 / %d 段摘录 / %d 篇日记 · data.js %d KB · v=%s'
          % (len(sess_out), len(recs_out), len(q_out), len(diary_out), len(js.encode('utf-8')) // 1024, ver))
    print('subs: %d 场字幕 / %d 块 / %d KB' % (n_subs, n_blocks, sub_bytes // 1024))
    if ext_meta:
        print('ext: v%s / %d 个文件 / %d KB → %s'
              % (ext_meta['ver'], ext_meta['files'], ext_meta['size'] // 1024, ext_meta['file']))
    if skipped:
        print('!! 找不到对应场次的摘录:', ', '.join(skipped))
    if skipped_diary:
        print('!! 找不到对应场次的日记:', ', '.join(skipped_diary))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
