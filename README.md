# 学习通答题工具（PagePilot）

基于 Electron + Fastify 的桌面答题辅助工具：内置浏览器打开学习通（超星）作业/考试页面，自动读取题目，调用 OpenAI 兼容接口批量生成答案，再按题号自动勾选或填写。默认只填答案，不提交。

> 仅用于个人学习辅助，请遵守学校与平台的使用规定，AI 生成的答案需要自行复核。

## 功能特性

- 内置浏览器：左侧工具台 + 右侧真实网页，支持前进/后退/刷新/地址栏导航，默认打开 `https://www.chaoxing.com/`。
- 登录态持久化：独立持久化分区 `persist:pagepilot`，Cookie 自动快照与还原；扫码登录成功后自动进入个人空间；对学习通个人空间的 302 重定向循环做保护。
- 题目识别三通道：
  1. DOM 深读：滚动触发懒加载、自动翻页预收集整卷题目，支持多 iframe；
  2. 学习通接口：在已登录页面内请求试卷接口，一次拉取全量题目；
  3. 视觉 OCR 兜底：DOM 题量过少或题干/选项文字被字体反爬破坏时，自动翻页截图 + 视觉模型识别补全。
- AI 答题：支持单选、多选、判断、填空、简答；分批请求 + 并发池、JSON 截断修复、低置信度二次复核，标记“需复核”题目。
- 答案应用：按题干与选项文字定位元素逐个点选/填写；多空题按 `||` 或分隔符拆分；执行前可人工勾选答案；默认不提交，可选“自动暂存（不提交）”。
- 执行安全：提交、支付、删除、发布等高风险动作标记为高风险并弹窗二次确认；失败不自动重试；可随时停止。
- AI 配置：控制台可填写 Base URL / API Key / 模型 / 温度，支持从配置文件或代码片段解析填入；内置 12 家厂商 70+ 模型的候选清单。
- 答案与记录：答案本地 JSON 导入/导出；服务端保存最近 200 条运行记录，支持导出 Markdown / JSON / CSV / HTML。
- 运行日志：每一步操作实时显示，智能自动滚动，按天写入本地日志文件。

## 技术架构

```
学习通答题工具/
├─ desktop/                  Electron 桌面端
│  ├─ main.js                窗口、内置浏览器、登录态、页面读取/执行、后端托管
│  ├─ preload.js             受限 IPC 桥（window.pilot）
│  ├─ automation.js          注入页面执行的快照采集与动作脚本
│  └─ ui/                    index.html / index.css / index.js
├─ server/                   Fastify + TypeScript 后端
│  └─ src/
│     ├─ index.ts            路由、参数校验、AI 限流、审计日志
│     ├─ ai.ts               OpenAI 兼容调用、JSON 容错解析、SSE 流式输出
│     ├─ prompts.ts          页面规划 / 答题 / 总结提示词
│     ├─ schemas.ts          Zod Schema 与计划、答案清洗
│     ├─ models.ts           各厂商模型清单
│     ├─ store.ts            设置与运行记录（db.json）
│     └─ exports.ts          运行记录导出
├─ package.json              根工作区与 electron-builder 打包配置
└─ 启动PagePilot.bat         Windows 一键启动（自动安装依赖、构建、启动）
```

工作方式：

1. 桌面端启动时探测 `http://127.0.0.1:8787/api/health`，没有可用后端就拉起 `server/dist/index.js`。
2. 页面读取与动作执行都在 Electron 主进程的 `WebContentsView` 中完成，渲染进程只能通过 `preload.js` 的白名单 IPC 调用。
3. 题目先由 DOM/接口/OCR 采集为结构化快照，再由后端 `/api/ai/quiz` 分批生成答案。
4. 前端把答案转换为 `click` / `fill` 步骤，经 `/page:execute` 逐条执行，并把事件流实时推送到左侧日志。

## 快速开始

### 环境要求

- Windows 10/11
- Node.js 20 LTS 及以上（推荐），npm 10+
- 可访问的 OpenAI 兼容大模型接口；OCR 兜底需要支持图片输入的视觉模型

### 启动方式

方式一：双击 `启动PagePilot.bat`。首次运行会自动执行 `npm install` 与 `npm run build`，然后启动桌面端。

方式二：命令行。

```bash
npm install
npm run build
npm run desktop
```

也可以直接打开指定网址：

```bash
npm run desktop -- https://mooc1.chaoxing.com/
```

开发后端时可单独以监听模式运行服务：

```bash
npm run dev          # tsx watch 启动 server/src/index.ts
npm run desktop      # 另一个终端启动桌面端
```

## 使用流程

1. 首次打开在右侧窗口完成学习通扫码登录，登录成功后会自动跳到个人空间。
2. 进入作业或考试答题页。
3. 左侧点击“读取页面题目”，等待状态栏显示识别题数。
4. 可按需填写补充要求（如“只做单选题”“按教材原文作答”）。
5. 点击“AI 生成答案”，等待分批生成完成。
6. 在答案列表中勾选要应用的题目，点击“应用选中答案（不提交）”。
7. 需要保存进度时，在控制台把“生成完成后”设为“自动应用答案”，并把“应用之后”设为“自动点击暂存（不提交）”；也可以手动在页面点击暂存。

## AI 配置

打开左侧“控制台 → AI 接口”：

| 配置项 | 说明 |
| --- | --- |
| 服务商 | 选择后自动补全推荐的 Base URL |
| Base URL | OpenAI 兼容地址，例如 `https://api.deepseek.com/v1` |
| API Key | 保存在本机服务端，界面只显示掩码 |
| 模型 | 可输入或从内置清单选择 |
| 温度 | 默认 `0.2`，答题建议保持较低值 |

支持两种配置来源，环境变量优先于控制台设置：

```bash
set OPENAI_API_KEY=sk-xxx
set OPENAI_BASE_URL=https://api.deepseek.com/v1
set OPENAI_MODEL=deepseek-chat
set OPENAI_TEMPERATURE=0.2
```

也兼容 `DEEPSEEK_API_KEY`。控制台的“导入配置文件 / 解析代码并填入”可从 `.env`、TOML、JSON、curl 片段等文本中提取 Base URL、Key 和模型。

答题参数（保存在浏览器 localStorage）：

- 每批题数：3–20，默认 10；
- 并发批数：1–4，默认 2；
- 复核阈值：0–1，默认 0.7，0 表示关闭低置信度复核；
- 生成完成后：仅生成答案 / 自动应用答案；
- 应用之后：不暂存 / 自动点击暂存（不提交）。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 以监听模式启动后端 |
| `npm run build` | 编译 `server/src` 到 `server/dist` |
| `npm start` | 以生产模式启动后端 |
| `npm run desktop` | 启动 Electron 桌面端 |
| `npm run typecheck` | TypeScript 类型检查（不产出文件） |
| `npm run pack:portable` | 打包免安装版到 `release/portable` |
| `npm run pack:installer` | 打包 NSIS 安装包到 `release/installer` |
| `npm run pack` | 依次打包免安装版与安装包 |

## 服务端接口

服务只监听 `127.0.0.1:8787`（可用 `HOST` / `PORT` 环境变量修改），AI 接口默认按 IP 限制每分钟 30 次。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查、AI 是否已配置 |
| GET | `/api/info` | 版本与运行环境信息 |
| GET | `/api/models` | 内置模型清单（按厂商分组） |
| GET | `/api/settings` | 读取 AI 与安全设置（Key 掩码） |
| PUT | `/api/settings` | 更新 Base URL、Key、模型、温度等 |
| POST | `/api/ai/test` | 测试 AI 连接与延迟 |
| POST | `/api/ai/plan` | 根据页面快照与自然语言要求生成操作计划 |
| POST | `/api/ai/quiz` | 分批生成题目答案，返回答案、告警与用量 |
| POST | `/api/ai/chat` | SSE 流式总结（需配置 AI） |
| POST | `/api/ocr` | 截图视觉识别题目 |
| GET | `/api/runs` | 运行记录列表 |
| POST | `/api/runs` | 新增运行记录 |
| GET/DELETE/PATCH | `/api/runs/:id` | 查看 / 删除 / 更新总结 |
| POST | `/api/exports` | 导出运行记录为 md/json/csv/html |
| GET | `/api/exports/:file` | 下载导出文件 |

## 数据与日志

| 内容 | 开发模式 | 安装版 |
| --- | --- | --- |
| 设置与运行记录 | `server/data/db.json` | `%APPDATA%\PagePilot\server-data\db.json` |
| 导出文件 | `server/data/exports/` | `%APPDATA%\PagePilot\server-data\exports\` |
| AI 调用审计 | `server/data/ai-calls.jsonl` | 同数据目录 |
| 运行日志 | `logs/run-YYYY-MM-DD.log` | `%APPDATA%\PagePilot\logs\` |
| Cookie / 上次网址 | Electron 用户数据目录 | 同左 |

- 运行记录只保留最近 200 条，`db.json` 不会无限增长。
- 审计日志只记录调用类型、模型、耗时、题量等元信息，不记录题目与答案正文。
- API Key 在服务端以明文保存在 `db.json` 中，界面仅做掩码显示；请勿把该文件提交到版本库或分享给他人。
- 安装版因程序目录可能不可写，会自动把数据目录切到用户目录。

## 安全设计

- 页面动作只允许 `click` / `fill` / `select` / `check` / `scroll` / `wait` / `extract`，且只能引用页面快照中真实存在的元素 ID，禁止执行任意 JavaScript。
- 提交、支付、删除、发布等不可逆操作会强制标记为高风险，执行前弹窗确认，拒绝则跳过。
- 用户没有明确要求提交时，只填答案并停止，不会自动提交。
- 答案应用失败不自动重放，避免重复点击、重复提交。
- Electron 渲染进程启用 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`；页面内容运行在独立的 `WebContentsView` 中。
- 应用为单实例运行，重复启动会聚焦已有窗口。

## 常见问题

**启动提示“后端未构建”**
先在项目根目录执行 `npm install` 和 `npm run build`，或直接使用 `启动PagePilot.bat`。

**8787 端口被占用 / 服务异常**
关闭占用端口的进程，或设置 `PORT` 环境变量后重新构建启动；桌面端默认连接 `http://127.0.0.1:8787`。

**读取不到题目**
确认已打开答题页且处于登录状态；若 DOM 文字为空或乱码，通常是字体反爬导致，请配置支持视觉的模型后重试，程序会自动翻页 OCR。

**OCR 失败或返回 0 道**
检查当前模型是否支持图片输入（如豆包 Vision、通义 VL、GPT-4o、GLM-4V 等），并确认接口地址与 Key 可用于视觉请求。

**AI 返回“未返回有效 JSON”**
多为输出被截断。可减少每批题数、关闭并发、换用输出更稳定的模型，或重试。

**登录后反复跳转 / ERR_TOO_MANY_REDIRECTS**
程序会自动清理空间标记并重载一次；仍失败时重新扫码登录，或回到学习通首页后再进入个人空间。

**打包后配置和记录不见了**
安装版数据保存在 `%APPDATA%\PagePilot`，与开发模式的 `server/data` 相互独立，需要重新配置或手动迁移。

## 免责声明

本项目仅用于个人学习与研究，不保证 AI 答案的正确性。使用者应自行核对答案，并遵守所在学校、考试平台及相关法律法规的要求。因使用本工具产生的任何后果由使用者自行承担。
