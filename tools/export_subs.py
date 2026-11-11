# -*- coding: utf-8 -*-
"""把翻译数据库导出成浏览器插件用的双语字幕轨。

  python tools/export_subs.py          # 单独导一次（dist/ 必须已存在）
  （日常不用单独跑：build.py 会在构建末尾自动调用 emit_from_db()）

数据直接读 translation_history.db，也就是 LiveTranslate 当时逐句翻出来的那张表：
每一行就是"日文原文 + 中文译文 + 时间戳"。这里把行按直播场次切开，把碎句按停顿并成
字幕块，写进 dist/subs/，随 GitHub Pages 一起发出去，插件从线上直接取。

比站点多出的意义：站点只收 23:30-01:30 开播的场次（白天场要手工加白名单），
而字幕轨按数据库全量切，白天场照样有字幕。

  site/data/subs/index.json      场次目录 + 稿件映射（插件启动只拉这一个）
  site/data/subs/<场次>.json     单场字幕块 [[起, 止, 中文, 日文], ...]

落在 site/data/ 而不是直接写 dist/，是因为 dist/ 不入库、CI 也拿不到数据库：
本地有库就重算并落盘（这份进 git），CI 没库就把已入库的直接复制进 dist/。
跟 site/data/sessions/ 是同一套思路。

时间轴是「距本场第一句话开口多少秒」，不是「距开播」。时间戳两种来源：

  新场次（LiveTranslate 已记 SpeechStart/Duration）——直接用真实开口时刻和说话时长；
  老场次——db 里的 Timestamp 是「翻译回到本地」的时刻，锚在说话的**结束**上
  （实测：说完到入库中位 0.75 秒，而开口到入库中位 4.3 秒，差值正好等于句子本身的
  长度）。所以老数据要减掉尾巴、再减掉这句话说了多久（按字数估，语速取自全库实测），
  否则字幕永远慢半句，而且长句比短句慢得更多——常数对时救不回来。

录播视频的 0:00 通常也不等于开播时刻（OBS 提前开录、投稿从黑屏切起），差多少由
插件里的偏移量补，这里不做假设。
"""
import json
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

TZ = timezone(timedelta(hours=8))

# 相邻两句间隔小于这个值就并进同一块：ASR 的断句比人说话碎得多，
# 一条一条闪过去看不清（全库 1.5 万处间隔里，1-5 秒占了八成）。
MERGE_GAP = 1.6
# 一块最多这么多字，再多就该换行了
MERGE_MAX = 42
# 一块最长覆盖多少秒，防止一口气不停地说时整段粘成一块
MERGE_SPAN = 14.0
# 没有真实时长时，一块按字数估个停留时间
HOLD_MIN, HOLD_MAX, HOLD_CPS = 1.0, 6.0, 6.0
# 前缀重合到这个长度，就认为后一句是 ASR 在重述同一句
DUP_PREFIX = 6

# 老数据的 Timestamp 不是「开口时刻」，是「翻译回到本地」的时刻——它锚在说话的**结束**：
# VAD 等静音 0.4s + 翻译往返 0.3s，实测 3690 句的中位是 0.75s 之后。
# 换句话说，老时间戳 ≈ 这句话说完之后 0.75 秒。拿它当字幕起点，平均晚 4.3 秒
# （晚的量正好等于句子本身的长度），而且长句比短句晚得更多——所以常数对时救不回来。
END_TAIL = 0.75
# 日文语速，字/秒（全库 7873 段的实测中位）。用它把老数据的句子时长估出来再往回推，
# 偏离真实开口从中位 4.3 秒降到 0.68 秒，比把时长当 0（误差 2.9 秒）好得多。
CPS = 5.88
# 说完之后字幕多留一会儿再撤，别在字音刚停的瞬间消失
LINGER = 0.4


def _clean_zh(text):
    """ASR 跨段拼接会在词中间留下「——」，字幕里读着别扭，改成逗号。

    只清中文：日文原文是当时的识别结果，保留原样当证据。
    """
    text = text.replace('——', '，').replace('—', '，')
    text = re.sub(r'[，,、]{2,}', '，', text)
    text = re.sub(r'^[，,、。]+', '', text)
    return text.strip()


def _est_dur(jp, zh):
    """老数据没有时长，按字数估一个（日语原文优先，实在没有就用中文）。"""
    n = len(re.sub(r'\s+', '', jp or '')) or len(re.sub(r'\s+', '', zh or ''))
    return max(0.8, min(9.0, n / CPS))


def _blocks(records, start_ts, timing=None):
    """碎句 → 字幕块。records 是 (时间戳, 日文, 中文)，返回 [[起, 止, 中文, 日文], ...]。

    timing 给的是每句「开口时刻 + 说话时长」（新版 LiveTranslate 才写这两列），
    有它就按真实时间摆，字幕和人声严丝合缝。

    没有的话，Timestamp 只能当「说完的时刻」用：它比说话结束晚约 0.75 秒，
    比说话开始晚约一整句的时长。所以要让字幕对上人声，得先减掉尾巴、再减掉
    这句话说了多久——后者只能按字数估。
    """
    timing = timing or {}
    items = []  # [起, 止(可为 None), 中文, 日文]
    for ts, jp, zh in records:
        zh = _clean_zh(zh or '')
        jp = (jp or '').strip()
        if not zh:
            continue
        t0, dur = timing.get((int(ts), jp), (None, None))
        if t0:
            start = max(0.0, t0 - start_ts)
            end = start + dur
        else:
            d = _est_dur(jp, zh)
            end = float(ts - start_ts) - END_TAIL
            start = end - d
        items.append([start, end, zh, jp])

    # 时间轴 0 点定在「第一句话开口」，不是「第一条入库记录」：后者要等这句话说完、
    # 翻完才写下，比开口晚好几秒，留着它第一句就会被挤到 0 之前（两句都落在 0 秒）。
    # 整场一起平移，句与句的相对位置一点不动。
    if items:
        base = min(x[0] for x in items)
        if base < 0:
            for x in items:
                x[0] -= base
                x[1] -= base

    # 翻译是异步回来的，先说完的句子不一定先入库；按开口时刻重排一遍，
    # 否则字幕会串行（有精确时间戳时才看得出来，老数据本来就是按时间排的）。
    items.sort(key=lambda x: x[0])

    merged = []  # [起, 止(可为 None), 最后一句的起, 中文, 日文]
    for start, end, zh, jp in items:
        if merged:
            last = merged[-1]
            # 合并看「两句开口的间隔」（ASR 碎句几乎连着说），不看「说完到开口的停顿」：
            # 后者碰上长句会把本来分开的两句并成一段。
            if (start - last[2] <= MERGE_GAP
                    and len(last[3]) + len(zh) <= MERGE_MAX
                    and start - last[0] <= MERGE_SPAN):
                if end is not None:
                    last[1] = end
                last[2] = start
                last[3] += zh
                if jp:
                    last[4] = (last[4] + ' ' + jp) if last[4] else jp
                continue
        merged.append([start, end, start, zh, jp])

    # ASR 偶尔会把同一句重新翻一遍，后一句是前一句的超集（"辛苦了" → "辛苦了，大家都…"）。
    # 留着会连闪两次，用更完整的那句替掉前面那句，起点仍然取早的。
    dedup = []
    for b in merged:
        if dedup:
            prev = dedup[-1]
            if (len(prev[3]) >= DUP_PREFIX and b[3].startswith(prev[3])
                    and len(b[3]) > len(prev[3])):
                dedup[-1] = [prev[0], b[1] if b[1] is not None else prev[1],
                             b[2], b[3], b[4]]
                continue
        dedup.append(b)
    merged = dedup

    out = []
    for i, (start, real_end, last_start, zh, jp) in enumerate(merged):
        if real_end is not None:
            hold = max(0.5, real_end - start)       # 真实说了多久，就显示多久
            end = start + hold
            slack = max(0.5, real_end - last_start)
        else:
            hold = max(HOLD_MIN, min(HOLD_MAX, len(zh) / HOLD_CPS))
            end = last_start + hold                 # 没有真实时长：按字数估停留
            slack = hold
        if i + 1 < len(merged):
            nxt = merged[i + 1][0]
            # 下一句接得紧就一直挂到它开口（不闪），接得远就按时收
            end = nxt if nxt - start <= slack + 3.0 else min(end, nxt)
        out.append([round(start, 1), round(max(end, start + 0.5), 1), zh, jp])
    return out


def load_timing(cfg):
    """{(Timestamp, 原文): (开口时刻, 时长)}。

    只有新版 LiveTranslate 写的行才有 SpeechStart/Duration；老数据、以及 C# 那个
    程序写的行都是 NULL，这里直接跳过，交由 _blocks 退回按 Timestamp 估算。
    """
    path = cfg['source']['db']
    if not os.path.exists(path):
        return {}
    try:
        uri = 'file:%s?mode=ro' % path.replace('\\', '/')
        con = sqlite3.connect(uri, uri=True, timeout=10)
        try:
            cols = {r[1] for r in con.execute('PRAGMA table_info(TranslationHistory)')}
            if 'SpeechStart' not in cols:
                return {}
            out = {}
            for ts, src, ss, dur in con.execute(
                    'SELECT Timestamp, SourceText, SpeechStart, Duration '
                    'FROM TranslationHistory WHERE SpeechStart IS NOT NULL'):
                if ss and dur:
                    out[(int(ts), (src or '').strip())] = (float(ss), float(dur))
            return out
        finally:
            con.close()
    except Exception as exc:
        print('!! 读不到语音时间戳（%s），本次按入库时间对齐' % exc, file=sys.stderr)
        return {}


def _origin(records, fallback, timing):
    """本场第一句开口的时刻，作为时间轴 0 点。

    有精确时间就用它：老数据库里 `start` 是第一句翻译回来的时刻，用它当 0 点会让
    整场字幕整体偏移一秒左右。
    """
    for ts, jp, _zh in records:
        t0, _dur = timing.get((int(ts), jp), (None, None))
        if t0:
            return t0
    return fallback


def load_sessions(cfg):
    """从数据库切场次。返回 [{key, start, end, records}]，按时间升序。

    key 与站点场次文件名同一套规则（2026-11-11_0904），两边能对上。
    """
    rows = common.read_db(cfg['source']['db'])
    raw = common.split_sessions(rows,
                                int(cfg['source'].get('session_gap_min', 30)),
                                int(cfg['source'].get('min_records', 20)))
    out = []
    for s in raw:
        st = datetime.fromtimestamp(s['start'], TZ)
        out.append({
            'key': st.strftime('%Y-%m-%d_%H%M'),
            'start': st,
            'end': datetime.fromtimestamp(s['end'], TZ),
            'records': s['recs'],
        })
    return out


def load_videos(site_dir):
    """人工维护的稿件映射：{"BV1xx...": "2026-11-11_0904"}。没有就返回空表。"""
    path = os.path.join(site_dir, 'data', 'videos.json')
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            raw = json.load(f)
    except Exception as exc:
        print('!! videos.json 读不了（%s），本次不带稿件映射' % exc, file=sys.stderr)
        return {}
    out, bad = {}, []
    for bv, key in raw.items():
        if isinstance(key, str) and key.strip():
            out[bv.strip()] = key.strip()
        else:
            bad.append(bv)
    if bad:
        print('!! videos.json 里有无效条目：%s' % ', '.join(bad), file=sys.stderr)
    return out


def load_diary(site_dir):
    """场次 key → 日记标题。只收写了 session 字段的（同一天两场时必须显式指定）。"""
    path = os.path.join(site_dir, 'data', 'diary.json')
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            raw = json.load(f)
    except Exception:
        return {}
    out = {}
    for d in raw:
        key = (d.get('session') or '').strip()
        if key:
            out[key] = d.get('title', '')
    return out


def emit_from_db(cfg, dist_dir, site_dir, stamp=''):
    """构建入口，返回 (场次数, 块数, 总字节)。

    数据库在就跑一遍重算，落盘 site/data/subs/（这份进 git）；数据库不在（CI 环境）
    就直接用已入库的那份。两种情况最后都复制进 dist/subs/ 随 Pages 发布。
    """
    src_dir = os.path.join(site_dir, 'data', 'subs')
    db = cfg['source']['db']

    if os.path.exists(db):
        n, blocks, size = emit(load_sessions(cfg), src_dir, site_dir, stamp, load_timing(cfg))
        if n == 0:
            # 库读到了却切不出场次（多半是空库/被锁），宁可延用旧数据也不要把线上打空
            print('!! 数据库切不出场次，本次沿用 site/data/subs 里的旧字幕', file=sys.stderr)
            n, blocks, size = _stat(src_dir)
    elif os.path.isdir(src_dir):
        n, blocks, size = _stat(src_dir)
        print('   没有数据库，沿用 site/data/subs 里已入库的 %d 场字幕' % n)
    else:
        print('!! 既没有数据库也没有 site/data/subs，跳过字幕轨', file=sys.stderr)
        return 0, 0, 0

    _copy_to(src_dir, os.path.join(dist_dir, 'subs'))
    return n, blocks, size


def _stat(src_dir):
    """读已入库的 index.json，得到 (场次数, 块数, 总字节)。"""
    idx = os.path.join(src_dir, 'index.json')
    if not os.path.exists(idx):
        return 0, 0, 0
    with open(idx, encoding='utf-8') as f:
        meta = json.load(f)
    size = sum(os.path.getsize(os.path.join(src_dir, name))
               for name in os.listdir(src_dir) if name.endswith('.json'))
    return int(meta.get('count', 0)), int(meta.get('blocks', 0)), size


def _copy_to(src_dir, dst_dir):
    os.makedirs(dst_dir, exist_ok=True)
    for name in os.listdir(src_dir):
        if name.endswith('.json'):
            shutil.copy2(os.path.join(src_dir, name), os.path.join(dst_dir, name))


def emit(sessions, out_dir, site_dir, stamp='', timing=None):
    os.makedirs(out_dir, exist_ok=True)
    timing = timing or {}

    diary = load_diary(site_dir)
    index, total_blocks, total_bytes = [], 0, 0
    n_precise = 0
    for s in sessions:
        origin = _origin(s['records'], int(s['start'].timestamp()), timing)
        blocks = _blocks(s['records'], origin, timing)
        if not blocks:
            continue

        # 这一场是不是带精确时间戳（新版程序录的才有）
        precise = any((int(ts), jp) in timing for ts, jp, _zh in s['records'])
        if precise:
            n_precise += 1

        body = {
            'key': s['key'],
            'at': int(s['start'].timestamp()),
            'count': len(blocks),
            'blocks': blocks,
        }
        text = json.dumps(body, ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(out_dir, s['key'] + '.json'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)

        size = len(text.encode('utf-8'))
        total_blocks += len(blocks)
        total_bytes += size
        st, en = s['start'], s['end']
        index.append({
            'key': s['key'],
            'label': st.strftime('%Y.%m.%d %H:%M'),
            'date': st.strftime('%m-%d'),
            'week': common.WEEK[st.weekday()],
            'start': st.strftime('%H:%M'),
            'end': en.strftime('%H:%M'),
            'dur': max(1, int((en - st).total_seconds() // 60) + 1),
            # 开播时刻的 unix 秒：插件拿稿件发布时间往上贴，不用解析字符串
            'at': int(st.timestamp()),
            'blocks': len(blocks),
            'file': s['key'] + '.json',
            # 站点上有对应日记的话，面板里给个「看日记」的入口
            'diary': diary.get(s['key'], ''),
            # 字幕块的时间是「开口时刻」（精确）还是「入库时刻」（晚约 1 秒）
            'precise': precise,
        })

    meta = {
        'v': 1,
        'updated': stamp or datetime.now(TZ).strftime('%Y.%m.%d %H:%M'),
        # 插件的备用镜像 / 相对取数都以此为根
        'site': 'https://hibane-hinome.github.io/live-archive/',
        'count': len(index),
        'blocks': total_blocks,
        # 有几场是真·开口时刻；其余是按下库时间估的，整体晚约 1 秒
        'precise': n_precise,
        'sessions': index,
        'videos': load_videos(site_dir),
    }
    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(meta, ensure_ascii=False, separators=(',', ':')) + '\n')

    # 场次被合并或删掉后，旧文件若留在入库目录里会被一起发出去，顺手清掉
    keep = {x['file'] for x in index} | {'index.json'}
    for name in os.listdir(out_dir):
        if name.endswith('.json') and name not in keep:
            os.remove(os.path.join(out_dir, name))
            print('   清掉过期字幕：%s' % name)

    return len(index), total_blocks, total_bytes


def main():
    """手动重算一次，落盘 site/data/subs/；dist 在的话顺便同步过去。"""
    cfg = common.load_config()
    site, dist = cfg['site']['dir'], cfg['site']['dist']
    if not os.path.exists(cfg['source']['db']):
        print('!! 找不到数据库，没法重算字幕：%s' % cfg['source']['db'], file=sys.stderr)
        return 1
    src = os.path.join(site, 'data', 'subs')
    n, blocks, size = emit(load_sessions(cfg), src, site,
                           datetime.now(TZ).strftime('%Y.%m.%d %H:%M'), load_timing(cfg))
    if os.path.isdir(dist):
        _copy_to(src, os.path.join(dist, 'subs'))
    print('subs: %d 场 / %d 块 / %d KB' % (n, blocks, size // 1024))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
