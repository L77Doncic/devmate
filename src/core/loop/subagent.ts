/**
 * # loop/subagent：子代理池（Workflow 功能点②；池级接缝）
 *
 * 每个子代理 = 一次独立 chat 调用（无工具、无会话文件——纯内存消息数组 + 流终止）：
 * [system: 固定角色, user: prompt] → 流式读取 text → 报告截断 4000 字符回注
 * （截断复用 context/truncate 的生成期截断面板——头 2000 + 尾 2000 + elide 标记 +
 * 收窄建议；禁止手写头截断）。
 * 任务形状：只带 prompt（title 已移除——投机泛化：池只用 prompt，无展示/追踪消费者）。
 * 池级职责（CTO 定型）：
 * - 开关：enabled=false → spawn 立即 {ok:false, error:'subagents-disabled'}（不排队不调用）；
 * - 信号量 FIFO：超过 maxParallel 排队；活跃完成释放；队列上限（缺省 64，超出 'queue-full'）；
 * - 成本护栏：每次 spawn/出队前预判「累计已花费 + 最近一次实际成本」是否超出
 *   池级上限（缺省 $1.00，超出 'cost-guard'）——自相似负载假设：下一次成本以最近一次
 *   实际成本为基准（无历史则 0），保守拦下会让预算穿底的后续请求（请求前预判，
 *   与主循环闸门 A「先估后发」同构；真实值以 usage 计）；
 * - abort/异常：一律收敛为 {ok:false, error}，spawn 绝不 throw（信号量保证释放）；
 * - dispose：拒绝新任务 + 取消队列（'disposed'）；在跑任务完成后池关闭。
 * 传输层重试归 LlmAdapter（boot 已接线）：本层只见 end/error 终态事件。
 */
import type { ChatMessage, ChatRequest, LlmUsage, StreamSnapshot } from '../../shared/llm-types.js';
import { LlmError } from '../../shared/llm-types.js';
import { TEXT_TOKENS_PER_ASCII_PROSE } from '../context/constants.js';
import { estimateTextTokens, estimateTokens } from '../context/estimator.js';
// 生成期截断面板单一来源（头尾保留 + elide 标记 + 收窄建议）；子代理报告只传阈值
import { truncateToolOutput } from '../context/truncate.js';
import type { WorkflowConfig } from '../../shared/workflow.js';
import type { LlmAdapter, Pricing } from './types.js';
import { DEFAULT_PRICING } from './types.js';

// ---------------------------------------------------------------------------
// 契约（CTO 定型；subagent 不用投影器：纯推理短会话，直接用 messages+llm）
// ---------------------------------------------------------------------------

/** 工作流配置（单一来源在 shared/workflow；池读取源；缺省 true/2 由调用方配置）。 */
export type { WorkflowConfig } from '../../shared/workflow.js';

export interface SubagentTask {
  /** 独立子任务指令（模型侧提示词；池只消费它）。 */
  prompt: string;
}

/** 一次子代理的归一结果：失败也是普通值（error 为机器码/传输层消息），绝不 throw。 */
export interface SubagentResult {
  ok: boolean;
  /** 子代理 report（text 流拼接；≥4000 字符经截断面板重写：头尾各 2000 + elide 标记 + 收窄建议）。 */
  report: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** 任一分量由本地估算兜底（usage 缺失/错误流）时为 true。 */
  estimated: boolean;
  durationMs: number;
  /** 'subagents-disabled' | 'cost-guard' | 'queue-full' | 'disposed' | 传输层消息。 */
  error?: string;
}

export type SubagentPoolErrorCode = 'subagents-disabled' | 'cost-guard' | 'queue-full' | 'disposed';

export interface SubagentStats {
  enabled: boolean;
  maxParallel: number;
  active: number;
  queued: number;
  completed: number;
  rejected: number;
}

export interface SubagentPool {
  spawn(task: SubagentTask): Promise<SubagentResult>;
  stats(): SubagentStats;
  dispose(): void;
}

/**
 * 池依赖：CTO 契约 {llm, config} 的超集——ChatRequest.model 为必填（CTO 契约未列，
 * 由接入方提供）；其余为可测试/可配置面（pricing/costLimitUsd/maxQueue/now 均有默认）。
 */
export interface SubagentPoolDeps {
  llm: LlmAdapter;
  config: () => WorkflowConfig;
  /** 请求侧模型名（ChatRequest 必填维度）。 */
  model: string;
  /** 成本计价表；缺省 DEFAULT_PRICING（占位价）。 */
  pricing?: Pricing;
  /** 池级总成本上限（USD）；缺省 DEFAULT_SUBAGENT_COST_LIMIT_USD。 */
  costLimitUsd?: number;
  /** 队列上限；缺省 DEFAULT_SUBAGENT_QUEUE_LIMIT。 */
  maxQueue?: number;
  /** 时钟注入（耗时测试）。 */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// 默认常量（单一来源）
// ---------------------------------------------------------------------------

/** 池级总成本上限默认（USD/池生命周期）。 */
export const DEFAULT_SUBAGENT_COST_LIMIT_USD = 1.0;
/** 队列上限默认（超出 spawn 拒绝 'queue-full'）。 */
export const DEFAULT_SUBAGENT_QUEUE_LIMIT = 64;
/** 报告截断阈值（字符；传入 context/truncate 的截断面板——头尾各 2000）。 */
export const SUBAGENT_REPORT_LIMIT_CHARS = 4000;
/** 子代理固定 system prompt（结构化中文报告；输入过长需精简）。 */
export const SUBAGENT_SYSTEM_PROMPT =
  '你是 DevMate 派出的子代理。独立完成任务，返回结构化中文报告（结论/关键发现/依据）。输入过长需精简。';

// ---------------------------------------------------------------------------
// 池实现
// ---------------------------------------------------------------------------

interface QueueEntry {
  task: SubagentTask;
  resolve: (result: SubagentResult) => void;
}

export function createSubagentPool(deps: SubagentPoolDeps): SubagentPool {
  const pricing = deps.pricing ?? DEFAULT_PRICING;
  const costLimitUsd = deps.costLimitUsd ?? DEFAULT_SUBAGENT_COST_LIMIT_USD;
  const maxQueue = deps.maxQueue ?? DEFAULT_SUBAGENT_QUEUE_LIMIT;
  const now = deps.now ?? (() => Date.now());

  let disposed = false;
  let active = 0;
  let completed = 0;
  let rejected = 0;
  /** 累计已结算成本（真实 usage 或本地估算兜底）。 */
  let ledgerCostUsd = 0;
  /** 最近一次实际成本：下一次请求前预判的基准（无历史 = 0）。 */
  let lastCostUsd = 0;
  const queue: QueueEntry[] = [];

  /** 未执行即告终的失败结果（拒绝路径共用；不记成本、不计 completed）。 */
  function rejectResult(error: SubagentPoolErrorCode): SubagentResult {
    rejected += 1;
    return {
      ok: false,
      report: '',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      estimated: false,
      durationMs: 0,
      error,
    };
  }

  /** 成本护栏预测：累计 + 最近一次实际 > 上限 ⇒ 拒绝（请求前预判；含纯累计超限特判）。 */
  function costGuardFires(): boolean {
    return ledgerCostUsd + lastCostUsd > costLimitUsd;
  }

  /** 信号量泵：队列非空且有槽位时出队执行（FIFO；出队仍过一次护栏预判）。 */
  function pump(): void {
    if (disposed) return;
    const capacity = Math.max(1, deps.config().maxParallel);
    while (queue.length > 0 && active < capacity) {
      const entry = queue.shift() as QueueEntry; // 队首（length 已判非空）
      if (costGuardFires()) {
        entry.resolve(rejectResult('cost-guard'));
        continue;
      }
      active += 1;
      void execute(entry);
    }
  }

  function spawn(task: SubagentTask): Promise<SubagentResult> {
    // 拒绝优先级：disposed（终态）→ disabled → 成本护栏 → 队列满
    if (disposed) return Promise.resolve(rejectResult('disposed'));
    if (!deps.config().subagentsEnabled) return Promise.resolve(rejectResult('subagents-disabled'));
    if (costGuardFires()) return Promise.resolve(rejectResult('cost-guard'));
    if (queue.length >= maxQueue) return Promise.resolve(rejectResult('queue-full'));
    return new Promise<SubagentResult>((resolve) => {
      queue.push({ task, resolve });
      pump();
    });
  }

  /** 单次子代理执行：一次独立 chat 调用（无工具、无会话文件）。 */
  async function execute(entry: QueueEntry): Promise<void> {
    const startedAt = now();
    const messages: ChatMessage[] = [
      { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
      { role: 'user', content: entry.task.prompt },
    ];
    const request: ChatRequest = { model: deps.model, messages };

    let content = '';
    let snapshot: StreamSnapshot | null = null;
    let error: LlmError | null = null;
    try {
      for await (const ev of deps.llm.chat(request)) {
        if (ev.type === 'text') content += ev.text;
        else if (ev.type === 'reasoning') {
          // 推理内容不进报告（与主循环「reasoning 不进请求」口径一致）
        } else {
          // end / error：终态（toolCalls 非本池契约——无工具请求，忽略）
          snapshot = ev.snapshot;
          if (ev.type === 'error') error = ev.error;
          break;
        }
      }
    } catch (err) {
      // chat() 同步/异步抛错（协议异常）：收敛为 error 结果，绝不外抛
      error =
        err instanceof LlmError
          ? err
          : new LlmError({
              kind: 'transport',
              status: 0,
              retryable: false,
              message: err instanceof Error ? err.message : String(err),
            });
    }

    // 记账：真实 usage 优先；缺失/错误流 → 本地估算兜底（estimated=true）。
    // 失败也记成本（与主循环「被计费的失败轮照记」语义一致；ADR-0003 防绕过）。
    const real = snapshot?.usage ?? null;
    const payment =
      real !== null
        ? paymentFromUsage(real, pricing)
        : estimatedPayment(messages, content, pricing);
    ledgerCostUsd += payment.costUsd;
    lastCostUsd = payment.costUsd;

    active -= 1;
    completed += 1;
    const result: SubagentResult = {
      ok: error === null,
      report: truncateReport(content),
      promptTokens: payment.promptTokens,
      completionTokens: payment.completionTokens,
      totalTokens: payment.promptTokens + payment.completionTokens,
      costUsd: payment.costUsd,
      estimated: real === null,
      durationMs: now() - startedAt,
    };
    if (error !== null) result.error = error.message;
    entry.resolve(result);
    pump();
  }

  return {
    spawn,
    stats(): SubagentStats {
      const cfg = deps.config();
      return {
        enabled: cfg.subagentsEnabled,
        maxParallel: cfg.maxParallel,
        active,
        queued: queue.length,
        completed,
        rejected,
      };
    },
    dispose(): void {
      disposed = true;
      const pending = queue.splice(0);
      for (const entry of pending) entry.resolve(rejectResult('disposed'));
    },
  };
}

// ---------------------------------------------------------------------------
// 记账与截断辅组
// ---------------------------------------------------------------------------

interface Payment {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** 真实 usage 计价（缓存命中 token 按缓存价；口径与主循环 addRealUsage 一致）。 */
function paymentFromUsage(usage: LlmUsage, pricing: Pricing): Payment {
  const cached = Math.min(usage.cachedTokens ?? 0, usage.promptTokens);
  const uncached = usage.promptTokens - cached;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costUsd:
      uncached * pricing.promptPerToken +
      cached * (pricing.cachedPerToken ?? pricing.promptPerToken) +
      usage.completionTokens * pricing.completionPerToken,
  };
}

/** 本地估算兜底：prompt 按 estimator 口径，completion 按散文口径（与主循环同源）。 */
function estimatedPayment(
  messages: readonly ChatMessage[],
  content: string,
  pricing: Pricing,
): Payment {
  const promptTokens = estimateTokens(messages).tokens;
  const completionTokens = estimateTextTokens(content, TEXT_TOKENS_PER_ASCII_PROSE);
  return {
    promptTokens,
    completionTokens,
    costUsd: promptTokens * pricing.promptPerToken + completionTokens * pricing.completionPerToken,
  };
}

/**
 * 报告截断：复用 context/truncate 的生成期截断面板（头半额 + 尾半额 + elide 标记 +
 * 收窄建议；阈值 = SUBAGENT_REPORT_LIMIT_CHARS）——禁止手写头截断。
 */
export function truncateReport(report: string): string {
  return truncateToolOutput(report, SUBAGENT_REPORT_LIMIT_CHARS);
}
