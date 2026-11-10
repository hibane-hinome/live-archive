# live-archive

火羽在 B 站直播的逐字稿档案。数据来自本机两个采集端：LiveTranslate（系统音频 → 日语 ASR → 混元 MT 译文）写 `TranslationHistory`，danmaku-it（B 站弹幕 / SC 旁路采集）写 `sc_message`、`danmaku`、`room_event`。两者共用一个 SQLite 文件，本仓库只保存整理后的结果，不入库数据库本身。

整个链路（三个项目、库表结构、切场规则、已知坑、备份与重建）见 **`AGENT.md`**；本文件只讲站点本身。

站点：https://hibane-hinome.github.io/live-archive/

## 结构

```
AGENT.md                 整条链路的总说明（库表结构、切场规则、坑、备份与重建），优先读这份
config.toml              数据源与发布配置（db 路径、切场阈值、时间窗）
site/
  index.html             页面骨架，构建时替换 {{TITLE}} {{DESC}} {{STREAMER}} {{V}}
  assets/                app.js（前端路由与检索）、style.css
  brand/                 头像与 favicon
  data/
    profile.json         主播名、标题、站点描述
    diary.json           直播日记（人工整理的每场摘要，按 date 挂到场次）
    quotes.json          人工整理的对话摘录（按 date + 时间戳挂到对应场次）
    sessions/*.json       每场直播一份：话题带、目录、逐条记录
tools/
  common.py              配置、数据库读取、会话切分、话题分类
  export.py              db → site/data/sessions/*.json
  build.py               site/ + data → dist/
  publish.py             导出 → 校验 → git commit → push
```

## 日常用法

**没有定时任务，直播结束后手动跑一次。**（原先有一个每小时 :20 的 Windows 计划任务，因为每次都会
弹出控制台窗口，已移除。）流程是：导出 → 构建 → **提交到本地**（review 模式，不上传）；
你确认内容没问题后，再运行 `publish.cmd --push` 推送，随后 GitHub Actions 自动发布。

入口：

```bat
publish.cmd                :: 导出 + 构建 + 本地提交（不推送，等 review）
publish.cmd --push         :: 确认内容后执行，推送到 GitHub
publish.cmd --force        :: 刚下播就想发，跳过静默判断
publish.cmd --dry-run      :: 只报告会改什么，不写文件、不提交
```

底层脚本：

```bash
python tools/export.py                     # 从数据库同步场次（幂等，内容没变不落盘）
python tools/build.py                      # 生成 dist/
python -m http.server 8799 -d dist        # 本地预览，固定 8799（占住 dist/，重建前先停）
python tools/publish.py                    # 导出 → 构建校验 → commit（默认不推送）
python tools/publish.py --push             # 同上，但提交后推送
```

`publish.py` 的判断顺序：最后一条记录静默不足 `quiet_min`（默认 10 分钟）就认为还在直播，直接退出；
导出后数据无变化则不提交；**默认不推送**——本地提交后由人工 review，确认后用 `--push` 推送
（或在 `config.toml` 里把 `[publish] auto_push` 改为 `true`，让脚本自己推送）。
所有动作记录在 `.state/publish.log`。

发布后约 40 秒生效。看到新内容再刷新页面，若仍是旧数据，多半是浏览器缓存——
`data.js` 带内容哈希，正常情况下会自动失效。

## 数据规则

- 相邻记录间隔超过 30 分钟视为新的一场（跨零点的场次不会被拆开）。
- 少于 20 条的片段当作误录，不进站点。
- 只收**开场时间**落在 `config.toml` 的 `time_window`（默认 `23:30-01:30`，跨零点）内的场次，白天的游戏实况自动跳过；傍晚开播的正式场次登记在 `time_window_keep` 里。留空字符串 = 不过滤。
- 话题按 `tools/common.py` 里的关键词表归类；表是按这批直播的具体内容调的，属于经验规则，不是通用分类器。
- 逐字稿保留识别原文；`quotes.json` 里的摘录做过断句、明显错字与语序的校正，两者会有细微差异。
- 摘录按「段」收录：一般连同引出它的那句观众发言或当时语境一起保留，不做单句截取，也不作评价。
- 校对译文时以 `sc_message` 为准：`message` 是观众手写的原文，`message_trans` 是 B 站官方译文；ASR + 机器翻译会错，SC 不会。同一份逐字稿里混着两代翻译器（早期 `OpenAI`、2026-11 起 `hunyuan-mt-chimera-7b`），对比时注意 `ApiUsed`。

## 部署

GitHub Pages，Source 选 **GitHub Actions**。`.github/workflows/pages.yml` 在 `site/**` 或 `tools/**`
有推送时构建 `dist/` 并发布。

## 说明

语音识别存在错漏，人名、专有名词、梗经常识别错误。本仓库不做二次判断，原文与译文逐条保留，
可对照场次时间回查。
