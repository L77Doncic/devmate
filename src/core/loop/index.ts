/**
 * # loop：主循环（接缝 S5）
 *
 * 职责（CONTEXT「主循环」）：
 * - Turn/Step 驱动：「查询 → 执行动作 → 结果回注」往复，直到命中终止条件；
 * - 终止条件与保险丝：成本、步数、墙钟分项预检查（前置在查询之前），默认开启成本上限；
 * - 熔断（连续格式错误）与错误回注成对出现（ADR-0006 / ADR-0013）；
 * - 写序不变量：assistant 消息先落盘 → 才执行任何工具 → 工具结果落盘 → 才发起下一次请求
 *   （ADR-0004）；崩溃/中断残留的悬空调用由 resume 修补（interrupted 占位）。
 * - 运行时接线（provider 适配 + 传输层重试 + 客户端）见 boot.ts。
 *
 * 本模块只 import 读用既有模块：llm（适配/客户端由 boot 组合）、session（SessionStore）、
 * context（project 投影与两级压缩）、retry（boot 接线），不改其源码。
 */
export { run, REVIEW_SENTINEL_USER_CONTENT } from './agent.js';
export { wiredLlmAdapter } from './boot.js';
export type { WiredLlmAdapterOptions } from './boot.js';
export { defineRegistry } from './tools.js';
export type { ReinjectionError, SchemaIssue, ToolCallValidation } from './tools.js';
export {
  DEFAULT_COST_LIMIT_USD,
  DEFAULT_MAX_FORMAT_ERRORS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PRICING,
  DEFAULT_TOOL_TIMEOUT_MS,
  hasReviewRun,
  hasSubstantiveWork,
} from './types.js';
export type {
  ApprovalDecision,
  Approver,
  JsonSchema,
  LlmAdapter,
  MethodologyGate,
  Pricing,
  ReviewGate,
  RunInput,
  RunOptions,
  RunResult,
  RunStats,
  RunStatus,
  Tool,
  ToolDef,
  ToolExecutionContext,
  ToolRegistry,
  ToolResult,
  UsageSummary,
} from './types.js';
/** 工具调用请求（Phase 3 工具实现直接 import 本类型）。 */
export type { ToolCall } from '../../shared/session-types.js';
