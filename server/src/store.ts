import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 打包安装后程序目录可能不可写，由主进程通过环境变量指定用户数据目录
export const DATA_DIR = process.env.PAGE_PILOT_DATA_DIR
  ? path.resolve(process.env.PAGE_PILOT_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const DB_FILE = path.join(DATA_DIR, 'db.json');

export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface SafetySettings {
  domainAllowlist: string[];
  requireConfirmForHighRisk: boolean;
}

export interface Settings {
  ai: AiSettings;
  safety: SafetySettings;
  updatedAt: string;
}

export interface PlanStep {
  action: string;
  target?: string;
  value?: string;
  amount?: number;
  risk: 'low' | 'high';
  confirm?: boolean;
  reason?: string;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  notes?: string;
}

export interface QuizOption {
  key: string;
  text: string;
  selected?: boolean;
}

export interface QuizQuestion {
  id: string;
  stem: string;
  type: string;
  options: QuizOption[];
  frame?: string;
  selectedKeys?: string[];
}

export interface QuizAnswer {
  questionId: string;
  optionKeys: string[];
  value?: string;
  confidence?: number;
  reason?: string;
  needsReview?: boolean;
}

export interface RunLog {
  at: string;
  action: string;
  target?: string;
  ok: boolean;
  detail?: string;
}

export interface RunRecord {
  id: string;
  createdAt: string;
  mode: 'plan' | 'quiz';
  title: string;
  url: string;
  requirement: string;
  plan?: Plan;
  questions?: QuizQuestion[];
  answers?: QuizAnswer[];
  logs?: RunLog[];
  summary?: string;
  status: 'success' | 'partial' | 'failed';
  durationMs?: number;
}

interface Db {
  settings: Settings;
  runs: RunRecord[];
}

const DEFAULT_SETTINGS: Settings = {
  ai: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.2,
  },
  safety: {
    domainAllowlist: [],
    requireConfirmForHighRisk: true,
  },
  updatedAt: new Date(0).toISOString(),
};

function ensureDirs() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

function load(): Db {
  ensureDirs();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Db>;
    return {
      settings: mergeSettings(DEFAULT_SETTINGS, parsed.settings),
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, runs: [] };
  }
}

function mergeSettings(base: Settings, incoming?: Partial<Settings>): Settings {
  return {
    ai: { ...base.ai, ...(incoming?.ai ?? {}) },
    safety: { ...base.safety, ...(incoming?.safety ?? {}) },
    updatedAt: incoming?.updatedAt ?? base.updatedAt,
  };
}

let cache: Db | null = null;

function db(): Db {
  if (!cache) cache = load();
  return cache;
}

function persist() {
  ensureDirs();
  fs.writeFileSync(DB_FILE, JSON.stringify(db(), null, 2), 'utf8');
}

export function getSettings(): Settings {
  return db().settings;
}

export interface SettingsPatch {
  ai?: Partial<AiSettings>;
  safety?: Partial<SafetySettings>;
  clearApiKey?: boolean;
}

export function updateSettings(patch: SettingsPatch): Settings {
  const current = db().settings;
  const nextAi = { ...current.ai, ...(patch.ai ?? {}) };
  if (patch.clearApiKey) nextAi.apiKey = '';
  const next: Settings = {
    ai: nextAi,
    safety: { ...current.safety, ...(patch.safety ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  db().settings = next;
  persist();
  return next;
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function listRuns(): RunRecord[] {
  return [...db().runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getRun(id: string): RunRecord | undefined {
  return db().runs.find((r) => r.id === id);
}

export function addRun(input: Omit<RunRecord, 'id' | 'createdAt'>): RunRecord {
  const record: RunRecord = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  db().runs.unshift(record);
  // 只保留最近 200 条，避免 db.json 无限增长
  db().runs = db().runs.slice(0, 200);
  persist();
  return record;
}

export function deleteRun(id: string): boolean {
  const before = db().runs.length;
  db().runs = db().runs.filter((r) => r.id !== id);
  const removed = db().runs.length !== before;
  if (removed) persist();
  return removed;
}

export function updateRunSummary(id: string, summary: string): RunRecord | undefined {
  const run = db().runs.find((r) => r.id === id);
  if (!run) return undefined;
  run.summary = summary;
  persist();
  return run;
}
