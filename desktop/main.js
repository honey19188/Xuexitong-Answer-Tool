'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, screen, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { SNAPSHOT_CODE, PRE_COLLECT_CODE, SCROLL_ALL_CODE, actionCode } = require('./automation');

const ROOT = path.resolve(__dirname, '..');
const PANEL_WIDTH = 404;
const TOPBAR_HEIGHT = 54;
const DEFAULT_SERVER = 'http://127.0.0.1:8787';
const START_URL = 'https://www.chaoxing.com/';
// 单次执行步骤上限：整卷答案可能上百步（多选/多空会拆成多步），不能再按 40 截断
const MAX_STEPS = 600;
// 持久化分区：Cookie / localStorage / 登录态写入用户目录，重启后仍然有效
const PARTITION = 'persist:pagepilot';

let win = null;
let view = null;
let serverChild = null;
let serverUrl = DEFAULT_SERVER;
let stopRequested = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stateFile(name) {
  return path.join(app.getPath('userData'), name);
}

/* ------------------------------------------------------------------ 运行日志 */

function readAppVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || app.getVersion();
  } catch {
    return app.getVersion();
  }
}

function logDir() {
  // 开发模式写项目 logs/ 便于查看；打包后写用户数据目录（程序目录可能不可写）
  return app.isPackaged ? path.join(app.getPath('userData'), 'logs') : path.join(ROOT, 'logs');
}

function logFilePath() {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(logDir(), `run-${day}.log`);
}

function writeRunLog(scope, text) {
  try {
    const body = String(text ?? '').replace(/\s+$/, '');
    if (!body) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${stamp}] [${scope}] ${body}\n`, 'utf8');
  } catch {
    // 日志写入失败不影响主流程
  }
}

process.on('uncaughtExceptionMonitor', (error) => {
  writeRunLog('main', `未捕获异常：${error?.stack || error}`);
});
process.on('unhandledRejection', (reason) => {
  writeRunLog('main', `未处理 Promise：${reason?.stack || reason}`);
});

function rememberedUrl() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile('last-url.json'), 'utf8'));
    if (data && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) return data.url;
  } catch {
    // 没有历史记录时忽略
  }
  return '';
}

function rememberUrl(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return;
  try {
    fs.writeFileSync(stateFile('last-url.json'), JSON.stringify({ url }), 'utf8');
  } catch {
    // 写入失败不影响使用
  }
}

// 学习通的登录 Cookie 多为会话 Cookie，正常退出会失效；
// 这里把 Cookie 快照到本地，启动时还原，保证重启后仍是登录状态。
function cookieFile() {
  return stateFile('cookies.json');
}

async function saveCookies(persist) {
  try {
    const cookies = await persist.cookies.get({});
    const list = cookies
      .filter((item) => item.domain && item.name)
      .map((item) => ({
        name: item.name,
        value: item.value,
        domain: item.domain,
        path: item.path,
        secure: item.secure,
        httpOnly: item.httpOnly,
        sameSite: item.sameSite,
        expirationDate: item.expirationDate,
      }));
    const temp = `${cookieFile()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(list), 'utf8');
    fs.renameSync(temp, cookieFile());
  } catch {
    // 保存失败忽略（比如首次启动还没有 Cookie）
  }
}

async function restoreCookies(persist) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(cookieFile(), 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(list) || !list.length) return;

  await Promise.all(
    list.map(async (item) => {
      if (!item || !item.name || !item.domain) return;
      const domain = String(item.domain);
      const host = domain.replace(/^\./, '');
      const scheme = item.secure ? 'https' : 'http';
      const details = {
        url: `${scheme}://${host}${item.path || '/'}`,
        name: item.name,
        value: String(item.value ?? ''),
        domain,
        path: item.path || '/',
        secure: Boolean(item.secure),
        httpOnly: Boolean(item.httpOnly),
        sameSite: item.sameSite || 'unspecified',
      };
      if (typeof item.expirationDate === 'number') details.expirationDate = item.expirationDate;
      try {
        await persist.cookies.set(details);
      } catch {
        // 个别 Cookie（如 __Host- 前缀）可能设置失败，忽略
      }
    }),
  );
}

// 支持 `npm run desktop -- <网址>` 直接打开指定页面，否则恢复上次页面
function initialUrl() {
  const candidate = process.argv.slice(1).find((arg) => /^https?:\/\//i.test(arg) || /^file:\/\//i.test(arg));
  return candidate || rememberedUrl() || START_URL;
}

/* ------------------------------------------------------------------ 窗口 */

function browserState() {
  if (!view || view.webContents.isDestroyed()) return {};
  const wc = view.webContents;
  const history = wc.navigationHistory;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: history ? history.canGoBack() : false,
    canGoForward: history ? history.canGoForward() : false,
  };
}

function layout() {
  if (!win || win.isDestroyed() || !view) return;
  const [width, height] = win.getContentSize();
  view.setBounds({
    x: PANEL_WIDTH,
    y: TOPBAR_HEIGHT,
    width: Math.max(0, width - PANEL_WIDTH),
    height: Math.max(0, height - TOPBAR_HEIGHT),
  });
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1440, Math.max(980, area.width - 40)),
    height: Math.min(920, Math.max(640, area.height - 40)),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14171c',
    title: 'PagePilot 桌面版',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#12171f', symbolColor: '#c8d2e2', height: 54 }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('resize', layout);
  win.on('maximize', layout);
  win.on('unmaximize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);

  view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  layout();

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) wc.loadURL(url);
    else if (/^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const pushState = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('browser:state', browserState());
  };
  const rememberCurrent = () => {
    const current = wc.getURL();
    if (/^https?:\/\//i.test(current)) rememberUrl(current);
  };

  wc.on('did-start-loading', pushState);
  wc.on('did-stop-loading', () => {
    pushState();
    rememberCurrent();
  });
  wc.on('did-finish-load', pushState);
  // ---- 扫码登录成功后自动跳转个人空间 ----
  // 学习通登录成功会从 passport.chaoxing.com/login 跳到 www.chaoxing.com。
  // 不能立刻打开 i.chaoxing.com：此时 fid / spaceFidEnc 等登录标记可能还没写入，
  // 个人空间与 passport 会互相跳转，最终报 ERR_TOO_MANY_REDIRECTS。
  const LOGIN_RE = /passport2?\.chaoxing\.com/;
  const MAIN_SITE_RE = /(^|\.)(www|mooc1)\.chaoxing\.com/;
  const isPersonalSpace = (value) => /^https?:\/\/i(\.mooc)?\.chaoxing\.com(?=\/|$)/i.test(value);
  const samePage = (a, b) => {
    try {
      const x = new URL(a);
      const y = new URL(b);
      return x.origin === y.origin && x.pathname === y.pathname;
    } catch {
      return false;
    }
  };

  let sawLoginPage = false;
  let personalJumpPending = false;

  // 轮询等待登录 Cookie 落盘，避免在登录态不完整时进入个人空间
  const waitForLoginCookies = async (timeoutMs = 8000) => {
    const persist = session.fromPartition(PARTITION);
    const deadline = Date.now() + timeoutMs;
    const required = ['_uid', 'uf', 'fid'];
    while (Date.now() < deadline) {
      try {
        const cookies = await persist.cookies.get({ domain: 'chaoxing.com' });
        const names = new Set(cookies.map((item) => item.name));
        if (required.every((name) => names.has(name))) return true;
      } catch {
        // 查询失败时继续重试
      }
      await sleep(400);
    }
    return false;
  };

  const jumpToPersonalSpace = async (landedAt) => {
    if (personalJumpPending) return;
    personalJumpPending = true;
    try {
      if (!(await waitForLoginCookies())) return;
      if (wc.isDestroyed()) return;
      const current = wc.getURL();
      // 用户已经自己进入个人空间，或已经离开登录落地页，就不要打断
      if (isPersonalSpace(current) || !samePage(current, landedAt)) return;
      await wc.loadURL('https://i.chaoxing.com/');
      if (win && !win.isDestroyed()) {
        win.webContents.send('browser:notice', {
          level: 'success',
          message: '扫码登录成功，已自动跳转个人空间',
        });
      }
    } catch {
      // 跳转失败由 did-fail-load 统一提示
    } finally {
      personalJumpPending = false;
    }
  };

  wc.on('did-navigate', (_event, url) => {
    pushState();
    rememberCurrent();
    resetRedirectHops();

    if (LOGIN_RE.test(url)) {
      sawLoginPage = true;
      return;
    }
    if (sawLoginPage && MAIN_SITE_RE.test(url)) {
      // 从 passport 登录页跳到了主站 → 扫码登录成功
      sawLoginPage = false;
      jumpToPersonalSpace(url);
    }
  });

  // ---- 重定向循环保护 ----
  // 登录态或空间标记不一致时，学习通会在 i.chaoxing.com 与 passport 之间反复 302。
  // 提前拦截并清理空间标记后重试一次，避免最终落到 ERR_TOO_MANY_REDIRECTS 错误页。
  let redirectHops = 0;
  let redirectTimer = null;
  let loopHandling = false;
  let loopRetriedKey = '';

  const loopKey = (value) => {
    try {
      const u = new URL(value);
      return `${u.host}${u.pathname}`;
    } catch {
      return String(value);
    }
  };

  function resetRedirectHops() {
    redirectHops = 0;
    if (redirectTimer) {
      clearTimeout(redirectTimer);
      redirectTimer = null;
    }
  }

  const clearSpaceCookies = async () => {
    const persist = session.fromPartition(PARTITION);
    const cookies = await persist.cookies.get({});
    const stale = cookies.filter((item) => /^spaceFid(?:Enc)?$/i.test(item.name));
    await Promise.all(
      stale.map((item) =>
        persist.cookies
          .remove(
            `${item.secure ? 'https' : 'http'}://${String(item.domain).replace(/^\./, '')}${item.path || '/'}`,
            item.name,
          )
          .catch(() => {}),
      ),
    );
  };

  const handleRedirectLoop = async (url) => {
    if (loopHandling) return;
    loopHandling = true;
    resetRedirectHops();
    try {
      wc.stop();
    } catch {
      // 忽略停止失败
    }
    try {
      const key = loopKey(url);
      if (loopRetriedKey === key) {
        if (win && !win.isDestroyed()) {
          win.webContents.send('browser:notice', {
            level: 'error',
            message: '个人空间反复跳转，已停止加载。请重新扫码登录后再试。',
          });
        }
        return;
      }
      loopRetriedKey = key;
      if (win && !win.isDestroyed()) {
        win.webContents.send('browser:notice', {
          level: 'warn',
          message: '检测到个人空间反复跳转，已重置登录标记并重新加载',
        });
      }
      await clearSpaceCookies();
      await wc.loadURL(url);
    } catch {
      // 重试失败时交由 did-fail-load 提示
    } finally {
      loopHandling = false;
    }
  };

  wc.on('will-redirect', (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame || !/chaoxing\.com/i.test(String(url))) return;
    redirectHops += 1;
    if (redirectTimer) clearTimeout(redirectTimer);
    redirectTimer = setTimeout(resetRedirectHops, 15000);
    if (redirectHops >= 10) handleRedirectLoop(url);
  });

  wc.on('did-navigate-in-page', () => {
    pushState();
    rememberCurrent();
  });
  wc.on('page-title-updated', pushState);
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    resetRedirectHops();
    pushState();
    if (!win || win.isDestroyed()) return;

    // ERR_TOO_MANY_REDIRECTS：学习通登录态未同步，停在错误页无法操作，
    // 退回首页便于用户重新登录后再进入个人空间
    if (code === -310 && /chaoxing\.com/i.test(String(url))) {
      win.webContents.send('browser:notice', {
        level: 'error',
        message: '个人空间跳转失败：登录状态未同步，已返回学习通首页，请重新登录后再试',
      });
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.loadURL(START_URL).catch(() => {});
      }, 600);
      return;
    }

    win.webContents.send('browser:notice', {
      level: 'error',
      message: `页面加载失败：${description}（${code}）`,
    });
  });

  wc.loadURL(initialUrl()).catch(() => {});

  win.on('closed', () => {
    win = null;
    view = null;
  });
}

/* --------------------------------------------------------- 页面读取/执行 */

function collectFrames(wc) {
  const frames = [];
  const walk = (frame) => {
    frames.push(frame);
    for (const child of frame.frames) walk(child);
  };
  try {
    walk(wc.mainFrame);
  } catch {
    // 页面切换时主框架可能已销毁
  }
  return frames;
}

async function evalInFrame(frame, code, timeoutMs = 15000) {
  try {
    return await Promise.race([
      frame.executeJavaScript(code, false),
      sleep(timeoutMs).then(() => {
        throw new Error('页面响应超时');
      }),
    ]);
  } catch {
    return null;
  }
}

async function readSnapshot() {
  if (!view) return { ok: false, error: '窗口未就绪' };
  const wc = view.webContents;
  const frames = collectFrames(wc).slice(0, 30);
  if (!frames.length) return { ok: false, error: '当前页面不可读取' };

  const mainFrame = frames[0];

  // ---- 第零步：滚动到底部触发懒加载 ----
  // 学习通作业/试卷详情页是超长滚动列表，所有题一次性渲染在 DOM 里
  // 首屏只渲染可见区域的题，下面的要滚过才会被 React/Vue 渲染
  let scrollResult = null;
  try {
    scrollResult = await evalInFrame(mainFrame, SCROLL_ALL_CODE, 15_000);
  } catch { scrollResult = null; }

  // ---- 第一步：预翻页，自动点"下一题"把所有题的完整 DOM 都抓到 ----
  // 只在主框架执行（逐题模式的按钮和题目都在 top frame 里）
  let preCollect = null;
  try {
    if (mainFrame) {
      preCollect = await evalInFrame(mainFrame, PRE_COLLECT_CODE, 120_000);
    }
  } catch (e) {
    preCollect = null;
  }

  // ---- 第二步：正常跑所有 frame 的完整快照（此时 DOM 应该已回到第一题） ----
  const results = await Promise.all(
    frames.map(async (frame, index) => ({ index, data: await evalInFrame(frame, SNAPSHOT_CODE) })),
  );

  const elements = [];
  const questions = [];
  const infos = [];
  const texts = [];
  let url = wc.getURL();
  let title = wc.getTitle();

  for (const { index, data } of results) {
    if (!data || data.error) continue;
    const label = index === 0 ? 'main' : `frame${index}`;
    if (index === 0) {
      url = data.url || url;
      title = data.title || title;
    }
    (data.elements || []).forEach((el) => elements.push({ ...el, frame: label }));
    (data.questions || []).forEach((q) => questions.push({ ...q, frame: label }));
    if (data.text) texts.push(data.text);
    infos.push({
      label,
      url: data.url,
      title: data.title,
      elements: (data.elements || []).length,
      questions: (data.questions || []).length,
    });
  }

  // ---- 合并：preCollect 收集到的完整题 + SNAPSHOT 当前页的题 ----
  if (preCollect && Array.isArray(preCollect.questions)) {
    // 把预收集的题也加进来（SNAPSHOT 抓到的有 options 的优先；预收集里多出来的补上）
    for (const pq of preCollect.questions) {
      const key = (pq.stem || '').slice(0, 100);
      if (!questions.some((q) => (q.stem || '').slice(0, 100) === key)) {
        questions.push({ ...pq, frame: 'main' });
      }
    }
    if (preCollect.url) url = preCollect.url;
    if (preCollect.title) title = preCollect.title;
  }

  const seen = new Set();
  const uniqueQuestions = questions.filter((q) => {
    const key =
      (q.stem || '').slice(0, 100) +
      '|' +
      (q.options || [])
        .map((o) => o.text)
        .join('|')
        .slice(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    ok: true,
    frames: infos,
    scroll: scrollResult
      ? { ok: scrollResult.ok, steps: scrollResult.steps || 0, scrollHeight: scrollResult.scrollHeight || 0 }
      : null,
    preCollect: preCollect
      ? { steps: preCollect.steps || 0, collected: (preCollect.questions || []).length }
      : null,
    snapshot: {
      url,
      title,
      elements: elements.slice(0, 320),
      questions: uniqueQuestions.slice(0, 200), // 放宽到 200 题
      text: texts.join('\n---\n').slice(0, 6000),
    },
  };
}

async function runAction(step) {
  if (!view) return { ok: false, detail: '窗口未就绪' };
  const frames = collectFrames(view.webContents);
  if (!frames.length) return { ok: false, detail: '当前页面不可操作' };

  if (step.action === 'scroll' || step.action === 'wait') {
    const data = await evalInFrame(frames[0], actionCode(step));
    return data || { ok: false, detail: '执行失败' };
  }

  const results = await Promise.all(
    frames.map(async (frame, index) => ({ index, data: await evalInFrame(frame, actionCode(step)) })),
  );
  const hit = results.find((item) => item.data && item.data.matched);
  if (!hit) return { ok: false, detail: '页面上没有找到目标元素（请重新读取页面）' };
  const detail = hit.data.detail || '';
  return { ...hit.data, detail: hit.index === 0 ? detail : `${detail} · frame ${hit.index}` };
}

function emitRun(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('run:event', payload);
}

async function confirmHighRisk(step) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '高风险操作确认',
    message: `即将执行高风险操作：${step.reason || step.action}`,
    detail: `动作：${step.action}${step.value ? `\n内容：${String(step.value).slice(0, 200)}` : ''}\n目标元素：${step.target || '-'}`,
    buttons: ['跳过这一步', '确认执行'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

async function executeSteps(rawSteps) {
  const steps = Array.isArray(rawSteps) ? rawSteps.slice(0, MAX_STEPS) : [];
  if (!steps.length) return { ok: false, error: '没有可执行的步骤' };
  stopRequested = false;

  const logs = [];
  emitRun({ kind: 'begin', total: steps.length });

  for (let index = 0; index < steps.length; index += 1) {
    if (stopRequested) {
      const log = { at: new Date().toISOString(), action: 'stop', ok: false, detail: '已手动停止' };
      logs.push(log);
      emitRun({ kind: 'step-result', index, ok: false, detail: log.detail, stopped: true });
      break;
    }

    const step = steps[index];
    emitRun({
      kind: 'step-start',
      index,
      total: steps.length,
      action: step.action,
      target: step.target,
      reason: step.reason,
      risk: step.risk,
    });

    if (step.risk === 'high') {
      const approved = await confirmHighRisk(step);
      if (!approved) {
        const detail = '高风险操作未确认，已跳过';
        logs.push({ at: new Date().toISOString(), action: step.action, target: step.target, ok: false, detail });
        emitRun({ kind: 'step-result', index, ok: false, detail });
        continue;
      }
    }

    const result = await runAction(step);
    const detail = result.detail || (result.ok ? '完成' : '执行失败');
    logs.push({ at: new Date().toISOString(), action: step.action, target: step.target, ok: Boolean(result.ok), detail });
    emitRun({ kind: 'step-result', index, ok: Boolean(result.ok), detail });
    await sleep(240);
  }

  const failed = logs.filter((log) => !log.ok).length;
  emitRun({ kind: 'end', total: logs.length, failed });
  return {
    ok: failed === 0 && !stopRequested,
    logs,
    failed,
    total: logs.length,
    stopped: stopRequested,
    url: view ? view.webContents.getURL() : '',
  };
}

/* ------------------------------------------------------------------ 后端 */

async function pingServer() {
  try {
    const res = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data.ok);
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await pingServer()) return { ok: true, started: false, base: serverUrl };

  const entry = path.join(ROOT, 'server', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    return { ok: false, error: '后端未构建：请先在项目根目录执行 npm run build', base: serverUrl };
  }
  try {
    const port = new URL(serverUrl).port || '8787';
    serverChild = spawn(process.execPath, [entry], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: port,
        HOST: '127.0.0.1',
        // 安装版程序目录不可写，数据放到用户目录；开发模式仍用 server/data
        ...(app.isPackaged
          ? { PAGE_PILOT_DATA_DIR: path.join(app.getPath('userData'), 'server-data') }
          : {}),
      },
    });
    const pipeServerLog = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) writeRunLog('server', line);
      }
    };
    serverChild.stdout?.on('data', pipeServerLog);
    serverChild.stderr?.on('data', pipeServerLog);
    serverChild.on('exit', () => {
      serverChild = null;
    });
  } catch (error) {
    return { ok: false, error: `后端启动失败：${error.message || error}`, base: serverUrl };
  }

  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    if (await pingServer()) return { ok: true, started: true, base: serverUrl };
  }
  return { ok: false, error: '后端启动超时，请检查 8787 端口', base: serverUrl };
}

async function api(pathname, init = {}) {
  const res = await fetch(`${serverUrl}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(185000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

/* ------------------------------------------------------------------- IPC */

ipcMain.handle('nav', async (_event, action, url) => {
  if (!view) return { ok: false };
  const wc = view.webContents;
  const history = wc.navigationHistory;
  try {
    if (action === 'back' && history?.canGoBack()) history.goBack();
    else if (action === 'forward' && history?.canGoForward()) history.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
    else if (action === 'goto') {
      let target = String(url || '').trim();
      if (!target) return { ok: false };
      if (!/^[a-z]+:\/\//i.test(target) && !target.startsWith('about:')) target = `https://${target}`;
      await wc.loadURL(target);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle('page:read', async () => {
  try {
    return await readSnapshot();
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

// 视觉识别用图：限制宽度 + JPEG 压缩，显著降低图片 token（对 OCR 精度影响很小）
function toVisionDataUrl(image, maxWidth = 1280, quality = 72) {
  try {
    const size = image.getSize();
    const img = size.width > maxWidth ? image.resize({ width: maxWidth, quality: 'good' }) : image;
    return `data:image/jpeg;base64,${img.toJPEG(quality).toString('base64')}`;
  } catch {
    return image.toDataURL();
  }
}

ipcMain.handle('page:capture', async (_event, target) => {
  // target: 'stage'（右侧 WebContentsView 整页）| 'visible'（可见区域）
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: '窗口未就绪' };
  try {
    let png;
    if (target === 'stage') {
      // 捕获 WebContentsView 的整个页面（可能长于可视区域）
      png = await view.webContents.capturePage();
    } else {
      // 默认只捕获可视区域
      png = await view.webContents.capturePage({});
    }
    const base64 = png.toDataURL(); // 自带 data:image/png;base64, 前缀
    return { ok: true, image: base64, url: view.webContents.getURL(), title: view.webContents.getTitle() };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

// 翻页 + 每页 OCR（逐题模式兜底）
// 前端调用一次 = 自动翻完所有页 + 每页 OCR + 回到第 1 题
// 翻页策略：① 优先找"题号导航面板"（学习通整卷预览里的 1-10 数字）
//          ② 退回到"下一题"按钮（4 级兜底：class → aria → 文字 → 位置推断）
ipcMain.handle('page:ocrLoop', async () => {
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: '窗口未就绪' };
  const wc = view.webContents;
  const mainFrame = wc.mainFrame;
  if (!mainFrame) return { ok: false, error: '主框架不可用' };

  // ---------- 翻页脚本（从 automation.js 同步过来，避免两套逻辑）----------
  const NEXT_TEXTS = ['下一题', '下一页', '继续', '下一题>', '下一题>>', 'next', 'Next', '下一篇'];
  const PREV_TEXTS = ['上一题', '上一页', '上一步', 'prev', 'Prev', '返回'];
  const NEXT_CLASSES = ['nextPage', 'nextBtn', 'next-btn', 'btn-next', 'el-button--next', 'answerNext', 'TiMu_next', 'question-next', 'pager-next'];
  const PREV_CLASSES = ['prevPage', 'prevBtn', 'prev-btn', 'btn-prev', 'el-button--prev', 'answerPrev', 'TiMu_prev', 'question-prev', 'pager-prev'];

  const FIND_NEXT = `(function(){
    const clean = (v) => String(v==null?'':v).replace(/\\s+/g,' ').trim();
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width<2 || r.height<2) return false;
      const s = getComputedStyle(el);
      return s.visibility!=='hidden' && s.display!=='none' && s.opacity!=='0';
    };
    // 1) class
    let el = null;
    for (const c of ${JSON.stringify(NEXT_CLASSES)}) {
      const hits = document.querySelectorAll('.'+c);
      for (let i=0;i<hits.length;i++) { if (visible(hits[i])) { el = hits[i]; break; } }
      if (el) break;
    }
    // 2) aria/title
    if (!el) {
      const all = document.querySelectorAll('[aria-label],[title],button,a');
      for (let i=0;i<all.length;i++) {
        const a = all[i].getAttribute('aria-label') || all[i].getAttribute('title') || '';
        if (/下一题|下一页|next/i.test(a) && visible(all[i])) { el = all[i]; break; }
      }
    }
    // 3) 文字
    if (!el) {
      const all = document.querySelectorAll('button,a,[role="button"],[onclick],span,div,li');
      for (const t of ${JSON.stringify(NEXT_TEXTS)}) {
        for (let i=0;i<all.length;i++) {
          const c = all[i];
          if (!visible(c)) continue;
          const t2 = clean(c.innerText || c.textContent || '');
          if (!t2.includes(t)) continue;
          if (${JSON.stringify(PREV_TEXTS)}.some(p => t2.includes(p))) continue;
          const r = c.getBoundingClientRect();
          if (r.height<14 || r.height>140) continue;
          el = c; break;
        }
        if (el) break;
      }
    }
    // 4) 位置推断：右下角的按钮
    if (!el) {
      const w = window.innerWidth, h = window.innerHeight;
      const all = document.querySelectorAll('button,a,[role="button"]');
      let best = null, bestDist = Infinity;
      for (let i=0;i<all.length;i++) {
        if (!visible(all[i])) continue;
        const r = all[i].getBoundingClientRect();
        if (r.left+r.width < w*0.6) continue;
        if (r.top+r.height < h*0.4) continue;
        const d = (w - (r.left+r.width/2)) + (h - (r.top+r.height/2));
        if (d < bestDist) { bestDist = d; best = all[i]; }
      }
      el = best;
    }
    if (!el) return null;
    try { el.scrollIntoView({block:'center'}); el.click(); } catch(e) {}
    return 'clicked';
  })()`;

  const FIND_PREV = `(function(){
    const clean = (v) => String(v==null?'':v).replace(/\\s+/g,' ').trim();
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width<2 || r.height<2) return false;
      const s = getComputedStyle(el);
      return s.visibility!=='hidden' && s.display!=='none' && s.opacity!=='0';
    };
    let el = null;
    for (const c of ${JSON.stringify(PREV_CLASSES)}) {
      const hits = document.querySelectorAll('.'+c);
      for (let i=0;i<hits.length;i++) { if (visible(hits[i])) { el = hits[i]; break; } }
      if (el) break;
    }
    if (!el) {
      const all = document.querySelectorAll('[aria-label],[title],button,a');
      for (let i=0;i<all.length;i++) {
        const a = all[i].getAttribute('aria-label') || all[i].getAttribute('title') || '';
        if (/上一题|上一页|prev|返回/i.test(a) && visible(all[i])) { el = all[i]; break; }
      }
    }
    if (!el) {
      const all = document.querySelectorAll('button,a,[role="button"],[onclick],span,div');
      for (const t of ${JSON.stringify(PREV_TEXTS)}) {
        for (let i=0;i<all.length;i++) {
          const c = all[i];
          if (!visible(c)) continue;
          const t2 = clean(c.innerText || c.textContent || '');
          if (!t2.includes(t)) continue;
          const r = c.getBoundingClientRect();
          if (r.height<14 || r.height>120) continue;
          el = c; break;
        }
        if (el) break;
      }
    }
    if (!el) return false;
    try { el.scrollIntoView({block:'center'}); el.click(); } catch(e) {}
    return true;
  })()`;

  // 找"题号导航面板"并点击指定数字（例如点"5"跳到第 5 题）
  // 返回：{ clicked: bool, availableMax: number }
  const CLICK_INDEX = `(function(targetNum){
    if (!targetNum) return {clicked:false, availableMax:0};
    const clean = (v) => String(v==null?'':v).replace(/\\s+/g,' ').trim();
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width<1 || r.height<1) return false;
      const s = getComputedStyle(el);
      return s.visibility!=='hidden' && s.display!=='none' && s.opacity!=='0';
    };
    // 学习通整卷预览里题号按钮的典型 class：Zy_TItle / TiMu / zy_left / item / question-index / pager
    // 先扫所有含纯 1-2 位数字的可见元素
    const candidates = [];
    const all = document.querySelectorAll('a,button,span,div,li,i,em');
    for (let i=0;i<all.length;i++) {
      const el = all[i];
      if (!visible(el)) continue;
      const t = clean(el.innerText || el.textContent || '');
      if (!/^\\d{1,2}$/.test(t)) continue;
      const n = parseInt(t, 10);
      if (isNaN(n) || n < 1 || n > 50) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) continue;
      if (r.width > 120 || r.height > 120) continue;
      candidates.push({ n, el, r });
    }
    // 按数字排序，找最大的那个 = 总题数
    let availableMax = 0;
    for (const c of candidates) if (c.n > availableMax) availableMax = c.n;
    // 尝试点目标数字（优先最靠左/上的那一个）
    const target = candidates
      .filter(c => c.n === targetNum)
      .sort((a,b) => (a.r.top - b.r.top) || (a.r.left - b.r.left))[0];
    if (target) {
      try { target.el.scrollIntoView({block:'center'}); target.el.click(); } catch(e) {}
      return {clicked:true, availableMax};
    }
    return {clicked:false, availableMax};
  })(arguments[0])`;

  const GET_SIG = `(function(){
    const clean = (v) => String(v==null?'':v).replace(/\\s+/g,' ').trim();
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width<2 || r.height<2) return false;
      const s = getComputedStyle(el);
      return s.visibility!=='hidden' && s.display!=='none' && s.opacity!=='0';
    };
    const pool = document.querySelectorAll('.TiMu,.questionLi,.subject_describe,.Zy_TItle,[class*="question"],[class*="item"]');
    for (let i=0;i<pool.length;i++) { if (visible(pool[i])) return clean(pool[i].innerText||'').slice(0,80); }
    return clean(document.body?document.body.innerText:'').slice(0,80);
  })()`;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const collected = [];
  const seenStems = new Set();
  const ocrUrl = `${serverUrl.replace(/\/+$/,'')}/api/ocr`;

  async function oneOCR() {
    const shot = await wc.capturePage();
    const b64 = toVisionDataUrl(shot);
    try {
      const ocr = await fetch(ocrUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: b64, url: wc.getURL(), title: wc.getTitle() }),
      }).then((r) => r.json());
      if (ocr.ok && Array.isArray(ocr.questions)) {
        for (const q of ocr.questions) {
          const k = String(q.stem || '').slice(0, 80);
          if (k && !seenStems.has(k)) { seenStems.add(k); collected.push({ ...q, frame: 'ocr' }); }
        }
      }
    } catch {}
  }

  // 扫题号导航面板的完整编号集合（用于漏题检测）
  const SCAN_NAV = `(function(){
    const clean = (v) => String(v==null?'':v).replace(/\\s+/g,' ').trim();
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width<1 || r.height<1) return false;
      const s = getComputedStyle(el);
      return s.visibility!=='hidden' && s.display!=='none' && s.opacity!=='0';
    };
    const nums = new Set();
    const all = document.querySelectorAll('a,button,span,div,li,i,em');
    for (let i=0;i<all.length;i++) {
      const el = all[i];
      if (!visible(el)) continue;
      const t = clean(el.innerText || el.textContent || '');
      if (!/^\\d{1,3}$/.test(t)) continue;
      const n = parseInt(t, 10);
      if (n >= 1 && n <= 500) nums.add(n);
    }
    return Array.from(nums).sort((a,b)=>a-b);
  })()`;

  // 提取 stem 开头的题号（匹配 "1." "2、" "3．" "(4)" 等）
  const extractIndex = (stem) => {
    if (!stem) return 0;
    const m = stem.match(/^\s*\(?\s*(\d{1,3})\s*[.、:：．)）]\s*/);
    return m ? parseInt(m[1], 10) : 0;
  };

  // ---- 策略 1：先探题号导航面板 ----
  let totalByNav = 0;
  try {
    const probe = await evalInFrame(mainFrame, CLICK_INDEX.replace('arguments[0]', '999'), 5000);
    if (probe && probe.availableMax >= 2) totalByNav = probe.availableMax;
  } catch {}

  // 抓第 1 题（当前）
  await oneOCR();
  let pagesOCRed = 1;

  if (totalByNav >= 2) {
    // ---- 策略 A：用题号导航逐一点击 ----
    win.webContents.send('run:event', { type: 'progress', text: `检测到题号导航 ${totalByNav} 题，按数字跳转…` });
    for (let i = 2; i <= totalByNav; i += 1) {
      const res = await evalInFrame(mainFrame, CLICK_INDEX.replace('arguments[0]', String(i)), 5000);
      if (!res || !res.clicked) break;
      await sleep(600); // 等题目渲染
      await oneOCR();
      pagesOCRed += 1;
      win.webContents.send('run:event', { type: 'progress', text: `OCR 第 ${i}/${totalByNav} 题，累计 ${collected.length} 道` });
    }
    // 漏题补录：扫题号面板完整集合 vs 已收集
    let missing = [];
    try {
      const navNums = await evalInFrame(mainFrame, SCAN_NAV, 5000);
      const haveIdx = new Set(collected.map((q) => extractIndex(q.stem)).filter((x) => x > 0));
      missing = navNums.filter((n) => !haveIdx.has(n));
    } catch {}
    if (missing.length > 0 && missing.length <= Math.max(30, Math.floor(totalByNav * 0.3))) {
      win.webContents.send('run:event', { type: 'progress', text: `漏题检测：导航面板显示 ${totalByNav} 题，OCR 漏了 ${missing.length} 道（${missing.slice(0, 10).join(', ')}…），开始补录…` });
      let补录 = 0;
      for (const idx of missing) {
        const res = await evalInFrame(mainFrame, CLICK_INDEX.replace('arguments[0]', String(idx)), 5000);
        if (!res || !res.clicked) continue;
        await sleep(550);
        const before = collected.length;
        await oneOCR();
        pagesOCRed += 1;
        const added = collected.length - before;
        if (added > 0) 补录 += 1;
      }
      if (补录 > 0) win.webContents.send('run:event', { type: 'progress', text: `补录完成：成功找回 ${补录}/${missing.length} 道` });
      else win.webContents.send('run:event', { type: 'progress', text: `补录失败：${missing.length} 道均未获取到（可能被折叠）` });
    }
    // 回到第 1 题
    await evalInFrame(mainFrame, CLICK_INDEX.replace('arguments[0]', '1'), 4000);
    await sleep(300);
  } else {
    // ---- 策略 B：退回"下一题"按钮 ----
    win.webContents.send('run:event', { type: 'progress', text: '未检测到题号导航，改用"下一题"按钮…' });
    let flipped = 0;
    const MAX_PAGES = 20;
    let consecutiveNoNew = 0;

    for (let page = 1; page < MAX_PAGES; page += 1) {
      const ok = await evalInFrame(mainFrame, FIND_NEXT, 5000);
      if (!ok) break;
      flipped += 1;
      await sleep(600);

      const before = collected.length;
      await oneOCR();
      pagesOCRed += 1;
      const added = collected.length - before;

      if (added === 0) consecutiveNoNew += 1;
      else consecutiveNoNew = 0;

      win.webContents.send('run:event', { type: 'progress', text: `翻页 ${flipped} 次，累计 ${collected.length} 道题` });
      if (consecutiveNoNew >= 3) break;
    }

    // 翻回第 1 题
    for (let i = 0; i < flipped; i += 1) {
      const ok = await evalInFrame(mainFrame, FIND_PREV, 4000);
      if (!ok) break;
      await sleep(280);
    }
  }

  return {
    ok: true,
    questions: collected,
    pagesOCRed,
    url: wc.getURL(),
    title: wc.getTitle(),
  };
});

// 情报 1：直接调学习通官方 API 拉全量题目（最牛方案，一次返回所有题）
// 来源：5ime.cn Python 爬虫 + zhangtiefei 插件分析
// API: http://mooc1.chaoxing.com/exam-ans/exam/test/reVersionPaperMarkContentNew?courseId=X&classId=Y&id=Z
// 注入到页面里执行（自动带 session cookies + DOMParser）
ipcMain.handle('page:fetchExam', async () => {
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: '窗口未就绪' };
  const wc = view.webContents;
  const mainFrame = wc.mainFrame;
  if (!mainFrame) return { ok: false, error: '主框架不可用' };

  const FETCH_EXAM = `(async function(){
    try {
      const curUrl = location.href;
      // 从当前 URL 提取参数
      const u = new URL(curUrl);
      const courseId = u.searchParams.get('courseId') || new URL(location.ancestorOrigins[0]+location.search).searchParams.get('courseId') || '';
      const classId = u.searchParams.get('classId') || '';
      const id = u.searchParams.get('id') || u.searchParams.get('examId') || '';
      const jid = u.searchParams.get('jid') || '';
      const name = u.searchParams.get('name') || '';
      const paperId = u.searchParams.get('paperId') || '';
      // 如果当前页本身就是 mooc1 的考试页，从 DOM 里再挖一遍参数
      let finalCourseId = courseId, finalClassId = classId, finalId = id;
      if (!finalId) {
        const scripts = document.querySelectorAll('script:not([src])');
        for (const s of scripts) {
          const t = s.textContent || '';
          const m1 = t.match(/courseId\\s*[:=]\\s*['"]?(\\d+)['"]?/); if (m1) finalCourseId = m1[1];
          const m2 = t.match(/classId\\s*[:=]\\s*['"]?(\\d+)['"]?/); if (m2) finalClassId = m2[1];
          const m3 = t.match(/['"]id['"]\\s*[:=]\\s*['"]?(\\d+)['"]?/); if (m3) finalId = m3[1];
        }
      }
      if (!finalId && !finalCourseId) {
        // 兜底：直接用当前 DOM 解析可见题目（情报 2+3 的选择器）
        return { ok:false, error:'页面无考试参数，走 DOM 解析兜底', fallback:'dom' };
      }
      // 构建多个候选 URL 试（不同版本的 API）
      const urls = [];
      const base = 'http://mooc1.chaoxing.com/exam-ans/exam/test/reVersionPaperMarkContentNew';
      const q = new URLSearchParams();
      if (finalCourseId) q.set('courseId', finalCourseId);
      if (finalClassId) q.set('classId', finalClassId);
      if (finalId) q.set('id', finalId);
      if (jid) q.set('jid', jid);
      if (name) q.set('name', name);
      if (paperId) q.set('paperId', paperId);
      q.set('ut', 's');
      urls.push(base + '?' + q.toString());
      // 也试 https
      urls.push(base.replace('http://','https://') + '?' + q.toString());
      // 还试旧 API
      const oldBase = 'http://mooc1.chaoxing.com/exam-ans/exam/test/reVersionPaperMarkContent';
      urls.push(oldBase + '?' + q.toString());
      // 发起请求
      let html = '', finalUrl = '';
      for (const tryUrl of urls) {
        try {
          const resp = await fetch(tryUrl, { credentials:'include', redirect:'follow' });
          if (resp.ok && resp.redirected) { finalUrl = resp.url; html = await resp.text(); break; }
          if (resp.ok) { html = await resp.text(); if (html.includes('TiMu') || html.includes('Cy_TItle') || html.includes('Zy_TItle')) { finalUrl = tryUrl; break; } }
        } catch(e) {}
      }
      if (!html) return { ok:false, error:'API 请求全部失败', fallback:'dom', urls: urls };
      // 用 DOMParser 解析
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const blocks = doc.querySelectorAll('.TiMu');
      const out = [];
      // 兜底选择器
      const titleSel = '.fl.clearfix, .fl, .Cy_TItle > div, .Cy_Title > div, .Zy_TItle, .Zy_Title, [class*="title"], [class*="question"]';
      const optSel = '.Cy_ulTop > form > li, .Cy_ulTop > li, .Zy_ulTop > li, .Zy_ulTop > form > li, .option, [class*="option"]';
      const ansSel = '.Py_answer > span, .Py_answer, .answer, [class*="answer"]';

      blocks.forEach((blk, idx) => {
        // 题干
        let stem = '';
        const tNode = blk.querySelector('.Cy_TItle > div, .Cy_Title > div, .Zy_TItle, .Zy_Title, .fl.clearfix, .fl');
        if (tNode) stem = (tNode.innerText || '').trim();
        else {
          const firstChild = blk.querySelector('div');
          if (firstChild) stem = (firstChild.innerText || '').trim();
        }
        // 选项
        const options = [];
        const optNodes = blk.querySelectorAll(optSel);
        let optIdx = 0;
        optNodes.forEach((li) => {
          const text = (li.innerText || '').trim().replace(/^[A-Fa-f][.、:：．)）]\s*/, '');
          if (!text || text.length < 1) return;
          const letter = String.fromCharCode(65 + (optIdx++));
          options.push({ key: letter, text: text.slice(0, 400), elementId: undefined });
        });
        // 题型推断
        let type = 'single';
        if (stem.includes('（多选') || stem.includes('(多选') || stem.includes('多选题')) type = 'multiple';
        else if (stem.includes('（判断') || stem.includes('(判断') || stem.includes('判断题')) type = 'judge';
        else if (stem.includes('填空') || stem.includes('____') || stem.includes('（    ）')) type = 'fill';
        if (options.length === 2 && /对|错|√|×|正确|错误/.test(options[0]?.text || '') && /对|错|√|×|正确|错误/.test(options[1]?.text || '')) type = 'judge';
        out.push({
          id: 'api_' + idx,
          stem: stem.slice(0, 2000),
          type,
          options,
          elementId: undefined,
          frame: 'api',
        });
      });
      return { ok: true, questions: out, sourceUrl: finalUrl, totalParams: { courseId: finalCourseId, classId: finalClassId, id: finalId } };
    } catch (err) {
      return { ok: false, error: String(err.message || err), fallback:'dom' };
    }
  })()`;

  try {
    const result = await evalInFrame(mainFrame, FETCH_EXAM, 15000);
    return result;
  } catch (error) {
    return { ok: false, error: String(error.message || error), fallback: 'dom' };
  }
});

ipcMain.handle('page:execute', async (_event, payload) => {
  try {
    return await executeSteps(payload?.steps);
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle('page:stop', async () => {
  stopRequested = true;
  return { ok: true };
});

// 点击学习通页面的“暂存”按钮（只保存草稿，不提交作业）
ipcMain.handle('page:save', async () => {
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: '窗口未就绪' };
  const frame = view.webContents.mainFrame;
  const clicked = await evalInFrame(
    frame,
    `(function () {
      const el = document.getElementById('tempsave');
      if (!el) return { ok: false, error: '页面上没有找到暂存按钮' };
      el.click();
      return { ok: true };
    })()`,
  );
  if (!clicked || !clicked.ok) return clicked || { ok: false, error: '页面响应超时' };
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const text = await evalInFrame(
      frame,
      `(document.getElementById('saveSuccessContent') || {}).innerText || ''`,
    );
    if (text && /保存成功/.test(text)) return { ok: true, message: text.trim() };
  }
  return { ok: false, error: '已点击暂存，但未检测到“保存成功”提示' };
});

// 导出答案到本地 JSON 文件
ipcMain.handle('answers:export', async (_event, payload) => {
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口未就绪' };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出答案',
    defaultPath: `answers-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle('server:check', async () => ensureServer());

ipcMain.handle('server:set', async (_event, raw) => {
  const next = String(raw || '').trim() || DEFAULT_SERVER;
  if (!/^https?:\/\//i.test(next)) {
    return { ok: false, error: '后端地址需要以 http:// 或 https:// 开头', base: serverUrl };
  }
  serverUrl = next.replace(/\/+$/, '');
  return ensureServer();
});

ipcMain.handle('backend:settings', async () => api('/api/settings'));

ipcMain.handle('backend:settingsUpdate', async (_event, patch) => {
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch || {}),
    });
    return { ok: true, ...data };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle('backend:runs', async () => {
  try {
    const data = await api('/api/runs');
    return { ok: true, runs: data.runs || [] };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.on('log:write', (_event, payload) => {
  const data = payload || {};
  writeRunLog(data.scope || 'ui', data.text || '');
});
ipcMain.handle('log:path', async () => logFilePath());
ipcMain.handle('backend:models', async () => api('/api/models'));
ipcMain.handle('backend:aiTest', async () => api('/api/ai/test', { method: 'POST', body: '{}' }));

ipcMain.handle('backend:ocr', async (_event, payload) => {
  try {
    const data = await api('/api/ocr', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
    return { ok: true, ...data };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle('ai:quiz', async (_event, payload) => {
  try {
    const data = await api('/api/ai/quiz', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
    return { ok: true, ...data };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

/* --------------------------------------------------------------- 生命周期 */

// 只允许一个实例：重复双击启动时聚焦已有窗口，避免用户数据目录冲突
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    const persist = session.fromPartition(PARTITION);
    await restoreCookies(persist);
    writeRunLog('main', `==== PagePilot 启动（v${readAppVersion()}，打包=${app.isPackaged}）====`);
    createWindow();
    const state = await ensureServer();
    if (win && !win.isDestroyed()) win.webContents.send('server:state', state);
    // 定时快照，避免异常退出导致登录态丢失
    const timer = setInterval(() => saveCookies(persist), 120_000);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();

  // 退出前把登录 Cookie 落盘，下次启动保持登录态
  try {
    if (view && !view.webContents.isDestroyed()) rememberUrl(view.webContents.getURL());
  } catch {
    // 忽略
  }
  const persist = session.fromPartition(PARTITION);
  Promise.race([saveCookies(persist).then(() => persist.cookies.flushStore()), sleep(1800)])
    .catch(() => {})
    .finally(() => {
      if (serverChild) {
        try {
          serverChild.kill();
        } catch {
          // 忽略退出时的清理错误
        }
        serverChild = null;
      }
      app.quit();
    });
});
