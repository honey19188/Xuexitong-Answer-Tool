import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { resolveAi, chat, parseJsonLoose, streamChat, type ChatMessage } from './ai.js';
import { PLAN_SYSTEM, QUIZ_SYSTEM, CHAT_SYSTEM, buildPlanUser, buildQuizUser } from './prompts.js';
import {
  SnapshotSchema,
  ModelPlanSchema,
  ModelAnswerSchema,
  QuestionSchema,
  sanitizePlan,
  sanitizeAnswers,
} from './schemas.js';
import {
  addRun,
  deleteRun,
  getRun,
  getSettings,
  listRuns,
  maskKey,
  updateSettings,
  updateRunSummary,
  EXPORT_DIR,
  DATA_DIR,
  type Plan,
  type QuizAnswer,
  type RunLog,
  type RunRecord,
} from './store.js';
import { writeExport, type ExportFormat } from './exports.js';
import { MODEL_GROUPS, ALL_MODELS } from './models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, '../../web/dist');
const EXTENSION_DIR = path.resolve(__dirname, '../../extension');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_AI_REQUESTS_PER_MINUTE = 30;

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 8 * 1024 * 1024,
  trustProxy: false,
});

// 必须在注册插件/路由之前设置，否则会被插件的封装上下文覆盖
app.setErrorHandler((error, req, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: '请求参数不合法',
      details: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  const status = (error as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) req.log.error(error);
  return reply.code(status).send({ error: (error as Error).message || '服务器内部错误' });
});

await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// ---------- 简单限流（按 IP，仅针对 AI 调用） ----------
const aiHits = new Map<string, number[]>();
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/ai/')) return;
  const key = req.ip || 'unknown';
  const now = Date.now();
  const hits = (aiHits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= MAX_AI_REQUESTS_PER_MINUTE) {
    return reply.code(429).send({ error: 'AI 调用过于频繁，请等待一分钟后再试' });
  }
  hits.push(now);
  aiHits.set(key, hits);
});

// ---------- AI 调用审计日志（JSONL，只记录元信息） ----------
function auditAi(entry: Record<string, unknown>) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'ai-calls.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 审计日志失败不影响主流程
  }
}

function requireAi() {
  const cfg = resolveAi();
  if (!cfg) {
    throw Object.assign(
      new Error('还没有配置 AI：请在 Web 控制台 → 设置里填写 API Key（或设置环境变量 OPENAI_API_KEY）'),
      { statusCode: 400 },
    );
  }
  return cfg;
}

function settingsView() {
  const settings = getSettings();
  const envKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
  const effective = resolveAi();
  return {
    ai: {
      baseUrl: settings.ai.baseUrl,
      model: settings.ai.model,
      temperature: settings.ai.temperature,
      apiKeyMasked: maskKey(settings.ai.apiKey),
      hasApiKey: Boolean(settings.ai.apiKey) || Boolean(envKey),
      source: effective?.source ?? 'none',
    },
    safety: settings.safety,
    updatedAt: settings.updatedAt,
  };
}

// ---------- 基础 ----------
app.get('/api/health', async () => ({
  ok: true,
  name: 'PagePilot',
  version: '0.1.0',
  time: new Date().toISOString(),
  aiConfigured: Boolean(resolveAi()),
}));

// ---------- 模型清单（供前端下拉补全） ----------
app.get('/api/models', async () => ({
  total: ALL_MODELS.length,
  groups: MODEL_GROUPS,
  flat: ALL_MODELS.map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, baseUrl: m.baseUrl, tags: m.tags })),
}));

app.get('/api/info', async () => ({
  name: 'PagePilot',
  version: '0.1.0',
  extensionPath: EXTENSION_DIR,
  extensionExists: fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json')),
  webDistPath: WEB_DIST,
  webBuilt: fs.existsSync(path.join(WEB_DIST, 'index.html')),
  aiConfigured: Boolean(resolveAi()),
  aiSource: resolveAi()?.source ?? 'none',
}));

// ---------- 设置 ----------
const SettingsPatchSchema = z
  .object({
    ai: z
      .object({
        baseUrl: z.string().url().max(500).optional(),
        apiKey: z.string().max(500).optional(),
        model: z.string().min(1).max(100).optional(),
        temperature: z.number().min(0).max(2).optional(),
      })
      .optional(),
    safety: z
      .object({
        domainAllowlist: z.array(z.string().max(200)).max(50).optional(),
        requireConfirmForHighRisk: z.boolean().optional(),
      })
      .optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict();

app.get('/api/settings', async () => settingsView());

app.put('/api/settings', async (req, reply) => {
  const patch = SettingsPatchSchema.parse(req.body ?? {});
  const ai = patch.ai ? { ...patch.ai } : undefined;
  if (ai && ai.apiKey === '') delete ai.apiKey; // 空字符串表示保持原 Key
  updateSettings({
    ai,
    safety: patch.safety,
    clearApiKey: patch.clearApiKey,
  });
  return reply.send({ ok: true, settings: settingsView() });
});

// ---------- AI ----------
app.post('/api/ai/test', async (req, reply) => {
  const cfg = requireAi();
  const started = Date.now();
  const result = await chat(cfg, [{ role: 'user', content: '只回复两个字：连接成功' }], {
    maxTokens: 20,
    temperature: 0,
  });
  auditAi({
    at: new Date().toISOString(),
    kind: 'test',
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    ms: Date.now() - started,
    ok: true,
  });
  return reply.send({
    ok: true,
    model: cfg.model,
    source: cfg.source,
    latencyMs: Date.now() - started,
    reply: result.text.trim().slice(0, 200),
  });
});

const PlanBodySchema = z.object({
  requirement: z.string().min(1).max(4000),
  snapshot: SnapshotSchema,
});

app.post('/api/ai/plan', async (req, reply) => {
  const cfg = requireAi();
  const body = PlanBodySchema.parse(req.body ?? {});
  const started = Date.now();
  try {
    const result = await chat(
      cfg,
      [
        { role: 'system', content: PLAN_SYSTEM },
        { role: 'user', content: buildPlanUser(body.requirement, body.snapshot) },
      ],
      { json: true },
    );
    const { plan, warnings } = sanitizePlan(parseJsonLoose(result.text), body.snapshot);
    if (!plan.steps.length && !plan.notes) plan.notes = 'AI 没有给出可执行步骤，请补充要求或换一种描述';
    auditAi({
      at: new Date().toISOString(),
      kind: 'plan',
      model: result.model ?? cfg.model,
      url: body.snapshot.url,
      steps: plan.steps.length,
      warnings,
      usage: result.usage,
      ms: Date.now() - started,
      ok: true,
    });
    return reply.send({ plan, warnings, usage: result.usage, model: result.model ?? cfg.model });
  } catch (error) {
    auditAi({
      at: new Date().toISOString(),
      kind: 'plan',
      url: body.snapshot.url,
      ms: Date.now() - started,
      ok: false,
      error: String((error as Error).message).slice(0, 500),
    });
    throw error;
  }
});

const QuizBodySchema = z.object({
  requirement: z.string().max(4000).optional().default(''),
  context: z.string().max(8000).optional(),
  snapshot: SnapshotSchema,
});

app.post('/api/ai/quiz', async (req, reply) => {
  const cfg = requireAi();
  const body = QuizBodySchema.parse(req.body ?? {});
  const questions = body.snapshot.questions ?? [];
  if (!questions.length) {
    return reply.code(400).send({ error: '当前页面没有识别到题目，请确认已打开答题页面并点击"读取页面"' });
  }
  const started = Date.now();

  // 分批请求：每批 10 道题，避免 AI 输出被 max_tokens 截断
  const BATCH_SIZE = 10;
  const batches: typeof questions[] = [];
  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    batches.push(questions.slice(i, i + BATCH_SIZE));
  }

  const allAnswers: unknown[] = [];
  const allWarnings: string[] = [];
  let totalTokens: { prompt?: number; completion?: number; total?: number } | undefined;
  let lastModel: string | undefined;
  const batchResults: { index: number; total: number; questions: number; answers: number; ms: number; ok: boolean; error?: string }[] = [];

  try {
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const batchSnapshot = { ...body.snapshot, questions: batch };
      const batchLabel = batches.length > 1 ? `（第 ${bi + 1}/${batches.length} 批）` : '';
      const batchStarted = Date.now();

      try {
        const messages = [
          { role: 'system' as const, content: QUIZ_SYSTEM + (batches.length > 1
            ? `\n\n当前为分批请求 ${batchLabel}，请仅回答本批 ${batch.length} 道题。`
            : '') },
          { role: 'user' as const, content: buildQuizUser(body.requirement, batchSnapshot, body.context) },
        ];
        let result = await chat(cfg, messages, { json: true, maxTokens: 4096 });
        let parsed;
        try {
          parsed = parseJsonLoose(result.text);
        } catch (firstError) {
          // 输出被截断或不是合法 JSON 时，整批重试一次
          result = await chat(cfg, messages, { json: true, maxTokens: 4096 });
          parsed = parseJsonLoose(result.text);
        }
        const { answers, warnings } = sanitizeAnswers(parsed, batchSnapshot);
        allAnswers.push(...answers);
        if (warnings.length) allWarnings.push(...warnings);

        if (result.usage) {
          totalTokens = {
            prompt: (totalTokens?.prompt ?? 0) + (result.usage.prompt_tokens ?? 0),
            completion: (totalTokens?.completion ?? 0) + (result.usage.completion_tokens ?? 0),
            total: (totalTokens?.total ?? 0) + (result.usage.total_tokens ?? 0),
          };
        }
        lastModel = result.model ?? cfg.model;

        batchResults.push({
          index: bi + 1,
          total: batches.length,
          questions: batch.length,
          answers: answers.length,
          ms: Date.now() - batchStarted,
          ok: true,
        });
      } catch (batchError) {
        // 单批失败不中断后续批次
        batchResults.push({
          index: bi + 1,
          total: batches.length,
          questions: batch.length,
          answers: 0,
          ms: Date.now() - batchStarted,
          ok: false,
          error: String((batchError as Error).message).slice(0, 200),
        });
      }
    }

    auditAi({
      at: new Date().toISOString(),
      kind: 'quiz',
      model: lastModel ?? cfg.model,
      url: body.snapshot.url,
      questions: questions.length,
      answers: allAnswers.length,
      warnings: allWarnings,
      usage: totalTokens,
      ms: Date.now() - started,
      ok: allAnswers.length > 0,
      batches: batches.length,
      batchResults,
    });
    return reply.send({
      answers: allAnswers,
      warnings: allWarnings,
      usage: totalTokens,
      model: lastModel ?? cfg.model,
      batches: batches.length,
      batchResults,
      ms: Date.now() - started,
    });
  } catch (error) {
    auditAi({
      at: new Date().toISOString(),
      kind: 'quiz',
      url: body.snapshot.url,
      questions: questions.length,
      ms: Date.now() - started,
      ok: false,
      error: String((error as Error).message).slice(0, 500),
    });
    throw error;
  }
});;

const ChatBodySchema = z.object({
  prompt: z.string().max(4000).optional(),
  context: z.string().max(12000).optional(),
  runId: z.string().max(80).optional(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(20)
    .optional(),
});

// ---------- OCR / 视觉识别 ----------
const OcrBodySchema = z.object({
  image: z.string().min(100).max(20_000_000), // data:image/png;base64,... 或纯 base64
  url: z.string().max(2000).optional(),
  title: z.string().max(500).optional(),
});

const OCR_SYSTEM = `你是一名专业的中文考试题目 OCR 助手。
你会收到一张考试/答题页面的截图。请从中提取所有可见的题目。

严格规则：
1. 必须返回合法 JSON（不要 markdown、不要多余文字）
2. type 字段只能是：single / multiple / judge / fill / short
   - single = 单选题
   - multiple = 多选题（题目里出现"多选"或多个正确选项提示）
   - judge = 判断题（题干很短，选项是"对/错"或"A=正确,B=错误"格式）
   - fill = 填空题（出现下划线/空格/括号要求填字）
   - short = 简答题/论述题（没有明确选项，要求写长答案）
3. 每道题的 id 用 "ocr_0", "ocr_1", ... 格式的递增序号
4. stem 字段完整保留题干原文（可以包含题目里的 A/B/C/D 分隔文字）
5. options 只保留有明确选项字母（A/B/C/D）的题目；fill/short 题 options 返回空数组 []
6. options 里每个选项 key 就是字母 A/B/C/D，text 只保留选项文字（不要 "A." 前缀）
7. 尽量多提：宁可多一道也不要漏一道。右下角一般有题目导航数字（1/2/3...10），如果能数出总数要全部提取

返回格式：
{
  "questions": [
    {
      "id": "ocr_0",
      "stem": "1.（单选题，10.0 分）发生火灾，疏散逃生时，浓烟环境下我们应该（ ）",
      "type": "single",
      "options": [
        {"key": "A", "text": "直立快速奔跑，尽快撤离"},
        {"key": "B", "text": "弯腰低姿，捂住口鼻，沿疏散指示标志前进"},
        {"key": "C", "text": "乘坐电梯快速下楼逃生"},
        {"key": "D", "text": "躲在衣柜等待救援"}
      ]
    }
  ]
}`;

app.post('/api/ocr', async (req, reply) => {
  const cfg = requireAi();
  const body = OcrBodySchema.parse(req.body ?? {});

  // 自动补全 data URI
  let dataUrl = body.image;
  if (!dataUrl.startsWith('data:')) {
    dataUrl = `data:image/png;base64,${body.image.replace(/\s+/g, '')}`;
  }

  const started = Date.now();
  const userPrompt = body.title
    ? `请识别这张考试页面截图里的所有题目。\n页面：${body.title}`
    : '请识别这张考试页面截图里的所有题目。';

  const visionMessages = [
    { role: 'system' as const, content: OCR_SYSTEM },
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: userPrompt },
        { type: 'image_url' as const, image_url: { url: dataUrl } },
      ],
    },
  ];

  // 候选模型：先用当前配置的模型（它可能本身支持 vision），失败则用同 baseUrl 的 vision 模型
  const VISION_FALLBACKS = [
    'doubao-1.5-vision-pro-32k',
    'doubao-vision-pro-32k',
    'glm-4v',
    'glm-4v-plus',
    'qwen-vl-plus',
    'qwen2.5-vl-72b-instruct',
    'gpt-4o',
    'gpt-4o-mini',
    'claude-3.5-sonnet',
  ];
  const candidates = [cfg.model, ...VISION_FALLBACKS.filter((m) => m !== cfg.model)];
  let lastError: unknown = null;
  let result: { text: string; usage?: unknown; model?: string } | null = null;
  let usedModel = cfg.model;

  for (const candidate of candidates.slice(0, 3)) {
    try {
      const trial = await chat(
        { ...cfg, model: candidate },
        visionMessages,
        { json: true, maxTokens: 8192 },
      );
      result = trial;
      usedModel = candidate;
      break;
    } catch (e) {
      lastError = e;
      // 非 vision 相关错误（比如网络）就不重试了
      const msg = String((e as Error).message || '');
      if (!/invalid param|not support|unsupported|image|vision|4001|4003/i.test(msg)) break;
    }
  }

  if (!result) {
    auditAi({
      at: new Date().toISOString(),
      kind: 'ocr',
      model: cfg.model,
      ms: Date.now() - started,
      ok: false,
      error: String((lastError as Error)?.message || lastError).slice(0, 500),
    });
    throw lastError ?? new Error('视觉识别失败');
  }

  try {
    const parsed = parseJsonLoose(result.text) as { questions?: unknown[] };
    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];

    // 统一补字段、去重（按 stem 前 80 字）
    const seen = new Set<string>();
    const cleaned = [];
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i] as Record<string, unknown>;
      const stem = String(q.stem || '').trim();
      if (!stem) continue;
      const key = stem.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);

      const typeRaw = String(q.type || 'single').toLowerCase();
      let type = typeRaw;
      if (!['single', 'multiple', 'judge', 'fill', 'short'].includes(type)) type = 'single';

      let options: Array<{ key: string; text: string }> = [];
      if (type !== 'fill' && type !== 'short' && Array.isArray(q.options)) {
        options = (q.options as unknown[])
          .map((opt) => {
            const o = opt as Record<string, unknown>;
            const k = String(o.key || '').trim().toUpperCase();
            const t = String(o.text || '').trim();
            return k && t ? { key: k.slice(0, 3), text: t.slice(0, 400) } : null;
          })
          .filter((x): x is { key: string; text: string } => Boolean(x));
      }

      cleaned.push({
        id: `ocr_${i}`,
        stem: stem.slice(0, 2000),
        type,
        options,
        elementId: undefined,
        frame: undefined,
      });
    }

    auditAi({
      at: new Date().toISOString(),
      kind: 'ocr',
      model: usedModel,
      ms: Date.now() - started,
      ok: true,
      questions: cleaned.length,
      usage: result.usage,
    });

    return reply.send({
      ok: true,
      questions: cleaned,
      url: body.url || '',
      title: body.title || '',
      model: usedModel,
      usage: result.usage,
      latencyMs: Date.now() - started,
    });
  } catch (error) {
    auditAi({
      at: new Date().toISOString(),
      kind: 'ocr',
      model: usedModel,
      ms: Date.now() - started,
      ok: false,
      error: String((error as Error).message).slice(0, 500),
    });
    throw error;
  }
});

app.post('/api/ai/chat', async (req, reply) => {
  const cfg = requireAi();
  const body = ChatBodySchema.parse(req.body ?? {});
  const run = body.runId ? getRun(body.runId) : undefined;

  const contextParts: string[] = [];
  if (body.context) contextParts.push(body.context);
  if (run) {
    contextParts.push(
      [
        `任务：${run.title}`,
        `页面：${run.url}`,
        `模式：${run.mode}`,
        `用户要求：${run.requirement}`,
        run.plan?.summary ? `计划：${run.plan.summary}` : '',
        run.answers?.length
          ? `共 ${run.answers.length} 条答案，其中需复核 ${run.answers.filter((a) => a.needsReview).length} 条`
          : '',
        run.summary ? `已有总结：${run.summary}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  const messages: ChatMessage[] = [{ role: 'system', content: CHAT_SYSTEM }];
  for (const msg of body.messages ?? []) messages.push(msg);
  messages.push({
    role: 'user',
    content: [body.prompt ?? '请总结本次执行情况。', contextParts.join('\n\n')].filter(Boolean).join('\n\n'),
  });

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (payload: unknown) => raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  send({ type: 'start', model: cfg.model });

  const controller = new AbortController();
  raw.on('close', () => {
    if (!raw.writableEnded) controller.abort();
  });
  try {
    await streamChat(
      cfg,
      messages,
      (delta) => send({ delta }),
      controller.signal,
    );
    send({ type: 'done' });
  } catch (error) {
    send({ type: 'error', message: String((error as Error).message).slice(0, 500) });
  } finally {
    raw.end();
  }
  return reply;
});

// ---------- 运行记录（审计） ----------
const RunLogSchema = z.object({
  at: z.string().max(40),
  action: z.string().max(40),
  target: z.string().max(100).optional(),
  ok: z.boolean(),
  detail: z.string().max(2000).optional(),
});

const RunBodySchema = z.object({
  mode: z.enum(['plan', 'quiz']),
  title: z.string().max(300).default('未命名任务'),
  url: z.string().max(2000).default(''),
  requirement: z.string().max(4000).default(''),
  plan: ModelPlanSchema.optional(),
  questions: z.array(QuestionSchema).max(500).optional(),
  answers: z.array(ModelAnswerSchema).max(500).optional(),
  logs: z.array(RunLogSchema).max(500).optional(),
  summary: z.string().max(8000).optional(),
  status: z.enum(['success', 'partial', 'failed']),
  durationMs: z.number().min(0).max(86_400_000).optional(),
});

app.get('/api/runs', async () => ({
  runs: listRuns().map((run) => ({
    id: run.id,
    createdAt: run.createdAt,
    mode: run.mode,
    title: run.title,
    url: run.url,
    status: run.status,
    answers: run.answers?.length ?? 0,
    needsReview: run.answers?.filter((a) => a.needsReview).length ?? 0,
    steps: run.plan?.steps.length ?? 0,
  })),
}));

app.get('/api/runs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const run = getRun(id);
  if (!run) return reply.code(404).send({ error: '运行记录不存在' });
  return reply.send({ run });
});

app.post('/api/runs', async (req, reply) => {
  const parsed = RunBodySchema.parse(req.body ?? {});
  const record = addRun({
    mode: parsed.mode,
    title: parsed.title,
    url: parsed.url,
    requirement: parsed.requirement,
    plan: parsed.plan as Plan | undefined,
    questions: parsed.questions,
    answers: parsed.answers as QuizAnswer[] | undefined,
    logs: parsed.logs as RunLog[] | undefined,
    summary: parsed.summary,
    status: parsed.status,
    durationMs: parsed.durationMs,
  });
  return reply.code(201).send({ id: record.id, run: record });
});

app.delete('/api/runs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!deleteRun(id)) return reply.code(404).send({ error: '运行记录不存在' });
  return reply.send({ ok: true });
});

const RunSummaryPatchSchema = z.object({ summary: z.string().max(8000) });

app.patch('/api/runs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { summary } = RunSummaryPatchSchema.parse(req.body ?? {});
  const run = updateRunSummary(id, summary);
  if (!run) return reply.code(404).send({ error: '运行记录不存在' });
  return reply.send({ ok: true, run });
});

// ---------- 导出 ----------
const ExportBodySchema = z.object({
  runId: z.string().max(80),
  format: z.enum(['md', 'json', 'csv', 'html']).default('md'),
});

app.post('/api/exports', async (req, reply) => {
  const parsed = ExportBodySchema.parse(req.body ?? {});
  const run = getRun(parsed.runId);
  if (!run) return reply.code(404).send({ error: '运行记录不存在' });
  const { file, size } = writeExport(run, parsed.format as ExportFormat);
  return reply.send({ file, size, url: `/api/exports/${encodeURIComponent(file)}` });
});

app.get('/api/exports/:file', async (req, reply) => {
  const { file } = req.params as { file: string };
  const safeName = path.basename(file);
  const target = path.join(EXPORT_DIR, safeName);
  if (!target.startsWith(EXPORT_DIR) || !fs.existsSync(target)) {
    return reply.code(404).send({ error: '导出文件不存在' });
  }
  const ext = path.extname(safeName).slice(1);
  const mime =
    ext === 'html'
      ? 'text/html; charset=utf-8'
      : ext === 'json'
        ? 'application/json; charset=utf-8'
        : ext === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'text/markdown; charset=utf-8';
  reply.header('Content-Type', mime);
  reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  return reply.send(fs.createReadStream(target));
});

// ---------- Web 控制台静态文件 ----------
if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/' });
} else {
  app.get('/', async () => ({
    name: 'PagePilot',
    message: 'Web 控制台还没有构建。开发模式请运行 npm run dev，或先执行 npm run build。',
    api: '/api/health',
  }));
}

await app.listen({ port: PORT, host: HOST });
app.log.info(`PagePilot 服务已启动： http://${HOST}:${PORT}`);
app.log.info(`扩展目录： ${EXTENSION_DIR}`);
app.log.info(`数据目录： ${DATA_DIR}`);

// 供外部脚本/测试复用
export { app };
