/**
 * # llm：LLM 客户端与供应商适配层（占位）
 *
 * 职责：
 * - 零依赖 LLM 客户端：Node 原生 fetch + 手写 SSE 解析器 + tool_calls 分片拼接
 *   （ADR-0001，连官方 SDK 也不用）。
 * - Provider Adapter：把各家协议差异归一为统一口径（采样参数白名单、strict
 *   默认值、finish_reason 词汇、流式 usage 载体、错误体形状、retry 头），见 ADR-0002。
 * - 只对接 OpenAI 兼容端点（ADR-0009）。
 */
export {};
