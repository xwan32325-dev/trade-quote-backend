# AI 工具箱（ai-toolbox）— 需求规格

一个可本机运行、可上线的全栈 AI 工具站。所有模型调用走后端，API Key 绝不下发到浏览器。

## 技术栈（不要换）

- 后端：Node.js 24（本机 `C:\Program Files\nodejs\node.exe`）+ Express 4
- 前端：纯静态 HTML + CSS + 原生 JS（**不要**引入 React/Vue/构建工具，必须零构建直接跑）
- 数据库：Node 24 内置 `node:sqlite`（`require('node:sqlite')`，**不要**用 better-sqlite3 等需要编译的包）
- 模型：DeepSeek 官方 API `https://api.deepseek.com/chat/completions`，使用 **流式**（stream: true）
- 端口：8787（`process.env.PORT` 可覆盖）
- 环境变量从 `.env` 读取，启动命令：`node --env-file=.env server.js`
- 依赖只允许：`express`。其他一律用 Node 内置模块实现

## 目录结构

```
ai-toolbox/
  server.js            # Express 服务 + API 路由 + SSE 流式转发
  lib/deepseek.js      # 调 DeepSeek 的封装（流式）
  lib/db.js            # node:sqlite 封装：初始化表 + 增删查
  public/index.html    # 单页界面
  public/app.js        # 前端逻辑（fetch + ReadableStream 读取 SSE）
  public/style.css     # 样式
  data/app.db          # sqlite 文件（自动创建，git 忽略）
  .env                 # DEEPSEEK_API_KEY=...（git 忽略，需提供 .env.example）
  .gitignore
  README.md            # 启动方式、接口说明
```

## 功能

### 4 个工具（前端顶部/侧边切 tab）

| id | 名称 | 系统提示词要求 |
| --- | --- | --- |
| `rewrite` | 智能改写 | 保原意、去 AI 味、更口语，输出改写后的正文，不要解释 |
| `xiaohongshu` | 小红书文案 | 输出：3 个标题候选 + 正文（带 emoji、分段、结尾 5 个话题标签） |
| `script` | 口播稿 | 输出可直接照读的口播稿：前 3 秒钩子 + 正文分段 + 结尾引导互动，口语化短句 |
| `translate` | 中英互译 | 自动判断中英，输出译文；中文译英文时给一版「口语版」 |

每个工具都要有一个可编辑的「系统提示词」输入框（前端可改，随请求发送），并给默认值。

### 交互要求

- 输入框 + 「生成」按钮；生成中按钮变「停止」，点击可中断请求（AbortController）
- 输出**逐字流式**显示（打字机效果），不要等全部返回
- 输出区右上角：复制按钮（复制成功有提示）
- 模型下拉：`deepseek-flash`（默认）/ `deepseek-v4-pro`
- 显示本次耗时与大致 token 数（后端在 SSE 最后一帧回传 usage 或估算值）

### 历史记录（SQLite）

- 表 `runs(id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, model TEXT, input TEXT, output TEXT, elapsed_ms INTEGER, created_at TEXT)`
- 每次生成成功（流结束）后写入
- 左侧历史列表：显示 工具名 + 输入前 20 字 + 时间；点击可回填输入并展示当年的输出；可删除单条
- 接口：`GET /api/history?limit=50`、`DELETE /api/history/:id`

## 接口

- `GET  /api/health` → `{ "status": "ok", "model": "...", "hasKey": true }`
- `GET  /api/history?limit=50` → `{ items: [...] }`
- `DELETE /api/history/:id` → `{ ok: true }`
- `POST /api/run` → SSE 流
  - 请求体：`{ tool, system, input, model }`
  - 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`
  - 事件：`data: {"type":"delta","text":"..."}` / `data: {"type":"done","elapsedMs":123,"chars":456}` / `data: {"type":"error","message":"..."}`
  - 服务端要用 `req.on('close')` 中止上游请求，避免用户点停止后还在烧 token

## 硬性要求

1. `DEEPSEEK_API_KEY` 只在服务端使用；前端代码里**不得**出现任何 key 字样或真实值
2. 上游返回非 200 时，把 DeepSeek 的报错信息透传给前端，不要吞掉
3. 没有 `DEEPSEEK_API_KEY` 时，`/api/health` 的 `hasKey` 为 false，前端要给出中文提示
4. 代码写中文注释；README 用中文
5. 全部文件写完必须能 `npm install && npm start` 直接跑起来（`npm start` = `node --env-file=.env server.js`）
6. 不要用 ES Module 的 `import`，统一 CommonJS `require`（`package.json` 不设 `"type": "module"`）
