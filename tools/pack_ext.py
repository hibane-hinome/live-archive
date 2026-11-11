# -*- coding: utf-8 -*-
"""把 extension/ 打成 zip，随站点发布供下载（工具页用）。

构建时调用，CI 也能跑——extension/ 是在仓库里的，不依赖数据库。

  dist/download/hibane-subs-0.1.3.zip

只装运行需要的文件：test/（本地预览页与测试视频）不进包，
`.gitignore` 里的临时文件也不进包——下载的人只要解压就能加载。
"""
import json
import os
import zipfile

# 打进包里的东西（白名单）。加文件别忘来这里登记，否则下载包里没有。
INCLUDE_DIRS = ('icons',)
INCLUDE_EXT = ('.js', '.css', '.html', '.json', '.md')
SKIP_NAMES = {'testsrc.mp4'}


def read_manifest(ext_dir):
    with open(os.path.join(ext_dir, 'manifest.json'), encoding='utf-8') as f:
        return json.load(f)


def build(ext_dir):
    """→ (文件名, 字节数, 版本号, 成员数)。失败由调用方决定要不要拦构建。"""
    man = read_manifest(ext_dir)
    ver = man.get('version', '0.0.0')
    name = 'hibane-subs-%s.zip' % ver

    import io
    buf = io.BytesIO()
    n = 0
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        # manifest.json 放最前，解压出来一眼能看到装的是什么
        z.write(os.path.join(ext_dir, 'manifest.json'), 'manifest.json')
        n += 1
        for root, dirs, files in os.walk(ext_dir):
            dirs[:] = sorted(d for d in dirs if d not in ('test', '__pycache__', '.git'))
            rel_root = os.path.relpath(root, ext_dir).replace('\\', '/')
            if rel_root == '.':
                rel_root = ''
            # 顶层散文件只收白名单后缀；子目录（icons/）整包收
            if rel_root and rel_root.split('/')[0] not in INCLUDE_DIRS:
                continue
            for fn in sorted(files):
                if fn in SKIP_NAMES or fn == 'manifest.json':
                    continue
                if not rel_root and not fn.lower().endswith(INCLUDE_EXT):
                    continue
                rel = (rel_root + '/' + fn) if rel_root else fn
                z.write(os.path.join(root, fn), rel)
                n += 1
    return name, buf.getvalue(), ver, n


def write(dist_dir, name, blob):
    """把打好的包落进 dist/download/，附带一份固定文件名的副本。"""
    out_dir = os.path.join(dist_dir, 'download')
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, name), 'wb') as f:
        f.write(blob)
    # 顺带留一份固定文件名：外部说明里写死链接、版本变了也不会失效
    with open(os.path.join(out_dir, 'hibane-subs-latest.zip'), 'wb') as f:
        f.write(blob)


def emit(ext_dir, dist_dir):
    name, blob, ver, n = build(ext_dir)
    write(dist_dir, name, blob)
    return {'file': 'download/' + name, 'ver': ver, 'size': len(blob), 'files': n}


if __name__ == '__main__':
    import sys
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dist = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'dist')
    info = emit(os.path.join(root, 'extension'), dist)
    print('ext: %s · v%s · %d 个文件 · %d KB'
          % (info['file'], info['ver'], info['files'], info['size'] // 1024))
