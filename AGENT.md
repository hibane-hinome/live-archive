# AGENT.md — 火羽直播档案三件套

> **这份文件的用途**：工作区被误删 / 上下文丢失 / 换了新对话之后，读这一份就能把整条链路接回来。
> 最后核对：2026-11-10 夜（数字都是当天实测的库内现状，会随时间增长）。
> 当晚修完了项目从 `D:/forDesktop/` 搬到 `D:/HibaneHinome/` 后的路径断链，并给导出加了时间窗过滤。

---

## 0. 一句话

三个项目，**一个 SQLite 文件**是唯一的枢纽：`live-archive/.data/translation_history.db`。
LiveTranslate 和 danmaku-it 都往这个库里写，live-archive 从里面读，导出成站点。

```
        LiveTranslate                        danmaku-it
   （WASAPI → VAD → ASR → LLM 翻译）      （B站弹幕/SC 旁路采集）
              │  写 TranslationHistory            │  写 sc_message / danmaku / room_event
              └──────────────┬────────────────────┘
                             ▼
        D:/HibaneHinome/live-archive/.data/translation_history.db   ← 唯一数据源
                             │  只读（mode=ro）
                             ▼
                     live-archive/tools/
                export.py → site/data/sessions/*.json
                （人工）  → site/data/diary.json · quotes.json
                build.py  → dist/
                publish.py→ git commit →（人工确认）→ push
                             ▼
             GitHub Pages: https://hibane-hinome.github.io/live-archive/
```

---

## 1. 三个项目

| | 角色 | 路径 | 语言 / 运行环境 | 版本控制 |
|---|---|---|---|---|
| 1 | **最终产物**：B站直播逐字稿档案站点 | `D:/HibaneHinome/live-archive` | Python 3.12+（仅标准库）+ 原生 JS | git，远端 GitHub |
| 2 | **SC / 弹幕收集器**：B站醒目留言旁路采集，用于事后矫正翻译、核对观众发言 | `D:/HibaneHinome/danmaku-it` | Python 3.13（`.venv`）+ PySide6 | **不在 git 里** |
| 3 | **实时翻译**：系统音频 → ASR → LLM 翻译 → 悬浮字幕 | `D:/HibaneHinome/LiveTranslate` | Python 3.11（`.venv`）+ PyTorch + PyQt6 | git |

三者的耦合点只有数据库路径，代码之间**没有任何 import 关系**：

- `LiveTranslate/user_settings.json` → `"history_db_path": "D:/HibaneHinome/live-archive/.data/translation_history.db"`
- `danmaku-it/config.json` → `"database": "D:\\HibaneHinome\\live-archive\\.data\\translation_history.db"`
- `live-archive/.state/config_data.toml` → `db = "D:/HibaneHinome/live-archive/.data/translation_history.db"`（**当前真正生效的那份**，见第 8 节坑 1）

（`live-archive/config.toml` 里写的还是旧的 C# 库路径，已过期。）

---

## 2. 枢纽数据库

**路径**：`D:/HibaneHinome/live-archive/.data/translation_history.db`（约 8.9 MB，WAL 模式）

这一个文件里同时躺着两套表，因为 LiveTranslate / C# 端和 danmaku-it 各自 `CREATE TABLE IF NOT EXISTS` 到同一个文件：

| 表 | 行数（11-10 快照） | 写入方 | 用途 |
|---|---|---|---|
| `TranslationHistory` | 9850 | LiveTranslate / LiveCaptions-Translator | 逐字稿本体：日文原文 + 中文译文 |
| `sc_message` | 324 | danmaku-it | SC 留言原文、金额、发送者、B站官方译文 |
| `danmaku` | 45978 | danmaku-it | 普通弹幕（房间 42062 / 22748536） |
| `room_event` | 2471 | danmaku-it | 进场 / 礼物 / 上舰 / SC 删除 |
| `collect_room` | 2 | danmaku-it | 采集过的房间信息 |
| `sc_deletion` | 0 | danmaku-it | 被删的 SC |

### TranslationHistory

```sql
Id INTEGER PRIMARY KEY AUTOINCREMENT,
Timestamp TEXT,          -- Unix 秒（字符串！），本地时区 GMT+8
SourceText TEXT,         -- 日语 ASR 原文
TranslatedText TEXT,     -- 机器译文（可能为空 / N/A / Translation Failed）
TargetLanguage TEXT,     -- BCP-47，如 zh-CN
ApiUsed TEXT             -- 见下
```

- **`Timestamp` 是 TEXT，比较时必须 `CAST(Timestamp AS INTEGER)`**，否则字符串比较会算错。
- `ApiUsed` 分布：`LiveTranslate:hunyuan-mt-chimera-7b` 5129 / `OpenAI` 4524 / `LogOnly` 197。
  → 早期用的是 C# 端 + OpenAI，2026-11 起换成 LiveTranslate + 腾讯混元 MT。同一份逐字稿是**两代翻译器混着的**。
- 数据范围：2026-10-23 23:58 → 2026-11-10 01:03。

### sc_message（翻译矫正的锚点）

```sql
sc_id TEXT PRIMARY KEY,  -- B站 SC id，去重键
room_id, uid, uname, price,
message TEXT,            -- 留言原文（日文/中文都有，观众写的）
message_trans TEXT,      -- B站官方译文（来自 SUPER_CHAT_MESSAGE_JPN，可空）
start_time INTEGER,      -- B站 Unix 秒 = 录播时间轴，权威
received_at INTEGER,     -- 本地墙钟毫秒，比 start_time 晚约 0.7s
guard_level, medal_*,
raw_json TEXT            -- 整条原始 payload
```

**这两个库为什么放在一起**：ASR + LLM 的译文会错，而 SC 是观众手写的原文 + B站官方译文，是同一时段里**唯一可信的人工对照**。人工校摘录 / 核译文时，就是拿 `sc_message.message` 去对 `TranslationHistory` 里同一时刻附近那条记录。历史提交能看到这个用法：

- `b85c915` 「11-08 摘录原文校对——8 段观众发言行改为 SC 原话」
- `521ac3f` 「11-09 深夜场收尾（日记+12段摘录，**SC表核对新库导出**）」

---

## 3. live-archive（最终产物）

### 结构

```
config.toml               ← 过期：指向旧 C# 库（见坑 1）
publish.cmd               一键入口（导出+构建+本地提交）
site/
  index.html              {{TITLE}} {{DESC}} {{STREAMER}} {{V}} 构建时替换
  assets/app.js           前端 hash 路由：#/ #/diary #/quotes #/archive #/about
  assets/style.css
  brand/                 头像与 favicon
  data/profile.json       主播名 / 标题 / 描述
  data/diary.json         直播日记（人工写，最新在最前）
  data/quotes.json        摘录（人工挑，按 date + t 挂场次）
  data/sessions/*.json    每场直播一份，脚本导出，**禁止手改**
tools/
  common.py               配置、读库、切场、话题分类（TOPICS 关键词表）
  export.py               db → site/data/sessions/
  build.py                site/ → dist/（含 data.js、版本哈希、构建时刻）
  publish.py              导出 → 构建 → commit（默认不 push）
dist/                     构建产物，不入库，CI 重新生成
.state/                   日志、截图、临时 dump、config_data.toml（gitignore）
.data/                    枢纽数据库（**未入 git**，见坑 2）
```

### 命令

```bash
cd D:/HibaneHinome/live-archive

# 导出（幂等：内容没变不落盘）
python tools/export.py
python tools/export.py --dry-run          # 先看会改什么，「清掉」必须是 0

# 构建 / 本地预览
python tools/build.py                     # 页脚「更新于」= 本次构建时刻，自动写入，无需手改
BUILD_TIME="2026.11.10 22:00" python tools/build.py   # 覆盖构建时刻（复现/调试用）
python -m http.server 8799 -d dist        # 固定 8799

# 发布（review 模式：只到本地提交）
publish.cmd                 # 等价于 python tools/publish.py
publish.cmd --push          # 人工确认之后才推
publish.cmd --force         # 刚下播就想发，跳过「静默 10 分钟」判断
publish.cmd --dry-run
```

`publish.py` 的判断顺序：最后一条记录静默 < `quiet_min`（10 分钟）→ 认为还在播，退出；导出无变化 → 不提交；**默认不推送**。

CI：`.github/workflows/pages.yml`，`site/**` / `tools/**` 推送后自动 build + deploy，约 40 秒生效。

### 切场规则（`common.py`）

- 相邻记录间隔 > 30 分钟 → 新的一场（跨零点不拆）
- 少于 20 条的片段 → 当作误录丢弃
- 开场时间不在 `time_window` 内 → 跳过；`time_window_keep` 里登记的场次例外（见坑 5）
- 话题靠 `TOPICS` 关键词表归类，顺即是优先级；表是照这批直播调的**经验规则**，不是通用分类器
- 版本哈希 = data.js + app.js + style.css 三者，任一改动都会让浏览器重新取

### 数据文件 schema

`diary.json`（list，**最新在最前**）

```json
{ "date": "11-10", "title": "一句话抓这件最突出的事",
  "tagline": "深夜场 · 美食话题 · 防感冒",
  "body": ["段落1", "段落2"] }
```

`quotes.json`（list）

```json
{ "date": "11-10", "t": "01:00:21", "tag": "劝解",
  "jp": "「观众发言」\n——她的原话，一行一句",
  "zh": "「译文」\n——对应译文，行数对齐",
  "note": "一句语境说明，不评价" }
```

- `t` 必须是真实时间戳，`build.py` 靠它把摘录挂到对应场次；挂不上会打印 `!! 找不到对应场次的摘录`
- `tag` 只用六类，别新造：`人生` `劝解` `吐槽` `科普` `自嘲` `努力`

### 当前规模（2026-11-10）

13 场 / 8202 条记录 / 105 段摘录 / 13 篇日记。

### 写作口径（长期约定，违反要重做）

1. **不推送**，除非用户明说「推送 / 发上去 / 上线」。默认到本地提交为止。
2. **不改逐字稿原文**。`site/data/sessions/*.json` 是机器记录，改了等于伪造；要改只能改 `tools/export.py`。
3. **不写评价**。日记和 `note` 只陈述「她说了什么、在回应谁、当时语境」，禁止「很温柔」「令人感动」「三观正」这类判断。
4. **摘录按「段」收录**，不截单句。连同引出它的观众发言一起给，读不懂宁可长一点。
5. **校正只限三类**：断句、明显识别错字、语序错乱。不润色、不替她换措辞、不把口语改书面语。
6. **不碰争议**（调侃平台/其他主播、2022 假同传旧事），除非用户明确同意。
7. **一次改动一次提交**，不把内容和前端改动混在一个 commit 里。
8. **不做截图自查**、不评价页面观感——构建通过就起服务交给用户。
9. **每场都要写**，没有「这场太平淡跳过」这种情况。

---

## 4. danmaku-it

```powershell
cd D:/HibaneHinome/danmaku-it
.\.venv\Scripts\python.exe -m collector gui -c config.json    # 悬浮弹幕机（gui.bat）
.\.venv\Scripts\python.exe -m collector run -c config.json    # 命令行常驻（run.bat）
.\.venv\Scripts\python.exe -m collector export --format csv --out exports/sc.csv
.\.venv\Scripts\python.exe -m collector stats
```

- 匿名连接（buvid + WBI 签名），多房间并发，每房间独立重连
- 协议必须收全量弹幕再本地过滤（B站不支持只订阅 SC）
- 房间号填 `0` = 离线回放，从库里读真实 payload 走同一套 `extract_sc()`，不联网不写库
- SC 的官方译文是 `SUPER_CHAT_MESSAGE_JPN` 晚到、按 `id` 回填到 `message_trans`
- 匿名连接下**普通弹幕昵称会被 B站打码**（`青***`），SC 和进场事件是完整的
- 断线期间 B站不补发 SC，重连补不齐

`danmaku-it/data/sc.db` 是老的自定义采集库，已被 `config.json` 改成直接写 `live-archive/.data/` 取代。**2026-11-10 已删除**，只剩盘外备份那一份（见第 9 节）——里面有 20 条 SC、1640 条弹幕来自 545068（德云色）等三个房间，`.data` 库从来没有过这些数据。

---

## 5. LiveTranslate

```bash
cd D:/HibaneHinome/LiveTranslate
.venv/Scripts/python.exe main.py      # 或 start.bat
```

当前配置（`user_settings.json`）：

| 项 | 值 |
|---|---|
| `asr_engine` | `anime-whisper`（日语动画/直播专用） |
| `asr_device` | `cuda:0` |
| `target_language` | `zh` |
| `active_model` | `hunyuan-mt-chimera-7b`（`context_turns: 3`） |
| `vad_mode` | `silero`，`silence_mode: auto` |
| `history_db_path` | `D:/HibaneHinome/live-archive/.data/translation_history.db` |
| `auto_save_transcript` | `true` |

- 系统提示词已针对「Vtuber 火羽ひのめ 的日常对话」调过，并带 ASR 错读纠正表（`ビリビリ`→b站、`スーぱちゃ`→SC）
- 每次译完一句就往 `TranslationHistory` 追加一行；`history_db.py` 自己会建表，写失败只记一次日志、不影响翻译
- 项目结构/线程模型/UI 细节见仓库里的 `CLAUDE.md`（非常详细，可以直接当参考）

---

## 6. 环境

| 用途 | 解释器 |
|---|---|
| live-archive 工具 | 系统 `python`（3.13，只用标准库 `tomllib/json/sqlite3`） |
| danmaku-it | `danmaku-it/.venv/Scripts/python.exe`（3.13.7） |
| LiveTranslate | `LiveTranslate/.venv/Scripts/python.exe`（3.11.9，torch 必须 3.11） |

固定端口：本地预览 `8799`（`dist/` 被它占住，重建前必须先停）。

---

## 7. 常规工作流

**开播前**：`run.bat` 起 danmaku-it（或 gui.bat 开悬浮窗）+ 起 LiveTranslate。

**下播后**（一场不落）：

1. `python tools/export.py`
   - 最后一条记录距今不足 10 分钟 → 可能还在播，先别写日记
   - **看输出里多出来哪些场次**，以及「跳过」了哪些（见坑 5）
   - 「清掉」必须是 0，出现「移除」立刻停（见坑 1）
2. 读完整逐字稿（`python -c` 从库里 dump 到 `.state/_dump_MMDD.txt`，再整篇读；别只看片段）
3. 写 `site/data/diary.json`（最新在最前）
4. 挑 `site/data/quotes.json`（行数对齐、`t` 用真实时间戳、`note` 不评价）
5. `node --check site/assets/app.js && python tools/build.py`
   - 不能有 `!! 找不到对应场次的摘录`
   - 版本哈希要变
6. 起 `python -m http.server 8799 -d dist`，把页面交给用户看，**不截图自查**
7. `git add site/data && git commit`（**不 push**），汇报：时长/条数/日记标题/新增摘录表/ahead 数
8. 用户确认后才 `publish.cmd --push`

**手动重译/回填**：只能改 `TranslationHistory` 的 `TranslatedText`，然后重新 export；不要在 sessions JSON 上手改（历史上 `865a499` 那次回填是直接改 JSON 的，属于例外，别照抄）。

---

## 8. 坑（按危险程度排）

### 1. `export.py` 会删掉库里不存在的场次（2026-11-10 已把 db 指对）

`export.py` 的设计行为是「以库为准」，库里切不出来的场次文件会被 `os.remove()`。所以 **db 路径指错 = 删数据**。

旧 C# 库还在 `D:/forDesktop/LiveCaptions-Translator/bin/Release/net8.0-windows/translation_history.db`（8493 行，只到 11-08），**别指回去**。指回后的实测输出：

```
场次 14 · 新增/更新 8 · 未变 6 · 清掉 2 · 记录 8493 条
  移除 2026-11-09_0006.json
  移除 2026-11-10_0014.json
```

现在 `config.toml` 的 `db` 已改成 `.data` 那份，`.state/config_data.toml` 是它的完整副本（用 `cp config.toml .state/config_data.toml` 同步），所以**不加 `--config` 也是对的**，`publish.cmd` 也安全了。

自查判据：`python tools/export.py --dry-run` 应当出现 **「清掉 0」**；出现「移除」就说明库指错了，停下来别提交。

### 2. 手改 sessions JSON 的译文会被导出覆盖（2026-11-10 已根治）

`export.py` 以数据库为准、**整份覆盖**场次 JSON。历史上 `865a499` 曾直接改 JSON 回填 229 条译文，导致之后每次导出都把那 8 条（10-23 的 5 条、10-30 的 2 条、11-01 的 1 条）打回空白。

2026-11-10 已把这 8 条写回数据库的 `TranslatedText`（Id `101 / 1200 / 1201 / 1202 / 1205 / 7979 / 7980 / 8541`，脚本见 `.state/_backfill.py`），重导 diff 为「译文丢失 0」。

结论不变，而且更硬：**永远不要手改 `site/data/sessions/*.json`**。要改译文就改数据库，要改结构就改 `tools/export.py`——手改的东西下次导出必然蒸发。

顺带记一个不那么显眼的副作用：重新导出历史场次会让**话题分类**漂移（`common.py` 的 `TOPICS` 关键词表后来调过，比如「ありがとう」现在归「问候/感谢」而不再落到「日常杂聊」），11-10 那次重导共 30 条分类码变化。这是修正，不是损坏，但 commit 里会看到 `topics` / `ribbon` / `segs` 一起变。

### 3. `.data/` 不在 git 里 ⚠️

`.gitignore` 没显式排除它，但 `git status` 显示 `?? .data/`——数据库从未入库。**这是全链路唯一不可再生的东西**（直播不会重播，弹幕服务器不补发），工作区被删 = 逐字稿全丢。

2026-11-10 起已做盘外备份：

```
D:/MyDocument/live-archive-backup/
  translation_history_2026-11-10.db      枢纽库（9850 行，8.5 MB）
  sc_collector_legacy_2026-11-10.db      老采集库（21 条 SC / 1640 弹幕 / 3345 room_event）
                                         ⚠️ 源文件 data/sc.db 已于 2026-11-10 删除，这是唯一副本
```

备份用 SQLite 的 `backup()` API 而不是直接复制文件——WAL 模式下直接 copy 可能漏掉未 checkpoint 的数据：

```python
import sqlite3
s = sqlite3.connect('live-archive/.data/translation_history.db')
d = sqlite3.connect('D:/MyDocument/live-archive-backup/translation_history_YYYY-MM-DD.db')
s.backup(d)
```

`.data/` 里不要再堆 `.bak_*`（会越积越大），备份一律走上面那条盘外路径，文件名带日期。

### 4. `danmaku-it` 已有版本控制（2026-11-10 起）

首次提交 `d1b4a01`，16 个文件 / 4044 行（`gui.py` 1766 行、`collector.py` 487 行等）。仓库**没有 remote**，只是本地版本管理。

`.gitignore` 刻意挡掉四类东西，提交前别用 `git add -f` 绕过：

| 排除项 | 原因 |
|---|---|
| `account.csv` | Netscape 格式的 B 站 cookie，19 行含登录态，泄露等于账号被接管 |
| `config.json` | 含 `sessdata` / `dede_user_id` / cookie 绝对路径 / 窗口坐标 |
| `.venv/` | 237 MB |
| `data/`、`logs/`、`exports/` | 数据库不可再生，走盘外备份；后两者是运行时产物 |

副作用：`config.json` 不入库，clone 下来跑不起来，得照 README 复制一份并填路径。

### 5. 白天场已由时间窗挡掉（2026-11-10 已修）

`.data` 库里能切出 16 段，站点只收 13 段。多出来的 3 段是白天的游戏实况：

| 场次 | 条数 | 内容 |
|---|---|---|
| 11-06 09:23–10:29 | 894 | 游戏实况（日文） |
| 11-06 11:34–12:20 | 543 | 游戏实况（日文） |
| 11-07 11:18–11:33 | 208 | 游戏实况（日文） |

原先 `export.py` 无条件收录，每次导出都要手删。现在 `config.toml` 里有：

```toml
time_window = "23:30-01:30"
time_window_keep = ["2026-11-02_1815"]
```

- 只收**开场时间**落在窗口内的场次，窗口支持跨零点（23:30 → 次日 01:30）；上面 3 段自动跳过，输出里会打印「跳过 …」
- 傍晚/下午开播的正式场次列进 `time_window_keep`，按场次名 `YYYY-MM-DD_HHMM` 登记（`2026-11-02_1815` 就是这种情况，它有日记和摘录，不能被挡）
- 留空字符串 `time_window = ""` = 关掉过滤
- 过滤作用在「场次」粒度，不切记录：跨零点场次（10-23 23:58 开播）靠窗口左端 23:30 兜住

站点 13 场的记录数 8202 = 9850 − 894 − 543 − 208 − 3（3 条差额来自历史回填时的微调），可以确认站点数据确实来自 `.data` 库。

### 6. `dist/` 被 8799 端口占住

`build.py` 开头 `shutil.rmtree(dist)`，服务没停会报删目录失败。重建前先停服务。

### 7. CRLF / LF

`build.py` 以 LF 写出 html/js/css，算版本哈希时也先把 app.js / style.css 按 LF 归一化再算——所以 Windows 工作区（style.css 实际是 CRLF）与 CI 的版本号现在一致，可以直接拿 `v=` 对照线上是否已更新。

反过来说：以前哈希读的是原始字节，本地 `v=` 永远对不上线上，别再用它判断「部署没生效」；要判断就看页脚「更新于」的时间。

### 8. 跨零点的场次

`date` 是开场日，`end` 可能是次日。算结束时间用 `start + dur*60`，不要用「当天 24:00」。

### 9. `live-archive-daily` skill 里的库路径已过期

`~/.workbuddy/skills/live-archive-daily/SKILL.md` 里写的还是 `LiveCaptions-Translator/.../translation_history.db`。照它跑 dump 会读到旧库（缺 11-09 之后的数据）。**以本文件第 2 节的路径为准**，顺手改一下那份 skill 更好。

---

## 9. 工作区又没了怎么办

| 能恢复 | 怎么恢复 |
|---|---|
| `live-archive` 的站点、工具、场次 JSON、日记、摘录 | `git clone`（远端 GitHub 有全量历史） |
| `LiveTranslate` | `git clone`（开源仓库）+ 手动补 `user_settings.json`（API key、模型、`history_db_path`） |
| `danmaku-it` | **只能靠外部备份**（无 git） |
| `.data/translation_history.db` | **只能靠外部备份**（未入库，8.9 MB）。现成的一份在 `D:/MyDocument/live-archive-backup/` |
| `account.csv`（B站 cookie） | 只能靠外部备份 |

所以最小备份集就三样：**`live-archive/.data/translation_history.db`、`danmaku-it/`、`LiveTranslate/user_settings.json`**。

重建顺序：

1. `git clone` live-archive → 恢复站点、工具、历史逐字稿；`config.toml` 现在已经是正确路径，clone 直接可用
2. 把备份的 `translation_history_YYYY-MM-DD.db` 放回 `live-archive/.data/`，改名为 `translation_history.db`
3. 恢复 `danmaku-it/`（含 `.venv`，或重新 `python -m venv .venv && .venv\Scripts\pip install -r requirements.txt`），确认 `config.json` 的 `database` 指回 `.data` 库
4. 恢复 LiveTranslate 的 `user_settings.json`，确认 `history_db_path` 指向 `.data` 库
5. 验证：`python tools/export.py --dry-run` 应当输出「场次 13 · 清掉 0」，并打印 3 条「跳过 …」（白天场）——**绝不能出现「移除」**；然后 `python tools/build.py` 应产出 13 场 / 8202 条

---

## 10. 待确认

- [x] `live-archive/config.toml` 是否改成指向 `.data` —— 2026-11-10 已改，`.state/config_data.toml` 同步为副本
- [x] 那 3 段白天场 —— 2026-11-10 已由 `time_window` 挡掉，不再需要手删
- [x] 那 8 条只存在于 JSON 里的回填译文 —— 2026-11-10 已写回数据库
- [x] `.data/` 备份 —— 2026-11-10 起走 `D:/MyDocument/live-archive-backup/`
- [ ] `.data/` 要不要纳入 git（8.9 MB，单文件在 100 MB 以内可以；或继续用盘外备份 + 本文件记录路径）
- [x] `danmaku-it` 要不要 `git init` —— 2026-11-10 已 init 并首次提交 `d1b4a01`（无 remote，凭证与 config 已挡在 .gitignore 外）
- [ ] `live-archive-daily` skill 里的库路径要不要同步改掉
- [ ] 项目搬迁后，`config.toml` 的 `db` 目前是绝对路径 `D:/HibaneHinome/...`；若以后还会移动，考虑改成相对路径 `../.data/translation_history.db`（`load_config` 会按仓库根解析相对路径）
