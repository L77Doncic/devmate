/**
 * # context/prune：第 1 层——组包期工具结果裁剪（Anthropic clear_tool_uses 语义的投影侧等价，§2.3）
 *
 * 规则（官方参数表 + §2.3 三条设计准则）：
 * - 较旧的工具结果按时间序替换为显式占位符，保留最近 KEEP_GROUPS（3）组 tool_use/result；
 * - 只替换 tool 结果消息，assistant 的调用请求（tool_use 输入）原样保留（clearToolInputs=false 语义）；
 * - 占位符必须明示「这里曾有内容被移除」，绝不能装作不存在（CONTEXT「占位符」）；
 * - 副作用型工具（excludeTools = write/edit/apply_patch/git_commit，§8 A-2）的结果永不裁剪；
 * - 孤儿结果（调用 ID 无对应请求）保守保留（不裁剪、不计豁免）；
 * - 触顶时还需满足「至少清出 ≥ clearAtLeastTokens（默认 8000）才裁剪」（§2.4 第 1 层 / §8 A-2），
 *   不足则本层跳过（status = 'insufficient-clearance'），由上层决定是否走更强一层。
 * 纯函数：输入消息项不被改写，占位符只出现在输出副本中。
 */
import type { ChatMessage } from '../../shared/llm-types.js';
import { KEEP_GROUPS, TEXT_TOKENS_PER_ASCII_CODE } from './constants.js';
import { estimateTextTokens } from './estimator.js';

/** 投影处理中间项：消息 + 裁剪所需的配对元数据（group 序号 / 调用名 / 可裁剪性）。 */
export interface MessageItem {
  message: ChatMessage;
  /** 所属工具请求组序号（assistant 带 toolCalls 的批次，从 1 起）；非工具消息或孤儿结果为 undefined。 */
  groupIndex?: number;
  /** 对应调用的工具名（配对成功才有；孤儿为 undefined，保守不裁剪）。 */
  toolName?: string;
  /** 是否裁剪候选（配对成功且不在 excludeTools 名单内）。 */
  prunable: boolean;
}

export interface PruneResult {
  items: MessageItem[];
  /** 被替换为占位符的结果条数。 */
  prunedCount: number;
  /** 命中副作用豁免名单的结果条数。 */
  excludedCount: number;
  /** 保留的最近组数（= KEEP_GROUPS 常数）。 */
  groupsKept: number;
  /** 本次被替换结果的工具名（去重，按流序；供清理警告引用）。 */
  prunedToolNames: string[];
}

/** 占位符：明示「曾有内容被移除」，附工具名与被移除的字符数（模型方能判断是否需重跑）。 */
export function placeholderForToolResult(toolName: string, removedChars: number): string {
  return (
    `[Tool result of "${toolName}" removed: ${removedChars} characters. ` +
    'This content was removed to fit the context window; if it is still needed, re-run the tool.]'
  );
}

/** 裁剪前一次性清理警告（§2.3 准则 2「即将清理 X 工具历史结果，如仍需请自行落盘」）。 */
export function pruneWarningFor(toolNames: readonly string[], count: number): string {
  const names = [...new Set(toolNames)].join(', ');
  return (
    `Older tool results (${count} result${count === 1 ? '' : 's'} for ${names}) are about to be ` +
    'removed from the context below and replaced with placeholders. If you still need any of them, ' +
    'save them to disk before continuing.'
  );
}

/**
 * 裁剪目标计划（共享判定：门槛估算 / 执行裁剪 / 跳过状态上报使用同一目标集，防漂移）。
 */
export interface PrunePlan {
  /** 将被替换为占位符的结果项（按流序）。 */
  targets: MessageItem[];
  /** 命中副作用豁免的结果条数。 */
  excludedCount: number;
}

/** 计算裁剪目标计划（keep 判定 + 豁免统计 + 目标集合）。 */
export function buildPrunePlan(
  items: readonly MessageItem[],
  excludeTools: readonly string[],
): PrunePlan {
  const excluded = new Set(excludeTools);
  let excludedCount = 0;
  // 带可裁剪结果的组序号（按流序），用于确定保留的最近 KEEP_GROUPS 组
  const prunableGroups: number[] = [];
  for (const item of items) {
    if (
      item.prunable &&
      item.groupIndex !== undefined &&
      !prunableGroups.includes(item.groupIndex)
    ) {
      prunableGroups.push(item.groupIndex);
    }
    if (item.toolName !== undefined && excluded.has(item.toolName)) {
      excludedCount += 1;
    }
  }
  const keepOrdinals = new Set(prunableGroups.slice(-KEEP_GROUPS));
  const targets: MessageItem[] = [];
  for (const item of items) {
    if (
      item.prunable &&
      item.groupIndex !== undefined &&
      !keepOrdinals.has(item.groupIndex) &&
      item.message.role === 'tool'
    ) {
      targets.push(item);
    }
  }
  return { targets, excludedCount };
}

/** 按目标集合（计划中的「被裁者」）估算合计将被清出量（token，K=3 代码口径）。 */
export function estimatePruneClearance(plan: PrunePlan): number {
  let cleared = 0;
  for (const target of plan.targets) {
    if (target.message.role === 'tool') {
      cleared += estimateTextTokens(target.message.content, TEXT_TOKENS_PER_ASCII_CODE);
    }
  }
  return cleared;
}

/**
 * 执行裁剪：保留最近 KEEP_GROUPS 个「含可裁剪结果」的组，更早组中的可裁剪结果替换为占位符。
 * 豁免（excludeTools）与孤儿结果原样保留，不占 keep 名额。
 * plan 可传入（与门槛估算共享同一判定，免二次计算）；缺省时内部计算。
 */
export function pruneToolResults(
  items: readonly MessageItem[],
  excludeTools: readonly string[],
  plan?: PrunePlan,
): PruneResult {
  const usedPlan: PrunePlan = plan ?? buildPrunePlan(items, excludeTools);

  let prunedCount = 0;
  const prunedToolNames: string[] = [];
  const targetSet = new Set(usedPlan.targets);
  const out: MessageItem[] = [];
  for (const item of items) {
    if (targetSet.has(item) && item.message.role === 'tool') {
      // 可达性不变量：targets 仅由 prunable（= toolName 已配对）项构成；若被破坏为死代码
      if (item.toolName === undefined) {
        throw new Error('prune: unreachable — pruned item without toolName (plan/execution drift)');
      }
      if (!prunedToolNames.includes(item.toolName)) {
        prunedToolNames.push(item.toolName);
      }
      const placeholder = placeholderForToolResult(item.toolName, item.message.content.length);
      out.push({
        ...item,
        prunable: false, // 已替换，不可再次触发
        message: { role: 'tool', content: placeholder, toolCallId: item.message.toolCallId },
      });
      prunedCount += 1;
    } else {
      out.push(item);
    }
  }

  return {
    items: out,
    prunedCount,
    excludedCount: usedPlan.excludedCount,
    groupsKept: KEEP_GROUPS,
    prunedToolNames,
  };
}
