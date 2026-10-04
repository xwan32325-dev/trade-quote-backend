'use strict';

// 实时汇率：多源回退 + 内存/磁盘缓存。
// 说明：免费公开源给的是参考汇率（ECB / exchangerate-api），不是银行现汇价，
// 实际结汇仍以银行牌价为准，因此前端必须显示来源与时间，并允许手动覆盖。

const fs = require('node:fs');
const path = require('node:path');

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟
const TIMEOUT_MS = 6000;
const CACHE_FILE = path.join(__dirname, '..', 'data', 'fx.json');

let memCache = null; // { key, payload, fetchedAt }

function readDiskCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeDiskCache(obj) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    // 写缓存失败不影响主流程
  }
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 把各源五花八门的日期统一成 YYYY-MM-DD，前端只按一种格式显示 */
function toIsoDate(input) {
  if (!input) return null;

  const s = String(input).trim();
  const direct = s.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;

  const parsed = new Date(s);

  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return s.slice(0, 16);
}

// 源 1：frankfurter（ECB 数据，能一次拿到最近两个交易日 → 可算涨跌）
async function fromFrankfurter(base, quote) {
  const start = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const data = await fetchJson(`https://api.frankfurter.app/${start}..?from=${base}&to=${quote}`);
  const dates = Object.keys(data.rates || {}).sort();

  if (dates.length === 0) throw new Error('frankfurter 无数据');

  const lastDate = dates[dates.length - 1];
  const prevDate = dates.length > 1 ? dates[dates.length - 2] : null;
  const rate = data.rates[lastDate][quote];
  const previousRate = prevDate ? data.rates[prevDate][quote] : null;

  return {
    rate,
    previousRate,
    sourceDate: lastDate,
    source: 'frankfurter.app (ECB)',
  };
}

/** 有效数字个数：用来判断某个源给的汇率够不够精细 */
function significantDigits(n) {
  if (!Number.isFinite(n) || n === 0) return 0;

  const mantissa = Math.abs(n)
    .toExponential()
    .replace(/e.*$/, '')
    .replace('.', '')
    .replace(/0+$/, '');

  return mantissa.length;
}

// 源 2：open.er-api.com（覆盖币种最全，但部分小币种给的有效数字很少，
// 例如 CNY->RUB 只给 12.5。这里正反两个方向都取，选有效数字更多的那个）
async function fromErApi(base, quote) {
  const [direct, inverse] = await Promise.all([
    fetchJson(`https://open.er-api.com/v6/latest/${base}`).catch(() => null),
    fetchJson(`https://open.er-api.com/v6/latest/${quote}`).catch(() => null),
  ]);

  const directRate = direct && direct.rates && direct.rates[quote];
  const inverseRate = inverse && inverse.rates && inverse.rates[base];
  const candidates = [];

  if (directRate) candidates.push({ rate: directRate, viaInverse: false });

  if (inverseRate) candidates.push({ rate: 1 / inverseRate, viaInverse: true });

  if (candidates.length === 0) throw new Error('open.er-api 无数据');

  candidates.sort((a, b) => significantDigits(b.rate) - significantDigits(a.rate));

  const best = candidates[0];

  return {
    rate: best.rate,
    previousRate: null,
    sourceDate: toIsoDate((direct && direct.time_last_update_utc) || (inverse && inverse.time_last_update_utc)),
    source: 'open.er-api.com' + (best.viaInverse ? '（倒数换算）' : ''),
  };
}

// 源 3：exchangerate-api.com v4（老接口，作为最后兜底）
async function fromExchangerateApi(base, quote) {
  const data = await fetchJson(`https://api.exchangerate-api.com/v4/latest/${base}`);
  const rate = data && data.rates && data.rates[quote];

  if (!rate) throw new Error('exchangerate-api 无数据');

  return {
    rate,
    previousRate: null,
    sourceDate: (data.date || '').slice(0, 10) || null,
    source: 'exchangerate-api.com',
  };
}

const SOURCES = [fromFrankfurter, fromErApi, fromExchangerateApi];

/**
 * 取汇率。命中 30 分钟缓存直接返回；否则依次尝试多个源。
 * 全部失败时退回磁盘上最后一次成功的值（stale= true），再不行才报错。
 */
async function getRate(base = 'USD', quote = 'CNY', { force = false } = {}) {
  const key = `${base}_${quote}`;
  const now = Date.now();

  if (!force && memCache && memCache.key === key && now - memCache.fetchedAt < CACHE_TTL_MS) {
    return { ...memCache.payload, cached: true, ageMs: now - memCache.fetchedAt };
  }

  const errors = [];
  const candidates = [];

  /*
   * 跨源择优：依次尝试各源，只要有一个给出足够精细的汇率（≥5 位有效数字）就停；
   * 否则把所有源的结果都拿到手，选有效数字最多的那个。
   * 例：IDR 在 ECB 只有 2 位有效数字，但 er-api 取倒数能得到 15 位，就该用后者。
   */
  for (const source of SOURCES) {
    try {
      const r = await source(base, quote);
      const digits = significantDigits(r.rate);

      candidates.push({ ...r, digits });

      if (digits >= 5) break;
    } catch (err) {
      errors.push(`${source.name}: ${err.message}`);
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.digits - a.digits);

    const best = candidates[0];
    const change = best.previousRate ? best.rate - best.previousRate : null;
    const digits = best.digits;
    const payload = {
      base,
      quote,
      rate: Number(best.rate.toPrecision(10)),
      previousRate: best.previousRate != null ? Number(best.previousRate.toPrecision(10)) : null,
      change: change != null ? Number(change.toPrecision(6)) : null,
      changePct: change != null && best.previousRate ? Number(((change / best.previousRate) * 100).toFixed(3)) : null,
      source: best.source,
      sourceDate: best.sourceDate,
      significantDigits: digits,
      // 有效数字太少时提示前端：这个币种的公开汇率源精度有限，别直接拿去签合同
      lowPrecision: digits > 0 && digits < 4,
      fetchedAt: new Date().toISOString(),
      stale: false,
    };

    memCache = { key, payload, fetchedAt: now };
    writeDiskCache({ key, payload, fetchedAt: now });

    return { ...payload, cached: false };
  }

  // 全部源失败 → 用磁盘上最后一次成功的值
  const disk = readDiskCache();

  if (disk && disk.key === key && disk.payload) {
    return { ...disk.payload, stale: true, cached: true, errors };
  }

  const e = new Error(`所有汇率源都失败了：${errors.join('; ')}`);

  e.errors = errors;
  throw e;
}

module.exports = { getRate, CACHE_TTL_MS };
