# trade-quote-backend（原 ai-toolbox）

「[外贸算价助手](https://github.com/<your-github-username>/trade-quote-miniapp)」的后端服务，同时也是一个可独立运行的 AI 工具箱。
**所有模型调用都在服务端完成，API Key 绝不下发到前端。**

![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![DeepSeek](https://img.shields.io/badge/DeepSeek-Chat%20%2B%20Vision-4d6bfe)
![license](https://img.shields.io/badge/license-MIT-blue)

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（含 `hasKey` 是否已配置 Key） |
| POST | `/api/run` | DeepSeek 流式对话（SSE），逐块返回增量文本 |
| POST | `/api/run-once` | 非流式一次性返回，带 IP 限流 |
| GET | `/api/fx?from=USD&to=CNY` | 实时汇率：多数据源交叉校验 + 跨源择优取最高精度，30 分钟内存 + 磁盘缓存，返回涨跌幅、数据日期与精度标记 |
| POST | `/api/parse-image` | 拍照填单：图片 → DeepSeek 视觉 → 结构化字段（多产品明细 / 客户名 / 箱规 / 税率），约 2~4 秒 |
| GET/POST | `/api/quote-doc` | 报价单导出：Edge 无头渲染 HTML → **PDF（约 1.5 秒）** 或 PNG，支持多行产品明细 |
| GET/DELETE | `/api/history` | AI 工具调用历史（`node:sqlite`） |

### `/api/parse-image`

```http
POST /api/parse-image
{ "image": "data:image/jpeg;base64,..." }

→ 200 {
  "ok": true,
  "fields": {
    "items": [
      { "productName": "不锈钢保温杯 500ml", "qty": 1000, "price": 100, "vatRate": 13, "rebateRate": 13 }
    ],
    "customerName": "ABC Trading Co., Ltd.",
    "currency": "CNY",
    "cartonL": 50, "cartonW": 40, "cartonH": 30, "grossWeight": 12,
    "notes": "交期30天，T/T 30% 定金"
  },
  "elapsedMs": 1820, "tokens": 342, "model": "deepseek-flash"
}
```

设计要点：**识别不到就返回 null，绝不编造数字**；白名单字段 + 类型规整后再返回，避免脏数据污染表单。

### `/api/quote-doc`

```http
GET /api/quote-doc?data=<encodeURIComponent(JSON)>&format=pdf   # 小程序 downloadFile 用（只支持 GET）
POST /api/quote-doc  { "quote": {...}, "company": {...}, "format": "png" | "pdf" }
```

用 Edge/Chrome 无头打印 HTML，中文排版、表格、分页全部由浏览器保证；单价格式化支持 2~6 位小数，
确保单据上「单价 × 数量 = 金额」「合计 = 各行之和」。

## 技术栈

- Node.js 24 + Express 4（零构建前端，纯静态 HTML/CSS/JS）
- `node:sqlite` 内置数据库（无需编译原生模块）
- `puppeteer-core` + 本机 Edge 做 PDF/PNG 渲染（不下载额外浏览器）
- DeepSeek 官方 API：`deepseek-flash`（文本 + 视觉）

## 快速开始

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
# 填入 DEEPSEEK_API_KEY
npm start                     # 等价于 node --env-file=.env server.js
# 打开 http://localhost:8787
```

`.env`：

```
DEEPSEEK_API_KEY=你的 DeepSeek API Key
PORT=8787
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

未配置 Key 时服务仍可启动，`/api/health` 的 `hasKey` 返回 `false`，依赖模型的接口会明确报错。

## 目录结构

```
server.js            # Express 服务：路由、限流、CORS
lib/deepseek.js      # DeepSeek 流式调用封装（AbortSignal、上游错误透传）
lib/fx.js            # 多源汇率聚合 + 跨源精度择优 + 内存/磁盘缓存
lib/vision.js        # 视觉结构化抽取（多产品明细，字段白名单 + 类型规整）
lib/quote-pdf.js     # 报价单 HTML 模板 + Edge 无头渲染 PDF/PNG
lib/ratelimit.js     # IP 限流（30 次/5 分钟，全局 600 次/天）
lib/db.js            # node:sqlite：建表 / 插入 / 列表 / 删除
public/              # 零构建前端（4 个 AI 工具）
docs/tasks/          # 每次迭代的任务书（需求与验收口径）
```

## 安全

- API Key 只在服务端读取，前端任何接口都不返回 Key
- 公网暴露时：接口白名单（只放行必要路径）+ IP 限流 + 请求体大小限制
- 图片识别接口限制 9 MB 以内，超时 90 秒自动中断

## License

[MIT](LICENSE) © 2026
