/**
 * # llm-types：LLM 客户端与主循环/UI 之间的共享契约（ADR-0001 接缝 S1）
 *
 * 对外只有 chat(wire: WireRequest, signal?): AsyncIterable<StreamEvent>——wire 是
 * Provider Adapter（ADR-0002）的归一产物，客户端为纯传输层。类型面说明：
 * - ChatRequest：请求侧统一口径消息模型（camelCase 领域名；Provider Adapter
 *   的 buildRequest 把它序列化为 OpenAI 兼容 wire 蛇形字段，见 §1/§3 的字段形状）。
 * - StreamEvent：流式事件流；tool_calls 分片拼接隐藏在客户端内部，
 *   end/error 事件携带拼接好的 StreamSnapshot（§8.B）。
 * - LlmUsage：归一账本（prompt/completion/cached/reasoning 四字段，另保留
 *   DeepSeek 的 hit/miss 明细；ADR-0002 的归一口径）。
 * - LlmError：统一内部错误（HTTP/传输/协议/中止），含可重试标记与 Retry-After。
 *
 * 契约（与 openai-compatible-api-spec.md §8 一致）：
 * - [DONE] 用 startsWith 判定且先于 JSON.parse（§8.A.2，官方 SDK 同款写法）；
 * - choices 为空的 usage chunk 是合法事件，绝不当作坏数据（§8.A.6）；
 * - tool_calls 按（choice.index, tc.index）两级聚合、以 tc.index 为主键（§8.A.11 /
 *   §8.B.13），arguments 只做字符串相加，不 parse、不 stringify（§8.B.12/17）；
 *   各 choice 的 tool_calls 与文本互不合并，装配结果只随快照/终态事件携带；
 * - usage 缺失（断流或供应商未下发）以 usageMissing 打标，由上层本地估算兜底
 *   （§4.5 / §7.2.3 / §8.A.8）。
 */

/** 函数工具定义（wire: tools[].function.*，请求侧才发送）。 */
export interface ChatToolFunction {
  name: string;
  description?: string;
  /** JSON Schema 对象；缺省视为空参数表（§1.3）。 */
  parameters?: unknown;
}

export interface ChatTool {
  type: 'function';
  function: ChatToolFunction;
}

/** 一次工具调用请求：arguments 是模型产出的 JSON 字符串，原始透传（§2.1）。 */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 消息模型（角色四种，见 §1.2）。assistant 消息的 reasoningContent 在本层
 * 不做策略处置——「推理内容回传策略」属 S2 adapter 的 buildRequest（§3.3）。
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls?: ChatToolCall[];
      reasoningContent?: string;
    }
  | { role: 'tool'; content: string; toolCallId: string };

export type ToolChoice =
  'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

/** 请求参数（统一口径）：Provider Adapter 的 buildRequest 映射为 wire（snake_case），
 * 并固定 stream:true（§1.5）；客户端不感知此形状。 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  streamOptions?: { includeUsage?: boolean };
}

/**
 * 归一 usage 账本（ADR-0002：prompt/completion/cached/reasoning 四字段的
 * 输入侧提取；hit/miss 为 DeepSeek 附加明细，§7.1）。
 */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 缓存命中输入 token（OpenAI cached_tokens / Kimi 扁平 cached_tokens）。 */
  cachedTokens?: number;
  /** 推理 token（completion_tokens_details.reasoning_tokens）。 */
  reasoningTokens?: number;
  /** DeepSeek prompt_cache_hit_tokens（单价低于未命中）。 */
  promptCacheHitTokens?: number;
  /** DeepSeek prompt_cache_miss_tokens。 */
  promptCacheMissTokens?: number;
}

export interface AssembledToolCall {
  index: number;
  id: string;
  name: string;
  /** 拼出的原始 JSON 字符串——逐字回传，禁止 parse 后再 stringify（§8.B.17）。 */
  arguments: string;
}

export interface StreamSnapshot {
  finishReason: string | null;
  usage: LlmUsage | null;
  /** 到终止时仍未得到 usage（断流或未下发）：上层用本地估算兜底（§7.2）。 */
  usageMissing: boolean;
  toolCalls: AssembledToolCall[];
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'end'; snapshot: StreamSnapshot }
  | { type: 'error'; error: LlmError; snapshot: StreamSnapshot };

export type LlmErrorKind = 'http' | 'transport' | 'protocol' | 'abort';

export interface LlmErrorInit {
  kind: LlmErrorKind;
  /** HTTP 状态码；传输/协议/中止为 0。 */
  status: number;
  /** 可重试集合：{408, 425, 429, 500, 502, 503, 504} ∪ 网络/断流（§6.3）。 */
  retryable: boolean;
  message: string;
  /** 错误体业务码（OpenAI code/type、GLM 字符串型业务码）。 */
  code?: string;
  /** Retry-After 秒数；响应头存在且可解析才带（§6.3）。 */
  retryAfter?: number;
  /** 非 JSON 错误体的原始摘录（Kimi 504 HTML 等，§8.A.9）。 */
  bodySnippet?: string;
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number;
  readonly retryable: boolean;
  readonly code?: string;
  readonly retryAfter?: number;
  readonly bodySnippet?: string;

  constructor(init: LlmErrorInit) {
    super(init.message);
    this.name = 'LlmError';
    this.kind = init.kind;
    this.status = init.status;
    this.retryable = init.retryable;
    if (init.code !== undefined) this.code = init.code;
    if (init.retryAfter !== undefined) this.retryAfter = init.retryAfter;
    if (init.bodySnippet !== undefined) this.bodySnippet = init.bodySnippet;
  }
}
