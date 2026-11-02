# -*- coding: utf-8 -*-
"""从 translation_history.db 导出每场直播为 site/data/sessions/*.json

用法：
  python tools/export.py            # 增量/幂等：重算全部场次，内容没变就不落盘
  python tools/export.py --dry-run  # 只打印会改动哪些文件
"""
import argparse
import os
import sys
from collections import Counter
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    cfg = common.load_config(args.config)
    rows = common.read_db(cfg['source']['db'])
    if not rows:
        print('数据库里没有记录')
        return 0

    sessions = common.split_sessions(rows, cfg['source']['session_gap_min'], cfg['source']['min_records'])
    out_dir = os.path.join(cfg['site']['dir'], 'data', 'sessions')

    written, unchanged, kept = [], [], set()
    for s in sessions:
        meta, st = common.build_session(s)
        name = st.strftime('%Y-%m-%d_%H%M') + '.json'
        kept.add(name)
        payload = dict(meta)
        payload['records'] = [
            [datetime.fromtimestamp(t).strftime('%H:%M:%S'), src, tr, common.classify(src, tr)]
            for t, src, tr in s['recs']
        ]
        path = os.path.join(out_dir, name)
        old = None
        if os.path.exists(path):
            import json
            with open(path, encoding='utf-8') as f:
                old = json.load(f)
        if old == payload:
            unchanged.append(name)
            continue
        if not args.dry_run:
            common.dump_json(path, payload)
        written.append((name, len(payload['records'])))

    # 清理数据库里已经不存在的场次
    removed = []
    if os.path.isdir(out_dir):
        for fn in sorted(os.listdir(out_dir)):
            if fn.endswith('.json') and fn not in kept:
                removed.append(fn)
                if not args.dry_run:
                    os.remove(os.path.join(out_dir, fn))

    for name, n in written:
        print('  写入', name, n, '条')
    for fn in removed:
        print('  移除', fn)
    print('场次 %d · 新增/更新 %d · 未变 %d · 清掉 %d · 记录 %d 条'
          % (len(sessions), len(written), len(unchanged), len(removed), len(rows)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
