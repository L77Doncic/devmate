/**
 * # llm：LLM 客户端（ADR-0001 接缝 S1）
 *
 * - 零依赖 LLM 客户端：Node 原生 fetch + 手写 SSE 解析器 + tool_calls 分片拼接
 *   （ADR-0001，连官方 SDK 也不用）。
 * - Provider Adapter（每个供应商一个 adapter）是 S2 的接缝（ADR-0002），
 *   本目录当前不提供任何 adapter 文件。
 * - 只对接 OpenAI 兼容端点（ADR-0009）。
 *
 * 公共接口只有 chat(request, signal?): AsyncIterable<StreamEvent>：
 * server 侧（loop）与 UI 都经由此契约消费流式事件。
 */
export { LlmClient } from './client.js';
export type { LlmClientOptions } from './client.js';
export { LlmError } from '../../shared/llm-types.js';
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
  StreamEvent,
  StreamSnapshot,
  ToolChoice,
} from '../../shared/llm-types.js';
