'use strict';

/*
 * 报价单 PDF：把报价数据渲染成正式单据（HTML → Edge 无头打印 PDF）。
 * 用 Edge/Chrome 打印的好处是中文排版、字体、分页都由浏览器保证，比手写 PDF 库可靠得多。
 */

const path = require('node:path');
const puppeteer = require('puppeteer-core');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let browserPromise = null;

function findBrowser() {
  const fs = require('node:fs');

  for (const p of EDGE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error('没找到 Edge/Chrome，无法生成 PDF');
}

/** 复用一个浏览器实例，避免每次导出都冷启动 */
async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;

      if (b.connected) return b;
    } catch (e) {
      // 掉线了，重建
    }
  }

  browserPromise = puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });

  return browserPromise;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  const v = Number(n);

  if (!Number.isFinite(v)) return '0.00';

  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 单价格式化：至少 2 位、最多 6 位小数，按实际精度显示。
 * 低单价大批量时必须显示到 4~6 位，否则「单价 × 数量 = 金额」在单据上对不上。
 */
function price(n) {
  const v = Number(n);

  if (!Number.isFinite(v)) return '0.00';

  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function rate(n) {
  const v = Number(n);

  if (!Number.isFinite(v) || v <= 0) return '-';

  if (v >= 1) return v.toFixed(4);

  const digits = v >= 0.01 ? 5 : v >= 0.001 ? 6 : v >= 0.0001 ? 7 : 8;

  return v.toFixed(digits);
}

const TERM_FULL = {
  EXW: 'Ex Works（工厂交货）',
  FAS: 'Free Alongside Ship（船边交货）',
  FOB: 'Free on Board（船上交货）',
  CFR: 'Cost and Freight（成本加运费）',
  CIF: 'Cost, Insurance and Freight（成本、保险费加运费）',
  FCA: 'Free Carrier（货交承运人）',
  CPT: 'Carriage Paid To（运费付至）',
  CIP: 'Carriage and Insurance Paid To（运费加保险费付至）',
  DAP: 'Delivered at Place（目的地交货）',
  DPU: 'Delivered at Place Unloaded（卸货地交货）',
  DDP: 'Delivered Duty Paid（完税后交货）',
};

function buildHtml({ quote, company }) {
  const c = company || {};
  const q = quote || {};
  const currency = esc(q.currency || 'USD');
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const validUntil = new Date(today.getTime() + 30 * 24 * 3600 * 1000);
  const validStr = `${validUntil.getFullYear()}-${String(validUntil.getMonth() + 1).padStart(2, '0')}-${String(validUntil.getDate()).padStart(2, '0')}`;

  // 支持多产品：优先用 items[]，没有则退回单产品的扁平字段
  const rawItems = Array.isArray(q.items) && q.items.length > 0
    ? q.items
    : [{ productName: q.productName, qty: q.qty, unitPrice: q.unitPrice, totalPrice: q.totalPrice }];

  const items = rawItems.map((it) => {
    const qty = Number(it.qty) || 0;
    const unit = Number(it.unitPrice) || 0;
    const amount = Number.isFinite(Number(it.totalPrice)) && it.totalPrice != null ? Number(it.totalPrice) : unit * qty;

    return { productName: it.productName || '-', qty, unitPrice: unit, amount, spec: it.spec || '' };
  });

  const grandTotal = items.reduce((s, it) => s + it.amount, 0);
  const multi = items.length > 1;

  const term = esc(q.tradeTerm || 'FOB');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; margin: 0; padding: 0; color: #111; }
  .page { width: 210mm; min-height: 297mm; padding: 18mm 16mm; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1f2937; padding-bottom: 10px; }
  .company { font-size: 20px; font-weight: 700; }
  .company-sub { font-size: 11px; color: #4b5563; margin-top: 4px; line-height: 1.6; }
  .doc-title { text-align: right; }
  .doc-title h1 { margin: 0; font-size: 26px; letter-spacing: 2px; }
  .doc-title .en { font-size: 12px; color: #6b7280; letter-spacing: 1px; }
  .meta { display: flex; justify-content: space-between; margin-top: 14px; font-size: 12px; line-height: 1.9; }
  .meta .label { color: #6b7280; display: inline-block; width: 62px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
  th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.idx { width: 34px; text-align: center; color: #6b7280; }
  .total-row td { font-weight: 700; background: #fafafa; }
  .amount { margin-top: 14px; font-size: 13px; }
  .amount b { font-size: 16px; }
  .terms { margin-top: 18px; font-size: 12px; line-height: 1.9; }
  .terms h3 { font-size: 13px; margin: 0 0 6px; }
  .note { margin-top: 14px; font-size: 11px; color: #4b5563; line-height: 1.8; }
  .sign { margin-top: 34px; display: flex; justify-content: space-between; font-size: 12px; }
  .sign .box { width: 45%; border-top: 1px solid #9ca3af; padding-top: 6px; color: #6b7280; }
  .footer { margin-top: 22px; border-top: 1px solid #e5e7eb; padding-top: 8px; font-size: 10px; color: #9ca3af; text-align: center; }
</style>
</head>
<body>
<div class="page">
  <div class="head">
    <div>
      <div class="company">${esc(c.name || '（请填写公司名称）')}</div>
      <div class="company-sub">
        ${c.address ? esc(c.address) + '<br/>' : ''}
        ${c.contact ? '联系人：' + esc(c.contact) + '　' : ''}${c.phone ? '电话：' + esc(c.phone) + '<br/>' : ''}
        ${c.email ? '邮箱：' + esc(c.email) + '　' : ''}${c.website ? '网址：' + esc(c.website) : ''}
      </div>
    </div>
    <div class="doc-title">
      <h1>报价单</h1>
      <div class="en">QUOTATION</div>
    </div>
  </div>

  <div class="meta">
    <div>
      <div><span class="label">客户：</span>${esc(q.customerName || '-')}</div>
      <div><span class="label">报价日期：</span>${dateStr}</div>
    </div>
    <div>
      <div><span class="label">币种：</span>${currency}</div>
      <div><span class="label">有效期至：</span>${validStr}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="idx">#</th>
        <th>产品名称 / 规格</th>
        <th class="num">数量</th>
        <th class="num">单价</th>
        <th class="num">金额</th>
      </tr>
    </thead>
    <tbody>
      ${items.map((it, i) => `<tr>
        <td class="idx">${i + 1}</td>
        <td>${esc(it.productName)}</td>
        <td class="num">${it.qty.toLocaleString('en-US')} 件</td>
        <td class="num">${currency} ${price(it.unitPrice)}</td>
        <td class="num">${currency} ${money(it.amount)}</td>
      </tr>`).join('\n      ')}
      <tr class="total-row">
        <td colspan="4">${multi ? '合计金额（' + items.length + ' 项）' : '合计金额'}</td>
        <td class="num">${currency} ${money(grandTotal)}</td>
      </tr>
    </tbody>
  </table>

  <div class="amount">报价金额：<b>${currency} ${money(grandTotal)}</b></div>

  <div class="terms">
    <h3>贸易条件</h3>
    <div>贸易方式：${term}　—　${esc(TERM_FULL[q.tradeTerm] || '')}</div>
    <div>运输方式：${esc(q.transportMode || '-')}${q.multimodalText ? '（' + esc(q.multimodalText) + '）' : ''}</div>
    <div>结算币种：${currency}　汇率：1 ${currency} = ${rate(q.exchangeRate)} CNY</div>
    ${multi ? '<div>注：运费、保险费等整票费用已按各产品货值比例分摊到单价中。</div>' : ''}
  </div>

  <div class="note">
    ${q.remark ? '备注：' + esc(q.remark) + '<br/>' : ''}
    1. 以上价格以人民币汇率 ${rate(q.exchangeRate)} 折算，如遇汇率大幅波动，双方另行协商。<br/>
    2. 本报价有效期为自发之日起 30 天，逾期需重新确认。<br/>
    3. 未尽事宜以双方签订的正式合同为准。
  </div>

  <div class="sign">
    <div class="box">报价方（盖章）</div>
    <div class="box">客户确认（签字）</div>
  </div>

  <div class="footer">本报价单由「外贸算价助手」生成 · ${dateStr}</div>
</div>
</body>
</html>`;
}

/** 生成 PDF，返回 Buffer */
async function renderQuotePdf(data) {
  const html = buildHtml(data);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });

    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

/** 同一份 HTML 也用来出图片（小程序/H5 预览、或直接发图给客户） */
async function renderQuotePng(data, { width = 900 } = {}) {
  const html = buildHtml(data);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width, height: 1200, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    const buf = await page.screenshot({ fullPage: true, type: 'png' });

    return Buffer.from(buf);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { renderQuotePdf, renderQuotePng, buildHtml };
