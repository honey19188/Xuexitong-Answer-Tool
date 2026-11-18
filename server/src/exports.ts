import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from './store.js';
import { EXPORT_DIR } from './store.js';

export type ExportFormat = 'md' | 'json' | 'csv' | 'html';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

function answerOf(run: RunRecord, questionId: string) {
  return (run.answers ?? []).find((a) => a.questionId === questionId);
}

function buildMarkdown(run: RunRecord): string {
  const lines: string[] = [];
  lines.push(`# ${run.title}`);
  lines.push('');
  lines.push(`- 时间：${formatTime(run.createdAt)}`);
  lines.push(`- 页面：${run.url}`);
  lines.push(`- 模式：${run.mode === 'quiz' ? '答题' : '页面操作'}`);
  lines.push(`- 状态：${run.status}`);
  lines.push(`- 用户要求：${run.requirement || '(未填写)'}`);
  lines.push('');

  if (run.plan) {
    lines.push('## AI 计划');
    lines.push('');
    if (run.plan.summary) lines.push(`> ${run.plan.summary}`, '');
    (run.plan.steps ?? []).forEach((step, i) => {
      const label = `${i + 1}. \`${step.action}\`${step.target ? ` → ${step.target}` : ''}${
        step.value ? ` = ${step.value}` : ''
      }${step.risk === 'high' ? ' ⚠️高风险' : ''}`;
      lines.push(label);
      if (step.reason) lines.push(`   - ${step.reason}`);
    });
    lines.push('');
  }

  if (run.questions?.length) {
    lines.push('## 题目与答案');
    lines.push('');
    lines.push('| # | 题型 | 题干 | AI 答案 | 置信度 | 需复核 | 理由 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    run.questions.forEach((q, i) => {
      const answer = answerOf(run, q.id);
      const picked = answer
        ? [
            ...answer.optionKeys.map((key) => {
              const option = q.options.find((o) => o.key === key);
              return option ? `${key}. ${option.text}` : key;
            }),
            answer.value ?? '',
          ]
            .filter(Boolean)
            .join('；')
        : '(未作答)';
      const confidence = answer?.confidence != null ? `${Math.round(answer.confidence * 100)}%` : '-';
      lines.push(
        `| ${i + 1} | ${q.type} | ${q.stem.replace(/\|/g, '\\|').slice(0, 160)} | ${picked
          .replace(/\|/g, '\\|')
          .slice(0, 200)} | ${confidence} | ${answer?.needsReview ? '是' : '否'} | ${(answer?.reason ?? '')
          .replace(/\|/g, '\\|')
          .slice(0, 120)} |`,
      );
    });
    lines.push('');
  }

  if (run.summary) {
    lines.push('## AI 总结');
    lines.push('');
    lines.push(run.summary);
    lines.push('');
  }

  if (run.logs?.length) {
    lines.push('## 执行日志');
    lines.push('');
    run.logs.forEach((log) => {
      lines.push(`- ${formatTime(log.at)} ${log.ok ? '✅' : '❌'} \`${log.action}\` ${log.target ?? ''} ${
        log.detail ?? ''
      }`);
    });
  }
  return lines.join('\n');
}

function buildCsv(run: RunRecord): string {
  const rows: string[][] = [['题号', '题型', '题干', '选项', 'AI答案', '置信度', '需复核', '理由', '执行结果']];
  (run.questions ?? []).forEach((q, i) => {
    const answer = answerOf(run, q.id);
    const selected = answer
      ? [...answer.optionKeys, answer.value ?? ''].filter(Boolean).join(' / ')
      : '';
    rows.push([
      String(i + 1),
      q.type,
      q.stem,
      q.options.map((o) => `${o.key}. ${o.text}`).join(' | '),
      selected,
      answer?.confidence != null ? `${Math.round(answer.confidence * 100)}%` : '',
      answer?.needsReview ? '是' : '否',
      answer?.reason ?? '',
      run.status,
    ]);
  });
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function buildHtml(run: RunRecord): string {
  const quizRows = (run.questions ?? [])
    .map((q, i) => {
      const answer = answerOf(run, q.id);
      const picked = answer
        ? [...answer.optionKeys, answer.value ?? ''].filter(Boolean).join(' / ')
        : '未作答';
      return `<tr><td>${i + 1}</td><td>${escapeHtml(q.type)}</td><td>${escapeHtml(
        q.stem,
      )}</td><td>${escapeHtml(picked)}</td><td>${
        answer?.confidence != null ? `${Math.round(answer.confidence * 100)}%` : '-'
      }</td><td>${answer?.needsReview ? '是' : '否'}</td><td>${escapeHtml(
        answer?.reason ?? '',
      )}</td></tr>`;
    })
    .join('\n');

  const stepRows = (run.plan?.steps ?? [])
    .map(
      (step, i) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(step.action)}</td><td>${escapeHtml(
          step.target ?? '',
        )}</td><td>${escapeHtml(step.value ?? '')}</td><td>${
          step.risk === 'high' ? '高风险' : '普通'
        }</td><td>${escapeHtml(step.reason ?? '')}</td></tr>`,
    )
    .join('\n');

  const logRows = (run.logs ?? [])
    .map(
      (log) =>
        `<tr><td>${escapeHtml(formatTime(log.at))}</td><td>${log.ok ? '成功' : '失败'}</td><td>${escapeHtml(
          log.action,
        )}</td><td>${escapeHtml(log.target ?? '')}</td><td>${escapeHtml(log.detail ?? '')}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(run.title)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 40px auto; max-width: 1000px; padding: 0 20px; color: #1f2430; background: #fafbfc; }
  h1 { font-size: 26px; margin-bottom: 6px; }
  .meta { color: #5b6472; font-size: 13px; line-height: 1.9; margin-bottom: 24px; }
  h2 { font-size: 18px; margin-top: 32px; border-left: 4px solid #3b82f6; padding-left: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; background: #fff; }
  th, td { border: 1px solid #e3e8ef; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; }
  .summary { background: #eef6ff; border: 1px solid #cfe3ff; padding: 12px 16px; border-radius: 8px; white-space: pre-wrap; }
  .footer { margin-top: 40px; font-size: 12px; color: #8892a0; }
</style>
</head>
<body>
<h1>${escapeHtml(run.title)}</h1>
<div class="meta">
  时间：${escapeHtml(formatTime(run.createdAt))}<br />
  页面：${escapeHtml(run.url)}<br />
  模式：${run.mode === 'quiz' ? '答题' : '页面操作'} · 状态：${escapeHtml(run.status)}<br />
  用户要求：${escapeHtml(run.requirement || '(未填写)')}
</div>
${run.summary ? `<h2>AI 总结</h2><div class="summary">${escapeHtml(run.summary)}</div>` : ''}
${quizRows ? `<h2>题目与答案</h2><table><thead><tr><th>#</th><th>题型</th><th>题干</th><th>AI 答案</th><th>置信度</th><th>需复核</th><th>理由</th></tr></thead><tbody>${quizRows}</tbody></table>` : ''}
${stepRows ? `<h2>操作计划</h2><table><thead><tr><th>#</th><th>动作</th><th>元素</th><th>值</th><th>风险</th><th>说明</th></tr></thead><tbody>${stepRows}</tbody></table>` : ''}
${logRows ? `<h2>执行日志</h2><table><thead><tr><th>时间</th><th>结果</th><th>动作</th><th>元素</th><th>详情</th></tr></thead><tbody>${logRows}</tbody></table>` : ''}
<div class="footer">由 PagePilot 生成 · AI 结果仅供参考，请人工复核后使用</div>
</body>
</html>`;
}

export function buildExport(run: RunRecord, format: ExportFormat): { ext: string; content: string } {
  switch (format) {
    case 'json':
      return { ext: 'json', content: JSON.stringify(run, null, 2) };
    case 'csv':
      return { ext: 'csv', content: `\uFEFF${buildCsv(run)}` };
    case 'html':
      return { ext: 'html', content: buildHtml(run) };
    case 'md':
    default:
      return { ext: 'md', content: buildMarkdown(run) };
  }
}

function slugify(input: string): string {
  const base = input
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (base || 'result').slice(0, 40);
}

export function writeExport(run: RunRecord, format: ExportFormat): { file: string; size: number } {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const { ext, content } = buildExport(run, format);
  const stamp = new Date(run.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `${stamp}-${slugify(run.title)}-${run.id.slice(0, 6)}.${ext}`;
  fs.writeFileSync(path.join(EXPORT_DIR, file), content, 'utf8');
  return { file, size: Buffer.byteLength(content, 'utf8') };
}
