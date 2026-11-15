# -*- coding: utf-8 -*-
"""构建 dist/：数据由 tools/gen_data.py 产出，页面与静态资源由 Vite 打包。

  python tools/build.py           # 生成 dist/
  python tools/build.py --check   # 兼容旧调用：行为相同，照常构建并校验

Vite 配置在仓库根的 vite.config.mjs；它会在构建前自己调用 gen_data.py，
所以 `npm run build` 与这个脚本等价。首次使用先跑 `npm install`。
"""
import argparse
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VITE = os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', help='传给 tools/gen_data.py 的数据配置')
    ap.add_argument('--check', action='store_true', help='兼容旧参数，行为不变')
    args = ap.parse_args()

    if not os.path.exists(VITE):
        print('!! 没装依赖：先在仓库根执行 npm install', file=sys.stderr)
        return 1
    node = os.environ.get('NODE') or shutil.which('node')
    if not node:
        print('!! 找不到 node，Vite 构建需要 Node 20.19+ / 22.12+', file=sys.stderr)
        return 1

    env = dict(os.environ)
    if args.config:
        env['LIVE_ARCHIVE_CONFIG'] = os.path.abspath(args.config)
    p = subprocess.run([node, VITE, 'build'], cwd=ROOT, env=env)
    return p.returncode


if __name__ == '__main__':
    raise SystemExit(main())
