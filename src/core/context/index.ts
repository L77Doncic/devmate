/**
 * # context：上下文管理与两级压缩（S4 接缝；ADR-0005「三级瀑布」）
 *
 * 公共接口（小而深）：`project(events, opts): Promise<Projection>`——由 append-only 会话事件流
 * 推导此刻发给模型的投影，纯变换、无 IO（唯一 IO 是注入的摘要器）；压缩顺序固定
 * 截断 → 裁剪 → 摘要，且只作用于投影（输入事件流永不动）。
 * 配套件：估算器（L2 启发式 + Cookbook 结构开销，A-1 体系）、生成期截断器、
 * 摘要提示词构造（五段式 + 禁止工具调用）、压缩防抖计数器、isOverBudget 判定。
 * 窗口值一律来自调用方（provider 覆盖/请求参数），本模块不硬编码；未知时不做阈值计算，
 * 走「超限报错 → 压缩 → 重试（上限 2 次）」兜底（§1.4/§8A/§8B）。
 */
export {
  CLEAR_TRIGGER_RATIO,
  COMPACT_TRIGGER_RATIO,
  DEBOUNCE_WINDOW_MS,
  DEFAULT_CLEAR_AT_LEAST_TOKENS,
  DEFAULT_EXCLUDE_TOOLS,
  ENUM_PROPERTY_ADJUSTMENT,
  KEEP_GROUPS,
  MAX_COMPACTION_ATTEMPTS,
  MAX_OUTPUT_CHARS,
  REPLY_PRIMING_TOKENS,
  SUMMARY_FORBID_TOOLS,
  SUMMARY_TARGET_MAX_TOKENS,
  TEXT_TOKENS_PER_ASCII_CODE,
  TEXT_TOKENS_PER_ASCII_PROSE,
  TOKENS_PER_CJK_CHAR,
  TOKENS_PER_ENUM_ITEM,
  TOKENS_PER_FUNCTION,
  TOKENS_PER_MESSAGE,
  TOKENS_PER_PROPERTY,
  TOKENS_PER_PROPERTY_KEY,
  TOOLS_END_TOKENS,
  TRUNCATE_HEAD_CHARS,
  TRUNCATE_TAIL_CHARS,
} from './constants.js';

export { estimateTextTokens, estimateTokens, estimateToolsOverhead } from './estimator.js';
export type { TokenEstimate, TokenEstimateParts } from './estimator.js';

export { elideMarker, OUTPUT_TOO_LONG_ADVICE, truncateToolOutput } from './truncate.js';
export { placeholderForToolResult } from './prune.js';
export { buildSummaryPrompt, extractSummaryContent, SUMMARY_SECTION_HEADERS } from './summary.js';
export { CompactionDebouncer } from './debounce.js';
export type { CompactionDebouncerOptions } from './debounce.js';

export { isOverBudget, project } from './project.js';
export type {
  CompactionLevel,
  ConversationSummarizer,
  Projection,
  ProjectionStats,
  ProjectOptions,
  PruneStatus,
  PruneStats,
  SummarizeRequest,
  SummaryStats,
  SummaryStatus,
  TruncateStats,
} from './project.js';
