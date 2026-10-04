'use strict';

// 前端逻辑：零构建原生 JS。通过 fetch + ReadableStream 读取后端 SSE，逐字渲染。
// 注意：这里不会出现任何 API Key，密钥只存在于服务端。

// 4 个工具及其默认系统提示词（与 SPEC 一致）。
const TOOLS = {
  rewrite: {
    name: '智能改写',
    system: '你是一个改写助手。在保留原意的前提下改写用户文本：去掉 AI 味，让它更口语、更自然。只输出改写后的正文，不要任何解释。',
  },
  xiaohongshu: {
    name: '小红书文案',
    system: '你是小红书文案写手。输出格式：先给 3 个标题候选（每行一个，带 emoji），然后正文（带 emoji、分段），结尾给 5 个话题标签。',
  },
  script: {
    name: '口播稿',
    system: '你是短视频口播稿写手。输出可直接照读的口播稿：前 3 秒钩子 + 正文分段 + 结尾引导互动，全部用口语化短句。',
  },
  translate: {
    name: '中英互译',
    system: '你是中英互译助手。自动判断输入是中文还是英文：中文译成英文，英文译成中文。只输出译文；中文译英文时，额外给一版「口语版」。',
  },
};

const el = {
  tabs: document.getElementById('tabs'),
  system: document.getElementById('system'),
  input: document.getElementById('input'),
  runBtn: document.getElementById('run-btn'),
  resetSystem: document.getElementById('reset-system'),
  output: document.getElementById('output'),
  copyBtn: document.getElementById('copy-btn'),
  meta: document.getElementById('meta'),
  model: document.getElementById('model'),
  historyList: document.getElementById('history-list'),
  refreshHistory: document.getElementById('refresh-history'),
  healthBadge: document.getElementById('health-badge'),
  configWarning: document.getElementById('config-warning'),
  toast: document.getElementById('toast'),
};

let currentTool = 'rewrite';
let running = false;
let controller = null;
let hasKey = true;
let waitTimer = null;
let waiting = false;
// 流式输出是否跟随到底部：用户手动上滚后就不再强制打断。
let stickToBottom = true;

// 每个工具单独记住用户改过的提示词，切 tab 不丢。
const systemByTool = {};
Object.keys(TOOLS).forEach((k) => { systemByTool[k] = TOOLS[k].system; });

function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.toast.hidden = true; }, 1600);
}

function setRunningUI(isRunning) {
  running = isRunning;
  el.runBtn.textContent = isRunning ? '停止' : '生成';
  el.runBtn.classList.toggle('btn-stop', isRunning);
  el.runBtn.classList.toggle('btn-primary', !isRunning);
}

// 首字到达前的等待态：显示「思考中… 已等待 N 秒」，每 200ms 刷新一次。
function startWaiting() {
  waiting = true;
  const t0 = Date.now();
  el.output.classList.add('waiting');
  el.output.textContent = '思考中… 已等待 0 秒';
  clearInterval(waitTimer);
  waitTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - t0) / 1000);
    el.output.textContent = `思考中… 已等待 ${secs} 秒`;
    if (stickToBottom) el.output.scrollTop = el.output.scrollHeight;
  }, 200);
}

// 首个字符、done 或 error 到达后清除等待态。
function stopWaiting() {
  clearInterval(waitTimer);
  waitTimer = null;
  if (!waiting) return;
  waiting = false;
  el.output.classList.remove('waiting');
  el.output.textContent = '';
}

function switchTool(tool) {
  if (!TOOLS[tool]) return;
  currentTool = tool;
  Array.from(el.tabs.children).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  el.system.value = systemByTool[tool];
}

// 点击 tab
el.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) switchTool(btn.dataset.tool);
});

// 编辑系统提示词时暂存
el.system.addEventListener('input', () => {
  systemByTool[currentTool] = el.system.value;
});

el.resetSystem.addEventListener('click', () => {
  systemByTool[currentTool] = TOOLS[currentTool].system;
  el.system.value = TOOLS[currentTool].system;
  showToast('已恢复默认提示词');
});

// 复制输出
el.copyBtn.addEventListener('click', async () => {
  const text = el.output.textContent || '';
  if (!text) { showToast('暂无内容可复制'); return; }
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch (_) {
    // 剪贴板 API 在非安全上下文可能不可用，降级用 textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('已复制到剪贴板'); }
    catch (e2) { showToast('复制失败'); }
    document.body.removeChild(ta);
  }
});

// 记录用户是否还在底部附近，用于决定是否自动跟随滚动。
el.output.addEventListener('scroll', () => {
  stickToBottom = el.output.scrollHeight - el.output.scrollTop - el.output.clientHeight < 24;
});

// 生成 / 停止
el.runBtn.addEventListener('click', () => {
  if (running) {
    if (controller) controller.abort();
    return;
  }
  run();
});

async function run() {
  const input = el.input.value.trim();
  if (!input) { showToast('请先输入内容'); return; }
  if (!hasKey) { showToast('服务端未配置模型密钥'); return; }

  controller = new AbortController();
  setRunningUI(true);
  el.output.textContent = '';
  el.meta.textContent = '生成中…';
  stickToBottom = true;
  startWaiting();

  const started = Date.now();
  let received = 0;

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: currentTool,
        system: el.system.value,
        input,
        model: el.model.value,
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const msg = await res.text().catch(() => '');
      throw new Error(`请求失败（${res.status}）${msg ? '：' + msg : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    // 逐块解析 SSE：每行 `data: {...}`
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        line = line.replace(/\r$/, '').trim();
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;

        let evt;
        try { evt = JSON.parse(payload); } catch (_) { continue; }

        if (evt.type === 'delta' && evt.text) {
          if (waiting) stopWaiting();          // 首字到达，撤掉等待态
          received += evt.text.length;
          el.output.textContent += evt.text;   // 逐字追加，形成打字机效果
          if (stickToBottom) el.output.scrollTop = el.output.scrollHeight;
        } else if (evt.type === 'done') {
          stopWaiting();
          const secs = (evt.elapsedMs / 1000).toFixed(2);
          const tokenText = evt.tokensEstimated ? `~${evt.tokens} tokens（估算）` : `${evt.tokens} tokens`;
          el.meta.textContent = `耗时 ${secs}s · ${evt.chars} 字 · ${tokenText}`;
          loadHistory();
        } else if (evt.type === 'error') {
          throw new Error(evt.message || '生成失败');
        }
      }
    }
  } catch (err) {
    stopWaiting();   // 出错或用户停止时同样撤掉等待态
    if (err.name === 'AbortError') {
      const secs = ((Date.now() - started) / 1000).toFixed(2);
      el.meta.textContent = `已停止 · 耗时 ${secs}s · 已输出 ${received} 字`;
    } else {
      el.meta.textContent = '生成失败';
      showToast(err.message || '生成失败');
      el.output.textContent += (el.output.textContent ? '\n\n' : '') + '[错误] ' + (err.message || '生成失败');
    }
  } finally {
    stopWaiting();   // 流异常结束时兜底清除等待态
    setRunningUI(false);
    controller = null;
  }
}

// ===== 历史记录 =====

async function loadHistory() {
  try {
    const res = await fetch('/api/history?limit=50');
    const data = await res.json();
    renderHistory(data.items || []);
  } catch (_) {
    /* 忽略历史加载失败 */
  }
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderHistory(items) {
  el.historyList.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'history-empty';
    li.textContent = '暂无历史记录';
    el.historyList.appendChild(li);
    return;
  }
  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'history-item';

    const main = document.createElement('div');
    main.className = 'history-main';
    const title = document.createElement('div');
    title.className = 'history-title';
    const toolName = (TOOLS[item.tool] && TOOLS[item.tool].name) || item.tool || '未知';
    title.textContent = `【${toolName}】${(item.input || '').slice(0, 20)}`;
    const sub = document.createElement('div');
    sub.className = 'history-sub';
    sub.textContent = fmtTime(item.created_at);
    main.appendChild(title);
    main.appendChild(sub);

    // 点击回填输入并展示当年的输出
    main.addEventListener('click', () => {
      if (TOOLS[item.tool]) switchTool(item.tool);
      el.input.value = item.input || '';
      el.output.textContent = item.output || '';
      el.meta.textContent = `历史记录 · 耗时 ${(item.elapsed_ms / 1000).toFixed(2)}s · ${(item.output || '').length} 字`;
    });

    const del = document.createElement('button');
    del.className = 'history-del';
    del.type = 'button';
    del.textContent = '删除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await fetch(`/api/history/${item.id}`, { method: 'DELETE' });
        loadHistory();
      } catch (_) {
        showToast('删除失败');
      }
    });

    li.appendChild(main);
    li.appendChild(del);
    el.historyList.appendChild(li);
  });
}

el.refreshHistory.addEventListener('click', loadHistory);

// ===== 启动时检查健康状态 =====

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    hasKey = Boolean(data.hasKey);
    if (hasKey) {
      el.healthBadge.textContent = '服务正常';
      el.healthBadge.className = 'badge badge-ok';
      el.configWarning.hidden = true;
    } else {
      el.healthBadge.textContent = '未配置密钥';
      el.healthBadge.className = 'badge badge-bad';
      el.configWarning.hidden = false;
    }
    if (data.model) el.model.value = data.model;
  } catch (_) {
    el.healthBadge.textContent = '服务不可用';
    el.healthBadge.className = 'badge badge-bad';
  }
}

// 初始化
switchTool('rewrite');
checkHealth();
loadHistory();
