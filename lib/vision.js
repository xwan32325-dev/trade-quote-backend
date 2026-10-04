'use strict';

// 拍照填单：把单据照片交给 deepseek-flash 做结构化抽取。
// 只做「识别 → 返回字段」，是否覆盖表单由前端决定。

const { VISION_MODEL } = require('./deepseek');

const MAX_BASE64_CHARS = 12 * 1024 * 1024; // 约 9MB 图片，够手机拍照压缩后用
const TIMEOUT_MS = 90000;

const FIELDS_PROMPT = `你是外贸单据识别助手。请从这张图片（可能是采购单、形式发票、装箱单或报价单）中提取字段。

只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。格式：
{
  "productName": "产品名称（含规格型号）",
  "customerName": "客户名称：优先取买方/采购商/收货人；单据上只有供应商时才填供应商",
  "qty": 数量（数字，单位：件）,
  "price": 采购含税单价（数字，单位：人民币元/件）,
  "currency": "若单据以人民币计价填 CNY，否则填币种代码如 USD/EUR",
  "vatRate": 增值税率（数字，百分数，如 13）,
  "rebateRate": 出口退税率（数字，百分数）,
  "cartonL": 外箱长（数字，厘米）,
  "cartonW": 外箱宽（数字，厘米）,
  "cartonH": 外箱高（数字，厘米）,
  "grossWeight": 单箱毛重（数字，千克）,
  "notes": "其它关键信息（交期、付款方式、贸易术语等，20字以内）"
}

规则（必须遵守）：
1. 图片里没有或看不清的字段，一律填 null —— **绝对不要猜测或编造数字**
2. 数字字段只填纯数字，不要带单位、货币符号或千分位
3. 若单据标注"不含税价"，请把该价格填进 price，并在 notes 里注明"不含税"
4. 若单据是外币报价，price 仍是该单据上的数字，currency 填对应币种
5. customerName 优先填**买方/采购商**（报价对象）；若图片里只有供应商，则填供应商，并在 notes 开头注明"单据为供应商单据"`;

async function parseImage(imageDataUrl, apiKey, baseUrl) {
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    throw new Error('图片格式不对：需要 data:image/... 的 base64 数据');
  }

  if (imageDataUrl.length > MAX_BASE64_CHARS) {
    throw new Error('图片太大了（压缩后请控制在 9MB 以内）');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: FIELDS_PROMPT },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 800,
        stream: false,
      }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      throw new Error('识别接口报错：' + msg);
    }

    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const fields = extractJson(text);

    return {
      fields,
      raw: text.slice(0, 800),
      elapsedMs: Date.now() - startedAt,
      tokens: data && data.usage ? data.usage.completion_tokens : null,
      model: VISION_MODEL,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 模型偶尔会包 ```json 或加解释，这里做容错抽取 */
function extractJson(text) {
  if (!text) return {};

  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) return {};

  try {
    return normalize(JSON.parse(s.slice(start, end + 1)));
  } catch (e) {
    return {};
  }
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;

  const n = Number(String(v).replace(/[,\s¥$€£]/g, ''));

  return Number.isFinite(n) ? n : null;
}

function toTextOrNull(v) {
  if (v === null || v === undefined) return null;

  const s = String(v).trim();

  return s && s.toLowerCase() !== 'null' ? s.slice(0, 120) : null;
}

/** 白名单字段 + 类型规整，避免模型返回脏数据污染表单 */
function normalize(obj) {
  return {
    productName: toTextOrNull(obj.productName),
    customerName: toTextOrNull(obj.customerName),
    qty: toNumberOrNull(obj.qty),
    price: toNumberOrNull(obj.price),
    currency: toTextOrNull(obj.currency) ? String(obj.currency).trim().toUpperCase().slice(0, 3) : null,
    vatRate: toNumberOrNull(obj.vatRate),
    rebateRate: toNumberOrNull(obj.rebateRate),
    cartonL: toNumberOrNull(obj.cartonL),
    cartonW: toNumberOrNull(obj.cartonW),
    cartonH: toNumberOrNull(obj.cartonH),
    grossWeight: toNumberOrNull(obj.grossWeight),
    notes: toTextOrNull(obj.notes),
  };
}

module.exports = { parseImage };
