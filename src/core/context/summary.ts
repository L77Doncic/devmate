/**
 * # context/summary：第 2 层——触顶期对话摘要（五段式；官方 client-side compaction 骨架，§2.2）
 *
 * 本模块只产摘要请求/内容：五段式 prompt 由 buildSummaryPrompt 构造（内置完整要求——
 * 官方提示词是「替换」不是「补充」，不能指望叠加，§2.2 坑 2），显式禁止调用工具
 * （§2.2 坑 1：定义了 tools 时模型偶尔会去调工具而不是写摘要）并把对话包进输入；
 * 摘要要求包进 <summary></summary> 标签以便程序提取（extractSummaryContent）。
 * 摘要写入事件流由调用方（loop）负责——本模块不落盘（CONTEXT「对话摘要」）。
 * 五段结构单一来源：SUMMARY_SECTIONS（标题 + 各段要写什么的描述），
 * prompt 的行文本与 SUMMARY_SECTION_HEADERS（标题列表）都由它派生，杜绝双份漂移。
 */
import type { ChatMessage } from '../../shared/llm-types.js';
import { SUMMARY_FORBID_TOOLS, SUMMARY_TARGET_MAX_TOKENS } from './constants.js';

/** 五段式段落（§2.2 官方骨架，逐字标题）；单一来源，prompt 由本表派生。 */
export const SUMMARY_SECTIONS = [
  {
    title: 'Task Overview',
    description: "the user's core request, success criteria, and constraints.",
  },
  {
    title: 'Current State',
    description: 'what was accomplished, which files were changed, artifacts produced.',
  },
  {
    title: 'Important Discoveries',
    description: 'technical constraints, decisions made, errors solved, dead ends.',
  },
  {
    title: 'Next Steps',
    description: 'what remains to be done, blockers, priorities.',
  },
  {
    title: 'Context to Preserve',
    description: 'user preferences, domain-specific details, promises made.',
  },
] as const;

/** 五段式结构标题列表（由 SUMMARY_SECTIONS 派生，非独立数据源）。 */
export const SUMMARY_SECTION_HEADERS: readonly string[] = SUMMARY_SECTIONS.map(
  (section) => section.title,
);

/** 五段式摘要指令（内置完整结构要求 + <summary> 包裹 + 禁止工具调用）。 */
export function buildSummaryPrompt(messages: readonly ChatMessage[]): string {
  const sections = SUMMARY_SECTIONS.map(
    (section, i) => `${i + 1}. ${section.title}: ${section.description}`,
  ).join('\n');
  const conversation = messages
    .map((m) => {
      if (m.role === 'assistant') {
        const calls = (m.toolCalls ?? [])
          .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
          .join('\n');
        return `[assistant] ${m.content ?? ''}${calls.length > 0 ? `\n[tool_calls]\n${calls}` : ''}`;
      }
      return `[${m.role}] ${m.content}`;
    })
    .join('\n');
  return [
    'You are compressing a coding-agent conversation into a structured summary.',
    undefined,
    'The summary MUST have exactly these five sections:',
    sections,
    undefined,
    'Wrap the whole summary in <summary>...</summary> tags.',
    SUMMARY_FORBID_TOOLS,
    `Keep the summary under ${SUMMARY_TARGET_MAX_TOKENS} tokens.`,
    undefined,
    'The conversation:\n<conversation>',
    conversation,
    '</conversation>',
  ]
    .filter((l): l is string => l !== undefined)
    .join('\n');
}

/** 摘要器返回内容去掉 <summary> 包裹标签（未包裹则原样返回）。 */
export function extractSummaryContent(raw: string): string {
  const match = /<summary>([\s\S]*)<\/summary>/u.exec(raw);
  return match !== null ? (match[1] ?? '') : raw;
}
