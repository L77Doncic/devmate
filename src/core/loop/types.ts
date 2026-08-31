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
import type { AttachmentResolver, ConversationSummarizer } from '../context/index.js';
import type { SessionStore } from '../session/index.js';
import type { ChatRequest, ReasoningEffort, StreamEvent } from '../../shared/llm-types.js';
import type { ToolCall, UserImage } from '../../shared/session-types.js';

// ---------------------------------------------------------------------------
// 交互层：run 的输入输出
// ---------------------------------------------------------------------------

export interface RunInput {
  sessionId: string;
  /** 任务描述：只在新会话时落为首个 user 事件；resume 时被忽略（历史不改写）。 */
  task: string;
  /** 多模态图片（ADR-0015；可选）：随任务落 user 事件 payload.images（与文本同命运）。 */
  images?: UserImage[];
}

/**
 * 终止原因（CONTEXT「终止条件」）：自然结束 / 保险丝三件（token 护栏、步数、墙钟）/
 * 熔断（连续格式错误、压缩防抖） / 用户中断 / 致命（传输层重试耗尽或 harness 异常）。
 * token 超限同时是熔断与终止（ADR-0003 成本护栏演进为 token 护栏——状态值保留兼容）。
 */
export type RunStatus =
  | 'completed' // 自然结束：本轮无工具调用
  | 'cost-guard' // Token 护栏（累计 totalTokens 超限；闸门 A/B/C；状态值兼容历史）
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

/**
 * 工具注册表接缝：list 暴露模型可见定义；execute 执行一次调用（按 name 分发）。
 * execute 的第二参（可选）是**运行时上下文补丁**：run 每次执行现传 {sessionId, signal}>
 * （与 defineRegistry 构造期静态上下文合并——运行时覆盖静态）。
 * 背景（P2-3 停止不杀命令树）：泄漏根因是工具面构造时固定 {sessionId} 静态上下文，
 * 运行时的中断 signal 从不到达工具（常驻 shell 的 waitForCompletion 听不到 abort →
 * sleep-30 自然跑完才落「已中断」）。可选参让 signal 现传（缺省调用方不传 = 旧行为）。
 */
export interface ToolRegistry {
  list(): readonly ToolDef[];
  execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// 审批接缝（ADR-0013）
// ---------------------------------------------------------------------------

/**
 * 拒绝回注的错误类型（审批链路单一集合：用户弹窗拒绝 / 权限预设策略自动拒绝）。
 * 'permission-denied'：兼容保留——服务端权限预设矩阵的 deny 直拒路径已删除（不再产生），
 * 但注入式 approver 仍可合法返回该值（loop 契约不变；类型保留防下游破坏）。
 */
export type ApprovalDeniedErrorType = 'user-denied' | 'permission-denied';

/**
 * 'allow' 放行；{deny:true, reason} 拒绝并回注；{deny:true}（无理由）→ 用户中止本轮
 * （user-interrupted）。
 * errorType 只在带理由拒绝时生效：'user-denied'（用户弹窗拒绝；缺省）或
 * 'permission-denied'（兼容保留：原权限预设矩阵 deny 直拒路径——服务端已不再产生该值，
 * 工具结果 error.type 逐字回注、普通回注不暂停的机制不变）。
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
  /**
   * 子代理是否可派发（可选接缝；P2-10 评审静默）：缺省 undefined = 认为可用（旧实现）；
   * 提供且返回 false（如池未启用 subagents-disabled）→ 哨兵**静默跳过注入**——
   * 不指示模型去摘必然失败的两连失败尝试；该轮直接自然结束（UI 侧至多提示一行
   * 「本次未派独立评审（子代理不可用）」，见 app.js maybeHintReviewSkipped）。
   */
  subagentAvailable?(): boolean;
  /**
   * 评审预算门（P2-8 修复 · UX 终版裁决）：一次的评审成本**估算**。提供时，哨兵注入
   * 前比对：估算 > 预算（maxReviewCostUsd ?? DEFAULT_MAX_REVIEW_COST_USD）→ **跳过注入**
   * （不含护栏置位——预算内容许后仍可再试）+ 一行系统注记
   * reviewBudgetSkipNote(预算)「本轮未派独立评审（评审预算 $0.02 内：超支风险）」。
   * 缺省 undefined = 不设预算门（旧行为——从不跳过）。
   * 真实装配为子代理池的 self-similar 下一次成本锚（池 cost-guard 同假设），见 subagent.ts。
   */
  reviewCostEstimate?(): number;
  /** 评审预算（USD）；缺省 DEFAULT_MAX_REVIEW_COST_USD（0.02）。仅 reviewCostEstimate 提供时生效。 */
  maxReviewCostUsd?: number;
}

/** 评审预算门缺省上限（USD；P2-8 裁决——一次评审估算超此即跳过）。 */
export const DEFAULT_MAX_REVIEW_COST_USD = 0.02;

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
  /**
   * 请求侧输入上限（A 档；settings.maxInputTokens 透传）。进入 ChatRequest.maxInputTokens，
   * 供应商白名单由 preset.maxInputTokensField 声明（仅 dashscope 发送；其余剔除，见
   * deepseek-vision.md §8）。不参与窗口预算结算——「最小：仅请求字段与文案，不重构预算」。
   */
  maxInputTokens?: number;
  /** 成本计价表；缺省=占位价（单价表补齐前，ADR-0003——只用于成本显示统计）。 */
  pricing?: Pricing;
  /**
   * Token 护栏上限（本轮 run 的累计 totalTokens 上限；单价表无关的判据）。
   * 缺省/undefined/null = **关闭**（= 无限 token——与 subagentsEnabled 开关族一致：关=不拦）。
   * 判据（保守裁决，agent.ts 有注释）：闸门 C 累计超限即停；
   * 闸门 A/B 按「累计 + 单轮上限」（本轮 prompt 估算 + 输出预留）预判超限即停/流中即中止。
   * 服务端经 POST /api/chat 的 maxRunTokens 字段透传（对话级 per-session；正整数校验，
   * 非法 400——本层再防御：非正整数按关闭处理）。
   */
  maxRunTokens?: number | null;
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
  /**
   * 附件 ref 展开器（ADR-0015；透传 S4 project——再经 resolveImageRef 注入）：
   * ref → dataURL（服务端读文件 + dataURL 组装）或 null（缺失 → 该图降级文本提示）。
   * 缺省 = 不展开（ref 事件保守降级——绝不发坏 URL、绝不崩溃）。
   */
  attachResolver?: AttachmentResolver;
  /** 上下文窗口 token 预算（透传 S4；未知时不触发阈值压缩）。 */
  windowTokens?: number;
  /**
   * 超限自愈链学习回调（E7 · ADR-0016）：核心循环命中「上下文超窗/输出区间」错误并
   * 自动修复（升级压缩重试）时调用——从 400 message 免费解析的上限（hintMax）与
   * 升级档（escalation 1=裁剪/2=摘要）上报；服务端用它做会话级记账（上限学习进
   * windowDetail「由错误学习」/ 钳制后续 run 的窗口与 maxTokens）。
   * 回调故障不放大为行为故障（调用方 try/catch 后继续重试链）。
   */
  onLimitsError?: (learning: {
    kind: 'context-exceeded' | 'output-limit';
    /** 供应商错误 message（原件）。 */
    message: string;
    /** 从 message 解析的上限（`[1, N]` 区间上界 / "maximum context length is N"）。 */
    hintMax?: number;
    /** 本轮已升级到的压缩级（1=裁剪 2=摘要）。 */
    escalation: 1 | 2;
  }) => void | Promise<void>;
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
