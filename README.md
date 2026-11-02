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

**默认不需要做任何事。** 直播结束后由 Windows 计划任务 `live-archive publish` 自动完成：
每小时的第 20 分检查一次数据库，有新内容就导出、构建、提交并推送，随后 GitHub Actions 自动发布。

手动入口（需要立刻发布、或改了金句想马上看效果时用）：

```bat
publish.cmd                :: 双击即可；要等最后一条记录静默满 10 分钟才会动
publish.cmd --force        :: 刚下播就想发，跳过静默判断
publish.cmd --dry-run      :: 只报告会改什么，不写文件、不提交
```

底层脚本：

```bash
python tools/export.py                     # 从数据库同步场次（幂等，内容没变不落盘）
python tools/build.py                      # 生成 dist/
python -m http.server -d dist 8766         # 本地预览
python tools/publish.py                    # 导出 → 构建校验 → commit → push
```

`publish.py` 的判断顺序：最后一条记录静默不足 `quiet_min`（默认 10 分钟）就认为还在直播，直接退出；
导出后数据无变化则不提交；若上次提交成功但推送失败，下次会补推，不会卡住。
所有动作记录在 `.state/publish.log`。

发布后约 40 秒生效。看到新内容再刷新页面，若仍是旧数据，多半是浏览器缓存——
`data.js` 带内容哈希，正常情况下会自动失效。

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
