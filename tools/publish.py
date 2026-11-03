# -*- coding: utf-8 -*-
"""一场直播结束后：导出新数据 → 校验构建 → 提交（默认不推送）。

默认是 review 模式：只导出、构建、本地提交，等人工确认内容后
再执行 `publish.cmd --push`（或 `git push`）推上 GitHub Pages。

  python tools/publish.py --dry-run     # 只看会发生什么，不写文件、不提交
  python tools/publish.py               # 正常执行（无新数据时什么也不做；不推送）
  python tools/publish.py --force       # 忽略「可能还在直播」的判断
  python tools/publish.py --push        # 提交后直接推送（人工确认后再用）
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

ROOT = common.ROOT
STATE = os.path.join(ROOT, '.state')
LOCK = os.path.join(STATE, 'publish.lock')
LOG = os.path.join(STATE, 'publish.log')


def log(msg):
    os.makedirs(STATE, exist_ok=True)
    line = '%s %s' % (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def run(cmd, cwd=ROOT, check=True):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if check and p.returncode != 0:
        raise RuntimeError('%s 失败：%s' % (' '.join(cmd), (p.stderr or p.stdout).strip()[:500]))
    return p


def acquire_lock():
    os.makedirs(STATE, exist_ok=True)
    if os.path.exists(LOCK):
        try:
            pid = int(open(LOCK).read().strip() or 0)
        except ValueError:
            pid = 0
        if pid and pid != os.getpid():
            print('另一个发布进程正在运行（pid %d），跳过' % pid)
            return False
    open(LOCK, 'w').write(str(os.getpid()))
    return True


def release_lock():
    try:
        os.remove(LOCK)
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--push', action='store_true', help='提交后推送到远端（默认只提交到本地，等人工 review）')
    ap.add_argument('--no-push', action='store_true', help='已废弃：默认就不推送，保留仅为兼容旧调用')
    ap.add_argument('--all', action='store_true', help='全量导出场次（默认也是全量幂等重算）')
    args = ap.parse_args()

    cfg = common.load_config(args.config)
    # 推送需要显式意愿：命令行 --push，或 config.toml 里 [publish] auto_push = true
    auto_push = bool(cfg['publish'].get('auto_push', False))
    do_push = args.push and not args.no_push or auto_push and not args.no_push

    if not acquire_lock():
        return 0
    try:
        # 1. 直播是否已经结束（最后一条记录要「静」够久）
        rows = common.read_db(cfg['source']['db'])
        if not rows:
            log('数据库为空，跳过')
            return 0
        last = rows[-1][0]
        quiet = (time.time() - last) / 60
        if quiet < cfg['source']['quiet_min'] and not args.force:
            log('最后一條记录在 %.0f 分钟前，直播可能还在进行，跳过' % quiet)
            return 0

        # 2. 导出
        cmd = [sys.executable, os.path.join(ROOT, 'tools', 'export.py')]
        if args.config:
            cmd += ['--config', args.config]
        if args.dry_run:
            cmd.append('--dry-run')
        p = run(cmd)
        sys.stdout.write(p.stdout)
        changed = [l for l in p.stdout.splitlines() if l.startswith('  写入') or l.startswith('  移除')]

        if args.dry_run:
            log('[dry-run] 数据变更 %d 项，未提交' % len(changed))
            return 0

        # 3. 校验能否构建
        p = run([sys.executable, os.path.join(ROOT, 'tools', 'build.py')] +
                (['--config', args.config] if args.config else []))
        sys.stdout.write(p.stdout)

        # 4. 有变化才提交
        status = run(['git', 'status', '--porcelain', 'site/data']).stdout.strip()
        if not status:
            # 上一次可能 commit 成功但还没推送（review 模式），这里只提醒不代推
            ahead = run(['git', 'rev-list', '--count', '@{upstream}..HEAD'], check=False)
            n = int(ahead.stdout.strip() or 0) if ahead.returncode == 0 else 0
            if n and do_push:
                log('数据无变化，但有 %d 个提交未推送，补推' % n)
                run(['git', 'push', cfg['publish']['remote'], cfg['publish']['branch']])
                log('已推送')
            elif n:
                log('数据无变化；有 %d 个本地提交待 review，确认后执行 publish.cmd --push' % n)
            else:
                log('数据无变化，不提交')
            return 0

        run(['git', 'add', 'site/data'])
        n_sess = len([l for l in status.splitlines() if l.strip()])
        stamp = datetime.fromtimestamp(last).strftime('%Y-%m-%d %H:%M')
        msg = 'data: %s 直播记录（%d 个文件）' % (stamp[:10], n_sess)
        run(['git', 'commit', '-m', msg])
        log('已提交：' + msg)

        if not do_push:
            log('review 模式：已在本地提交，未推送。确认内容后执行 publish.cmd --push（或 git push）')
            return 0
        run(['git', 'push', cfg['publish']['remote'], cfg['publish']['branch']])
        log('已推送到 %s/%s' % (cfg['publish']['remote'], cfg['publish']['branch']))
        return 0
    except Exception as e:
        log('失败：%s' % e)
        return 1
    finally:
        release_lock()


if __name__ == '__main__':
    raise SystemExit(main())
