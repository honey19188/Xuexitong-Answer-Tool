export interface SnapshotElement {
  id: string;
  tag: string;
  type?: string;
  name?: string;
  role?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  selector?: string;
  visible?: boolean;
}

export interface SnapshotOption {
  key: string;
  text: string;
  elementId?: string;
  selected?: boolean;
}

export interface SnapshotQuestion {
  id: string;
  stem: string;
  type: string;
  options: SnapshotOption[];
  elementId?: string;
  frame?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text?: string;
  elements?: SnapshotElement[];
  questions?: SnapshotQuestion[];
}

function cut(value: string | undefined, max: number): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function describeSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`页面标题：${cut(snapshot.title, 120)}`);
  lines.push(`页面地址：${cut(snapshot.url, 300)}`);

  const questions = snapshot.questions ?? [];
  if (questions.length) {
    lines.push(`\n识别到 ${questions.length} 道题目：`);
    questions.slice(0, 30).forEach((q, i) => {
      lines.push(`Q${i + 1} [id=${q.id}] 类型=${q.type}`);
      lines.push(`  题干：${cut(q.stem, 400)}`);
      if (q.options.length) {
        const opts = q.options
          .map((o) => `${o.key}. ${cut(o.text, 160)}${o.selected ? '（当前已选）' : ''}`)
          .join(' | ');
        lines.push(`  选项：${opts}`);
      }
    });
  }

  const elements = snapshot.elements ?? [];
  if (elements.length) {
    lines.push(`\n可交互元素（最多 90 个）：`);
    elements.slice(0, 90).forEach((el) => {
      const parts = [`id=${el.id}`, `<${el.tag}${el.type ? ` type=${el.type}` : ''}>`];
      if (el.label) parts.push(`label="${cut(el.label, 60)}"`);
      if (el.placeholder) parts.push(`placeholder="${cut(el.placeholder, 50)}"`);
      if (el.name) parts.push(`name="${cut(el.name, 30)}"`);
      if (el.text) parts.push(`text="${cut(el.text, 70)}"`);
      lines.push(`- ${parts.join(' ')}`);
    });
  } else {
    lines.push('\n（页面中没有识别到可交互元素）');
  }

  if (snapshot.text) {
    lines.push(`\n页面正文摘要：\n${cut(snapshot.text, 2500)}`);
  }
  return lines.join('\n');
}

export const PLAN_SYSTEM = `你是一个浏览器自动化规划器。用户会给出当前页面的元素清单和一句自然语言要求，你要输出严格的 JSON 操作计划。

只允许以下动作：
- click：点击元素，target 为元素 id
- fill：填写文本框，target 为元素 id，value 为填写内容
- select：选择下拉框，target 为元素 id，value 为选项值
- check：勾选/取消复选框，target 为元素 id，value 为 "true" 或 "false"
- scroll：滚动页面，value 可为 "down"/"up"/"top"/"bottom"
- wait：等待，amount 为毫秒数
- extract：读取元素文本，target 为元素 id（结果会返回给用户）

硬性规则：
1. 只能使用元素清单里真实存在的 id，禁止编造 selector、禁止生成 JavaScript。
2. 最多 20 步；步骤之间按真实操作顺序排列。
3. 提交表单、支付、删除、发布、确认提交等不可逆动作，必须设置 "risk":"high" 和 "confirm":true，并在 reason 中说明后果。
4. 用户没有明确要求提交时，不要提交，最多填好内容后停下。
5. 每一步都要写简短 reason（中文）。
6. 如果要求无法用现有元素完成，steps 可以为空，并在 notes 中说明缺什么。

输出 JSON 结构：
{"summary":"一句话说明计划","steps":[{"action":"fill","target":"元素id","value":"...","risk":"low","confirm":false,"reason":"..."}],"notes":""}`;

export function buildPlanUser(requirement: string, snapshot: PageSnapshot): string {
  return `用户要求：${requirement}\n\n${describeSnapshot(snapshot)}`;
}

export const QUIZ_SYSTEM = `你是一个严谨的答题助手。根据给出的题目和选项作答，只输出严格 JSON：
{"answers":[{"questionId":"题目id","optionKeys":["A"],"value":"","confidence":0.0,"reason":"简短理由","needsReview":false}],"summary":"整体说明"}

规则：
1. questionId 必须来自输入，禁止编造；不要重复题干，不要输出 JSON 之外的内容。
2. 单选只返回 1 个 optionKeys；多选可返回多个，逐项独立判断，不要"看起来都对"就全选。
3. 判断题固定 A=正确、B=错误；若选项文字明显相反以文字为准。
4. 填空题没有选项时答案写入 value；题干标注"共 N 空"时按顺序给 N 个答案并用 || 分隔，不写题号。
5. 简答/论述题把完整答案写入 value，中文分点，1500 字以内。
6. 所有题目都必须作答，不要遗漏；信息不足也给最可能的答案，不要留空。
7. confidence 要真实：有明确依据给 0.8 以上，纯推测约 0.5；低于 0.6 或没把握时 needsReview=true。
8. 先独立判断命题真假/正确项，再对照选项落键，不受选项排列顺序影响。
9. 输出前自检：判断题正反、多选题漏选/多选、填空题答案个数与空数一致。
10. reason 不超过 20 字中文，summary 不超过 30 字。`;

export function buildQuizUser(
  requirement: string,
  snapshot: PageSnapshot,
  context?: string,
): string {
  const questions = (snapshot.questions ?? []).map((q, i) => ({
    id: q.id,
    index: i + 1,
    type: q.type,
    stem: cut(q.stem, 1200),
    options: q.options.map((o) => ({ key: o.key, text: cut(o.text, 400) })),
  }));
  const parts = [`用户要求：${requirement || '给出最可能的答案'}`, `题目列表：${JSON.stringify(questions)}`];
  if (context) parts.push(`补充资料（来自用户，可参考）：\n${cut(context, 4000)}`);
  return parts.join('\n\n');
}

export const CHAT_SYSTEM = `你是网页自动化助手的总结模块。请用简洁的中文总结本次执行情况：做了哪些操作、得到什么结果、有哪些需要注意或复核的地方。不要编造页面中不存在的信息。`;
