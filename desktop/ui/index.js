// 左侧工具台逻辑：读取页面 → AI 分析 → 人工确认 → 逐步执行（右侧实时可见）
const $ = (id) => document.getElementById(id);

const ACTION_LABEL = {
  click: '点击',
  fill: '填写',
  select: '选择',
  check: '勾选',
  scroll: '滚动',
  wait: '等待',
  extract: '读取',
};

const state = {
  snapshot: null,
  questions: [],
  qMap: new Map(),
  answers: [],
  checked: new Set(),
  running: false,
  stale: false,
  browser: null,
  serverBase: 'http://127.0.0.1:8787',
  models: [],
  vendors: new Map(),
};

// 答题参数（控制台可调，存 localStorage）
const QUIZ_DEFAULTS = { batchSize: 10, concurrency: 2, review: 0.7, autoApply: false, autoSave: false };
const quizOptions = { ...QUIZ_DEFAULTS };

// 智能自动滚动：用户手动向上滚时自动暂停，滚回底部或点按钮时恢复
const autoScroll = {
  logsLocked: false,   // 用户手动锁（点按钮）
  logsPaused: false,   // 用户手动向上滚时自动暂停
  answersLocked: false,
  answersPaused: false,

  // 给某个可滚动容器绑定自动滚动+智能暂停
  bind(container, onPause) {
    if (!container) return;
    container.addEventListener('wheel', () => {
      autoScroll.logsPaused = true;
      autoScroll._refreshBtn();
      if (onPause) onPause();
    }, { passive: true });
    container.addEventListener('touchmove', () => {
      autoScroll.logsPaused = true;
      autoScroll._refreshBtn();
      if (onPause) onPause();
    }, { passive: true });
    container.addEventListener('scroll', () => {
      // 接近底部（距底 < 40px）时自动恢复
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distFromBottom < 40) {
        autoScroll.logsPaused = false;
        autoScroll._refreshBtn();
      }
    }, { passive: true });
  },

  shouldScroll() { return !autoScroll.logsLocked && !autoScroll.logsPaused; },

  forceScroll(container) {
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  },

  toggle() {
    autoScroll.logsLocked = !autoScroll.logsLocked;
    autoScroll.logsPaused = false;
    autoScroll._refreshBtn();
    if (autoScroll.logsLocked) {
      $('autoScroll').title = '已暂停自动滚动（点击恢复）';
    } else {
      $('autoScroll').title = '自动滚动已开启（运行时手动向上滚可暂停）';
      autoScroll.forceScroll($('logs'));
    }
  },

  _refreshBtn() {
    const btn = $('autoScroll');
    if (!btn) return;
    if (autoScroll.logsLocked) {
      btn.textContent = '⏸';
      btn.style.color = '#ffb4b4';
      btn.style.borderColor = 'rgba(239,91,91,0.3)';
    } else if (autoScroll.logsPaused) {
      btn.textContent = '⏩';
      btn.style.color = '#f5b544';
      btn.style.borderColor = 'rgba(245,181,68,0.3)';
    } else {
      btn.textContent = '⏩';
      btn.style.color = '#8fe3c0';
      btn.style.borderColor = 'rgba(61,220,151,0.3)';
    }
  },
};

/* ------------------------------------------------------------------ 工具 */

const TYPE_LABEL = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
  fill: '填空',
  short: '简答',
};

function setButtonLabel(id, text) {
  const label = $(id).querySelector('.btn-label');
  if (label) label.textContent = text;
  else $(id).textContent = text;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function now() {
  const date = new Date();
  return date.toTimeString().slice(0, 8);
}

let logsEmpty = true;
function clearLogs() {
  const list = $('logs');
  list.innerHTML = '';
  logsEmpty = false;
  stepNodes.clear();
}

const stepNodes = new Map();

function appendLog(cls, text, spinning) {
  try {
    pilot.writeLog(`ui:${cls || 'info'}`, String(text ?? ''));
  } catch {
    // 日志落盘失败不影响界面
  }
  const list = $('logs');
  if (logsEmpty && list.children.length === 1 && list.firstElementChild.classList.contains('muted')) {
    list.innerHTML = '';
    logsEmpty = false;
  }
  const li = h('li', `log ${cls || 'info'}`);
  li.appendChild(h('span', 'log-time', now()));
  const icon = h('span', 'log-icon', spinning ? '' : cls === 'ok' ? '✓' : cls === 'fail' ? '✕' : cls === 'warn' ? '!' : '·');
  if (spinning) icon.appendChild(h('span', 'spin'));
  li.appendChild(icon);
  li.appendChild(h('span', 'log-text', text));
  list.appendChild(li);
  if (autoScroll.shouldScroll()) list.scrollTop = list.scrollHeight;
  return li;
}

function setServerStatus(ok, text) {
  $('serverDot').classList.toggle('ok', ok);
  $('serverDot').classList.toggle('bad', !ok);
  $('serverText').textContent = text;
}

function setStats(text, isError) {
  $('quizStats').textContent = text;
  $('quizStats').style.color = isError ? '#ff9a9a' : '';
}

function setHint(id, text, isError) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('error', Boolean(isError));
}

/* ------------------------------------------------------------------ 初始化 */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindTabs();
  bindNav();
  bindActions();
  loadQuizOptions();
  bindConsoleExtras();

  // 智能自动滚动绑定
  autoScroll.bind($('logs'));
  $('autoScroll').addEventListener('click', () => autoScroll.toggle());
  autoScroll._refreshBtn();

  // 运行面板折叠
  $('runCollapse').addEventListener('click', () => {
    $('runPanel').classList.toggle('collapsed');
  });
  // 点击头部（除按钮外）也能折叠
  $('runHead').addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    $('runPanel').classList.toggle('collapsed');
  });

  $('reloadBtn').addEventListener('click', () => {
    pilot.nav(state.browser?.loading ? 'stop' : 'reload');
  });

  pilot.onBrowserState((data) => {
    if (!data) return;
    state.browser = data;
    if (document.activeElement !== $('urlInput')) {
      $('urlInput').value = data.url && data.url !== 'about:blank' ? data.url : '';
    }
    $('backBtn').disabled = !data.canGoBack;
    $('fwdBtn').disabled = !data.canGoForward;
    $('reloadBtn').textContent = data.loading ? '✕' : '⟳';
    $('reloadBtn').title = data.loading ? '停止加载' : '刷新';
    $('loadBar').classList.toggle('on', Boolean(data.loading));

    if (state.snapshot && !state.running && data.url && data.url !== state.snapshot.url) {
      state.stale = true;
      setStats('页面已变化，请重新读取题目');
      $('applyAnswers').disabled = true;
    }
  });

  pilot.onBrowserNotice((notice) => {
    if (notice?.message) appendLog('warn', notice.message);
  });

  pilot.onRunEvent(handleRunEvent);

  pilot.onServerState((data) => {
    if (!data) return;
    applyServerState(data);
    if (data.ok) {
      loadSettings();
      loadModelList();
    }
  });

  loadModelList();
  loadSettings();
  renderAnswers();
  try {
    pilot.logPath().then((file) => {
      if (file) appendLog('muted', `运行日志自动保存：${file}`);
    }).catch(() => {});
  } catch {
    // 旧版主进程不支持日志路径时忽略
  }
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.pane === name);
  });
  for (const key of ['quiz', 'console']) {
    const pane = $(`pane-${key}`);
    if (pane) pane.hidden = key !== name;
  }
  if (name === 'console') {
    loadSettings();
    loadRuns();
    renderOverview();
    applyQuizOptionsToForm();
  }
  // 控制台页专注配置，收起运行日志，避免遮挡运行记录
  $('runPanel').hidden = name === 'console';
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.pane));
  });
}

function bindNav() {
  $('backBtn').addEventListener('click', () => pilot.nav('back'));
  $('fwdBtn').addEventListener('click', () => pilot.nav('forward'));
  $('goBtn').addEventListener('click', () => pilot.nav('goto', $('urlInput').value));
  $('urlInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') pilot.nav('goto', $('urlInput').value);
  });
  $('quickBtn').addEventListener('click', () => pilot.nav('goto', 'https://mooc1.chaoxing.com/'));
}

function bindActions() {
  $('settingsToggle').addEventListener('click', () => activateTab('console'));

  $('cfgSave').addEventListener('click', saveSettings);
  $('cfgClear').addEventListener('click', clearApiKey);
  $('runsRefresh').addEventListener('click', loadRuns);
  $('cfgKeyToggle').addEventListener('click', () => {
    const input = $('cfgKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('cfgKeyToggle').textContent = show ? '隐藏' : '显示';
  });

  $('testAi').addEventListener('click', async () => {
    const button = $('testAi');
    button.disabled = true;
    setHint('cfgHint', '正在调用 AI…');
    try {
      const res = await pilot.testAi();
      setHint('cfgHint', `连接成功 · ${res.model} · ${res.latencyMs} ms · ${res.reply}`);
      appendLog('ok', `AI 连接正常（${res.model}，${res.latencyMs} ms）`);
    } catch (error) {
      setHint('cfgHint', String(error.message || error), true);
      appendLog('fail', `AI 连接失败：${error.message || error}`);
    } finally {
      button.disabled = false;
    }
  });

  $('readBtn').addEventListener('click', () => readPage({ resetQuiz: true }));
  $('quizBtn').addEventListener('click', generateAnswers);
  $('applyAnswers').addEventListener('click', applyAnswers);

  $('cfgImportFile').addEventListener('click', () => $('cfgImportFileInput').click());
  $('cfgImportFileInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      $('cfgImportText').value = text.slice(0, 20000);
      applyImportedConfig(text);
    } catch (error) {
      setHint('cfgHint', `读取文件失败：${error.message || error}`, true);
    } finally {
      event.target.value = '';
    }
  });
  $('cfgImportCode').addEventListener('click', () => {
    const text = $('cfgImportText').value.trim();
    if (!text) {
      setHint('cfgHint', '请先粘贴配置代码，或点“导入配置文件”', true);
      return;
    }
    applyImportedConfig(text);
  });

  $('cfgProvider').addEventListener('change', () => {
    const vendor = $('cfgProvider').value;
    if (!vendor) {
      renderModelOptions('');
      return;
    }
    const info = state.vendors.get(vendor);
    if (!info) return;
    $('cfgBase').value = info.baseUrl;
    renderModelOptions(vendor);
    setHint('cfgHint', `已选择 ${vendor}，可继续选择该厂商的模型`);
  });
  $('cfgBase').addEventListener('input', syncProviderFromBase);

  $('stopBtn').addEventListener('click', async () => {
    await pilot.stop();
    appendLog('warn', '已请求停止，当前步骤完成后结束');
  });
}

/* ------------------------------------------------------------------ 后端 */

function applyServerState(data) {
  if (!data) return;
  if (data.base) state.serverBase = data.base;
  if (data.ok) {
    setServerStatus(true, data.started ? '服务已就绪' : '服务正常');
  } else {
    setServerStatus(false, data.error || '服务异常');
  }
}

async function loadModelList() {
  const datalist = $('modelList');
  const countEl = $('modelCount');
  if (!datalist) return;

  // 先填入内建的默认列表（离线也能用）
  const builtinDefaults = [
    'deepseek-chat', 'deepseek-reasoner', 'deepseek-flash',
    'Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.0-Pro',
    'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwq-32b-preview',
    'glm-5', 'glm-5-air', 'glm-4-plus',
    'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'o3-mini',
    'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k',
    'ernie-4.0-turbo-8k', 'ernie-3.5-8k',
    'yi-large', 'yi-medium',
    'step-1-64k', 'step-2',
    'qwen2.5:72b', 'qwen2.5:14b', 'deepseek-r1:14b',
  ];
  datalist.innerHTML = builtinDefaults
    .map((id) => `<option value="${id}">`)
    .join('');
  if (countEl) countEl.textContent = `· ${builtinDefaults.length}+ 候选`;

  // 后端就绪后拉取完整清单填充（走 IPC，避免页面 CSP 拦截本地请求）
  try {
    const json = await pilot.models();
    if (json && Array.isArray(json.flat) && json.flat.length) {
      state.models = json.flat;
      state.vendors = new Map();
      for (const m of json.flat) {
        if (!m.vendor || !m.baseUrl) continue;
        if (!state.vendors.has(m.vendor)) state.vendors.set(m.vendor, { baseUrl: m.baseUrl, models: [] });
        state.vendors.get(m.vendor).models.push(m.id);
      }
      renderProviderOptions();
      syncProviderFromBase();
    }
  } catch {
    // 后端未启动时保留默认列表，忽略错误
  }
}

function renderProviderOptions() {
  const select = $('cfgProvider');
  if (!select) return;
  const options = ['<option value="">自定义 / 手动填写</option>'];
  for (const [vendor, info] of state.vendors) {
    const host = info.baseUrl.replace(/^https?:\/\//, '');
    options.push(`<option value="${vendor}" title="${info.baseUrl}">${vendor} · ${host}</option>`);
  }
  select.innerHTML = options.join('');
}

function renderModelOptions(vendor) {
  const datalist = $('modelList');
  const countEl = $('modelCount');
  if (!datalist || !state.models.length) return;
  const list = vendor ? state.models.filter((m) => m.vendor === vendor) : state.models;
  datalist.innerHTML = list.map((m) => `<option value="${m.id}">${m.vendor} · ${m.name}</option>`).join('');
  if (countEl) countEl.textContent = `· ${list.length} 候选${vendor ? `（${vendor}）` : ''}`;
}

// 根据当前 Base URL 反查服务商；手动改地址时自动切回“自定义”
function syncProviderFromBase() {
  const select = $('cfgProvider');
  if (!select) return;
  const current = $('cfgBase').value.trim().replace(/\/+$/, '');
  let matched = '';
  for (const [vendor, info] of state.vendors) {
    if (info.baseUrl.replace(/\/+$/, '') === current) {
      matched = vendor;
      break;
    }
  }
  select.value = matched;
  renderModelOptions(matched);
}

/* ------------------------------------------------------------------ 配置导入 */

function pickConfigValue(raw, patterns) {
  for (const re of patterns) {
    const match = raw.match(re);
    if (match && match[1]) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

function extractAiConfig(text) {
  const raw = String(text || '');
  const protocol = /ANTHROPIC_|x-api-key/i.test(raw) ? 'anthropic' : 'openai';

  let baseUrl = pickConfigValue(raw, [
    /ANTHROPIC_BASE_URL\s*[:=]\s*["']?([^"'\s,;#]+)/i,
    /OPENAI_BASE_URL\s*[:=]\s*["']?([^"'\s,;#]+)/i,
    /["']?(?:base[_-]?url|baseURL|baseUrl|api[_-]?base)["']?\s*[:=]\s*["']?([^"'\s,;#]+)/i,
    /Base\s*URL\s*[:=]\s*["']?([^"'\s,;#]+)/i,
  ]) || pickConfigValue(raw, [/https?:\/\/[^\s"',;#]+/i]);

  baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/(?:chat\/completions|messages|models)$/i, '');
  if (baseUrl && !/\/v\d+[a-z0-9]*$/i.test(baseUrl)) baseUrl += '/v1';

  const apiKey = pickConfigValue(raw, [
    /["']?(?:api[_-]?key|apiKey)["']?\s*[:=]\s*["']?([^"'\s,;#]+)/i,
    /["']?(?:ANTHROPIC_AUTH_TOKEN|AUTH_TOKEN|OPENAI_API_KEY|auth[_-]?token)["']?\s*[:=]\s*["']?([^"'\s,;#]+)/i,
    /Bearer\s+([A-Za-z0-9._\-]{6,})/i,
    /\b(sk-[A-Za-z0-9._\-]{6,})/,
  ]);

  const model =
    pickConfigValue(raw, [
      /["']?(?:ANTHROPIC_MODEL|OPENAI_MODEL)["']?\s*[:=]\s*["']?([^"'\s,;#}]+)/i,
      /["']?(?:model|model_name|modelName)["']?\s*[:=]\s*["']?([^"'\s,;#}]+)/i,
    ]) ||
    pickConfigValue(raw, [
      /\b(deepseek[\w.\-]*|gpt-[\w.\-]+|o[13][\w.\-]*|glm-[\w.\-]+|qwen[\w.\-]*|doubao[\w.\-]*|claude[\w.\-]*|moonshot[\w.\-]*|gemini[\w.\-]*|yi-[\w.\-]+)\b/i,
    ]);

  const envKeyName = pickConfigValue(raw, [/["']?env_key["']?\s*[:=]\s*["']?([A-Za-z0-9_]+)/i]);
  return { baseUrl, apiKey, model, protocol, envKeyName };
}

function applyImportedConfig(text) {
  const cfg = extractAiConfig(text);
  const missing = [];
  if (cfg.baseUrl) $('cfgBase').value = cfg.baseUrl;
  else missing.push('Base URL');
  if (cfg.model) $('cfgModel').value = cfg.model;
  else missing.push('模型');
  if (cfg.apiKey) $('cfgKey').value = cfg.apiKey;
  else missing.push('API Key');

  const notes = [];
  if (cfg.protocol === 'anthropic') notes.push('来源是 Anthropic 协议，已按 OpenAI 兼容地址处理');
  if (cfg.apiKey && /(…|\.\.\.)/.test(cfg.apiKey)) notes.push('Key 看起来被省略，请补全后再保存');
  if (!cfg.apiKey && cfg.envKeyName) notes.push(`原配置的 Key 来自环境变量 ${cfg.envKeyName}，请填入实际值`);

  if (missing.length) {
    setHint(
      'cfgHint',
      `已导入部分配置，缺少：${missing.join('、')}（${notes.join('；') || '请手动补充'}）`,
      true,
    );
  } else {
    setHint('cfgHint', `导入成功，已填入 Base URL / Key / 模型${notes.length ? `（${notes.join('；')}）` : ''}，请点“保存”`);
  }
  appendLog('info', `已从文本解析 AI 配置：${cfg.baseUrl || '无地址'} · ${cfg.model || '无模型'}`);
  syncProviderFromBase();
}

async function loadSettings() {
  try {
    const settings = await pilot.settings();
    const ai = settings.ai || {};
    $('modelText').textContent = `${ai.model || '-'}${ai.hasApiKey ? '' : '（未配置 Key）'}`;
    $('cfgBase').value = ai.baseUrl || '';
    $('cfgModel').value = ai.model || '';
    $('cfgTemp').value = typeof ai.temperature === 'number' ? String(ai.temperature) : '0';
    $('cfgKey').value = '';
    $('cfgKey').placeholder = ai.hasApiKey
      ? `已配置（${ai.apiKeyMasked || '已保存'}），留空不修改`
      : '未配置，请填写 API Key';
    setHint(
      'cfgHint',
      ai.hasApiKey
        ? `当前 Key 来源：${ai.source === 'env' ? '环境变量' : '本地设置'}`
        : '还没有配置 Key，填写后点“保存”',
      !ai.hasApiKey,
    );
    setServerStatus(true, '服务正常');
    syncProviderFromBase();
  } catch (error) {
    setServerStatus(false, '服务异常');
  }
}

async function saveSettings() {
  const baseUrl = $('cfgBase').value.trim();
  const model = $('cfgModel').value.trim();
  const temperature = Number($('cfgTemp').value);
  const apiKey = $('cfgKey').value.trim();

  if (!baseUrl || !model) {
    setHint('cfgHint', 'Base URL 和模型不能为空', true);
    return;
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    setHint('cfgHint', '温度需要在 0 到 2 之间', true);
    return;
  }

  const button = $('cfgSave');
  button.disabled = true;
  try {
    const patch = { ai: { baseUrl, model, temperature } };
    if (apiKey) patch.ai.apiKey = apiKey;
    const res = await pilot.updateSettings(patch);
    if (!res.ok) throw new Error(res.error || '保存失败');
    setHint('cfgHint', '已保存');
    appendLog('ok', `AI 配置已更新：${model}`);
    button.textContent = '已保存';
    setTimeout(() => {
      button.textContent = '保存';
    }, 1200);
    await loadSettings();
  } catch (error) {
    setHint('cfgHint', String(error.message || error), true);
    appendLog('fail', `保存配置失败：${error.message || error}`);
  } finally {
    button.disabled = false;
  }
}

async function clearApiKey() {
  if (!window.confirm('确定清除已保存的 API Key？清除后需要重新填写才能调用 AI。')) return;
  const button = $('cfgClear');
  button.disabled = true;
  try {
    const res = await pilot.updateSettings({ clearApiKey: true });
    if (!res.ok) throw new Error(res.error || '清除失败');
    setHint('cfgHint', '已清除 API Key');
    appendLog('warn', '已清除 API Key');
    await loadSettings();
  } catch (error) {
    setHint('cfgHint', String(error.message || error), true);
  } finally {
    button.disabled = false;
  }
}

async function loadRuns() {
  const box = $('runsList');
  try {
    const res = await pilot.runs();
    if (!res.ok) throw new Error(res.error || '读取失败');
    renderRuns(res.runs || []);
  } catch (error) {
    box.innerHTML = '';
    box.appendChild(h('div', 'runs-empty', `读取运行记录失败：${error.message || error}`));
  }
}

function renderRuns(runs) {
  const box = $('runsList');
  box.innerHTML = '';
  if (!runs.length) {
    box.appendChild(h('div', 'runs-empty', '暂无运行记录：执行答题或自动操作后会出现在这里'));
    return;
  }

  runs.slice(0, 10).forEach((run) => {
    const item = h('div', 'run-item');
    item.appendChild(h('div', 'run-item-title', run.title || run.url || '未命名任务'));
    const meta = h('div', 'run-meta');
    meta.appendChild(h('span', '', run.mode === 'quiz' ? '答题' : '自动操作'));
    try {
      meta.appendChild(
        h(
          'span',
          '',
          new Date(run.createdAt).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }),
        ),
      );
    } catch {
      // 时间解析失败时省略
    }
    if (run.answers) meta.appendChild(h('span', '', `${run.answers} 条答案`));
    if (run.needsReview) meta.appendChild(h('span', '', `${run.needsReview} 待复核`));
    if (run.steps) meta.appendChild(h('span', '', `${run.steps} 步`));
    item.appendChild(meta);
    box.appendChild(item);
  });
}

/* ------------------------------------------------------------------ 读取 */

/* ------------------------------------------------------------------ DOM 文字质量检测与 OCR 补全 */

function questionIndex(stem) {
  const m = String(stem || '').match(/^\s*\(?\s*(\d{1,3})\s*[.、:：．)）]\s*/);
  return m ? parseInt(m[1], 10) : 0;
}

function optionTextBlank(question) {
  const options = question.options || [];
  return options.length > 0 && options.every((o) => !String(o.text || '').replace(/\s/g, '').length);
}

function optionKeysLookBroken(question) {
  const options = question.options || [];
  if (options.length < 2) return false;
  return options.some((o, i) => String(o.key || '').toUpperCase() !== String.fromCharCode(65 + i));
}

function stemLooksBroken(stem) {
  const text = String(stem || '');
  // 学习通字体反爬常把数字渲染成空白：{ , , , }
  if (/\{\s*(?:,\s*){2,}\}/.test(text)) return true;
  const noIndex = text.replace(/^\s*\(?\s*\d{1,3}\s*[.、:：．)）]\s*/, '');
  const meaningful = noIndex.replace(/[\s\p{P}\p{S}]/gu, '');
  return meaningful.length < 4;
}

function needsOcrText(questions) {
  if (!questions.length) return false;
  const withOptions = questions.filter((q) => (q.options || []).length > 0);
  const blank = withOptions.filter(optionTextBlank).length;
  const blankRatio = withOptions.length ? blank / withOptions.length : 0;
  const brokenStem = questions.filter((q) => stemLooksBroken(q.stem)).length;
  const brokenKeys = questions.filter(optionKeysLookBroken).length;
  return blankRatio >= 0.25 || brokenStem > 0 || brokenKeys > 0;
}

// OCR 结果只补文字/字母，保留 DOM 题的 elementId，确保后续能正确写回页面
function mergeOcrText(domQuestions, ocrQuestions) {
  const byIndex = new Map();
  for (const q of ocrQuestions) {
    const idx = questionIndex(q.stem);
    if (idx && !byIndex.has(idx)) byIndex.set(idx, q);
  }
  let merged = 0;
  domQuestions.forEach((q, i) => {
    const idx = Number(q.questionIndex) || questionIndex(q.stem) || i + 1;
    const oq = byIndex.get(idx) || (ocrQuestions.length === domQuestions.length ? ocrQuestions[i] : null);
    if (!oq) return;
    let changed = false;
    if (stemLooksBroken(q.stem) && oq.stem) {
      q.stem = oq.stem;
      changed = true;
    }
    if (Array.isArray(oq.options) && oq.options.length) {
      const repairKeys = optionKeysLookBroken(q) && oq.options.length === q.options.length;
      if (repairKeys) {
        q.options.forEach((opt, j) => {
          opt.key = String(oq.options[j].key || String.fromCharCode(65 + j)).toUpperCase();
        });
        changed = true;
      }
      if (optionTextBlank(q)) {
        const textByKey = new Map(oq.options.map((o) => [String(o.key || '').toUpperCase(), o.text]));
        q.options.forEach((opt) => {
          const text = textByKey.get(String(opt.key || '').toUpperCase());
          if (text) {
            opt.text = text;
            changed = true;
          }
        });
      }
    }
    if (changed) merged += 1;
  });
  return merged;
}

async function readPage(options = {}) {
  const resetQuiz = options.resetQuiz !== false;
  const button = $('readBtn');
  button.disabled = true;
  setStats('正在读取页面…');
  try {
    const res = await pilot.readPage();
    if (!res || !res.ok) {
      setStats(`读取失败：${res?.error || '未知错误'}`, true);
      appendLog('fail', `读取页面失败：${res?.error || '未知错误'}`);
      return false;
    }

    state.snapshot = res.snapshot;
    state.questions = res.snapshot.questions || [];
    state.qMap = new Map(state.questions.map((q) => [q.id, q]));
    state.stale = false;

    if (resetQuiz) {
      state.answers = [];
      state.checked = new Set();
      renderAnswers();
      $('applyAnswers').disabled = true;
    }

    $('quizBtn').disabled = state.questions.length === 0;

    const frameText = (res.frames || []).length > 1 ? ` · ${res.frames.length} 个框架` : '';

    // ---- 滚动预收集日志 ----
    if (res.scroll && res.scroll.ok) {
      appendLog('info', `滚动预收集：${res.scroll.steps} 步，scrollHeight=${(res.scroll.scrollHeight / 1000).toFixed(1)}px（所有题 DOM 已懒加载）`);
    } else if (res.scroll && !res.scroll.ok) {
      appendLog('info', `跳过滚动预收集：${res.scroll.reason || '无可滚动容器'}`);
    }

    const pre = res.preCollect;
    const preText = pre && pre.steps > 0
      ? ` · 自动翻页 ${pre.steps} 次`
      : '';
    setStats(
      `识别到 ${state.questions.length} 道题${preText}${frameText} · ${state.snapshot.elements.length} 个可操作元素`,
      state.questions.length === 0,
    );
    if (pre && pre.steps > 0) {
      appendLog('ok', `自动翻页 ${pre.steps} 次，预收集到 ${pre.collected} 道题（已回到第 1 题）`);
    }

    // ---- 情报 1 兜底：先试官方 API（一次拉全量） ----
    let apiDone = false;
    appendLog('run', '尝试调用学习通官方 API 拉取完整试卷…');
    try {
      const api = await pilot.fetchExam();
      if (api && api.ok && api.questions && api.questions.length >= 2) {
        const domStems = new Set(state.questions.map((q) => (q.stem || '').slice(0, 80)));
        let added = 0;
        for (const q of api.questions) {
          const key = (q.stem || '').slice(0, 80);
          if (!key || domStems.has(key)) continue;
          state.questions.push(q);
          domStems.add(key);
          added += 1;
        }
        state.qMap = new Map(state.questions.map((q) => [q.id, q]));
        apiDone = true;
        appendLog('ok', `官方 API 成功：${api.questions.length} 道题，新增 ${added} 道（courseId=${api.totalParams?.courseId || '?'}）`);
      } else if (api && api.ok && api.questions && api.questions.length === 1) {
        appendLog('info', `官方 API 返回 1 道题（可能是逐题模式），继续 DOM + OCR`);
      } else {
        appendLog('muted', `官方 API 未命中：${api?.error || '未拿到参数'}（会自动走 OCR）`);
      }
    } catch (apiErr) {
      appendLog('muted', `官方 API 异常：${apiErr.message || apiErr}`);
    }

    // ---- OCR 兜底：题太少，或 DOM 文字被字体反爬破坏时，启动翻页视觉识别 ----
    let ocrDone = false;
    const domTextBroken = state.questions.length > 1 && needsOcrText(state.questions);
    if (state.questions.length <= 1 || domTextBroken) {
      appendLog('run', domTextBroken
        ? '检测到题干/选项文字缺失（可能是字体反爬），启动翻页视觉识别补全…'
        : `DOM + API 只识别到 ${state.questions.length} 道题，启动翻页视觉识别…`);
      setStats('正在翻页 + 视觉识别（每题一次）…');
      const started = Date.now();
      try {
        const ocr = await pilot.ocrLoop();
        if (ocr && ocr.ok && ocr.questions && ocr.questions.length > 0) {
          const sec = ((Date.now() - started) / 1000).toFixed(1);
          if (domTextBroken) {
            const merged = mergeOcrText(state.questions, ocr.questions);
            ocrDone = merged > 0;
            appendLog(merged ? 'ok' : 'warn',
              `视觉识别 ${ocr.questions.length} 道，补全 ${merged} 道题的题干/选项文字（${sec}s，保留原答题定位）`);
          } else {
            const domStems = new Set(state.questions.map((q) => (q.stem || '').slice(0, 80)));
            let added = 0;
            for (const q of ocr.questions) {
              const key = (q.stem || '').slice(0, 80);
              if (!key || domStems.has(key)) continue;
              state.questions.push(q);
              domStems.add(key);
              added += 1;
            }
            ocrDone = true;
            appendLog('ok', `翻页 ${ocr.pagesOCRed} 次，视觉识别 ${ocr.questions.length} 道，新增 ${added} 道（${sec}s）`);
          }
          state.qMap = new Map(state.questions.map((q) => [q.id, q]));
        } else if (ocr && ocr.ok) {
          appendLog('warn', `翻页视觉识别返回 0 道`);
        } else {
          appendLog('warn', `翻页视觉识别失败：${ocr?.error || '未知'}`);
        }
      } catch (ocrErr) {
        appendLog('fail', `翻页视觉识别异常：${ocrErr.message || ocrErr}`);
      }
    }

    if (!state.questions.length) {
      appendLog('warn', '没有识别到题目：DOM + 视觉识别都未生效，请确认已打开答题页面，且 AI 模型支持视觉');
    } else {
      const sourceText = ocrDone ? '（含视觉识别）' : '';
      appendLog('info', `已读取页面${sourceText}：${state.questions.length} 道题，${state.snapshot.elements.length} 个可操作元素`);
    }

    state.qMap = new Map(state.questions.map((q) => [q.id, q]));
    return true;
  } catch (error) {
    setStats(`读取失败：${error.message || error}`, true);
    appendLog('fail', `读取页面失败：${error.message || error}`);
    return false;
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ 答题 */

async function generateAnswers() {
  const requirement = $('quizExtra').value.trim();
  if (!state.snapshot || state.stale) {
    const ok = await readPage({ resetQuiz: true });
    if (!ok) return;
  }
  if (!state.questions.length) {
    appendLog('warn', '当前页面没有题目，请先打开答题页并读取');
    return;
  }

  const button = $('quizBtn');
  button.disabled = true;
  setButtonLabel('quizBtn', 'AI 正在分析题目…');
  appendLog('run', `AI 答题开始：${state.questions.length} 道题，要求「${requirement || '按题型标准作答'}」`, true);
  const started = Date.now();

  state.answers = [];
  state.checked = new Set();
  renderAnswers();
  $('applyAnswers').disabled = true;

  const orderMap = new Map(state.questions.map((q, i) => [q.id, i]));
  const warnings = [];
  const usage = { prompt: 0, completion: 0, total: 0, calls: 0 };
  let lastModel = '';
  let failed = 0;
  let finishedBatches = 0;
  let totalBatches = 0;

  const mergeAnswers = (fresh) => {
    const byId = new Map(state.answers.map((answer) => [answer.questionId, answer]));
    fresh.forEach((answer) => byId.set(answer.questionId, answer));
    state.answers = Array.from(byId.values()).sort(
      (a, b) => (orderMap.get(a.questionId) ?? 1e9) - (orderMap.get(b.questionId) ?? 1e9),
    );
    state.checked = new Set(state.answers.map((_, index) => index));
    renderAnswers();
    $('applyAnswers').disabled = state.answers.length === 0;
  };

  // 分批 + 两批并发：单批只跑 10 题，避免整卷请求超时，同时把耗时压到一半
  const runPool = async (list, tag, extraRequirement) => {
    const batches = [];
    for (let i = 0; i < list.length; i += quizOptions.batchSize) {
      batches.push(list.slice(i, i + quizOptions.batchSize));
    }
    totalBatches += batches.length;
    const prompt = [requirement, extraRequirement].filter(Boolean).join('\n');
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        const bi = cursor;
        cursor += 1;
        const batch = batches[bi];
        const label = `${tag}${bi + 1}/${batches.length} 批（${batch.length} 道题）`;
        try {
          const res = await pilot.quiz({
            requirement: prompt,
            context: '',
            // 只传答题必需字段，避免把 elements/text 等无关内容发给后端
            snapshot: {
              title: state.snapshot.title,
              url: state.snapshot.url,
              questions: batch,
            },
          });
          if (!res.ok) throw new Error(res.error || 'AI 调用失败');
          const got = res.answers || [];
          if (res.usage) {
            usage.prompt += res.usage.prompt || 0;
            usage.completion += res.usage.completion || 0;
            usage.total += res.usage.total || 0;
            usage.calls += res.batches || 1;
          }
          mergeAnswers(got);
          lastModel = res.model || lastModel;
          if (res.warnings?.length) warnings.push(...res.warnings);
          appendLog('info', `${label} → 返回 ${got.length} 条答案`);
        } catch (error) {
          failed += 1;
          appendLog('fail', `${label} → 失败：${error.message || error}`);
        } finally {
          finishedBatches += 1;
          setButtonLabel('quizBtn', `AI 分析中 ${finishedBatches}/${totalBatches}`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(quizOptions.concurrency, batches.length) }, () => worker()),
    );
  };

  // 第一轮：全量作答
  await runPool(state.questions, '第 ', '');

  // 第二轮：没返回答案的题强制补答，避免整题空白
  let missing = state.questions.filter((q) => !state.answers.some((a) => a.questionId === q.id));
  if (missing.length) {
    appendLog('warn', `有 ${missing.length} 道题没有返回答案，正在补答…`);
    await runPool(
      missing,
      '补答 ',
      '上一轮这些题没有返回答案，必须全部作答；信息不足时给出最可能的答案，不要留空。',
    );
    missing = state.questions.filter((q) => !state.answers.some((a) => a.questionId === q.id));
  }

  // 第三轮：复核低置信度题目，提升正确率（阈值可在控制台调整，0 表示关闭复核）
  const reviewThreshold = Number(quizOptions.review) || 0;
  const lowConfidence = reviewThreshold > 0
    ? state.answers.filter((a) => a.needsReview || (a.confidence ?? 1) < reviewThreshold)
    : [];
  if (lowConfidence.length) {
    const ids = new Set(lowConfidence.map((a) => a.questionId));
    const list = state.questions.filter((q) => ids.has(q.id));
    if (list.length) {
      appendLog('run', `复核 ${list.length} 道低置信度题目…`);
      const before = new Map(state.answers.map((a) => [a.questionId, a]));
      await runPool(
        list,
        '复核 ',
        '这是复核：先独立判断，再核对选项与空数，给出你最有把握的最终答案。',
      );
      let corrected = 0;
      let kept = 0;
      // 复核结果按置信度取优：新答案把握不更高时保留原答案，避免来回翻烧饼
      state.answers = state.answers.map((answer) => {
        const old = before.get(answer.questionId);
        if (old && (answer.confidence ?? 1) < (old.confidence ?? 1) - 0.05) {
          kept += 1;
          return old;
        }
        const changed =
          old &&
          (JSON.stringify(old.optionKeys || []) !== JSON.stringify(answer.optionKeys || []) ||
            String(old.value || '') !== String(answer.value || ''));
        if (changed) corrected += 1;
        return answer;
      });
      state.answers.sort(
        (a, b) => (orderMap.get(a.questionId) ?? 1e9) - (orderMap.get(b.questionId) ?? 1e9),
      );
      renderAnswers();
      if (corrected) appendLog('info', `复核修正了 ${corrected} 道题的答案`);
      if (kept) appendLog('info', `${kept} 道题复核后把握更低，保留首轮答案`);
    }
  }

  // 第四轮：仍无答案的选择题，本地按"选项信息最完整"兜底填写并标记复核
  const still = state.questions.filter((q) => !state.answers.some((a) => a.questionId === q.id));
  let fallback = 0;
  still.forEach((q) => {
    if (!q.options.length) return;
    const best = q.options
      .slice()
      .sort((a, b) => String(b.text || '').length - String(a.text || '').length)[0];
    if (!best) return;
    state.answers.push({
      questionId: q.id,
      optionKeys: [best.key],
      confidence: 0.4,
      reason: '本地兜底：选择信息最完整的选项',
      needsReview: true,
    });
    fallback += 1;
  });
  if (fallback) {
    mergeAnswers([]);
    appendLog('warn', `${fallback} 道题未拿到 AI 答案，已按选项内容兜底填写（建议复核）`);
  }
  const unanswered = state.questions.filter((q) => !state.answers.some((a) => a.questionId === q.id));
  if (unanswered.length) appendLog('warn', `${unanswered.length} 道填空题/简答题未拿到答案，需要人工补充`);

  const sec = ((Date.now() - started) / 1000).toFixed(1);
  const review = state.answers.filter((a) => a.needsReview).length;
  if (failed) appendLog('warn', `⚠️ 共 ${failed} 个批次失败`);
  appendLog(
    state.answers.length ? 'ok' : 'fail',
    `AI 完成（${sec}s）：题目 ${state.questions.length} → 答案 ${state.answers.length} 条${review ? `，其中 ${review} 条需复核` : ''}${lastModel ? ` · 模型 ${lastModel}` : ''}`,
  );
  for (const w of warnings.slice(0, 10)) appendLog('warn', w);
  if (usage.total) {
    appendLog(
      'muted',
      `Token 消耗：prompt ${usage.prompt} + completion ${usage.completion} = ${usage.total}（${usage.calls} 次调用）`,
    );
  }

  // 控制台可开启：生成后自动应用答案，可选再自动点暂存（不会提交作业）
  if (quizOptions.autoApply && state.answers.length) {
    appendLog('run', '按控制台设置自动应用答案…');
    await applyAnswers();
    if (quizOptions.autoSave) {
      const saved = await pilot.saveDraft();
      appendLog(
        saved?.ok ? 'ok' : 'warn',
        saved?.ok
          ? `已自动暂存：${saved.message || '保存成功'}`
          : `自动暂存失败：${saved?.error || '未知错误'}`,
      );
    }
  }
  renderOverview();

  button.disabled = state.questions.length === 0;
  setButtonLabel('quizBtn', 'AI 生成答案');
}

function renderAnswers() {
  const box = $('answers');
  box.innerHTML = '';

  const head = $('answerHead');
  const count = $('answerCount');
  if (state.answers.length) {
    head.hidden = false;
    const review = state.answers.filter((item) => item.needsReview).length;
    count.textContent = `${state.answers.length} 条${review ? ` · ${review} 条需复核` : ''}`;
  } else {
    head.hidden = true;
  }

  if (!state.answers.length) {
    const empty = h('div', 'empty');
    empty.appendChild(h('div', 'empty-icon', '◎'));
    empty.appendChild(h('div', 'empty-title', '还没有生成答案'));
    empty.appendChild(h('div', 'empty-sub', '先读取页面，再让 AI 作答'));
    box.appendChild(empty);
    return;
  }

  state.answers.forEach((answer, index) => {
    const question = state.qMap.get(answer.questionId);
    if (!question) return;

    const item = h('label', `answer${answer.needsReview ? ' review' : ''}${state.checked.has(index) ? '' : ' off'}`);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.checked.has(index);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.checked.add(index);
      else state.checked.delete(index);
      item.classList.toggle('off', !checkbox.checked);
    });

    const body = h('div', 'answer-body');

    const headRow = h('div', 'answer-head');
    headRow.appendChild(h('span', 'q-index', String(index + 1)));
    const badge = h('span', 'q-type', TYPE_LABEL[question.type] || '题目');
    badge.dataset.type = question.type || 'single';
    headRow.appendChild(badge);

    if (typeof answer.confidence === 'number') {
      const percent = Math.max(0, Math.min(100, Math.round(answer.confidence * 100)));
      const conf = h('span', 'conf');
      const bar = h('span', 'conf-bar');
      const fill = h('i');
      fill.style.width = `${percent}%`;
      bar.appendChild(fill);
      conf.appendChild(bar);
      conf.appendChild(h('em', '', `${percent}%`));
      headRow.appendChild(conf);
    }
    body.appendChild(headRow);

    body.appendChild(h('div', 'answer-stem', question.stem));

    const pick = h('div', 'answer-pick');
    if (question.type === 'fill' || question.type === 'short' || !question.options.length) {
      pick.appendChild(h('span', 'chip value', String(answer.value || '（空）').replace(/\|\|/g, ' ｜ ')));
    } else {
      for (const key of answer.optionKeys || []) {
        const option = question.options.find((opt) => opt.key === key);
        const text = option ? String(option.text).replace(/^[A-Fa-f]\s*[.、:：．)）]\s*/, '') : '';
        pick.appendChild(h('span', 'chip', `${key}. ${text.slice(0, 34)}`));
      }
    }
    body.appendChild(pick);

    if (answer.reason) body.appendChild(h('div', 'answer-reason', answer.reason));

    if (answer.needsReview) {
      const meta = h('div', 'answer-meta');
      meta.appendChild(h('span', 'badge-warn', '需人工复核'));
      body.appendChild(meta);
    }

    item.appendChild(checkbox);
    item.appendChild(body);
    box.appendChild(item);
  });
  // 答案列表自动滚到底部（如果用户没手动向上滚查看）
  const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
  if (dist < 80 || box.scrollTop === 0) box.scrollTop = box.scrollHeight;
}

function buildAnswerSteps() {
  const steps = [];
  state.answers.forEach((answer, index) => {
    if (!state.checked.has(index)) return;
    const question = state.qMap.get(answer.questionId);
    if (!question) return;

    if (question.type === 'fill' || !question.options.length) {
      const rawValue = String(answer.value || '').trim();
      const blanks = Array.isArray(question.blankElementIds) && question.blankElementIds.length
        ? question.blankElementIds
        : question.elementId
          ? [question.elementId]
          : [];
      if (!rawValue && !blanks.length) return;

      // 单空题：整段写入，不做拆分（避免把答案里的顿号、斜杠误当成多空分隔）
      if (blanks.length <= 1) {
        steps.push({
          action: 'fill',
          target: blanks[0] || '',
          value: rawValue,
          reason: `填空：${question.stem.slice(0, 28)}`,
          hint: { stem: question.stem },
        });
        return;
      }

      // 多空题：优先按 AI 约定的 || 拆分，数量不足时退回换行/分号等分隔
      let values = rawValue.split('||').map((v) => v.trim());
      if (values.filter((v) => v).length < blanks.length) {
        const parts = rawValue
          .split(/\n+|\｜|；|;\s*|\s{2,}/)
          .map((v) => v.trim())
          .filter(Boolean);
        if (parts.length > values.filter((v) => v).length) values = parts;
      }
      blanks.forEach((targetId, index) => {
        const value = values[index] || '';
        if (!value) return;
        steps.push({
          action: 'fill',
          target: targetId,
          value: value,
          reason: `填空（第${index + 1}空）：${question.stem.slice(0, 22)}`,
          hint: { stem: `${question.stem}（第${index + 1}空）` },
        });
      });
      return;
    }

    for (const key of answer.optionKeys || []) {
      const option = question.options.find((opt) => opt.key === key);
      const optionText = option ? String(option.text).replace(/^[A-Fa-f]\s*[.、:：．)）]\s*/, '') : '';
      steps.push({
        action: 'click',
        target: option?.elementId || '',
        value: key,
        reason: `${question.stem.slice(0, 24)}… 选 ${key}`,
        hint: { stem: question.stem, optionText },
      });
    }
  });
  return steps;
}

async function applyAnswers() {
  const steps = buildAnswerSteps();
  if (!steps.length) {
    appendLog('warn', '没有可应用的答案：请勾选要应用的题目');
    return;
  }
  await executeSteps(steps);
}

/* ------------------------------------------------------ 控制台扩展工具 */

function applyQuizOptionsToForm() {
  if (!$('optBatch')) return;
  $('optBatch').value = quizOptions.batchSize;
  $('optConcurrency').value = quizOptions.concurrency;
  $('optReview').value = quizOptions.review;
  $('optAutoApply').value = quizOptions.autoApply ? '1' : '0';
  $('optAutoSave').value = quizOptions.autoSave ? '1' : '0';
}

function loadQuizOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem('quizOptions') || '{}');
    if (saved && typeof saved === 'object') Object.assign(quizOptions, QUIZ_DEFAULTS, saved);
  } catch {
    // 配置损坏时用默认值
  }
  applyQuizOptionsToForm();
}

function saveQuizOptions() {
  const clamp = (value, min, max, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  };
  quizOptions.batchSize = Math.round(clamp($('optBatch').value, 3, 20, QUIZ_DEFAULTS.batchSize));
  quizOptions.concurrency = Math.round(clamp($('optConcurrency').value, 1, 4, QUIZ_DEFAULTS.concurrency));
  quizOptions.review = clamp($('optReview').value, 0, 1, QUIZ_DEFAULTS.review);
  quizOptions.autoApply = $('optAutoApply').value === '1';
  quizOptions.autoSave = $('optAutoSave').value === '1';
  localStorage.setItem('quizOptions', JSON.stringify(quizOptions));
  applyQuizOptionsToForm();
  setHint(
    'optHint',
    `已保存：每批 ${quizOptions.batchSize} 题 · 并发 ${quizOptions.concurrency} · 复核阈值 ${quizOptions.review || '关闭'}${quizOptions.autoApply ? ' · 自动应用' : ''}${quizOptions.autoSave ? ' · 自动暂存' : ''}`,
  );
}

function renderOverview() {
  const box = $('overviewText');
  if (!box) return;
  if (!state.snapshot) {
    box.textContent = '尚未读取页面';
    return;
  }
  const counts = {};
  state.questions.forEach((q) => {
    counts[q.type] = (counts[q.type] || 0) + 1;
  });
  const names = { single: '单选', multiple: '多选', fill: '填空', judge: '判断', short: '简答' };
  const parts = Object.keys(counts).map((key) => `${names[key] || key} ${counts[key]}`);
  box.textContent = `${state.snapshot.title || '未命名页面'}\n${state.snapshot.url || ''}\n共 ${state.questions.length} 题：${parts.join(' · ') || '无'}\n答案 ${state.answers.length} 条${state.stale ? '（页面已变化，建议重新读取）' : ''}`;
}

async function exportAnswersToFile() {
  if (!state.answers.length) {
    setHint('toolsHint', '还没有答案可以导出', true);
    return;
  }
  const res = await pilot.exportAnswers({
    url: state.snapshot?.url || '',
    title: state.snapshot?.title || '',
    exportedAt: new Date().toISOString(),
    questions: state.questions.map((q) => ({ id: q.id, type: q.type, stem: q.stem, options: q.options })),
    answers: state.answers,
  });
  if (res?.ok) setHint('toolsHint', `已导出到：${res.path}`);
  else if (!res?.canceled) setHint('toolsHint', `导出失败：${res?.error || '未知错误'}`, true);
}

async function importAnswersFromFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data.answers) ? data.answers : [];
    const valid = list.filter((a) => a && a.questionId && state.qMap.has(a.questionId));
    if (!valid.length) {
      setHint('toolsHint', '文件里没有匹配当前页面的答案，请先读取页面', true);
      return;
    }
    state.answers = valid;
    state.checked = new Set(valid.map((_, index) => index));
    renderAnswers();
    $('applyAnswers').disabled = false;
    setHint(
      'toolsHint',
      `已导入 ${valid.length} 条答案${list.length > valid.length ? `（忽略 ${list.length - valid.length} 条不匹配）` : ''}`,
    );
  } catch (error) {
    setHint('toolsHint', `导入失败：${error.message || error}`, true);
  }
}

async function copyRunLogs() {
  const text = [...document.querySelectorAll('#logs > li')]
    .map((li) => (li.innerText || '').replace(/\s+/g, ' ').trim())
    .join('\n');
  if (!text) {
    setHint('toolsHint', '暂无可复制的日志', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setHint('toolsHint', `已复制 ${text.split('\n').length} 行日志`);
  } catch {
    setHint('toolsHint', '复制失败，请手动选择日志文本', true);
  }
}

function bindConsoleExtras() {
  $('optSave').addEventListener('click', saveQuizOptions);
  $('optReset').addEventListener('click', () => {
    Object.assign(quizOptions, QUIZ_DEFAULTS);
    localStorage.removeItem('quizOptions');
    applyQuizOptionsToForm();
    setHint('optHint', '已恢复默认参数');
  });
  $('overviewRefresh').addEventListener('click', renderOverview);
  $('exportAnswers').addEventListener('click', exportAnswersToFile);
  $('importAnswers').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importAnswersFromFile);
  $('clearAnswers').addEventListener('click', () => {
    state.answers = [];
    state.checked = new Set();
    renderAnswers();
    $('applyAnswers').disabled = true;
    setHint('toolsHint', '已清空答案列表');
  });
  $('copyLogs').addEventListener('click', copyRunLogs);
  $('logsClear').addEventListener('click', () => {
    clearLogs();
    setHint('toolsHint', '日志已清空');
  });
}

/* ------------------------------------------------------------------ 执行 */

function handleRunEvent(event) {
  if (!event) return;

  if (event.kind === 'begin') {
    clearLogs();
    $('runProgress').textContent = `0/${event.total}`;
    appendLog('info', `开始执行，共 ${event.total} 步（右侧窗口可实时观看）`);
    return;
  }

  if (event.kind === 'step-start') {
    const label = ACTION_LABEL[event.action] || event.action;
    const risk = event.risk === 'high' ? ' · 高风险' : '';
    const reason = event.reason ? ` · ${event.reason}` : '';
    const li = appendLog('run', `第 ${event.index + 1}/${event.total} 步 · ${label}${risk}${reason}`, true);
    stepNodes.set(event.index, li);
    $('runProgress').textContent = `${event.index}/${event.total}`;
    return;
  }

  if (event.kind === 'step-result') {
    const li = stepNodes.get(event.index);
    if (li) {
      li.classList.remove('run');
      li.classList.add(event.ok ? 'ok' : 'fail');
      const icon = li.querySelector('.log-icon');
      if (icon) icon.textContent = event.ok ? '✓' : '✕';
      const text = li.querySelector('.log-text');
      if (text) text.textContent += ` — ${event.detail || ''}`;
    } else {
      appendLog(event.ok ? 'ok' : 'fail', event.detail || '');
    }
    return;
  }

  if (event.kind === 'end') {
    const success = event.total - event.failed;
    $('runProgress').textContent = `完成 ${success}/${event.total}`;
    appendLog(
      event.failed ? 'warn' : 'ok',
      event.failed ? `执行结束：${success} 步成功，${event.failed} 步失败` : `执行完成，共 ${event.total} 步`,
    );
    return;
  }

  // OCR 翻页进度（type: 'progress'）或其他未知事件 → 当日志打出来
  if (event.type === 'progress' || event.text) {
    appendLog('run', event.text || event.message || JSON.stringify(event));
  }
}

async function executeSteps(steps) {
  if (state.running) return;
  state.running = true;
  $('stopBtn').disabled = false;
  $('applyAnswers').disabled = true;
  $('runProgress').textContent = '执行中…';

  try {
    const res = await pilot.execute({ steps });
    if (res && res.error) appendLog('fail', res.error);
  } catch (error) {
    appendLog('fail', `执行失败：${error.message || error}`);
  } finally {
    state.running = false;
    $('stopBtn').disabled = true;
    $('applyAnswers').disabled = state.answers.length === 0 || state.stale;
  }
}
