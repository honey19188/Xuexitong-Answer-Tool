// 常见 LLM 模型清单（按厂商/API 分组），供前端下拉补全
// 备注字段给出推荐 baseUrl；实际使用时以 settings.ai.baseUrl 为准

export interface ModelEntry {
  id: string;        // 传给 API 的 model 名
  name: string;      // 显示名（中文友好）
  vendor: string;    // 厂商分组
  baseUrl?: string;  // 推荐 base URL
  tags?: string[];   // 能力标签：chat / reason / vision / coding
}

export interface ModelGroup {
  vendor: string;
  baseUrl?: string;
  models: ModelEntry[];
}

// ---------- OpenAI ----------
const openai: ModelEntry[] = [
  { id: 'gpt-4o',          name: 'GPT-4o',        vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['chat', 'vision', 'reason'] },
  { id: 'gpt-4o-mini',     name: 'GPT-4o Mini',   vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['chat', 'vision'] },
  { id: 'gpt-4.1',         name: 'GPT-4.1',       vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['chat', 'reason'] },
  { id: 'gpt-4.1-mini',    name: 'GPT-4.1 Mini',  vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['chat'] },
  { id: 'gpt-4-turbo',     name: 'GPT-4 Turbo',   vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['chat', 'vision'] },
  { id: 'gpt-4',           name: 'GPT-4',         vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['chat'] },
  { id: 'gpt-3.5-turbo',   name: 'GPT-3.5 Turbo', vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['chat'] },
  { id: 'o3',              name: 'o3',            vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['reason'] },
  { id: 'o3-mini',         name: 'o3-mini',       vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['reason'] },
  { id: 'o1',              name: 'o1',            vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['reason'] },
  { id: 'o1-mini',         name: 'o1-mini',       vendor: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tags: ['reason'] },
];

// ---------- DeepSeek ----------
const deepseek: ModelEntry[] = [
  { id: 'deepseek-chat',       name: 'DeepSeek V3 (chat)',       vendor: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', tags: ['chat'] },
  { id: 'deepseek-reasoner',   name: 'DeepSeek R1 (reasoner)',   vendor: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', tags: ['reason'] },
  { id: 'deepseek-flash',      name: 'DeepSeek Flash',           vendor: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', tags: ['chat'] },
];

// ---------- 字节跳动 / 豆包 ----------
const doubao: ModelEntry[] = [
  { id: 'Doubao-Seed-2.1-Pro',     name: '豆包 Seed 2.1 Pro',    vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['chat', 'reason'] },
  { id: 'Doubao-Seed-2.0-Pro',     name: '豆包 Seed 2.0 Pro',    vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['chat'] },
  { id: 'Doubao-1.5-Pro',          name: '豆包 1.5 Pro',         vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['chat'] },
  { id: 'Doubao-1.5-Lite',         name: '豆包 1.5 Lite',        vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['chat'] },
  { id: 'doubao-pro-4k',           name: 'doubao-pro-4k',        vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['chat'] },
  { id: 'doubao-pro-32k',          name: 'doubao-pro-32k',       vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['chat'] },
  { id: 'doubao-pro-128k',         name: 'doubao-pro-128k',      vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['chat'] },
  { id: 'doubao-lite-4k',          name: 'doubao-lite-4k',       vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['chat'] },
  { id: 'doubao-lite-32k',         name: 'doubao-lite-32k',      vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['chat'] },
  { id: 'doubao-1.5-vision-pro-32k', name: '豆包 1.5 Vision Pro', vendor: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', tags: ['vision'] },
];

// ---------- 阿里 / 通义千问 ----------
const qwen: ModelEntry[] = [
  { id: 'qwen-max',             name: '通义千问 Max',          vendor: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tags: ['chat', 'reason'] },
  { id: 'qwen-plus',            name: '通义千问 Plus',         vendor: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tags: ['chat'] },
  { id: 'qwen-turbo',           name: '通义千问 Turbo',        vendor: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tags: ['chat'] },
  { id: 'qwen-long',            name: '通义千问 Long',         vendor: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tags: ['chat'] },
  { id: 'qwen-coder-plus',      name: '通义千问 Coder Plus',   vendor: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tags: ['coding'] },
  { id: 'qwen-vl-plus',         name: '通义千问 VL Plus',      vendor: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tags: ['vision'] },
  { id: 'qwen-vl-max',          name: '通义千问 VL Max',       vendor: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tags: ['vision'] },
  { id: 'qwq-32b-preview',      name: 'QwQ-32B Preview',      vendor: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tags: ['reason'] },
];

// ---------- 百度 / 文心一言 ----------
const ernie: ModelEntry[] = [
  { id: 'ernie-4.0-turbo-8k',   name: '文心一言 4.0 Turbo',    vendor: '文心', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', tags: ['chat'] },
  { id: 'ernie-4.0-8k',         name: '文心一言 4.0',          vendor: '文心', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', tags: ['chat'] },
  { id: 'ernie-3.5-8k',         name: '文心一言 3.5',          vendor: '文心', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', tags: ['chat'] },
  { id: 'ernie-3.5-128k',       name: '文心一言 3.5 128k',     vendor: '文心', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', tags: ['chat'] },
  { id: 'ernie-speed-8k',       name: '文心一言 Speed',        vendor: '文心', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', tags: ['chat'] },
  { id: 'ernie-lite-8k',        name: '文心一言 Lite',         vendor: '文心', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', tags: ['chat'] },
];

// ---------- 智谱 AI / GLM ----------
const glm: ModelEntry[] = [
  { id: 'glm-5',                 name: 'GLM-5',                 vendor: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tags: ['chat', 'reason'] },
  { id: 'glm-5-air',             name: 'GLM-5 Air',             vendor: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tags: ['chat'] },
  { id: 'glm-5-encoding',        name: 'GLM-5 Encoding',        vendor: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tags: ['chat'] },
  { id: 'glm-4-plus',            name: 'GLM-4 Plus',            vendor: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tags: ['chat'] },
  { id: 'glm-4-air',             name: 'GLM-4 Air',             vendor: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tags: ['chat'] },
  { id: 'glm-4-airx',            name: 'GLM-4 AirX',            vendor: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tags: ['chat'] },
  { id: 'glm-4-long',            name: 'GLM-4 Long',            vendor: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tags: ['chat'] },
  { id: 'glm-4-flash',           name: 'GLM-4 Flash',           vendor: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tags: ['chat'] },
  { id: 'glm-4-vision-preview',  name: 'GLM-4 Vision Preview',  vendor: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tags: ['vision'] },
];

// ---------- 月之暗面 / Moonshot ----------
const moonshot: ModelEntry[] = [
  { id: 'moonshot-v1-8k',       name: 'Moonshot v1 8k',        vendor: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', tags: ['chat'] },
  { id: 'moonshot-v1-32k',      name: 'Moonshot v1 32k',       vendor: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', tags: ['chat'] },
  { id: 'moonshot-v1-128k',     name: 'Moonshot v1 128k',      vendor: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', tags: ['chat'] },
];

// ---------- MiniMax ----------
const minimax: ModelEntry[] = [
  { id: 'abab6.5s-chat',        name: 'MiniMax abab6.5s',     vendor: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', tags: ['chat'] },
  { id: 'abab6.5-chat',         name: 'MiniMax abab6.5',      vendor: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', tags: ['chat'] },
  { id: 'abab5.5-chat',         name: 'MiniMax abab5.5',      vendor: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', tags: ['chat'] },
  { id: 'abab5.5s-chat',        name: 'MiniMax abab5.5s',     vendor: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', tags: ['chat'] },
];

// ---------- 零一万物 / Yi ----------
const yi: ModelEntry[] = [
  { id: 'yi-large',             name: 'Yi Large',              vendor: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', tags: ['chat'] },
  { id: 'yi-medium',            name: 'Yi Medium',             vendor: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', tags: ['chat'] },
  { id: 'yi-spark',             name: 'Yi Spark',              vendor: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', tags: ['chat'] },
  { id: 'yi-vision',            name: 'Yi Vision',             vendor: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', tags: ['vision'] },
];

// ---------- 阶跃星辰 / Step ----------
const stepfun: ModelEntry[] = [
  { id: 'step-1-64k',           name: 'Step 1 64k',            vendor: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', tags: ['chat', 'reason'] },
  { id: 'step-1-flash',         name: 'Step 1 Flash',          vendor: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', tags: ['chat'] },
  { id: 'step-2',               name: 'Step 2',                vendor: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', tags: ['chat', 'reason'] },
  { id: 'step-2-mini',          name: 'Step 2 Mini',           vendor: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', tags: ['chat'] },
];

// ---------- 阿里 / Ollama 本地 ----------
const ollama: ModelEntry[] = [
  { id: 'qwen2.5:72b',          name: 'Ollama qwen2.5:72b',    vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['chat'] },
  { id: 'qwen2.5:14b',          name: 'Ollama qwen2.5:14b',    vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['chat'] },
  { id: 'qwen2.5:7b',           name: 'Ollama qwen2.5:7b',     vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['chat'] },
  { id: 'qwen2.5-coder:32b',    name: 'Ollama qwen2.5-coder',  vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['coding'] },
  { id: 'llama3.1:70b',         name: 'Ollama llama3.1:70b',   vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['chat'] },
  { id: 'llama3.1:8b',          name: 'Ollama llama3.1:8b',    vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['chat'] },
  { id: 'deepseek-r1:14b',      name: 'Ollama deepseek-r1:14b',vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['reason'] },
  { id: 'deepseek-r1:7b',       name: 'Ollama deepseek-r1:7b', vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['reason'] },
  { id: 'phi4:14b',             name: 'Ollama phi4:14b',       vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['chat'] },
  { id: 'gemma3:27b',           name: 'Ollama gemma3:27b',     vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['chat'] },
  { id: 'mistral:7b',           name: 'Ollama mistral:7b',     vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: ['chat'] },
];

// ---------- SiliconFlow (聚合平台) ----------
const siliconflow: ModelEntry[] = [
  { id: 'Qwen/Qwen2.5-72B-Instruct',       name: 'Qwen2.5-72B-Instruct',      vendor: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', tags: ['chat'] },
  { id: 'Qwen/Qwen2.5-32B-Instruct',       name: 'Qwen2.5-32B-Instruct',      vendor: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', tags: ['chat'] },
  { id: 'Qwen/Qwen2.5-14B-Instruct',       name: 'Qwen2.5-14B-Instruct',      vendor: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', tags: ['chat'] },
  { id: 'Qwen/Qwen2.5-7B-Instruct',        name: 'Qwen2.5-7B-Instruct',       vendor: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', tags: ['chat'] },
  { id: 'deepseek-ai/DeepSeek-V3',         name: 'DeepSeek-V3',               vendor: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', tags: ['chat'] },
  { id: 'deepseek-ai/DeepSeek-R1',         name: 'DeepSeek-R1',               vendor: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', tags: ['reason'] },
  { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama-3.3-70B-Instruct',  vendor: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', tags: ['chat'] },
  { id: 'THUDM/glm-4-9b-chat',             name: 'GLM-4-9B-Chat',             vendor: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', tags: ['chat'] },
];

export const ALL_MODELS: ModelEntry[] = [
  ...openai,
  ...deepseek,
  ...doubao,
  ...qwen,
  ...ernie,
  ...glm,
  ...moonshot,
  ...minimax,
  ...yi,
  ...stepfun,
  ...ollama,
  ...siliconflow,
];

export const MODEL_GROUPS: ModelGroup[] = [
  { vendor: 'OpenAI',     baseUrl: 'https://api.openai.com/v1',                          models: openai },
  { vendor: 'DeepSeek',   baseUrl: 'https://api.deepseek.com/v1',                        models: deepseek },
  { vendor: '豆包',       baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',           models: doubao },
  { vendor: '通义',       baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',  models: qwen },
  { vendor: '文心',       baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', models: ernie },
  { vendor: '智谱',       baseUrl: 'https://open.bigmodel.cn/api/paas/v4',               models: glm },
  { vendor: 'Moonshot',   baseUrl: 'https://api.moonshot.cn/v1',                         models: moonshot },
  { vendor: 'MiniMax',    baseUrl: 'https://api.minimax.chat/v1',                        models: minimax },
  { vendor: '零一万物',   baseUrl: 'https://api.lingyiwanwu.com/v1',                     models: yi },
  { vendor: '阶跃星辰',   baseUrl: 'https://api.stepfun.com/v1',                         models: stepfun },
  { vendor: 'Ollama',     baseUrl: 'http://127.0.0.1:11434/v1',                          models: ollama },
  { vendor: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',                     models: siliconflow },
];

export function countModels(): number {
  return ALL_MODELS.length;
}
