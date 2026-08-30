/**
 * # llm：LLM 客户端（ADR-0001 接缝 S1）
 *
 * - 零依赖 LLM 客户端：Node 原生 fetch + 手写 SSE 解析器 + tool_calls 分片拼接
 *   （ADR-0001，连官方 SDK 也不用）；传输层纯消费 WireRequest，序列化在 adapter。
 * - Provider Adapter（每个供应商一个 adapter，每供应商一个 preset 数据表）是 S2
 *   的接缝（ADR-0002）：buildRequest 产出 WireRequest，normalizeError/
 *   normalizeFinishReason 归一供应商差异。
 * - 只对接 OpenAI 兼容端点（ADR-0009）。
 *
 * 公共接口只有 chat(wire: WireRequest, signal?): AsyncIterable<StreamEvent>：
 * server 侧（loop）与 UI 都经由此契约消费流式事件。
 */
export { LlmClient } from './client.js';
export type { LlmClientOptions } from './client.js';
export { LlmError } from '../../shared/llm-types.js';
export {
  MODEL_WINDOW_HINT_RE,
  PROVIDER_IDS,
  ProviderAdapterError,
  buildRequest,
  normalizeError,
  normalizeFinishReason,
  sanitizeProviderModel,
} from './provider-adapter.js';
export type {
  NormalizedFinishReason,
  ProviderId,
  ProviderPreset,
  ReasoningPolicy,
  RetryableRule,
  ToolChoiceKind,
  WireRequest,
} from './provider-adapter.js';
export {
  DEFAULT_PROVIDER_ID,
  PROVIDER_PRESETS,
  defaultProviderPreset,
  getProviderPreset,
  providerPresetOfBaseUrl,
} from './presets.js';
// 上限钳制（S 档；ADR-0016）：settings POST/GET 与适配层护栏共用同一张上限表
export { clampLimits } from './clamp-limits.js';
export type { ClampLimitsInput, ClampLimitsResult } from './clamp-limits.js';
// 超限错误分类（M1；ADR-0016 E7 自愈链/上限学习的数据源）
export { classifyContextError } from './error-parse.js';
export type { ContextErrorInfo, ContextErrorKind } from './error-parse.js';
// 网关窗口探测（三源取窗 · 网关层；零依赖纯模块）
export {
  DEFAULT_WINDOW_TIMEOUT_MS,
  WINDOW_FIELD_KEYS,
  WINDOW_MAX,
  discoverWindow,
  modelsEndpointOf,
  normalizeWindow,
} from './models.js';
export type { DiscoverWindowParams, DiscoverWindowResult, DiscoverWindowSource } from './models.js';
export type {
  AssembledToolCall,
  ChatMessage,
  ChatRequest,
  ChatTool,
  ChatToolCall,
  ChatToolFunction,
  LlmErrorInit,
  LlmErrorKind,
  LlmUsage,
  ReasoningEffort,
  StreamEvent,
  StreamSnapshot,
  ToolChoice,
} from '../../shared/llm-types.js';
