import { getSettings } from './store.js';

export interface EffectiveAi {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  source: 'env' | 'settings';
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
      >;
};

const TIMEOUT_MS = 180_000;

export function resolveAi(): EffectiveAi | null {
  const envKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  const cfg = getSettings().ai;
  if (envKey) {
    return {
      baseUrl: process.env.OPENAI_BASE_URL || cfg.baseUrl,
      apiKey: envKey,
      model: process.env.OPENAI_MODEL || cfg.model,
      temperature: Number(process.env.OPENAI_TEMPERATURE ?? cfg.temperature),
      source: 'env',
    };
  }
  if (cfg.apiKey) {
    return {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature: Number(cfg.temperature),
      source: 'settings',
    };
  }
  return null;
}

function endpointOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

interface CompletionOptions {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

async function callOnce(
  cfg: EffectiveAi,
  messages: ChatMessage[],
  opts: CompletionOptions,
): Promise<CompletionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const signal = opts.signal ?? controller.signal;
  try {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: opts.temperature ?? cfg.temperature,
      max_tokens: opts.maxTokens ?? 4096,
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    const res = await fetch(endpointOf(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const err = new Error(`AI 接口返回 ${res.status}：${raw.slice(0, 500)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: CompletionResult['usage'];
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    return { text, usage: data.usage, model: data.model };
  } finally {
    clearTimeout(timer);
  }
}

export async function chat(
  cfg: EffectiveAi,
  messages: ChatMessage[],
  opts: CompletionOptions = {},
): Promise<CompletionResult> {
  try {
    return await callOnce(cfg, messages, opts);
  } catch (error) {
    const status = (error as { status?: number }).status;
    // 部分 OpenAI 兼容服务不支持 response_format，降级重试一次
    if (opts.json && status && status >= 400 && status < 500) {
      return await callOnce(cfg, messages, { ...opts, json: false });
    }
    throw error;
  }
}

export function parseJsonLoose(text: string): unknown {
  let body = text.trim();
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // 1) 先尝试直接 parse
  try {
    return JSON.parse(body);
  } catch {}

  // 2) 尝试提取第一个 { 到最后一个 }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {}
  }

  // 3) 修复截断的 JSON — 逐步补全缺失的闭合符号
  let fixed = body.slice(start !== -1 ? start : 0, end !== -1 ? end + 1 : body.length);
  if (fixed.length < body.length) {
    // 如果原始 body 里有 { 但没 }，说明被截断了
  }

  // 3.1 移除 JSON 结尾可能残留的自然语言（截断后 AI 可能继续输出解释）
  // 找到最后一个合法的引号闭合位置
  let truncateAt = fixed.length;
  let lastValidQuote = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < fixed.length; i++) {
    const ch = fixed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; if (!inString) lastValidQuote = i; }
  }
  // 如果最后在字符串里（inString=true），截断到最后一个闭合引号之后
  if (inString && lastValidQuote > 0) {
    truncateAt = lastValidQuote + 1;
  }
  fixed = fixed.slice(0, truncateAt);

  // 3.2 数括号，补缺失的闭合
  let depthObj = 0;
  let depthArr = 0;
  inString = false;
  escape = false;
  for (let i = 0; i < fixed.length; i++) {
    const ch = fixed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depthObj++;
    else if (ch === '}') depthObj--;
    else if (ch === '[') depthArr++;
    else if (ch === ']') depthArr--;
  }
  // 去掉末尾不完整的逗号
  fixed = fixed.replace(/[,，]\s*$/, '');
  // 从内到外补全：先补对象，再补数组
  while (depthObj > 0 || depthArr > 0) {
    // 优先把 object 补完（answers 对象里可能有嵌套）
    if (depthObj > 0 && (depthArr === 0 || depthObj >= depthArr)) {
      // 检查当前层最后一个值是不是完整的：如果最后非空字符是引号/数字/}
      fixed += '}';
      depthObj--;
    } else if (depthArr > 0) {
      fixed += ']';
      depthArr--;
    } else {
      break;
    }
    // 再去掉补完后的末尾逗号（比如补完数组后紧接着外层 object 也要补）
    fixed = fixed.replace(/[,，]\s*([}\]])/g, '$1');
  }

  // 尝试解析补全后的
  try {
    return JSON.parse(fixed);
  } catch {}

  // 4) 最后尝试：只取 answers 数组部分
  const answersMatch = fixed.match(/"answers"\s*:\s*\[([\s\S]*?)(\]?)\s*\}/);
  if (answersMatch) {
    let arr = answersMatch[1];
    arr = arr.replace(/[,，]\s*$/, '');
    // 算 arr 里括号深度
    let od = 0, ad = 0, ins = false, esc = false;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { ins = !ins; continue; }
      if (ins) continue;
      if (c === '{') od++; else if (c === '}') od--;
      else if (c === '[') ad++; else if (c === ']') ad--;
    }
    while (od > 0) { arr += '}'; od--; }
    while (ad > 0) { arr += ']'; ad--; }
    try {
      return { answers: JSON.parse('[' + arr + ']') };
    } catch {}
  }

  throw new Error('AI 未返回有效 JSON（可能被截断，请减少题目数量后重试）');
}

export async function streamChat(
  cfg: EffectiveAi,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const finalSignal = signal ?? controller.signal;
  try {
    const res = await fetch(endpointOf(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: 1500,
        stream: true,
      }),
      signal: finalSignal,
    });
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => '');
      throw new Error(`AI 接口返回 ${res.status}：${raw.slice(0, 500)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) onDelta(delta);
        } catch {
          // 忽略无法解析的心跳/注释行
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
