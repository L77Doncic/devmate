/**
 * # context/constants：上下文管理参数单一来源（context-and-error-handling.md §8）
 *
 * 全部数值只在此处定义，分散到实现中的一律通过这里引用。
 * 体系声明（§8 表头）：本表为 A-1（OpenAI-compat 体系，客户端形态）；
 * A-2 的 Anthropic 参考值（244/325 bash 定义、100k/200k 触发）只作注脚，**不可与本表混加**。
 * 标定声明（REVIEW.md C 表）：Cookbook 常数与 K 系数落地前需以 tiktoken 离线标定，
 * 标定前按偏高估算——CJK 每字 1 token 即保守侧取值。
 */

/** 单条工具输出截断阈值（字符）。超过即保留头尾（mini-swe-agent 一手默认，§8 D）。 */
export const MAX_OUTPUT_CHARS = 10_000;
/** 截断时保留的头部字符数。 */
export const TRUNCATE_HEAD_CHARS = 5_000;
/** 截断时保留的尾部字符数。 */
export const TRUNCATE_TAIL_CHARS = 5_000;

/** ASCII 连续段 token 估算除数（英文/JSON/Markdown，§8 A-1）。 */
export const TEXT_TOKENS_PER_ASCII_PROSE = 4;
/** ASCII 连续段 token 估算除数（源码/diff，§8 A-1）。 */
export const TEXT_TOKENS_PER_ASCII_CODE = 3;
/** CJK 字符（含 CJK 标点/全角）每字符 token 数（§8 A-1，保守取值）。 */
export const TOKENS_PER_CJK_CHAR = 1;

/** 每条消息结构开销（OpenAI Cookbook tokens_per_message，§1.3 一手）。 */
export const TOKENS_PER_MESSAGE = 3;
/** 回复 priming（every reply is primed with assistant reply tokens，§1.3 一手）。 */
export const REPLY_PRIMING_TOKENS = 3;
/** 每个 function 工具定义固定开销（gpt-4o 系取值，§8 A-1）。 */
export const TOKENS_PER_FUNCTION = 7;
/** 每个 property 开销（§1.3 一手）。 */
export const TOKENS_PER_PROPERTY = 3;
/** 每个 property 的 key 开销（§1.3 一手）。 */
export const TOKENS_PER_PROPERTY_KEY = 3;
/** enum 属性基础调整（§1.3 一手：-3），配合每枚举项 +3。 */
export const ENUM_PROPERTY_ADJUSTMENT = -3;
/** 每个枚举项开销（§1.3 一手）。 */
export const TOKENS_PER_ENUM_ITEM = 3;
/** tools 段收尾开销（§1.3 一手）。 */
export const TOOLS_END_TOKENS = 12;

/** 组包期裁剪触发比例（clearTrigger = window × 0.45，§8 A-2 注释同口径；窗口未知不以此计算）。 */
export const CLEAR_TRIGGER_RATIO = 0.45;
/** 触顶期摘要触发比例（compactTrigger = window × 0.72，§8 A-2 注释同口径；窗口未知不以此计算）。 */
export const COMPACT_TRIGGER_RATIO = 0.72;
/** 裁剪后保留的最近工具组数（keep=3，Anthropic clear_tool_uses 一手默认，§8 A-2）。 */
export const KEEP_GROUPS = 3;
/** 组包期裁剪的最低清出量（token）：触顶但将被清出量不足时本层跳过（§2.4 第 1 层 / §8 A-2「至少清出 ≥8k tokens」）。 */
export const DEFAULT_CLEAR_AT_LEAST_TOKENS = 8_000;
/** 摘要目标体积（tokens，§8 A-1：≤8000；官方示例 2–3k 太激进）。 */
export const SUMMARY_TARGET_MAX_TOKENS = 8_000;
/** 摘要提示词显式禁止调用工具（§2.2 坑 1：模型偶尔会去调工具而不是写摘要）。 */
export const SUMMARY_FORBID_TOOLS = 'Do NOT call any tools. Return only the summary text.';

/** 副作用型工具名默认全集（永不裁剪；write/edit/apply_patch/git_commit，§8 A-2 excludeTools，集合内容由我们定）。 */
export const DEFAULT_EXCLUDE_TOOLS = ['write', 'edit', 'apply_patch', 'git_commit'] as const;

/** 压缩防抖：摘要后仍超限的重试上限（CONTEXT 裁决 8：上限 2 次；§8B）。 */
export const MAX_COMPACTION_ATTEMPTS = 2;
/** 压缩防抖时间窗口（连续压缩后 5 分钟内又触顶 ⇒ 熔断，§8 A-1）。 */
export const DEBOUNCE_WINDOW_MS = 5 * 60_000;
