'use strict';

// DeepSeek 调用封装：只做流式（stream: true），逐块把增量文本回调出去。
// 上游返回非 200 时，把 DeepSeek 的原始报错信息原样抛出，绝不吞掉。

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

// 允许的模型白名单：本账号实际可用的两个名字。
const ALLOWED_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
const DEFAULT_MODEL = 'deepseek-flash';

function normalizeBaseUrl(base) {
  const b = (base && String(base).trim()) || DEFAULT_BASE_URL;
  return b.replace(/\/+$/, '');
}

// 从上游错误响应里尽量提取可读信息（优先 JSON 的 error.message）。
function extractUpstreamError(status, rawText) {
  let detail = rawText;
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && parsed.error) {
      detail = parsed.error.message || JSON.stringify(parsed.error);
    } else if (parsed && parsed.message) {
      detail = parsed.message;
    }
  } catch (_) {
    // 不是 JSON，就用原文
  }
  return `DeepSeek 接口返回 ${status}：${detail || '（无错误详情）'}`;
}

/**
 * 流式调用 DeepSeek。
 * @param {object} opts
 * @param {string} opts.system   系统提示词
 * @param {string} opts.input    用户输入
 * @param {string} [opts.model]  模型名
 * @param {AbortSignal} [opts.signal] 中断信号，用户点停止 / 连接关闭时触发
 * @param {(text:string)=>void} opts.onDelta 每收到一段增量文本时回调
 * @returns {Promise<{text:string, usage:object|null}>} 完整文本与 usage（上游可能不返回）
 */
async function streamChat({ system, input, model, signal, onDelta }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('服务端未配置 DEEPSEEK_API_KEY，无法调用模型');
  }

  const useModel = ALLOWED_MODELS.includes(model) ? model : DEFAULT_MODEL;
  const url = `${normalizeBaseUrl(process.env.DEEPSEEK_BASE_URL)}/chat/completions`;

  const body = {
    model: useModel,
    messages: [
      { role: 'system', content: String(system || '') },
      { role: 'user', content: String(input || '') },
    ],
    stream: true,
    stream_options: { include_usage: true },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(extractUpstreamError(res.status, raw));
  }

  if (!res.body) {
    throw new Error('DeepSeek 接口未返回流式响应体');
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';
  let usage = null;

  // 手动读取 ReadableStream，按 SSE 行解析：每行形如 `data: {...}`。
  const reader = res.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      // 按换行切分，最后一段可能不完整，留在 buffer 里等下一块。
      while ((idx = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        line = line.replace(/\r$/, '').trim();
        if (!line || !line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch (_) {
          continue; // 忽略无法解析的分片
        }

        if (json.usage) usage = json.usage;

        const choice = json.choices && json.choices[0];
        const delta = choice && choice.delta && choice.delta.content;
        if (delta) {
          fullText += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
      }
    }
  } finally {
    // 无论正常结束还是被中断，都释放 reader。
    try {
      reader.releaseLock();
    } catch (_) {
      /* ignore */
    }
  }

  return { text: fullText, usage };
}

module.exports = { streamChat, ALLOWED_MODELS, DEFAULT_MODEL };
