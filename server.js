'use strict';

// AI 工具箱后端：Express 静态站点 + API 路由 + SSE 流式转发。
// 所有模型调用都在服务端完成，API Key 绝不下发到浏览器。

const path = require('node:path');
const express = require('express');

const db = require('./lib/db');
const fx = require('./lib/fx');
const { streamChat, DEFAULT_MODEL } = require('./lib/deepseek');

const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(express.json({ limit: '1mb' }));

// CORS：H5 调试页面（5174）和小程序开发者工具需要跨域访问这些接口
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

// 静态资源目录（index.html / app.js / style.css）
app.use(express.static(path.join(__dirname, 'public')));

// 各工具在「前端没传 system」时的兜底系统提示词。
const TOOL_FALLBACK_SYSTEM = {
  rewrite: '你是一个改写助手。在保留原意的前提下改写用户文本：去掉 AI 味，让它更口语、更自然。只输出改写后的正文，不要任何解释。',
  xiaohongshu: '你是小红书文案写手。输出格式：先给 3 个标题候选（每行一个，带 emoji），然后正文（带 emoji、分段），结尾给 5 个话题标签。',
  script: '你是短视频口播稿写手。输出可直接照读的口播稿：前 3 秒钩子 + 正文分段 + 结尾引导互动，全部用口语化短句。',
  translate: '你是中英互译助手。自动判断输入是中文还是英文：中文译成英文，英文译成中文。只输出译文；中文译英文时，额外给一版「口语版」。',
};

// 健康检查：模型名、是否配置了 Key。
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: DEFAULT_MODEL,
    hasKey: Boolean(process.env.DEEPSEEK_API_KEY),
  });
});

// 历史记录列表
app.get('/api/history', (req, res) => {
  const limit = req.query.limit || 50;
  res.json({ items: db.listRuns(limit) });
});

// 删除单条历史记录
app.delete('/api/history/:id', (req, res) => {
  const ok = db.deleteRun(req.params.id);
  res.json({ ok });
});

// 生成接口：SSE 流式返回
app.post('/api/run', async (req, res) => {
  const { tool, system, input } = req.body || {};
  const model = req.body && req.body.model;

  if (!input || !String(input).trim()) {
    res.status(400).json({ ok: false, message: 'input 不能为空' });
    return;
  }

  // SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // 统一的 SSE 发送函数
  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // 客户端断开（点停止 / 关页面）时中止上游请求，避免继续烧 token。
  // 监听 res 的 'close'：正常结束时 writableEnded 已为 true，不算中断；
  // 只有「响应没写完就关闭」才判定为用户主动中断。
  // 注意：不能用 req.on('close')——请求体被 express.json() 读完后该事件会立即触发，会误伤。
  const upstream = new AbortController();
  let clientGone = false;
  const onClose = () => {
    if (!res.writableEnded) {
      clientGone = true;
      upstream.abort();
    }
  };
  res.on('close', onClose);

  const useSystem = system && String(system).trim()
    ? String(system)
    : (TOOL_FALLBACK_SYSTEM[tool] || '');

  const startedAt = Date.now();
  let fullText = '';

  try {
    const { text, usage } = await streamChat({
      system: useSystem,
      input: String(input),
      model,
      signal: upstream.signal,
      onDelta: (delta) => {
        fullText += delta;
        send({ type: 'delta', text: delta });
      },
    });

    const elapsedMs = Date.now() - startedAt;
    const chars = fullText.length;

    // 流正常结束后才写入历史
    const id = db.insertRun({
      tool,
      model: model || DEFAULT_MODEL,
      input: String(input),
      output: fullText,
      elapsedMs,
    });

    // token：优先用上游 usage，缺失时用「字符数近似」兜底
    const tokens = usage && usage.completion_tokens != null
      ? usage.completion_tokens
      : Math.max(1, Math.round(chars / 2));

    if (!clientGone) {
      send({
        type: 'done',
        elapsedMs,
        chars,
        tokens,
        tokensEstimated: !(usage && usage.completion_tokens != null),
        id,
        usage: usage || null,
      });
    }
  } catch (err) {
    // 用户主动中断不算错误，静默收尾即可
    if (clientGone || upstream.signal.aborted) {
      // no-op
    } else {
      send({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
  } finally {
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
});

// 实时汇率：多源回退 + 30 分钟缓存，供报价页自动填入
app.get('/api/fx', async (req, res) => {
  const base = String(req.query.from || 'USD').toUpperCase();
  const quote = String(req.query.to || 'CNY').toUpperCase();
  const force = req.query.force === '1';

  try {
    const data = await fx.getRate(base, quote, { force });
    res.json({ ok: true, ...data, ttlSeconds: Math.round(fx.CACHE_TTL_MS / 1000) });
  } catch (err) {
    res.status(502).json({ ok: false, message: err.message, errors: err.errors || [] });
  }
});

// 非流式生成接口：小程序（uni.request 不方便处理 SSE）使用这个
app.post('/api/run-once', async (req, res) => {
  const { tool, system, input } = req.body || {};
  const model = req.body && req.body.model;

  if (!input || !String(input).trim()) {
    res.status(400).json({ ok: false, message: 'input 不能为空' });
    return;
  }

  const useSystem = system && String(system).trim()
    ? String(system)
    : (TOOL_FALLBACK_SYSTEM[tool] || '');

  const startedAt = Date.now();

  try {
    const { text, usage } = await streamChat({
      system: useSystem,
      input: String(input),
      model,
      onDelta: () => {}, // 非流式：不逐字推送，最后一次性返回
    });

    const elapsedMs = Date.now() - startedAt;
    const tokens = usage && usage.completion_tokens != null
      ? usage.completion_tokens
      : Math.max(1, Math.round(text.length / 2));

    // 与 /api/run 保持一致：成功后写入历史
    db.insertRun({
      tool,
      model: model || DEFAULT_MODEL,
      input: String(input),
      output: text,
      elapsedMs,
    });

    res.json({ text, elapsedMs, tokens });
  } catch (err) {
    // 把上游错误信息透传给调用方，不要吞掉
    res.status(502).json({ ok: false, message: err && err.message ? err.message : String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[ai-toolbox] 服务已启动: http://localhost:${PORT}`);
  console.log(`[ai-toolbox] DEEPSEEK_API_KEY: ${process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置'}`);
});
