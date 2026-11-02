# -*- coding: utf-8 -*-
"""公共部分：配置读取、数据库读取、会话切分、话题分类。"""
import json
import os
import re
import sqlite3
import sys
import tomllib
from collections import Counter
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

# 话题表：名称 / 颜色 / 关键词。顺序即优先级（先命中者归属）。
TOPICS = [
    ('打赏/SC', '#5b8cff', r'スパチャ|スパツ|スーパーチャ|ギフト|打赏|スク|9000|8000|8500'),
    ('问候/感谢', '#5a9e6f', r'こんばんは|ありがとうござ|こん|晚上好|谢谢|はじめまして|宜しく'),
    ('生日祝福', '#4caf7d', r'誕生日|生日|お誕生|ハッピーバースデー|バースデー'),
    ('求婚/结婚梗', '#e05c8f', r'結婚|プロポーズ|嫁|求婚|结婚|新娘|妻|ダーリン'),
    ('日语课堂', '#9c6bff', r'日本語|日本语|曖昧|暧昧|文法|勉強|学習|語彙|敬語|日本語上手'),
    ('游戏/联动', '#3fb6c9', r'FF14|ファンフェス|吉田|エヴァ|真嗣|ミサト|EVA|粉丝节|福音战士|ダービー|エオルゼア|ポケモン|任天堂|ニンテンドー|スイッチ|宝可梦|御三家|ダイレクト'),
    ('动漫/梗', '#c98bdd', r'遊戯王|ゲーム王|カード|ワンピース|海贼王|ニンジャ|忍者|ナルト|コスプレ|衣装|プレキュア|ラブライブ|星空凛|アニメ|漫画|まんが|ちいかわ'),
    ('节日/万圣', '#e07b39', r'ハロウィン|渋谷|クリスマス|サンタ|万圣节|圣诞节|トリック|お菓子|イブ'),
    ('科普/杂学', '#67c23a', r'口噛み|口嚼|巫女|おみくじ|御神籤|食品衛生|末広|漢方|占い|タロット|神社|うんちく|豆知識|求签|伏見|大凶'),
    ('美食', '#d4a056', r'味噌|カレー|ラーメン|ご飯|メシ|食べ物|グルメ|神戸|馬肉|熊|エクレア|牛肉|お酒|飲み会|塩分|食べる|昼食|夕食|夜食|弁当|豚肉'),
    ('情感/人生相談', '#f272a8', r'告白|彼氏|彼女|恋愛|失恋|好き|表白|恋爱|モテ|フラれ|片思い|お見合い|相亲'),
    ('工作/生活', '#8d9bb5', r'仕事|社畜|有給|転職|退職|残業|バイト|シフト|上班|工作|加班|学校|授業|休暇|留学'),
    ('健康/作息', '#6fc7ba', r'風邪|病気|体調|病院|睡眠|寝る|寝な|健康|感冒|医院|睡觉|熬夜|疲れ|早起き'),
    ('天气/季节', '#7fb2e5', r'寒い|暑い|天気|雨|雪|涼しい|冷える|天气|气温|十一月'),
    ('B站/平台', '#66b1ff', r'ビリビリ|bilibili|ピクシブ|B站|平台|配信サイト|動画|登録|審査'),
]
OTHER = ('日常杂聊', '#4a4f5e')
TOPIC_NAMES = [t[0] for t in TOPICS] + [OTHER[0]]
TOPIC_COLORS = [t[1] for t in TOPICS] + [OTHER[1]]
OTHER_ID = len(TOPICS)

DEFAULTS = {
    'source': {
        'db': 'translation_history.db',
        'session_gap_min': 30,
        'min_records': 20,
        'quiet_min': 10,
    },
    'site': {'dir': 'site', 'dist': 'dist'},
    'publish': {'remote': 'origin', 'branch': 'main'},
}


def load_config(path=None):
    path = path or os.path.join(ROOT, 'config.toml')
    cfg = {k: dict(v) for k, v in DEFAULTS.items()}
    if os.path.exists(path):
        with open(path, 'rb') as f:
            user = tomllib.load(f)
        for section, values in user.items():
            cfg.setdefault(section, {}).update(values)
    else:
        print('!! 未找到 config.toml，使用默认值', file=sys.stderr)

    db = cfg['source']['db']
    if not os.path.isabs(db):
        db = os.path.join(ROOT, db)
    cfg['source']['db'] = os.path.normpath(db)
    cfg['site']['dir'] = os.path.join(ROOT, cfg['site']['dir'])
    cfg['site']['dist'] = os.path.join(ROOT, cfg['site']['dist'])
    return cfg


def classify(src, tr):
    text = (src or '') + ' ' + (tr or '')
    for i, (_n, _c, pat) in enumerate(TOPICS):
        if re.search(pat, text, re.I):
            return i
    return OTHER_ID


def clean_translation(tr):
    trs = (tr or '').strip()
    if trs in ('', 'N/A') or 'Translation Failed' in trs or 'ERROR' in trs:
        return ''
    return trs


def read_db(db_path):
    """只读打开，避免和正在跑的字幕程序抢写锁。"""
    if not os.path.exists(db_path):
        raise SystemExit('找不到数据库：%s' % db_path)
    uri = 'file:%s?mode=ro' % db_path.replace('\\', '/')
    con = sqlite3.connect(uri, uri=True, timeout=10)
    try:
        cur = con.cursor()
        cur.execute('SELECT Timestamp, SourceText, TranslatedText FROM TranslationHistory '
                    'ORDER BY CAST(Timestamp AS INTEGER)')
        rows = [(int(ts), (src or '').strip(), clean_translation(tr)) for ts, src, tr in cur.fetchall()]
    finally:
        con.close()
    return rows


def split_sessions(rows, gap_min=30, min_records=20):
    gap = gap_min * 60
    out, cur = [], None
    for rec in rows:
        t = rec[0]
        if cur is None or t - cur['end'] > gap:
            if cur:
                out.append(cur)
            cur = {'start': t, 'end': t, 'recs': [rec]}
        else:
            cur['end'] = t
            cur['recs'].append(rec)
    if cur:
        out.append(cur)
    return [s for s in out if len(s['recs']) >= min_records]


def build_session(s):
    """把一段会话整理成站点用的结构（不含记录正文）。"""
    st = datetime.fromtimestamp(s['start'])
    en = datetime.fromtimestamp(s['end'])
    dur = max(1, (s['end'] - s['start']) // 60 + 1)

    minute_topics, tcount = {}, Counter()
    for t, src, tr in s['recs']:
        mi = min((t - s['start']) // 60, dur - 1)
        ti = classify(src, tr)
        minute_topics.setdefault(mi, set()).add(ti)
        tcount[ti] += 1

    ribbon = [-1] * dur
    for mi, tset in minute_topics.items():
        # 同一分钟内取「全库出现次数最少」的话题，避免日常杂聊吃掉所有格子
        ribbon[mi] = min(tset, key=lambda i: (tcount.get(i, 0), i))

    segs = []
    for ti in range(len(TOPICS)):
        mins = sorted(mi for mi, tset in minute_topics.items() if ti in tset)
        if not mins:
            continue
        blocks = [[mins[0], mins[0]]]
        for m in mins[1:]:
            if m - blocks[-1][1] <= 2:
                blocks[-1][1] = m
            else:
                blocks.append([m, m])
        for b0, b1 in blocks:
            if b1 - b0 + 1 >= 4:
                t0 = s['start'] + b0 * 60
                t1 = s['start'] + (b1 + 1) * 60
                segs.append({
                    'topic': ti,
                    'time': '%s-%s' % (datetime.fromtimestamp(t0).strftime('%H:%M'),
                                        datetime.fromtimestamp(t1).strftime('%H:%M')),
                    'mins': b1 - b0 + 1,
                })
    segs.sort(key=lambda x: x['time'])

    return {
        'date': st.strftime('%m-%d'),
        'dateLong': st.strftime('%Y.%m.%d'),
        'week': WEEK[st.weekday()],
        'start': st.strftime('%H:%M'),
        'end': en.strftime('%H:%M'),
        'dur': dur,
        'count': len(s['recs']),
        'topics': {str(k): v for k, v in tcount.most_common()},
        'ribbon': ribbon,
        'segs': segs,
    }, st


def dump_json(path, obj, compact=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')
    os.replace(tmp, path)
