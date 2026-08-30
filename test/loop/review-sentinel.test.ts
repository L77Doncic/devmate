/**
 * # test/loop/review-sentinel：收尾评审哨兵（R2-S2）主循环行为
 *
 * 门契约（loop 层，RunOptions.review）：
 * - 自然收尾点（模型回复无 toolCalls）：若 gate 存在且 实质变更（hasSubstantiveWork）且
 *   无独立审查（hasReviewRun）且未注入过（isFlagged=false）→ 注入一条 kind:'user'、
 *   meta.system=true 的哨兵消息（内容 = REVIEW_SENTINEL_USER_CONTENT），置位 flag 后
 *   续跑一轮（随后模型对该消息 respond，正常计入 steps/成本，不计熔断）；
 * - 已 flag 后模型仍无审查直接自然结束 → 放行（护栏即一次——同会话不重复注入）；
 * - 非实质 / 已有审查 / review=undefined（关闭）→ 无干预（零注入，直接自然结束）；
 * - gate 抛错 → 按关闭收敛（不干预自然结束）。
 * hasSubstantiveWork / hasReviewRun 为纯函数（RunStats 形状；本测试直测）。
 * 预期值独立：FakeLlm 脚本 + 会话事件序列手算。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_REVIEW_COST_USD,
  hasReviewRun,
  hasSubstantiveWork,
  REVIEW_SENTINEL_USER_CONTENT,
  reviewBudgetSkipNote,
  run,
} from '../../src/core/loop/index.js';
import type { ReviewGate, RunOptions, RunStats } from '../../src/core/loop/index.js';
import { collectEvents, echoTool, kindsOf, readyStore } from './support.js';
import { FakeLlm } from './support.js';
import { defineRegistry } from '../../src/core/loop/index.js';

/** 会话级假门（loop 测试面）：判定可编程；flag 记录调用并随注入自动置位。 */
function gateOf(options: {
  substantive?: boolean;
  review?: boolean;
  flagged?: boolean;
}): ReviewGate & { markCalls: string[] } {
  const markCalls: string[] = [];
  let flagged = options.flagged ?? false;
  return {
    markCalls,
    hasSubstantiveWork: () => options.substantive ?? false,
    hasReviewRun: () => options.review ?? false,
    isFlagged: () => flagged,
    markFlagged(sessionId) {
      markCalls.push(sessionId);
      flagged = true;
    },
  };
}

function baseOpts(overrides: Partial<RunOptions>): RunOptions {
  return {
    store: undefined as never,
    tools: undefined as never,
    llm: undefined as never,
    model: 'test-model',
    ...overrides,
  };
}

/** 哨兵事件提取：kind=user 且 meta.system=true（无 → undefined）。 */
function sentinelEvent(events: Awaited<ReturnType<typeof collectEvents>>) {
  return events.find((ev) => ev.kind === 'user' && ev.meta?.system === true) as
    { kind: 'user'; payload: { content: string }; meta?: Record<string, unknown> } | undefined;
}

describe('loop：收尾评审哨兵（RunOptions.review）', () => {
  it('r1) 实质变更 + 无审查 + 未注入 → 注入 system-user 且模型续跑（steps=2，completed，不计熔断）', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true });
    const llm = new FakeLlm([{ content: '改完了' }, { content: '先审查再收尾' }]);

    const result = await run(
      { sessionId: 's1', task: '修一个 bug' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2); // 注入后多续一轮
    expect(gate.markCalls).toEqual(['s1']);
    expect(llm.requests).toHaveLength(2);

    const events = await collectEvents(store, 's1');
    expect(kindsOf(events)).toEqual([
      'user',
      'assistant(0tc)',
      'user',
      'assistant(0tc)',
      'event(run_result)',
    ]);
    const sentinel = sentinelEvent(events);
    expect(sentinel).toBeDefined();
    expect(sentinel!.payload.content).toBe(REVIEW_SENTINEL_USER_CONTENT);
    expect(sentinel!.meta).toEqual({ system: true });
    // 哨兵文案契约：含 skill:"code-review" 注入指引（B-1 skill 注入）；「审查」要求保留
    expect(sentinel!.payload.content).toContain('skill:"code-review"');
    expect(sentinel!.payload.content).toContain('spawn_subagent');
    expect(sentinel!.payload.content).toContain('审查');
    // 续跑的一轮请求：哨兵消息已是最后一条 user 消息（模型对其 respond）
    const second = llm.requests[1]!;
    const last = second.messages[second.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(String(last.content)).toBe(REVIEW_SENTINEL_USER_CONTENT);
  });

  it('r2) 已注入过（flag）后仍无审查 → 放行：直接自然结束，不重复注入', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true, flagged: true });
    const llm = new FakeLlm([{ content: '收尾' }]);

    const result = await run(
      { sessionId: 's1', task: '改一个' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    expect(llm.requests).toHaveLength(1);
    expect(gate.markCalls).toEqual([]);
    const events = await collectEvents(store, 's1');
    expect(kindsOf(events)).toEqual(['user', 'assistant(0tc)', 'event(run_result)']);
    expect(sentinelEvent(events)).toBeUndefined();
  });

  it('r3) 非实质变更（hasSubstantiveWork=false）→ 不触发', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: false });
    const llm = new FakeLlm([{ content: '无事发生' }]);
    const result = await run(
      { sessionId: 's1', task: '看文档' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );
    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    const events = await collectEvents(store, 's1');
    expect(sentinelEvent(events)).toBeUndefined();
  });

  it('r4) 已有独立审查（hasReviewRun=true）→ 不触发', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true, review: true });
    const llm = new FakeLlm([{ content: '审查完了收尾' }]);
    const result = await run(
      { sessionId: 's1', task: '做一个功能' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );
    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    const events = await collectEvents(store, 's1');
    expect(sentinelEvent(events)).toBeUndefined();
  });

  it('r5) review 未注入（Closed）→ 从不干预（E2E/测试/老配置默认路径）', async () => {
    const store = readyStore();
    const llm = new FakeLlm([{ content: '完成' }]);
    const result = await run(
      { sessionId: 's1', task: '改一个文件' },
      baseOpts({ store, tools: defineRegistry([echoTool()], { sessionId: 's1' }), llm }),
    );
    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    const events = await collectEvents(store, 's1');
    expect(sentinelEvent(events)).toBeUndefined();
  });

  it('r6) 注入后模型仍无审查直接自然结束 → 放行（护栏即一次；同会话跨 run 亦不重复注入）', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true });
    const llm = new FakeLlm([{ content: 'a' }, { content: 'b' }]);
    const result = await run(
      { sessionId: 's1', task: '改一个文件' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );
    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);
    const events = await collectEvents(store, 's1');
    // 恰好一次注入（r2 的 flag 已置位 → 第二次自然结束直接放行）
    const sentinels = events.filter((ev) => ev.kind === 'user' && ev.meta?.system === true);
    expect(sentinels).toHaveLength(1);

    // 同会话第二次 run（resume）：flag 保持 → 不重复注入
    const gate2 = gateOf({ substantive: true, flagged: true });
    const llm2 = new FakeLlm([{ content: 'c' }]);
    const result2 = await run(
      { sessionId: 's1', task: 'resume' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm: llm2,
        review: gate2,
      }),
    );
    expect(result2.status).toBe('completed');
    const sentinelsAfter = (await collectEvents(store, 's1')).filter(
      (ev) => ev.kind === 'user' && ev.meta?.system === true,
    );
    expect(sentinelsAfter).toHaveLength(1);
  });

  it('r7) gate 查询抛错 → 按关闭收敛（不干预自然结束；故障不放大为行为故障）', async () => {
    const store = readyStore();
    const throwing: ReviewGate = {
      hasSubstantiveWork() {
        throw new Error('gate failure');
      },
      hasReviewRun: () => false,
      isFlagged: () => false,
      markFlagged: () => undefined,
    };
    const llm = new FakeLlm([{ content: '结束' }]);
    const result = await run(
      { sessionId: 's1', task: '改一个文件' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: throwing,
      }),
    );
    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    const events = await collectEvents(store, 's1');
    expect(sentinelEvent(events)).toBeUndefined();
  });
});

describe('loop：评审哨兵语义纯函数（RunStats）', () => {
  it('s1) hasSubstantiveWork：write/edit/shell/mcp/spawn 任一执行过 → true；读类/未知工具 → false；计数 0 → false', () => {
    expect(hasSubstantiveWork(undefined)).toBe(false);
    const none: RunStats = { counts: {}, subagentPrompts: [] };
    expect(hasSubstantiveWork(none)).toBe(false);
    const reads: RunStats = {
      counts: { read_file: 3, grep: 1, use_skill: 2 },
      subagentPrompts: [],
    };
    expect(hasSubstantiveWork(reads)).toBe(false);
    for (const name of [
      'write_file',
      'edit_file',
      'run_command',
      'spawn_subagent',
      'mcp_search_web_search',
      'mcp_fetch_url',
    ]) {
      expect(hasSubstantiveWork({ counts: { [name]: 1 }, subagentPrompts: [] }), name).toBe(true);
    }
    // 被执行过的工具即使结果失败（ok:false）也计「执行过」
    expect(
      hasSubstantiveWork({ counts: { run_command: 3, read_file: 9 }, subagentPrompts: [] }),
    ).toBe(true);
    expect(hasSubstantiveWork({ counts: { write_file: 0 }, subagentPrompts: [] })).toBe(false);
  });

  it('s2) hasReviewRun：任一成功 spawn 的 prompt 含 审查/review（大小写不敏感）→ true；否则 false', () => {
    expect(hasReviewRun(undefined)).toBe(false);
    const plain: RunStats = { counts: {}, subagentPrompts: ['写代码', '调研数据源'] };
    expect(hasReviewRun(plain)).toBe(false);
    expect(hasReviewRun({ counts: {}, subagentPrompts: ['请审查这份 diff'] })).toBe(true);
    expect(hasReviewRun({ counts: {}, subagentPrompts: ['Please review the changes'] })).toBe(true);
    expect(hasReviewRun({ counts: {}, subagentPrompts: ['REVIEW'] })).toBe(true);
    expect(hasReviewRun({ counts: {}, subagentPrompts: ['先查资料', '请审查代码'] })).toBe(true);
  });
});

describe('loop：评审哨兵子代理可用性（P2-10 静默 —— subagents-disabled 时不指示模型尝试）', () => {
  it('r7) subagentAvailable=false（子代理未启用）→ 哨兵静默跳过：不注入、一步自然结束（不再双失败）', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true });
    (gate as ReviewGate & { subagentAvailable?: () => boolean }).subagentAvailable = () => false;
    const llm = new FakeLlm([{ content: '改完了，收尾' }]);

    const result = await run(
      { sessionId: 's1', task: '修一个 bug' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1); // 无续跑：未被打扰
    expect(llm.requests).toHaveLength(1);
    expect(gate.markCalls).toEqual([]); // 未置位（用户随后启用子代理仍可再试）
    const events = await collectEvents(store, 's1');
    expect(kindsOf(events)).toEqual(['user', 'assistant(0tc)', 'event(run_result)']);
    expect(sentinelEvent(events)).toBeUndefined();
  });

  it('r8) gate 的 subagentAvailable 抛错 → 按门故障收敛：不干预自然结束', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true });
    (gate as ReviewGate & { subagentAvailable?: () => boolean }).subagentAvailable = () => {
      throw new Error('pool missing');
    };
    const llm = new FakeLlm([{ content: '结束' }]);

    const result = await run(
      { sessionId: 's1', task: '改一个' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    expect(sentinelEvent(await collectEvents(store, 's1'))).toBeUndefined();
  });
});

describe('loop：评审预算门（P2-8 —— maxReviewCostUsd 缺省 0.02）', () => {
  it('r9) 估算超预算（0.03 > 缺省 0.02）→ 跳过哨兵注入 + 一行系统注记「本轮未派独立评审（评审预算 $0.02 内：超支风险）」；一步自然结束；护栏不置位', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true });
    (gate as ReviewGate & { reviewCostEstimate?: () => number }).reviewCostEstimate = () => 0.03;
    const llm = new FakeLlm([{ content: '改完了，收尾' }]);

    const result = await run(
      { sessionId: 's1', task: '修一个 bug' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1); // 无续跑：注记不驱动模型再回合（纯提示行）
    expect(llm.requests).toHaveLength(1);
    expect(gate.markCalls).toEqual([]); // 护栏未置位：预算内容许后仍可再试
    const events = await collectEvents(store, 's1');
    expect(kindsOf(events)).toEqual(['user', 'assistant(0tc)', 'user', 'event(run_result)']);
    const systemNotes = events.filter((ev) => ev.kind === 'user' && ev.meta?.system === true);
    expect(systemNotes).toHaveLength(1);
    expect((systemNotes[0]!.payload as { content: string }).content).toBe(
      '本轮未派独立评审（评审预算 $0.02 内：超支风险）',
    );
    // 注记 ≠ 哨兵（不是让模型去审查的提示）
    expect((systemNotes[0]!.payload as { content: string }).content).not.toBe(
      REVIEW_SENTINEL_USER_CONTENT,
    );
  });

  it('r10) 估算在预算内（0.01 ≤ 0.02）→ 正常注入哨兵（与经济门共存：预算够就照常审查）', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true });
    (gate as ReviewGate & { reviewCostEstimate?: () => number }).reviewCostEstimate = () => 0.01;
    const llm = new FakeLlm([{ content: '改完了' }, { content: '先审查再收尾' }]);

    const result = await run(
      { sessionId: 's1', task: '修一个 bug' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);
    expect(gate.markCalls).toEqual(['s1']);
    const events = await collectEvents(store, 's1');
    const sentinel = sentinelEvent(events);
    expect(sentinel).toBeDefined();
    expect(sentinel!.payload.content).toBe(REVIEW_SENTINEL_USER_CONTENT);
  });

  it('r11) 自定义预算（maxReviewCostUsd=0.1）+ 估算 0.5 → 跳过；注记带预算值 $0.10', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true });
    const g = gate as ReviewGate & { reviewCostEstimate?: () => number; maxReviewCostUsd?: number };
    g.reviewCostEstimate = () => 0.5;
    g.maxReviewCostUsd = 0.1;
    const llm = new FakeLlm([{ content: '收尾' }]);

    const result = await run(
      { sessionId: 's1', task: '做一个功能' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    const note = (await collectEvents(store, 's1')).find(
      (ev) => ev.kind === 'user' && ev.meta?.system === true,
    );
    expect((note!.payload as { content: string }).content).toBe(reviewBudgetSkipNote(0.1));
  });

  it('r12) 估算抛错 → 按无预算信息处理：哨兵照常注入（门故障不放大为行为故障）', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true });
    (gate as ReviewGate & { reviewCostEstimate?: () => number }).reviewCostEstimate = () => {
      throw new Error('estimate broken');
    };
    const llm = new FakeLlm([{ content: '搞定' }, { content: '审查' }]);

    const result = await run(
      { sessionId: 's1', task: '改一下' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);
    expect(sentinelEvent(await collectEvents(store, 's1'))?.payload.content).toBe(
      REVIEW_SENTINEL_USER_CONTENT,
    );
  });

  it('r13) 估算值 = 0（池无先例：self-similar 锚缺省）→ 预算内：正常注入', async () => {
    const store = readyStore();
    const gate = gateOf({ substantive: true });
    (gate as ReviewGate & { reviewCostEstimate?: () => number }).reviewCostEstimate = () => 0;
    const llm = new FakeLlm([{ content: '收尾' }, { content: '审查再收尾' }]);

    const result = await run(
      { sessionId: 's1', task: '改一下' },
      baseOpts({
        store,
        tools: defineRegistry([echoTool()], { sessionId: 's1' }),
        llm,
        review: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);
  });

  it('r14) 常量契约：DEFAULT_MAX_REVIEW_COST_USD = 0.02（缺省预算口径）', () => {
    expect(DEFAULT_MAX_REVIEW_COST_USD).toBe(0.02);
    expect(reviewBudgetSkipNote(DEFAULT_MAX_REVIEW_COST_USD)).toBe(
      '本轮未派独立评审（评审预算 $0.02 内：超支风险）',
    );
  });
});
