/**
 * # tools/subagent：spawn_subagent 工具（独立子任务隔离上下文；Workflow 功能点②）
 *
 * - 池级语义全部在注入的 SubagentPool（loop/subagent：开关/信号量 FIFO/队列上限/
 *   池级成本护栏预判/abort 与异常收敛/绝不 throw）——本工具只做参数解析与结果归一，
 *   **绝不复制池规则**：工作流配置变化（POST /api/workflow）由池 config 闭包每次
 *   spawn 现读，本工具无缓存。
 * - 结果契约：成功 → {ok:true, content: 报告}（池已在 SUBAGENT_REPORT_LIMIT_CHARS
 *   截断，内容不再加工）；失败 → {ok:false, error:{type,message}}（content 为合法
 *   JSON，errorContentJson 单一来源）——type 归一：'subagents-disabled' | 'cost-guard'
 *   | 'queue-full' 透传池错误码；'disposed' 与传输层消息一律收敛 'subagent-error'
 *   （disposed 只出现于服务关闭窗口，对模型而言「当前不可用」已足够）。
 * - 错误 message 的数字披露（模块级明确记录的放宽）：'subagent-error' 的 message
 *   **允许携带池侧差错详情原文**（如传输层消息或含数字的上游报错——数字进 message
 *   能显著提升排障与自愈，裁定记录于本注释）。**成本/队列数字仍不入**：判型
 *   'cost-guard' / 'queue-full' 的 message 刻意不含任何数字（预算额度/队列深度
 *   属服务端 stats 与事件通道的职责——统计只做展示，按「报告状态」而非「报告预算」
 *   设计），成本/队列信息绝不随工具内容泄漏给模型。
 * - 参数形状：{prompt} + 可选 {skill}（title 已移除——投机泛化：池只用 prompt，无消费者）。
 *   skill（B-1 借鉴①）：技能 id，给出时该技能全文经 skillContent 解析器机械注入子代理
 *   system（池侧 capSkill ≤6000 字符）；未知/未接线/解析器故障 → 零注入普通模式。
 * - 防线：pool.spawn 契约不 throw（池内收敛），本层仍兜底 try/catch → 'subagent-error'
 *   （防御池实现违规：错误仍是普通消息，绝不外抛）。
 */
import type { ToolCall } from '../../shared/session-types.js';
import { errorContentJson } from '../loop/tools.js';
import type { JsonSchema, Tool, ToolResult } from '../loop/types.js';
import { SKILL_INJECTION_LIMIT_CHARS } from '../loop/subagent.js';
import type { SubagentPool, SubagentResult, SubagentTask } from '../loop/subagent.js';

/** 本工具的错误判型（4 类；池侧其余错误收敛到 subagent-error）。 */
export type SubagentToolErrorCode =
  'subagents-disabled' | 'cost-guard' | 'queue-full' | 'subagent-error';

/** spawn_subagent 工具构造依赖（池单例注入；池级开关/护栏/队列都在池内）。 */
export interface SubagentToolOptions {
  pool: SubagentPool;
  /**
   * 技能全文解析器（id → SKILL.md 全文；B-1 借鉴①接线）。缺省/返回 null/
   * 抛错 → 跳过注入（子代理普通模式，绝不硬失败）——未知 id / 索引未回填 /
   * 索引故障按「零注入」收敛（与失败是普通消息同口径）。
   */
  skillContent?: (id: string) => Promise<string | null>;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'The independent subtask the sub-agent should complete. The sub-agent has no tools ' +
        'and no session memory (a single read-only step); keep the input self-contained.',
    },
    skill: {
      type: 'string',
      description:
        'Optional skill id (see the available skills section of the system prompt) whose ' +
        `text is injected into the sub-agent system prompt (bounded at ${SKILL_INJECTION_LIMIT_CHARS} ` +
        'code points; the bound follows the module constant) — the sub-agent then acts under ' +
        'the same methodology as the main agent, e.g. skill:"code-review" for the final ' +
        'independent review. Unknown/unavailable/disabled ids are skipped silently ' +
        '(the sub-agent runs in plain mode).',
    },
  },
  required: ['prompt'],
};

/** 构造 spawn_subagent 工具（参数 {prompt}；结果 = 子代理报告或归一错误）。 */
export function createSubagentTool(options: SubagentToolOptions): Tool {
  return {
    name: 'spawn_subagent',
    description:
      'Spawn a sub-agent that handles an independent subtask in an isolated context. ' +
      'The sub-agent has no tools and no memory: give it a self-contained prompt. ' +
      'The report (bounded at 4000 chars) is returned as the tool result.',
    parameters: SCHEMA,
    execute: (call) => executeSubagent(call, options),
  };
}

async function executeSubagent(call: ToolCall, options: SubagentToolOptions): Promise<ToolResult> {
  // 主循环已做 schema 校验（loop/tools.ts）；此处仍是防线（与 fs.ts parseArgs 同口径）。
  let prompt = '';
  let skillId = '';
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const rawPrompt = (parsed as Record<string, unknown>).prompt;
      if (typeof rawPrompt === 'string') prompt = rawPrompt;
      const rawSkill = (parsed as Record<string, unknown>).skill;
      if (typeof rawSkill === 'string') skillId = rawSkill;
    }
  } catch {
    // fallthrough → 报错
  }
  if (prompt.trim() === '') {
    return failResult(
      'subagent-error',
      'spawn_subagent: "prompt" must be a non-empty string',
      'Provide the full subtask as a non-empty string and retry, or finish without a sub-agent.',
    );
  }

  // 任务形状 {prompt} + 可选 {skillId, skillContent}（B-1 借鉴① skill 注入）：
  // 池级信号量/FIFO/护栏不消费 skill，其余键一律宽进。
  // skill 给出 → 经 skillContent 解析器取全文；null/未接线/抛错 → 跳过注入（不硬失败）。
  const task: SubagentTask = { prompt, ...(skillId !== '' ? { skillId } : {}) };
  if (skillId !== '' && options.skillContent !== undefined) {
    let content: string | null = null;
    try {
      content = await options.skillContent(skillId);
    } catch {
      content = null; // 索引故障按零注入收敛（失败是普通消息；不放大为工具失败）
    }
    if (content !== null && content !== '') task.skillContent = content;
  }

  let result: SubagentResult;
  try {
    result = await options.pool.spawn(task);
  } catch (err) {
    // 池实现违规（契约不 throw）也收敛为普通失败——绝不外抛
    return failResult(
      'subagent-error',
      `spawn_subagent: sub-agent pool failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (result.ok) return { ok: true, content: result.report };
  const code = normalizePoolError(result.error);
  return failResult(code, subagentErrorMessage(code, result.error));
}

/** 池错误码 → 本工具判型（4 类；disposed/传输层 → subagent-error）。 */
function normalizePoolError(poolError: string | undefined): SubagentToolErrorCode {
  switch (poolError) {
    case 'subagents-disabled':
    case 'cost-guard':
    case 'queue-full':
      return poolError;
    default:
      return 'subagent-error';
  }
}

/**
 * message 只带判型与「下一步」；成本/队列数字**有意排除**（'cost-guard'/'queue-full'
 * 的 message 不含任何数字——预算/队列属 stats 展示职责，见模块注释）。
 * 明确记录的放宽：'subagent-error' 分支可直接引用上游差错详情（含数字）——
 * 传输层/池侧报错原文进 message 提升排障与自愈，属模块级裁定（见文件头注释）。
 */
function subagentErrorMessage(code: SubagentToolErrorCode, detail: string | undefined): string {
  switch (code) {
    case 'subagents-disabled':
      return (
        'sub-agents are disabled in the workflow settings; enable them first ' +
        'or finish without a sub-agent'
      );
    case 'cost-guard':
      return (
        'sub-agent pool cost guard tripped: the spawn was rejected before sending ' +
        '(pool-level budget; retry after the pool frees up or finish without a sub-agent)'
      );
    case 'queue-full':
      return (
        'sub-agent pool queue is full: the spawn was rejected (wait for capacity ' +
        'or finish without a sub-agent)'
      );
    case 'subagent-error':
      return detail !== undefined && detail !== ''
        ? `sub-agent failed: ${detail}`
        : 'sub-agent failed (unknown error; retry or finish without a sub-agent)';
  }
}

/** 失败结果构造：content 恒为合法 JSON（errorContentJson 单一来源；错误是普通消息）。 */
function failResult(type: SubagentToolErrorCode, message: string, humanHint?: string): ToolResult {
  return {
    ok: false,
    content: errorContentJson({
      type,
      message,
      ...(humanHint !== undefined ? { human_hint: humanHint } : {}),
    }),
    error: { type, message },
  };
}
