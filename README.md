# AI 工具箱（ai-toolbox）

一个可本机运行、也可直接上线的全栈 AI 工具站。所有模型调用都在 Node 后端完成，**API Key 绝不下发到浏览器**。

内置 4 个工具，全部支持流式（打字机）输出：

| 工具 | 说明 |
| --- | --- |
| 智能改写 | 保留原意，去掉 AI 味，让文字更口语、更自然 |
| 小红书文案 | 输出 3 个标题候选 + 带 emoji 的正文 + 5 个话题标签 |
| 口播稿 | 前 3 秒钩子 + 分段正文 + 结尾引导互动，口语化短句，可直接照读 |
| 中英互译 | 自动判断中英方向；中文译英文时额外给一版「口语版」 |

## 技术栈

- 后端：Node.js 24 + Express 4
- 前端：纯静态 HTML + CSS + 原生 JS（零构建，无需打包）
- 数据库：Node 24 内置 `node:sqlite`（无需编译原生模块）
- 模型：DeepSeek 官方 API（流式 `stream: true`）

## 快速开始

1. 安装依赖：

   ```bash
   npm install
   ```

2. 配置环境变量：复制 `.env.example` 为 `.env`，填入真实的 Key：

   ```
   DEEPSEEK_API_KEY=你的 DeepSeek API Key
   PORT=8787
   DEEPSEEK_BASE_URL=https://api.deepseek.com
   ```

3. 启动（`npm start` 等价于 `node --env-file=.env server.js`）：

   ```bash
   npm start
   ```

4. 浏览器打开 http://localhost:8787

> 若未配置 `DEEPSEEK_API_KEY`，服务仍能启动，`/api/health` 的 `hasKey` 会返回 `false`，页面上方会显示中文提示。

## 目录结构

```
ai-toolbox/
  server.js            # Express 服务 + API 路由 + SSE 流式转发
  lib/deepseek.js      # DeepSeek 流式调用封装（支持 AbortSignal，透传上游错误）
  lib/db.js            # node:sqlite 封装：建表 / 插入 / 列表 / 删除
  public/index.html    # 单页界面
  public/app.js        # 前端逻辑（fetch + ReadableStream 读取 SSE）
  public/style.css     # 样式
  data/app.db          # SQLite 文件（自动创建，已被 .gitignore 忽略）
  .env                 # 环境变量（已被 .gitignore 忽略）
  .env.example         # 环境变量模板
```

## 接口说明

### `GET /api/health`

健康检查。

```json
{ "status": "ok", "model": "deepseek-flash", "hasKey": true }
```

### `GET /api/history?limit=50`

按时间倒序返回历史记录，`limit` 默认 50（上限 200）。

```json
{ "items": [ { "id": 1, "tool": "rewrite", "model": "deepseek-flash", "input": "…", "output": "…", "elapsed_ms": 1234, "created_at": "2026-10-04T12:00:00.000Z" } ] }
```

### `DELETE /api/history/:id`

删除单条历史记录。

```json
{ "ok": true }
```

### `POST /api/run`（SSE 流）

请求体：

```json
{ "tool": "rewrite", "system": "你是一个改写助手", "input": "要处理的文本", "model": "deepseek-flash" }
```

响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`。

事件流（每条以 `data: ` 开头，JSON 格式）：

```
data: {"type":"delta","text":"今天"}
data: {"type":"delta","text":"天气"}
…
data: {"type":"done","elapsedMs":1234,"chars":456,"tokens":210,"tokensEstimated":false,"id":7}
```

出错时：

```
data: {"type":"error","message":"DeepSeek 接口返回 401：…"}
```

- `delta`：增量文本，前端逐字追加形成打字机效果
- `done`：`elapsedMs` 耗时、`chars` 字符数、`tokens` token 数（优先用上游 `usage`，缺失时为估算值，`tokensEstimated` 标识）、`id` 为写入历史的记录 id
- `error`：上游报错信息原样透传，不吞掉

用户点「停止」或关闭页面时，服务端会通过 `res` / `req` 的 `close` 事件中止上游请求，避免继续消耗 token。

## 可用模型

- `deepseek-flash`（默认）
- `deepseek-v4-pro`

模型名通过请求体的 `model` 字段传入，服务端做白名单校验，非法值回退到默认模型。
