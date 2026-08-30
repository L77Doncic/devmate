/**
 * # loop/agent：run() 主循环（接缝 S5 的核心）
 *
 * 每轮次（Turn）动作序列（CONTEXT「主循环」/「写序不变量」）：
 * 保险丝前置（成本/步数/墙钟分项，查询之前）→ project 投影（两级压缩只作用于投影；
 * 摘要后按压缩防抖计数、超容忍即熔断，CONTEXT「压缩防抖」）→ 闸门 A 请求前估算
 * → 流式查询（含传输层 retry，归 boot 的 LlmAdapter）→ assistant 事件先落盘（T1）
 * → 无 toolCalls = 自然结束 → 工具执行（并行 + 独立超时 + 审批 + 畸形回注）→
 * 结果事件落盘（T2）→ 熔断/计数 → 下一轮。
 *
 * 分层纪律（ADR-0006）：轮次层错误（畸形参数/未知工具/schema 违例/参数缺失/执行失败/
 * 超时/用户拒绝）一律以该次调用的工具结果内容回注，绝不抛异常；传输层错误由
 * LlmAdapter（boot 接线）重试到底，本层只按终止面收尾（fatal 或 user-interrupted）。
 * 被计费的失败轮照记成本（ADR-0003：保险丝防绕过），熔断与回注成对（ADR-0006）。
 */
import type {
  ChatMessage,
  ChatRequest,
  ChatTool,
  LlmError,
  LlmUsage,
  ReasoningEffort,
  StreamSnapshot,
} from '../../shared/llm-types.js';
import type { SessionEvent, ToolCall } from '../../shared/session-types.js';
import { INTERRUPTED_RESULT_CONTENT } from '../../shared/session-types.js';
import {
  CompactionDebouncer,
  TokenEstimateCalibrator,
  estimateTextTokens,
  project,
} from '../context/index.js';
import { TEXT_TOKENS_PER_ASCII_PROSE } from '../context/constants.js';
import type { ProjectOptions } from '../context/index.js';
import type { SessionStore } from '../session/index.js';
import {
  errorResultContent,
  invalidArgumentsResult,
  invalidToolArgumentsResult,
  methodologyFirstResult,
  unknownToolResult,
  validateToolCall,
} from './tools.js';
import type {
  ApprovalDeniedErrorType,
  Approver,
  LlmAdapter,
  MethodologyGate,
  Pricing,
  ReviewGate,
  RunInput,
  RunOptions,
  RunResult,
  RunStatus,
  ToolDef,
  ToolRegistry,
  ToolResult,
} from './types.js';
import {
  DEFAULT_COST_LIMIT_USD,
  DEFAULT_MAX_FORMAT_ERRORS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PRICING,
  DEFAULT_TOOL_TIMEOUT_MS,
} from './types.js';

// ---------------------------------------------------------------------------
// run()：唯一入口
// ---------------------------------------------------------------------------

/**
 * 评审哨兵注入的用户消息（R2-S2）：在模型自然结束（无工具调用）时由环境注入，
 * 事件 meta.system=true（UI 显示为系统样式）。
 * 措辞契约（测试锚点）：以「评审哨兵」标记 + 指出动作（spawn_subagent 独立审查）
 * + B-1 借鉴①的 skill:"code-review" 注入指引（该方法论全文会注入审查子代理）。
 * 「审查/review 进 prompt」要求保留（hasReviewRun 判定）。
 */
export const REVIEW_SENTINEL_USER_CONTENT =
  '【评审哨兵】本轮任务产生了实质变更（写入/编辑/命令执行/MCP 调用/子代理）。' +
  '收尾前请先派一次独立审查：调用 spawn_subagent，其 prompt 须含「审查」或 review——' +
  '以交付物对照任务目标，列出缺陷与放行理由（≤400 字）；对审查结论先修复或说明，再收尾。' +
  '建议 spawn_subagent 时带 skill:"code-review"（该方法论全文会注入审查子代理）；';

export async function run(input: RunInput, opts: RunOptions): Promise<RunResult> {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const costLimit = opts.costLimitUsd ?? DEFAULT_COST_LIMIT_USD;
  const maxFormatErrors = opts.maxFormatErrors ?? DEFAULT_MAX_FORMAT_ERRORS;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  // 闸门 A 输出侧估价（§8 A-1 输出预留）：请求带 maxTokens 用之，否则模型默认预留。
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const signal = opts.signal;
  const now = opts.now ?? (() => Date.now());
  const startAt = now();
  const { store } = opts;

  const ledger: Ledger = { promptTokens: 0, completionTokens: 0, costUsd: 0, estimated: false };
  /** 最近一次投影的上下文估算（C 档：usage 的 contextEstimateTokens；无投影路径缺省）。 */
  let contextEstimate: number | undefined;
  const calibrator = new TokenEstimateCalibrator(); // L0 事后校准（ADR-0012；默认系数 1）
  const debouncer = new CompactionDebouncer(); // 压缩防抖（CONTEXT「压缩防抖」/ §8 A-1）
  let formatErrors = 0;
  let steps = 0;
  let status: RunStatus | null = null;
  let errorMessage: string | undefined;
  // 方法论前置门（R2-S1）：route 一次 run 一次；未注入/路由故障/未命中 → 门关闭（从不拦截）
  const methodologyRoutedId = await resolveMethodologyRoute(opts.methodology, input.task);

  try {
    // 会话引导：新会话 = create + task 落为首个 user 事件；resume = 既有事件流直接继续（不改写）
    if (!(await store.exists(input.sessionId))) {
      await store.create(input.sessionId);
      // 多模态（ADR-0015）：images 随 payload.images 落盘（服务端路径早已先落 user 事件——
      // 本分支只服务直调 run 的形态：subagent/loop 测试）。
      await store.append(input.sessionId, {
        kind: 'user',
        payload: {
          content: input.task,
          ...(input.images !== undefined && input.images.length > 0
            ? { images: input.images }
            : {}),
        },
      });
    }
    // resume 修补：悬空工具调用 → 「中断占位」结果（B 形态，ADR-0004）
    await store.repairOrphaned(input.sessionId);

    while (status === null) {
      // 保险丝前置：每轮查询之前（CONTEXT「保险丝」；优先级：成本 → 墙钟 → 步数）
      if (signal?.aborted === true) {
        status = 'user-interrupted';
        break;
      }
      if (ledger.costUsd > costLimit) {
        // 闸门 C 校准后越限：下一轮查询前停（熔断与终止合一的成本护栏）
        status = 'cost-guard';
        break;
      }
      if (opts.wallTimeMs !== undefined && now() - startAt >= opts.wallTimeMs) {
        status = 'wall-time';
        break;
      }
      if (opts.maxSteps !== undefined && steps >= opts.maxSteps) {
        status = 'max-steps';
        break;
      }

      // 投影（两级压缩只作用于投影；append-only 事件流不动）
      const events = await readEvents(store, input.sessionId);
      const defs = opts.tools.list();
      const chatTools = defs.map(toChatTool);
      const projectOpts: ProjectOptions = {
        ...(opts.windowTokens !== undefined ? { windowTokens: opts.windowTokens } : {}),
        ...(chatTools.length > 0 ? { tools: chatTools } : {}),
        ...(opts.summarizer !== undefined ? { summarizer: opts.summarizer } : {}),
        ...(opts.systemPrompt !== undefined ? { systemPrefix: opts.systemPrompt } : {}),
        // 附件 ref 展开（ADR-0015）：服务端注入 resolver（读文件 dataURL 组装）；
        // 未注入 → ref 事件保守降级（绝不发坏 URL）
        ...(opts.attachResolver !== undefined ? { resolveImageRef: opts.attachResolver } : {}),
      };
      const projection = await project(events, projectOpts);
      if (
        projection.stats.summary.status === 'summarized' &&
        projection.stats.summary.content !== undefined
      ) {
        // 摘要本身写入事件流（CONTEXT「对话摘要」/ ADR-0005；resume 重放以此为边界）
        await store.append(input.sessionId, {
          kind: 'event',
          payload: {
            type: 'compaction',
            data: { summary: projection.stats.summary.content },
          },
        });
        // 压缩防抖（CONTEXT「压缩防抖」/ §8 A-1）：摘要后投影估算仍超窗口 = 压不收敛，计数 +1；
        // 超过容忍上限（MAX_COMPACTION_ATTEMPTS = 2，CONTEXT 裁决 8）即熔断退出——
        // 不能无限烧钱；收敛（回到预算内）清零计数。窗口未知时摘要不会触发，本分支同样不计数。
        const stillOverWindow =
          opts.windowTokens !== undefined &&
          projection.stats.summary.tokensAfter !== undefined &&
          projection.stats.summary.tokensAfter > opts.windowTokens;
        debouncer.record(now(), stillOverWindow);
        if (debouncer.shouldTrip()) {
          status = 'compaction-debounce';
          errorMessage =
            `compaction did not converge: the projected context stayed over the window budget ` +
            `(${opts.windowTokens} tokens) after ${debouncer.attempts} consecutive summaries; ` +
            `automatic summarization stopped (compaction debounce)`;
          break;
        }
      } else {
        // 一次干净轮次（本投影未触发摘要）：压缩链条已断，防抖重新起算（debounce.ts
        // 「一次干净轮次…即重新起算」/ ADR-0006「一次干净的 Step 清零连续计数」）。
        debouncer.reset();
      }

      // 闸门 A：请求前估价（§5.3：est_prompt×prompt 价 + maxTokens×completion 价 + 累计 > 预算 ⇒ 不发请求；
      // 单价表缺口期按「估算 token × 占位价」近似，ADR-0003）。promptEst 经 L0 校正系数（ADR-0012）。
      const rawEst = projection.stats.estimatedTokens;
      contextEstimate = rawEst; // C 档：透传 usage 的 contextEstimateTokens（最后一次投影）
      const promptEst = calibrator.apply(rawEst);
      if (
        ledger.costUsd +
          promptEst * pricing.promptPerToken +
          maxTokens * pricing.completionPerToken >
        costLimit
      ) {
        status = 'cost-guard';
        break;
      }

      steps += 1;
      const turn = await runTurn({
        store,
        sessionId: input.sessionId,
        llm: opts.llm,
        signal,
        model: opts.model,
        messages: projection.messages,
        chatTools,
        defs,
        tools: opts.tools,
        approver: opts.approver,
        toolTimeoutMs,
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.maxInputTokens !== undefined ? { maxInputTokens: opts.maxInputTokens } : {}),
        ...(opts.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
        budget: { pricing, costLimit, promptEst, ledger },
        calibrator,
        rawEst,
        methodology:
          opts.methodology !== undefined && methodologyRoutedId !== null
            ? { gate: opts.methodology, routedId: methodologyRoutedId }
            : null,
        review: opts.review,
      });
      if (turn.type === 'status') {
        status = turn.status;
        errorMessage = turn.errorMessage;
        break;
      }
      if (turn.type === 'continue') {
        // 评审哨兵续跑（R2-S2）：注入 system-user 后本轮继续——无终止面变化
        continue;
      }
      if (turn.type === 'natural-end') {
        status = 'completed';
        break;
      }
      // 工具轮：熔断与回注成对（ADR-0006）；一次干净的 Step 清零连续计数
      formatErrors = turn.malformed ? formatErrors + 1 : 0;
      if (formatErrors >= maxFormatErrors) {
        status = 'circuit-break';
        break;
      }
    }
  } catch (err) {
    // harness 异常：把所有路径收敛为 fatal finalize（每条路径都落盘现场）
    if (status === null) status = 'fatal';
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // run_result 载荷与 RunResult 单源构造（同一对象派生，避免两份漂移）
  const result: RunResult = {
    status: status === null ? 'fatal' : status,
    usage: {
      promptTokens: ledger.promptTokens,
      completionTokens: ledger.completionTokens,
      totalTokens: ledger.promptTokens + ledger.completionTokens,
      costUsd: ledger.costUsd,
      estimated: ledger.estimated,
      ...(contextEstimate !== undefined ? { contextEstimateTokens: contextEstimate } : {}),
    },
    steps,
    durationMs: now() - startAt,
  };
  if (errorMessage !== undefined) result.error = errorMessage;
  await store.append(input.sessionId, {
    kind: 'event',
    payload: {
      type: 'run_result',
      data: {
        status: result.status,
        steps: result.steps,
        durationMs: result.durationMs,
        ...result.usage,
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    },
  });
  return result;
}

// ---------------------------------------------------------------------------
// 单轮（查询 + 装配 + 执行 + 回注）
// ---------------------------------------------------------------------------

interface TurnDeps {
  store: SessionStore;
  sessionId: string;
  llm: LlmAdapter;
  signal: AbortSignal | undefined;
  model: string;
  messages: ChatMessage[];
  chatTools: ChatTool[];
  defs: readonly ToolDef[];
  tools: ToolRegistry;
  approver: Approver | undefined;
  toolTimeoutMs: number;
  /** 请求侧 maxTokens（opts 提供时随请求发送；缺省不发、闸门 A 用模型默认预留估价）。 */
  maxTokens?: number;
  /** 请求侧输入上限（A 档；仅白名单供应商发送——见 preset.maxInputTokensField）。 */
  maxInputTokens?: number;
  /** 思考强度（C 档：RunOptions.reasoning 逐字进 ChatRequest.reasoningEffort）。 */
  reasoning?: ReasoningEffort;
  /** 成本护栏状态归并（Data Clumps：pricing/costLimit/promptEst/ledger 成组流转）。 */
  budget: BudgetState;
  /** L0 事后校准器（真实 usage 到位后 update；ADR-0012）。 */
  calibrator: TokenEstimateCalibrator;
  /** 本轮请求前投影估算（未校正原始值，供 L0 校准与真值对比）。 */
  rawEst: number;
  /** 方法论前置门状态（null = 未注入/未命中/路由故障 → 从不拦截）。 */
  methodology: { gate: MethodologyGate; routedId: string } | null;
  /** 评审哨兵门（undefined = 关闭——从不注入；E2E/测试/老配置默认路径）。 */
  review: ReviewGate | undefined;
}

/** 成本护栏计价状态（ADR-0003：计价表 + 上限 + 本轮请求前估算 + 累计账本）。 */
interface BudgetState {
  pricing: Pricing;
  costLimit: number;
  /** 本轮请求前投影估算（已乘 L0 校正系数）。 */
  promptEst: number;
  ledger: Ledger;
}

interface Ledger {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  estimated: boolean;
}

type TurnOutcome =
  | { type: 'natural-end' }
  /** 评审哨兵注入后继续下一轮（无终止面变化；不计熔断）。 */
  | { type: 'continue' }
  | { type: 'tool-round'; malformed: boolean }
  | { type: 'status'; status: RunStatus; errorMessage?: string };

type CallOutcome =
  | { kind: 'result'; call: ToolCall; result: ToolResult }
  | { kind: 'denied'; call: ToolCall; reason: string; errorType?: ApprovalDeniedErrorType }
  | { kind: 'denied-no-reason'; call: ToolCall }
  | { kind: 'malformed'; call: ToolCall; result: ToolResult }
  | { kind: 'blocked'; call: ToolCall; result: ToolResult }
  | { kind: 'skipped'; call: ToolCall };

async function runTurn(deps: TurnDeps): Promise<TurnOutcome> {
  const request: ChatRequest = {
    model: deps.model,
    messages: deps.messages,
    ...(deps.chatTools.length > 0 ? { tools: deps.chatTools } : {}),
    ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
    // A 档：请求侧输入上限（adapter 按 preset.maxInputTokensField 白名单取舍）
    ...(deps.maxInputTokens !== undefined ? { maxInputTokens: deps.maxInputTokens } : {}),
    // C 档思考强度：设置侧 reasoning（缺省 medium）逐字透传——adapter 按家映射
    ...(deps.reasoning !== undefined ? { reasoningEffort: deps.reasoning } : {}),
  };

  let content = '';
  let reasoning = '';
  let snapshot: StreamSnapshot | null = null;
  let streamError: LlmError | null = null;
  let costAborted = false;
  const completionEst = { tokens: 0 };

  streamLoop: for await (const ev of deps.llm.chat(request, deps.signal)) {
    if (ev.type === 'end' || ev.type === 'error') {
      snapshot = ev.snapshot;
      streamError = ev.type === 'error' ? ev.error : null;
      break streamLoop;
    }
    if (ev.type === 'text') content += ev.text;
    else if (ev.type === 'reasoning') reasoning += ev.text;
    completionEst.tokens = estimateTextTokens(content + reasoning, TEXT_TOKENS_PER_ASCII_PROSE);
    // 闸门 B：流式中值超阈值 → 中止（尽力保留已生成部分）。
    // 用户中止由 LlmAdapter 观测 signal（传输层 abort → error{kind:'abort'} 事件）
    // 与轮/工具边界检查实现；流内不轮询信号，避免事件次序竞态。
    if (
      deps.budget.ledger.costUsd +
        deps.budget.promptEst * deps.budget.pricing.promptPerToken +
        completionEst.tokens * deps.budget.pricing.completionPerToken >
      deps.budget.costLimit
    ) {
      costAborted = true;
      break streamLoop;
    }
  }

  const calls: ToolCall[] = (snapshot?.toolCalls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
  }));

  if (costAborted) {
    // 流式中超预算：尽力保留已生成部分（text/reasoning），usage 记账（估算标记）。
    // 中止先于 end/error：snapshot 必为 null，calls 恒空（无任何 toolCalls 可保留）。
    await persistPartial(deps, content, reasoning, calls);
    addEstimateUsage(deps.budget, completionEst.tokens);
    return { type: 'status', status: 'cost-guard' };
  }

  if (streamError !== null) {
    // 传输层已由 LlmAdapter（boot）重试到底；此处只收尾：已生成部分落盘 + 记账
    await persistPartial(deps, content, reasoning, calls);
    if (snapshot !== null && snapshot.usage !== null) {
      addRealUsage(deps, snapshot.usage);
    } else {
      addEstimateUsage(deps.budget, completionEst.tokens);
    }
    return {
      type: 'status',
      status: streamError.kind === 'abort' ? 'user-interrupted' : 'fatal',
      ...(streamError.kind === 'abort' ? {} : { errorMessage: streamError.message }),
    };
  }

  // 正常终态：assistant 事件先落盘（写序 T1）→ 之后才允许执行任何工具
  if (reasoning !== '') {
    await deps.store.append(deps.sessionId, { kind: 'reasoning', payload: { content: reasoning } });
  }
  await deps.store.append(deps.sessionId, {
    kind: 'assistant',
    payload: { content, toolCalls: calls },
  });

  // 闸门 C：响应后真实 usage 校准累计（usage 缺失 → 本地估算兜底）+ L0 校正系数滑动更新
  if (snapshot !== null && snapshot.usage !== null) {
    addRealUsage(deps, snapshot.usage);
  } else {
    addEstimateUsage(deps.budget, completionEst.tokens);
  }

  // 自然结束：本轮不再发起任何工具调用即告结束（CONTEXT「自然结束」）。
  // 评审哨兵（R2-S2）：实质变更 + 无独立审查 + 未注入过 → 注入 system-user 请求一次
  //（替代该轮收尾），模型续跑；已注入过而无审查 → 直接放行（护栏即一次）。
  if (calls.length === 0) {
    const reinjected = await maybeInjectReviewSentinel(deps);
    return reinjected ? { type: 'continue' } : { type: 'natural-end' };
  }

  // 方法论前置门（R2-S1）：命中未加载且调用组不含 use_skill(<id>) → 整组拦截。
  // 替代执行一次：以 methodology-first 指导性结果回注（普通回注管线，不计熔断）——
  // 工具未真执行；模型下一轮先 use_skill（成功即 markLoaded），之后不再拦。
  const methodologyBlocked = methodologyBlockedIds(deps, calls);

  // 工具轮：并行 + 独立超时 + 审批 + 畸形回注（全部并行评估，按发出顺序落盘）。
  // 中断也 settle 全部：已完成的判型照常落盘、未及执行的以 interrupted 占位落盘——
  // 最小缺口只剩「真正没跑完的」，不再留下待 resume 修补的悬空调用。
  const outcomes = await Promise.all(
    calls.map((call) =>
      methodologyBlocked !== null && methodologyBlocked.has(call.id)
        ? {
            kind: 'blocked' as const,
            call,
            result: methodologyFirstResult(deps.methodology!.routedId),
          }
        : evaluateCall(call, deps),
    ),
  );
  let malformed = false;
  let deniedNoReason = false;
  for (const outcome of outcomes) {
    // 单次判型：appendToolOutcome 返回判型标记（case 收敛一处），落盘与计数同源
    const mark = await appendToolOutcome(deps, outcome);
    if (mark === 'malformed') malformed = true;
    else if (mark === 'denied-no-reason') deniedNoReason = true;
  }
  if (deps.signal?.aborted === true) {
    return { type: 'status', status: 'user-interrupted' };
  }
  if (deniedNoReason) {
    // 无备注拒绝 = 用户拒绝停止本轮（CONTEXT「危险操作审批」「无备注则结束本轮」）：
    // 与「拒绝停止本轮」语义自洽 → user-interrupted；其它已判型调用结果保留，
    // 被拒调用无执行结果 → 悬空，resume 以 interrupted 占位修补。
    return { type: 'status', status: 'user-interrupted' };
  }
  return { type: 'tool-round', malformed };
}

/**
 * 评审哨兵判定 + 注入（一次）：
 * - 门未注入/查询组合不满足 → false（不干预自然结束）；
 * - 满足：先 markFlagged（per-session 一次性；置位失败 → 不注入——防无限回注），
 *   再落盘 kind:'user'（payload.content = 哨兵文本；meta.system=true -> 系统样式），
 *   true = 本轮替代收尾（下一轮模型对该消息 respond，正常计入成本/步数，不计熔断）。
 * - 故障收敛：任何查询/置位抛错按「门故障 = 关闭」处理（护栏故障不放大为行为故障）。
 */
async function maybeInjectReviewSentinel(deps: TurnDeps): Promise<boolean> {
  const gate = deps.review;
  if (gate === undefined) return false;
  let substantive = false;
  let hasReview = false;
  let flagged = false;
  try {
    substantive = gate.hasSubstantiveWork(deps.sessionId);
    hasReview = gate.hasReviewRun(deps.sessionId);
    flagged = gate.isFlagged(deps.sessionId);
  } catch {
    return false;
  }
  if (!substantive || hasReview || flagged) return false;
  try {
    gate.markFlagged(deps.sessionId);
  } catch {
    return false;
  }
  await deps.store.append(deps.sessionId, {
    kind: 'user',
    payload: { content: REVIEW_SENTINEL_USER_CONTENT },
    meta: { system: true },
  });
  return true;
}

/** 用户中断查询（每次现场读 signal，避免 await 后的残留窄化）。 */
function interruptedMaybe(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * 方法论路由解析（一次 run 一次）：未注入 / route 抛错 / 未命中 → null（门关闭）。
 * 「已加载」由调用时的 isLoaded 现场判定（同一 run 内多轮也能放开——加载后立即放行）。
 */
async function resolveMethodologyRoute(
  methodology: MethodologyGate | undefined,
  task: string,
): Promise<string | null> {
  if (methodology === undefined) return null;
  try {
    return await methodology.route(task);
  } catch {
    return null; // 路由故障按关闭处理（本轮不拦截；下次 run 天然重试）
  }
}

/**
 * 拦截判定（每次工具组现算）：未注入/未命中/已加载/组内含 use_skill(<id>) → null；
 * 否则返回整组 callId（全部替代执行——方法未加载前不做任何动作）。
 * isLoaded 抛错同样按不拦截收敛（护栏故障不放大为行为故障）。
 */
function methodologyBlockedIds(deps: TurnDeps, calls: readonly ToolCall[]): Set<string> | null {
  if (deps.methodology === null) return null;
  const { gate, routedId } = deps.methodology;
  let loaded: boolean;
  try {
    loaded = gate.isLoaded(deps.sessionId, routedId);
  } catch {
    return null;
  }
  if (loaded) return null;
  if (calls.some((call) => skillIdOf(call) === routedId)) return null; // 组内含加载调用 → 放行
  return new Set(calls.map((call) => call.id));
}

/**
 * 取 use_skill 调用的技能 id（非 use_skill / 参数畸形 → null；畸形走主循环正常回注）。
 * 参数兼容（S2 小修）：{skill} 或 {id}；两者都给以 id 优先——与 skill.ts 运行时同口径
 * （方法论前置门的「组内含 use_skill(<id>) 放行」与加载观察器都经本函数）。
 */
function skillIdOf(call: ToolCall): string | null {
  if (call.name !== 'use_skill') return null;
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const id = record.id;
      if (typeof id === 'string' && id !== '') return id;
      const raw = record.skill;
      return typeof raw === 'string' ? raw : null;
    }
  } catch {
    // fallthrough → 畸形视角（null）
  }
  return null;
}

/** 校验先于审批：畸形调用绝不触达工具与审批（E9/E10/E11 → 回注 + 计数）。 */
async function evaluateCall(call: ToolCall, deps: TurnDeps): Promise<CallOutcome> {
  if (interruptedMaybe(deps.signal)) return { kind: 'skipped', call };
  const def = deps.defs.find((d) => d.name === call.name);
  if (def === undefined) {
    return {
      kind: 'malformed',
      call,
      result: unknownToolResult(
        call.name,
        deps.defs.map((d) => d.name),
      ),
    };
  }
  const validation = validateToolCall(def, call.arguments);
  if (!validation.ok) {
    const result =
      validation.type === 'invalid_tool_arguments'
        ? invalidToolArgumentsResult(validation.message, validation.arguments_head ?? '')
        : invalidArgumentsResult(def.name, validation.issues ?? []);
    return { kind: 'malformed', call, result };
  }
  if (deps.approver !== undefined) {
    const decision = await deps.approver(call);
    if (decision !== 'allow' && decision.deny === true) {
      if (decision.reason !== undefined && decision.reason !== '') {
        // 带理由拒绝：拒因回注（缺省 user-denied；permission-denied 兼容保留——权限预设
        // deny 直拒路径已由服务端删除，不再产生，注入式 approver 显式使用仍按普通回注），
        // 模型继续（ADR-0013 / 权限预设语义定案）
        return {
          kind: 'denied',
          call,
          reason: decision.reason,
          ...(decision.errorType !== undefined ? { errorType: decision.errorType } : {}),
        };
      }
      // 无备注拒绝：用户拒绝停止本轮（CONTEXT「危险操作审批」）
      return { kind: 'denied-no-reason', call };
    }
  }
  // 执行前最后一道中断检查：校验/审批完成但尚未触达工具层即断 → 该调用如实判 skipped
  if (interruptedMaybe(deps.signal)) return { kind: 'skipped', call };
  // 执行：失败/超时也是普通结果（绝不因工具失败崩进程）
  let result: ToolResult;
  try {
    result = await withTimeout(deps.tools.execute(call), deps.toolTimeoutMs);
  } catch (err) {
    result =
      err instanceof ToolTimeoutError
        ? {
            ok: false,
            content: '',
            error: { type: 'timeout', message: `tool timed out after ${deps.toolTimeoutMs}ms` },
          }
        : {
            ok: false,
            content: '',
            error: {
              type: 'tool-error',
              message: err instanceof Error ? err.message : String(err),
            },
          };
  }
  // 方法论观察器：use_skill 执行成功（ok:true）→ markLoaded（加载后该技能不再被拦截）
  if (result.ok && deps.methodology !== null) {
    const skillId = skillIdOf(call);
    if (skillId !== null) {
      try {
        deps.methodology.gate.markLoaded(deps.sessionId, skillId);
      } catch {
        // mark 故障不改变工具结果（观察器尽力而为）
      }
    }
  }
  return { kind: 'result', call, result };
}

/**
 * 判型标记（Case 收敛一处：计数与落盘同源）。
 * 'malformed' → 熔断计数；'denied-no-reason' → user-interrupted 终止；其余无标记。
 */
type OutcomeMark = 'malformed' | 'denied-no-reason';

/** 单次判型 + 落盘（中断也 settle：已完成照常落盘，skipped 以 interrupted 占位落盘）。 */
async function appendToolOutcome(
  deps: TurnDeps,
  outcome: CallOutcome,
): Promise<OutcomeMark | undefined> {
  switch (outcome.kind) {
    case 'denied-no-reason':
      await deps.store.append(deps.sessionId, {
        kind: 'event',
        payload: {
          type: 'approval_denied',
          data: { toolCallId: outcome.call.id, name: outcome.call.name },
        },
      });
      return 'denied-no-reason';
    case 'denied': {
      // 拒绝类型（用户弹窗拒绝 / 权限策略自动拒绝）；缺省 user-denied（ADR-0013 旧语义）
      const errorType = outcome.errorType ?? 'user-denied';
      await deps.store.append(deps.sessionId, {
        kind: 'event',
        payload: {
          type: 'approval_denied',
          data: {
            toolCallId: outcome.call.id,
            name: outcome.call.name,
            reason: outcome.reason,
            ...(errorType === 'permission-denied' ? { errorType } : {}),
          },
        },
      });
      await deps.store.append(deps.sessionId, {
        kind: 'tool',
        payload: {
          toolCallId: outcome.call.id,
          content: JSON.stringify({
            ok: false,
            error: { type: errorType, message: outcome.reason },
          }),
        },
      });
      return undefined;
    }
    case 'malformed':
      await deps.store.append(deps.sessionId, {
        kind: 'tool',
        payload: { toolCallId: outcome.call.id, content: outcome.result.content },
      });
      return 'malformed';
    case 'blocked':
      // 方法论拦截：content 已为合法 JSON 载荷（methodology-first 指导性结果）——
      // 按普通工具结果落盘；不算畸形（不计熔断计数）、不触达工具层与审批。
      await deps.store.append(deps.sessionId, {
        kind: 'tool',
        payload: { toolCallId: outcome.call.id, content: outcome.result.content },
      });
      return undefined;
    case 'result':
      await deps.store.append(deps.sessionId, {
        kind: 'tool',
        payload: {
          toolCallId: outcome.call.id,
          content: outcome.result.ok ? outcome.result.content : errorResultContent(outcome.result),
        },
      });
      return undefined;
    case 'skipped':
      // 中断时未及执行的调用：如实落 interrupted 占位（CONTEXT「悬空工具调用」；
      // 副作用未知，由模型自行决定是否重新探测）。
      await deps.store.append(deps.sessionId, {
        kind: 'tool',
        payload: {
          toolCallId: outcome.call.id,
          content: INTERRUPTED_RESULT_CONTENT,
          interrupted: true,
        },
      });
      return undefined;
  }
}

/** 尽力保留已生成的部分（中止/传输失败路径）：推理 → assistant（只保留已拿到的）。 */
async function persistPartial(
  deps: TurnDeps,
  content: string,
  reasoning: string,
  calls: ToolCall[],
): Promise<void> {
  if (content === '' && calls.length === 0 && reasoning === '') return;
  if (reasoning !== '') {
    await deps.store.append(deps.sessionId, { kind: 'reasoning', payload: { content: reasoning } });
  }
  await deps.store.append(deps.sessionId, {
    kind: 'assistant',
    payload: { content, toolCalls: calls },
  });
}

// ---------------------------------------------------------------------------
// 记账与杂项
// ---------------------------------------------------------------------------

function addRealUsage(deps: TurnDeps, usage: LlmUsage): void {
  const { ledger } = deps.budget;
  const { pricing } = deps.budget;
  const cached = Math.min(usage.cachedTokens ?? 0, usage.promptTokens);
  const uncached = usage.promptTokens - cached;
  const cost =
    uncached * pricing.promptPerToken +
    cached * (pricing.cachedPerToken ?? pricing.promptPerToken) +
    usage.completionTokens * pricing.completionPerToken;
  ledger.promptTokens += usage.promptTokens;
  ledger.completionTokens += usage.completionTokens;
  ledger.costUsd += cost;
  // L0 事后校准（ADR-0012）：校正系数按 真实 prompt/估算 比值滑动，下一轮闸门 A 起用
  deps.calibrator.update(deps.rawEst, usage.promptTokens);
}

function addEstimateUsage(budget: BudgetState, completionTokens: number): void {
  const { ledger } = budget;
  const { pricing } = budget;
  ledger.promptTokens += budget.promptEst;
  ledger.completionTokens += completionTokens;
  ledger.costUsd +=
    budget.promptEst * pricing.promptPerToken + completionTokens * pricing.completionPerToken;
  ledger.estimated = true;
}

function toChatTool(def: ToolDef): ChatTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}

async function readEvents(store: SessionStore, sessionId: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const ev of store.events(sessionId)) events.push(ev);
  return events;
}

class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`tool timed out after ${ms}ms`);
    this.name = 'ToolTimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
