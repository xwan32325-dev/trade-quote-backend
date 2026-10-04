'use strict';

// 简易内存限流：H5 试用版会暴露到公网，防止有人刷爆 DeepSeek 额度。
// 单 IP：每 5 分钟最多 30 次；全局：每天最多 600 次。

const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const MAX_PER_DAY = 600;

const hits = new Map(); // ip -> [timestamps]
let dayKey = '';
let dayCount = 0;

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @returns {{ok:true, remainingToday:number} | {ok:false, message:string}}
 */
function check(ip) {
  const now = Date.now();
  const d = today();

  if (d !== dayKey) {
    dayKey = d;
    dayCount = 0;
  }

  if (dayCount >= MAX_PER_DAY) {
    return { ok: false, message: `今日试用额度已用完（${MAX_PER_DAY} 次），请明天再试` };
  }

  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);

  if (list.length >= MAX_PER_WINDOW) {
    return { ok: false, message: '请求太频繁了，休息几分钟再试' };
  }

  list.push(now);
  hits.set(ip, list);
  dayCount++;

  // 顺手清理过期记录，避免内存增长
  if (hits.size > 2000) {
    for (const [k, v] of hits) {
      const keep = v.filter((t) => now - t < WINDOW_MS);

      if (keep.length === 0) hits.delete(k);
      else hits.set(k, keep);
    }
  }

  return { ok: true, remainingToday: MAX_PER_DAY - dayCount };
}

function stats() {
  return { usedToday: dayCount, maxPerDay: MAX_PER_DAY, maxPerWindow: MAX_PER_WINDOW, windowMs: WINDOW_MS, trackedIps: hits.size };
}

module.exports = { check, stats };
