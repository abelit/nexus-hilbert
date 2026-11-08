/**
 * Prompts for the CMDB AI actions. They are plain functions so the wording and
 * caps can be tested without mounting the assistant.
 *
 * The prompts name the selected CI ids but never embed full rows: the agent is
 * expected to re-read them with the caller's own credential.
 */

export const MAX_EXPLAIN_CIS = 10;
export const MAX_PROMPT_TEXT = 4000;

function language(locale: string): string {
  return locale.toLowerCase().startsWith('en') ? 'English' : '中文';
}

function quoteIDs(ids: number[]): string {
  return ids.map((id) => `#${id}`).join('、');
}

export function explainCIsPrompt(ids: number[], model: string, locale: string): string {
  const shown = ids.slice(0, MAX_EXPLAIN_CIS);
  const truncated = ids.length > shown.length;
  return [
    `请解释以下 CMDB 配置项（模型：${model || '未知'}）：${quoteIDs(shown)}。`,
    '先用 cmdb_get_ci 逐个确认身份和属性值；引用工具返回的真实字段，不要凭空推断关系。',
    '需要关系或影响面时，再使用 cmdb_get_ci_relations 或 cmdb_relation_graph。',
    truncated ? `本次选中 ${ids.length} 项，超过 ${MAX_EXPLAIN_CIS} 个上限；只解释前 ${shown.length} 个。` : '',
    `用${language(locale)}回答，先给结论，再给证据。`,
  ].filter(Boolean).join('\n');
}

export function relationsPrompt(
  ciId: number,
  direction: 'both' | 'up' | 'down',
  depth: number,
  locale: string,
): string {
  const hops = Math.max(1, Math.min(3, Math.trunc(depth)));
  const side = direction === 'up' ? '上游' : direction === 'down' ? '下游' : '上下游';
  return [
    `请分析 CI #${ciId} 的${side}关系与影响面。`,
    '先用 cmdb_get_ci 确认身份；再用 cmdb_get_ci_relations 逐跳查询，或用 cmdb_relation_graph 生成有界关系图。',
    `默认 ${hops} 跳；只报告工具实际返回的 CI（id + 名称 + 关系），不要把模型间的关系当成实例关系。`,
    '区分“结构依赖”和“当前运行状态”；没有指标/日志证据时不要断言故障。',
    `用${language(locale)}回答，先给结论，再给证据。`,
  ].join('\n');
}

export function translateValuePrompt(text: string, targetLang: 'zh' | 'en', context?: string): string {
  const clipped = text.length > MAX_PROMPT_TEXT;
  const body = text.slice(0, MAX_PROMPT_TEXT);
  return [
    `请把下面的内容翻译成${targetLang === 'zh' ? '中文' : 'English'}。`,
    '只做翻译，不要调用工具，不要改写数字、单位、专有名词或查询表达式；保留原格式。',
    context ? `上下文：${context}` : '',
    clipped ? `原文超过 ${MAX_PROMPT_TEXT} 字，已截断。` : '',
    '只输出译文和必要的说明。',
    '---',
    body,
  ].filter(Boolean).join('\n');
}

export function explainValuePrompt(text: string, context?: string): string {
  const clipped = text.length > MAX_PROMPT_TEXT;
  const body = text.slice(0, MAX_PROMPT_TEXT);
  return [
    '请解释下面这个 CMDB 字段值/片段，说明它代表什么、可能的影响和需要注意的地方。',
    '只做解释，不要调用工具；如果信息不足，明确指出缺少什么。',
    context ? `上下文：${context}` : '',
    clipped ? `原文超过 ${MAX_PROMPT_TEXT} 字，已截断。` : '',
    '---',
    body,
  ].filter(Boolean).join('\n');
}
