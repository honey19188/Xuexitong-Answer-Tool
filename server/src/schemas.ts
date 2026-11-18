import { z } from 'zod';
import type { PageSnapshot } from './prompts.js';
import type { Plan, PlanStep, QuizAnswer } from './store.js';

export const ElementSchema = z.object({
  id: z.string().min(1).max(80),
  tag: z.string().max(30),
  type: z.string().max(30).optional(),
  name: z.string().max(100).optional(),
  role: z.string().max(40).optional(),
  label: z.string().max(200).optional(),
  placeholder: z.string().max(120).optional(),
  text: z.string().max(300).optional(),
  selector: z.string().max(400).optional(),
  visible: z.boolean().optional(),
});

export const OptionSchema = z.object({
  key: z.string().max(10),
  text: z.string().max(600),
  elementId: z.string().max(80).optional(),
  selected: z.boolean().optional(),
});

export const QuestionSchema = z.object({
  id: z.string().min(1).max(80),
  stem: z.string().max(2000),
  type: z.string().max(20),
  options: z.array(OptionSchema).max(20).default([]),
  elementId: z.string().max(80).optional(),
  frame: z.string().max(60).optional(),
});

export const SnapshotSchema = z.object({
  url: z.string().max(2000),
  title: z.string().max(500),
  text: z.string().max(20000).optional(),
  elements: z.array(ElementSchema).max(800).default([]),
  questions: z.array(QuestionSchema).max(500).default([]),
});

export const StepSchema = z.object({
  action: z.enum(['click', 'fill', 'select', 'check', 'scroll', 'wait', 'extract']),
  target: z.string().max(80).optional(),
  value: z.string().max(4000).optional(),
  amount: z.number().finite().min(0).max(60000).optional(),
  risk: z.enum(['low', 'high']).default('low'),
  confirm: z.boolean().optional(),
  reason: z.string().max(300).optional(),
});

export const ModelPlanSchema = z.object({
  summary: z.string().max(1000).default(''),
  steps: z.array(StepSchema).max(40).default([]),
  notes: z.string().max(1000).optional(),
});

export const ModelAnswerSchema = z.object({
  questionId: z.string().max(80),
  optionKeys: z.array(z.string().max(10)).max(10).default([]),
  value: z.string().max(4000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().max(500).optional(),
  needsReview: z.boolean().optional(),
});

export const ModelQuizSchema = z.object({
  answers: z.array(ModelAnswerSchema).max(100).default([]),
  summary: z.string().max(1000).optional(),
});

const HIGH_RISK_PATTERN =
  /提交|支付|付款|删除|移除|发布|购买|下单|注销|确认提交|submit|pay\b|delete|remove|publish|purchase|checkout/i;

const MAX_STEPS = 20;

export function collectElementIds(snapshot: PageSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const el of snapshot.elements ?? []) ids.add(el.id);
  for (const q of snapshot.questions ?? []) {
    if (q.elementId) ids.add(q.elementId);
    for (const o of q.options) if (o.elementId) ids.add(o.elementId);
  }
  return ids;
}

export interface SanitizeResult {
  plan: Plan;
  warnings: string[];
}

export function sanitizePlan(input: unknown, snapshot: PageSnapshot): SanitizeResult {
  const parsed = ModelPlanSchema.parse(input);
  const ids = collectElementIds(snapshot);
  const warnings: string[] = [];
  const steps: PlanStep[] = [];

  for (const step of parsed.steps) {
    if (steps.length >= MAX_STEPS) {
      warnings.push(`步骤超过 ${MAX_STEPS} 条，已截断`);
      break;
    }
    if (step.action !== 'scroll' && step.action !== 'wait') {
      if (!step.target || !ids.has(step.target)) {
        warnings.push(`已丢弃引用了不存在元素 ${step.target ?? '(空)'} 的步骤`);
        continue;
      }
    }
    const next: PlanStep = {
      action: step.action,
      target: step.target,
      value: step.value,
      amount: step.amount,
      risk: step.risk,
      confirm: step.confirm,
      reason: step.reason,
    };
    const haystack = `${next.reason ?? ''} ${next.value ?? ''}`;
    const targetEl = (snapshot.elements ?? []).find((el) => el.id === next.target);
    const targetText = `${targetEl?.text ?? ''} ${targetEl?.label ?? ''}`;
    if (next.action === 'click' && HIGH_RISK_PATTERN.test(`${haystack} ${targetText}`)) {
      next.risk = 'high';
      next.confirm = true;
      warnings.push('检测到可能不可逆的点击，已标记为高风险并需要二次确认');
    }
    steps.push(next);
  }

  return {
    plan: { summary: parsed.summary, steps, notes: parsed.notes },
    warnings: [...new Set(warnings)],
  };
}

export interface SanitizeAnswersResult {
  answers: QuizAnswer[];
  warnings: string[];
}

export function sanitizeAnswers(input: unknown, snapshot: PageSnapshot): SanitizeAnswersResult {
  const parsed = ModelQuizSchema.parse(input);
  const questions = snapshot.questions ?? [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answers: QuizAnswer[] = [];
  const warnings: string[] = [];

  for (const answer of parsed.answers) {
    const question = byId.get(answer.questionId);
    if (!question) {
      warnings.push(`已丢弃未知题目 ${answer.questionId}`);
      continue;
    }
    const validKeys = new Set(question.options.map((o) => o.key));
    const keys = answer.optionKeys
      .map((k) => k.trim().toUpperCase())
      .filter((k, i, arr) => validKeys.has(k) && arr.indexOf(k) === i);

    if (question.type === 'fill' || question.options.length === 0) {
      if (!answer.value?.trim()) {
        warnings.push(`填空题 ${answer.questionId} 没有给出答案`);
        continue;
      }
      answers.push({
        questionId: question.id,
        optionKeys: [],
        value: answer.value.trim(),
        confidence: answer.confidence,
        reason: answer.reason,
        needsReview: answer.needsReview ?? (answer.confidence ?? 0) < 0.6,
      });
      continue;
    }

    if (keys.length === 0) {
      warnings.push(`题目 ${answer.questionId} 的答案没有匹配到有效选项`);
      continue;
    }
    if (question.type !== 'multiple' && keys.length > 1) {
      warnings.push(`题目 ${answer.questionId} 不是多选题，只保留第一个选项`);
    }
    const finalKeys = question.type === 'multiple' ? keys : keys.slice(0, 1);
    answers.push({
      questionId: question.id,
      optionKeys: finalKeys,
      confidence: answer.confidence,
      reason: answer.reason,
      needsReview: answer.needsReview ?? (answer.confidence ?? 0) < 0.6,
    });
  }

  const missing = questions.filter((q) => !answers.some((a) => a.questionId === q.id));
  if (missing.length) warnings.push(`有 ${missing.length} 道题没有返回答案`);

  return { answers, warnings };
}
