# 本次任务（给 Claude Code 执行）

按同目录的 `SPEC.md` 完整实现这个全栈 AI 工具箱，并自己跑通验证。

## 事实前提

- `.env` 已经写好且正确（三行：`DEEPSEEK_API_KEY=...` / `PORT=8787` / `DEEPSEEK_BASE_URL=https://api.deepseek.com`），不要修改它，也不要把它提交到 git。
- 模型名用 `deepseek-flash`（默认）和 `deepseek-v4-pro`，这是本账号实际可用的名字。不要把 `deepseek-chat`/`deepseek-reasoner` 当作真实名称。
- 本机 Node 版本 v24.19.0，`node:sqlite`、全局 `fetch`、`--env-file` 都可用。
- 端口 8787 目前空闲。

## 必须产出

1. `package.json`（CommonJS，`dependencies` 只有 `express`，`scripts.start` = `node --env-file=.env server.js`）
2. `lib/db.js`（`node:sqlite`：建表、插入、列表、删除）
3. `lib/deepseek.js`（流式调用封装，支持 AbortSignal，上游错误信息要透传）
4. `server.js`（Express：静态目录 + `/api/health` + `/api/history` + `/api/history/:id` DELETE + `/api/run` SSE）
5. `public/index.html`、`public/app.js`、`public/style.css`（零构建单页：4 个工具 tab、可编辑系统提示词、流式打字机输出、停止、复制、模型下拉、历史记录列表、删除历史）
6. `.env.example`、`README.md`（中文，写清启动方式、接口、每个工具用途）

## 自测要求（必须真的执行）

1. `npm install`
2. 启动服务（后台方式），等端口起来
3. `curl.exe -s http://localhost:8787/api/health` → 贴出真实返回
4. `curl.exe -s -N -X POST http://localhost:8787/api/run -H "Content-Type: application/json" -d "{\"tool\":\"rewrite\",\"system\":\"你是一个改写助手\",\"input\":\"今天天气不错，我们去公园散步吧。\",\"model\":\"deepseek-flash\"}"` → 贴出真实输出片段，证明是逐字流式（能看到多个 delta 分片）
5. `curl.exe -s "http://localhost:8787/api/history?limit=5"` → 证明刚才那次生成已经写进历史
6. 测完 **停掉服务**，不要占着 8787
7. 用 `git add -A && git -c user.email=dev@local -c user.name=dev commit -m "feat: AI 工具箱 v1"` 提交（`.env` 和 `data/` 已被 .gitignore 忽略）

## 汇报格式（中文）

- 文件清单（每个文件一句话说明）
- 你执行过的每条命令 + 真实输出关键片段
- 遗留问题 / 不确定的地方
