/**
 * # loop/types：主循环公共契约（接缝 S5）
 *
 * 术语遵循 CONTEXT.md（轮次/Step/自然结束/保险丝/成本护栏/错误回注/写序不变量/
 * 悬空工具调用/会话/投影/提交信号/审批）。
 * 契约边界：
 * - run() 是唯一入口：查（投影+请求）→ 回（流式）+ 执行（工具/审批）→ 回注（落盘）
 *   的驱动者；终止条件前置在查询之前；任意路径 finalize（run_result 事件）。
 * - LlmAdapter 是本循环依赖的 LLM 最小接缝：provider 序列化（S2 buildRequest）与
 *   传输层重试（S6）由 boot 接线，本层只见统一 ChatRequest/StreamEvent。
 * - ToolRegistry 接缝：list() 供模型可见定义（含 JSON Schema），execute(call) 执行一次
 *   调用；本循环负责参数校验、审批、超时与错误回注（挂接 S5 唯一事实来源）。
 * - Approver 接缝：'allow' 放行；{deny:true, reason} 拒绝并回注拒因（带理由→模型继续）；
 *   {deny:true} 无理由 → 用户中止本轮（user-interrupted；CONTEXT「危险操作审批」
 *   「无备注则结束本轮」，与「拒绝停止本轮」语义一致）。
 */
import type { ConversationSummarizer } from '../context/index.js';
import type { SessionStore } from '../session/index.js';
import type { ChatRequest, ReasoningEffort, StreamEvent } from '../../shared/llm-types.js';
import type { ToolCall } from '../../shared/session-types.js';

// ---------------------------------------------------------------------------
// 交互层：run 的输入输出
// ---------------------------------------------------------------------------

export interface RunInput {
  sessionId: string;
  /** 任务描述：只在新会话时落为首个 user 事件；resume 时被忽略（历史不改写）。 */
  task: string;
}

/**
 * 终止原因（CONTEXT「终止条件」）：自然结束 / 保险丝三件（成本、步数、墙钟）/
 * 熔断（连续格式错误、压缩防抖） / 用户中断 / 致命（传输层重试耗尽或 harness 异常）。
 * 成本超限同时是熔断与终止（ADR-0003），与"熔断"合并为本状态。
 */
export type RunStatus =
  | 'completed' // 自然结束：本轮无工具调用
  | 'cost-guard' // 成本护栏（闸门 A/B/C）
  | 'max-steps'
  | 'wall-time'
  | 'circuit-break' // 连续格式错误达阈值（ADR-0006）
  | 'compaction-debounce' // 压缩防抖：摘要后仍超限达容忍上限（CONTEXT「压缩防抖」/ §8 A-1）
  | 'user-interrupted' // AbortSignal / 无理由拒绝（随时中断接管；含「拒绝停止本轮」）
  | 'fatal'; // 传输层重试耗尽 / 协议错误 / harness 异常

/** 归一记账输出（成本护栏累计账本的对外形状）。 */
export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** 任何分量由本地估算兜底（usage 缺失 / 流式中断）时为 true。 */
  estimated: boolean;
  /** 本轮 run 最后一次投影的上下文估算 token（projection.stats.estimatedTokens；
   *  C 档 usage 帧的 contextEstimateTokens；无投影路径不带键）。 */
  contextEstimateTokens?: number;
}

export interface RunResult {
  status: RunStatus;
  usage: UsageSummary;
  /** 已进代码的查询次数（每轮一次查询计一步）。 */
  steps: number;
  /** 运行耗时（ms；受注入时钟影响）。 */
  durationMs: number;
  /** 终止原因回注（fatal / compaction-debounce 带说明；与 run_result 事件载荷同源）。 */
  error?: string;
}

// ---------------------------------------------------------------------------
// LLM 接缝
// ---------------------------------------------------------------------------

/**
 * LLM 最小接缝：流式请求，供应商序列化与传输层重试在 boot。
 * 实现方需保证：error 事件为「重试已耗尽/不可重试」的终极形态；signal 中止
 * 以 LlmError{kind:'abort'} 或终止流表达。
 */
export interface LlmAdapter {
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

// ---------------------------------------------------------------------------
// 工具面接缝（本模块定义；真实工具实现属 Phase 3，ADR-0008/0010）
// ---------------------------------------------------------------------------

/**
 * JSON Schema 子集（本循环校验所用；Phase 3 可扩充，未知键忽略）。
 * 仅支持 object/properties/required + 属性级 string/number/integer/boolean/array 与 enum；
 * items（元素级校验）声明但未实现，先不保留声明（工具面 Phase 3 再定，ADR-0008/0010）。
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  description?: string;
}

/** 模型可见的工具定义（ToolRegistry.list() 的返回形状）。 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** 工具执行结果：失败也是一个普通结果（CONTEXT「ToolResult」）。 */
export interface ToolResult {
  ok: boolean;
  content: string;
  error?: { type: string; message: string };
}

/** 工具执行上下文（由 defineRegistry 注入：会话 id + 用户中断信号）。 */
export interface ToolExecutionContext {
  sessionId: string;
  signal?: AbortSignal;
}

/** 一次工具定义：ToolDef + execute。参数已由主循环校验后才调用。 */
export interface Tool extends ToolDef {
  execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult>;
}

/** 工具注册表接缝：list 暴露模型可见定义；execute 执行一次调用（按 name 分发）。 */
export interface ToolRegistry {
  list(): readonly ToolDef[];
  execute(call: ToolCall): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// 审批接缝（ADR-0013）
// ---------------------------------------------------------------------------

/** 拒绝回注的错误类型（审批链路单一集合：用户弹窗拒绝 / 权限预设策略自动拒绝）。 */
export type ApprovalDeniedErrorType = 'user-denied' | 'permission-denied';

/**
 * 'allow' 放行；{deny:true, reason} 拒绝并回注；{deny:true}（无理由）→ 用户中止本轮
 * （user-interrupted）。
 * errorType 只在带理由拒绝时生效：'user-denied'（用户弹窗拒绝；缺省）或
 * 'permission-denied'（权限预设矩阵的 deny 直拒——工具结果 error.type 逐字，普通回注）。
 */
export type ApprovalDecision =
  'allow' | { deny: boolean; reason?: string; errorType?: ApprovalDeniedErrorType };
export type Approver = (call: ToolCall) => Promise<ApprovalDecision>;

// ---------------------------------------------------------------------------
// 评审哨兵（R2-S2：收尾评审护栏）
// ---------------------------------------------------------------------------

/**
 * 会话级工具运行统计（评审哨兵语义版的数据源）：计数由接线层观察器在每次
 * 工具真实执行时累积（被审批拒绝 / 未触达工具层的调用不计——「执行过」语义）。
 * 纯函数 hasSubstantiveWork / hasReviewRun 只消费本形状（测试面板直测函数）。
 */
export interface RunStats {
  /** 工具名 → 已执行次数（含失败结果：失败也是「执行过」）。 */
  counts: Readonly<Record<string, number>>;
  /** 成功执行的 spawn_subagent 的 prompt 文本序列（评审判定数据源，按执行序）。 */
  subagentPrompts: readonly string[];
}

/** 实质变更工具名（写/编辑/命令/子代理；MCP 按 mcp_ 前缀另行判定）。 */
const SUBSTANTIVE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'run_command',
  'spawn_subagent',
]);

/** 独立审查 prompt 判定（含「审查」或 "review"——大小写不敏感）。 */
const REVIEW_PROMPT_PATTERN = /审查|review/i;

/** 实质变更判定：write/edit/shell/mcp 工具/spawn 任一执行过。 */
export function hasSubstantiveWork(stats: RunStats | undefined): boolean {
  if (stats === undefined) return false;
  for (const name of Object.keys(stats.counts)) {
    if ((stats.counts[name] ?? 0) > 0) {
      if (SUBSTANTIVE_TOOL_NAMES.has(name) || name.startsWith('mcp_')) return true;
    }
  }
  return false;
}

/** 独立审查判定：任一次 spawn_subagent 成功且其 prompt 含 /审查|review/i。 */
export function hasReviewRun(stats: RunStats | undefined): boolean {
  if (stats === undefined) return false;
  return stats.subagentPrompts.some((prompt) => REVIEW_PROMPT_PATTERN.test(prompt));
}

/**
 * 评审哨兵门（RunOptions.review）：自然收尾点护栏——任务有实质变更（本轮执行过
 * write / edit / run_command / mcp 工具 / spawn_subagent）且尚无独立审查时，先注入一次
 * 「请先派独立审查子代理再收尾」的用户消息（事件 meta.system:true，UI 显示为
 * 系统样式），续跑一轮；flag 为 per-session 一次性——已注入过即置位，之后模型
 * 若无审查直接自然结束 → 放行（护栏即一次）。
 * - 纯查询与一次性置位的契约（实现方各自收敛：server 语义版经 RunStats 判定；
 *   loop 层只消费本接缝，绝不外挂统计）。
 * - 故障收敛：任一查询/置位抛错按「不干预自然结束」处理（护栏故障不放大为行为故障）。
 */
export interface ReviewGate {
  /** 该会话是否已有实质变更（写/编辑/命令/MCP/子代理任一执行过）。 */
  hasSubstantiveWork(sessionId: string): boolean;
  /** 该会话是否已有独立审查（spawn_subagent 成功且 prompt 含 /审查|review/i）。 */
  hasReviewRun(sessionId: string): boolean;
  /** 该会话是否已注入过（per-session 一次性护栏）。 */
  isFlagged(sessionId: string): boolean;
  /** 注入时置位（一次性护栏的写侧；先置位后注入）。 */
  markFlagged(sessionId: string): void;
}

// ---------------------------------------------------------------------------
// 方法论前置门（R2-S1：方法论内化）
// ---------------------------------------------------------------------------

/**
 * 方法论前置门（RunOptions.methodology）：route 命中 method 型技能且该会话尚未加载
 * 时，拦截工具调用组（**组内不含 use_skill(<id>) 时**），回注 guidance 型结果
 * （{ok:false, error:{type:'methodology-first'}}，普通回注管线，不计熔断）。
 * - route(task)：把任务文本匹配到技能 id（语义版按触发词关键词命中；未命中/无表 → null）；
 * - isLoaded / markLoaded：会话级加载状态（use_skill 执行成功由主循环观察并 mark）；
 * - 不注入（undefined）= 关闭：从不拦截（老配置/E2E/test 默认路径）。
 */
export interface MethodologyGate {
  route(task: string): Promise<string | null>;
  isLoaded(sessionId: string, id: string): boolean;
  markLoaded(sessionId: string, id: string): void;
}

// ---------------------------------------------------------------------------
// 成本计价（ADR-0003：单价表缺失期以占位价近似）
// ---------------------------------------------------------------------------

export interface Pricing {
  /** 未命中输入 token 单价（USD/token）。 */
  promptPerToken: number;
  /** 输出 token 单价（USD/token；推理 token 计入输出价，CONTEXT「成本护栏」）。 */
  completionPerToken: number;
  /** 缓存命中输入 token 单价（缺省=promptPerToken：无折扣差表）。 */
  cachedPerToken?: number;
}

// ---------------------------------------------------------------------------
// RunOptions：本循环的可配置面
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** 会话存储（唯一事实来源；写序由本模块保证）。 */
  store: SessionStore;
  tools: ToolRegistry;
  llm: LlmAdapter;
  /** 危险动作审批；缺省=全放行。 */
  approver?: Approver;
  /** 请求侧模型名。 */
  model: string;
  /** 请求侧输出上限（maxTokens）；缺省不发送（闸门 A 输出侧按模型默认预留 DEFAULT_MAX_TOKENS 估价，§8 A-1）。 */
  maxTokens?: number;
  /** 成本计价表；缺省=占位价（单价表补齐前，ADR-0003）。 */
  pricing?: Pricing;
  /** 成本上限（USD）；缺省 DEFAULT_COST_LIMIT_USD（ADR-0003：默认唯一开启）。 */
  costLimitUsd?: number;
  /** 步数上限；缺省禁用（评测/CI 给固定值，§8C）。 */
  maxSteps?: number;
  /** 墙钟上限；缺省禁用。 */
  wallTimeMs?: number;
  /** 连续格式错误熔断阈值；缺省 3（mini-swe 一手默认，ADR-0006）。 */
  maxFormatErrors?: number;
  /** 单工具执行超时；缺省 120s（ADR-0010 单命令默认）。 */
  toolTimeoutMs?: number;
  /** 摘要器（透传 S4 project；缺省不摘要）。 */
  summarizer?: ConversationSummarizer;
  /** 上下文窗口 token 预算（透传 S4；未知时不触发阈值压缩）。 */
  windowTokens?: number;
  /** 思考强度（C 档：/api/settings 的 reasoning；逐字进入 ChatRequest.reasoningEffort——adapter 按家映射）。 */
  reasoning?: ReasoningEffort;
  /** 持久规则载体（投影系统前缀，压缩永不触碰，ADR-0005）。 */
  systemPrompt?: string;
  /** 用户中断信号：任意时刻可中断，立场一致可续。 */
  signal?: AbortSignal;
  /** 时钟注入（墙钟测试）。 */
  now?: () => number;
  /** 方法论前置门；缺省 undefined = 关闭（从不拦截——E2E/测试/老配置默认路径）。 */
  methodology?: MethodologyGate;
  /**
   * 评审哨兵门（R2-S2）；缺省 undefined = 关闭（从不注入——E2E/测试/老配置默认路径）。
   * server 语义版：hasSubstantiveWork/hasReviewRun 由接线层观察器记帐的 RunStats 装配。
   */
  review?: ReviewGate;
}

// ---------------------------------------------------------------------------
// 默认常量（单一来源：ADRs/research 一手默认）
// ---------------------------------------------------------------------------

/** 成本上限默认（USD/任务；ADR-0003：评测基线 3.0，默认唯一开启的终止条件）。 */
export const DEFAULT_COST_LIMIT_USD = 3.0;
/** 连续格式错误熔断阈值（mini-swe-agent 一手默认 max_consecutive_format_errors=3）。 */
export const DEFAULT_MAX_FORMAT_ERRORS = 3;
/** 单工具默认执行超时（ms；ADR-0010 单命令默认 120s）。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
/**
 * 输出预留（token；§8 A-1：max_completion_tokens 默认 8192，测试/重构类可提至 16384）。
 * 闸门 A 输出侧估价在请求未带 maxTokens 时以此作为模型默认预留。
 */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * 占位单价（USD/token；ADR-0003：单价表缺口（REVIEW D3.1）前闸门 A 只能以
 * 「本地估算 token × 占位价」近似；真实单价表落地后由 boot/CLI 注入替换）。
 */
export const DEFAULT_PRICING: Pricing = Object.freeze({
  promptPerToken: 1e-6,
  completionPerToken: 3e-6,
});
