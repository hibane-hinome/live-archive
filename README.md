# live-archive

火羽在 B 站直播的逐字稿档案。数据来自本机 [LiveCaptions-Translator](https://github.com/Arkueid/LiveCaptions-Translator)
的字幕记录（日语语音识别 + 机器翻译），本仓库只保存整理后的结果，不保存数据库本身。

站点：https://hibane-hinome.github.io/live-archive/

## 结构

```
config.toml              数据源与发布配置（db 路径、会话切分阈值）
site/
  index.html             页面骨架，构建时替换 {{TITLE}} {{DESC}} {{STREAMER}} {{V}}
  assets/                app.js（前端路由与检索）、style.css
  brand/                 头像与 favicon
  data/
    profile.json         主播名、标题、站点描述
    quotes.json          人工挑选的句子（按 date + 时间戳挂到对应场次）
    sessions/*.json       每场直播一份：话题带、目录、逐条记录
tools/
  common.py              配置、数据库读取、会话切分、话题分类
  export.py              db → site/data/sessions/*.json
  build.py               site/ + data → dist/
  publish.py             导出 → 校验 → git commit → push
```

## 日常用法

```bash
python tools/export.py                     # 从数据库同步场次（幂等，内容没变不落盘）
python tools/build.py                      # 生成 dist/
python -m http.server -d dist 8766         # 本地预览
python tools/publish.py --dry-run          # 看会不会有变更，不写不提交
python tools/publish.py                    # 真有新数据时才会 commit + push
```

`publish.py` 会先看最后一条记录是否已静默 10 分钟（`quiet_min`），避免把直播到一半的数据推上去；
没有变化时直接退出，因此可以放心地每小时跑一次。

## 数据规则

- 相邻记录间隔超过 30 分钟视为新的一场（跨零点的场次不会被拆开）。
- 少于 20 条的片段当作误录，不进站点。
- 话题按 `tools/common.py` 里的关键词表归类；表是按这批直播的具体内容调的，属于经验规则，不是通用分类器。
- 逐字稿保留识别原文；`quotes.json` 里的句子做过断句和明显错字的校正，两者会有细微差异。

## 部署

GitHub Pages，Source 选 **GitHub Actions**。`.github/workflows/pages.yml` 在 `site/**` 或 `tools/**`
有推送时构建 `dist/` 并发布。

## 说明

语音识别存在错漏，人名、专有名词、梗经常识别错误。本仓库不做二次判断，原文与译文逐条保留，
可对照场次时间回查。
