/**
 * # test/tools/subagent：spawn_subagent 工具
 *
 * 契约（src/core/tools/subagent.ts）：参数 {prompt}（title 已移除——池只用 prompt）
 * 池级语义（开关/护栏/队列/信号量）在注入的 SubagentPool，本工具只做参数解析 + 结果归一：
 * 成功 → {ok:true, content: 报告}（池已 4k 截断）；失败 → 4 类判型：
 * 'subagents-disabled'|'cost-guard'|'queue-full' 透传，其余（disposed/传输层）→
 * 'subagent-error'；成本/队列数字不进工具内容（message 无数字——subagent-error 例外
 * 见其单测：上游差错详情（数字）允许透传，属模块注释明确记录的放宽）。
 * 会话绑定（子代理工具化 2026-09-01）：执行上下文的 sessionId 逐字透传进
 * SubagentTask.sessionId（池照它为子代理装配只读工作区工具）；ctx 缺省/空 → 不带键。
 */
import { describe, expect, it } from 'vitest';
import { createSubagentTool } from '../../src/core/tools/subagent.js';
import type {
  SubagentPool,
  SubagentResult,
  SubagentStats,
  SubagentTask,
} from '../../src/core/loop/subagent.js';

/** 最简假池：按脚本出结果（记录 spawn 请求；绝不触网、绝不 throw 的池形状）。 */
function fakePool(script: SubagentResult): { pool: SubagentPool; spawned: SubagentTask[] } {
  const spawned: SubagentTask[] = [];
  const stats: SubagentStats = {
    enabled: true,
    maxParallel: 2,
    active: 0,
    queued: 0,
    completed: 0,
    rejected: 0,
  };
  return {
    spawned,
    pool: {
      spawn(task: SubagentTask): Promise<SubagentResult> {
        spawned.push(task);
        return Promise.resolve(script);
      },
      stats: () => stats,
      nextCostEstimateUsd: () => 0,
      dispose: () => {},
    },
  };
}

function failedScript(error: string | undefined): SubagentResult {
  return {
    ok: false,
    report: '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    estimated: false,
    durationMs: 0,
    ...(error !== undefined ? { error } : {}),
  };
}

const OK_REPORT = '总体结论：任务完成。\n关键发现：A。\n依据：测试全绿。';

async function run(pool: SubagentPool, argumentsRaw: string) {
  const tool = createSubagentTool({ pool });
  return tool.execute(
    { id: 'c1', name: 'spawn_subagent', arguments: argumentsRaw },
    { sessionId: 's1' },
  );
}

describe('tools/subagent：spawn_subagent', () => {
  it('成功：{ok:true, content = 池报告}（已截断，内容原样不加工）；池收到 {prompt, sessionId(执行上下文透传)}', async () => {
    const { pool, spawned } = fakePool({
      ok: true,
      report: OK_REPORT,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.00003,
      estimated: false,
      durationMs: 3,
    });
    const r = await run(pool, JSON.stringify({ prompt: 'ls 并总结' }));
    expect(r).toEqual({ ok: true, content: OK_REPORT });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({ prompt: 'ls 并总结', sessionId: 's1' });
  });

  it('title 参数已移除：即使传入也被忽略，池只收到 {prompt, sessionId};schema 无 title 属性', async () => {
    const { pool, spawned } = fakePool({
      ok: true,
      report: 'ok',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      estimated: false,
      durationMs: 0,
    });
    const r = await run(pool, JSON.stringify({ prompt: 'p', title: 'legacy' }));
    expect(r.ok).toBe(true);
    expect(spawned[0]).toEqual({ prompt: 'p', sessionId: 's1' });
    // schema 契约：只声明 prompt（无 title——投机泛化移除）
    const tool = createSubagentTool({ pool });
    expect(tool.parameters?.properties?.prompt).toMatchObject({ type: 'string' });
    expect(tool.parameters?.properties?.title).toBeUndefined();
    expect(tool.parameters?.required).toEqual(['prompt']);
  });

  it('对端判型归一：disabled / cost-guard / queue-full 原样透传（message 无数字）', async () => {
    const cases: Array<[string, string]> = [
      ['subagents-disabled', 'disabled in the workflow settings'],
      ['cost-guard', 'cost guard tripped'],
      ['queue-full', 'queue is full'],
    ];
    for (const [poolError, messageFragment] of cases) {
      const { pool } = fakePool(failedScript(poolError));
      const r = await run(pool, JSON.stringify({ prompt: 'p' }));
      expect(r).toMatchObject({ ok: false, error: { type: poolError } });
      expect(r.error?.message).toContain(messageFragment);
      // 成本/队列数字不进内容
      expect(/[0-9]/.test(r.error?.message ?? '')).toBe(false);
      const content = JSON.parse(r.content) as {
        ok: boolean;
        error: { type: string; message: string };
      };
      expect(content.ok).toBe(false);
      expect(content.error.type).toBe(poolError);
    }
  });

  it('disposed 与传输层消息 → subagent-error（消息带池侧详情；content 恒合法 JSON）', async () => {
    for (const detail of ['disposed', 'upstream 503: rate limited']) {
      const { pool } = fakePool(failedScript(detail));
      const r = await run(pool, JSON.stringify({ prompt: 'p' }));
      expect(r).toMatchObject({ ok: false, error: { type: 'subagent-error' } });
      // P2-9 文案净化：message 从「sub-agent failed: <detail>」改为用户友好中文「子代理调用失败：<detail>」
      // （数字/详情仍随 message 披露的放宽保留（模块头注）；disposed 属「未知细节」分支）
      expect(r.error?.message).toContain(detail === 'disposed' ? '子代理调用失败' : detail);
      expect(JSON.parse(r.content).ok).toBe(false);
    }
  });

  it('防线：prompt 缺失/空 → 普通失败（不触达池），非 JSON → 不 throw', async () => {
    const { pool, spawned } = fakePool(failedScript(undefined));
    for (const bad of [JSON.stringify({}), JSON.stringify({ prompt: '   ' }), 'not-json{{{']) {
      const r = await run(pool, bad);
      expect(r.ok).toBe(false);
      expect(r.error?.type).toBe('subagent-error');
      expect(JSON.parse(r.content).ok).toBe(false);
    }
    expect(spawned).toHaveLength(0);
  });

  it('池 throw（实现违规）也收敛为普通失败：subagent-error', async () => {
    const throwing: SubagentPool = {
      spawn: () => {
        throw new Error('pool exploded');
      },
      stats: () => ({
        enabled: true,
        maxParallel: 2,
        active: 0,
        queued: 0,
        completed: 0,
        rejected: 0,
      }),
      dispose: () => {},
      nextCostEstimateUsd: () => 0,
    };
    const r = await run(throwing, JSON.stringify({ prompt: 'p' }));
    expect(r).toMatchObject({ ok: false });
    expect(r.error?.type).toBe('subagent-error');
    expect(r.error?.message).toContain('pool exploded');
  });

  it('schema：新增可选 skill（字符串；required 仍只 prompt）；skill 给出 → 池任务带 skillId+skillContent', async () => {
    const { pool, spawned } = fakePool({
      ok: true,
      report: 'ok',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      estimated: false,
      durationMs: 0,
    });
    const tool = createSubagentTool({
      pool,
      skillContent: async (id) => (id === 'code-review' ? '审查双轴方法论' : null),
    });

    expect(tool.parameters?.properties?.skill).toMatchObject({ type: 'string' });
    expect(tool.parameters?.required).toEqual(['prompt']);

    const r = await tool.execute(
      {
        id: 'c1',
        name: 'spawn_subagent',
        arguments: JSON.stringify({ prompt: 'p', skill: 'code-review' }),
      },
      { sessionId: 's1' },
    );
    expect(r.ok).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({
      prompt: 'p',
      skillId: 'code-review',
      skillContent: '审查双轴方法论',
      sessionId: 's1',
    });
  });

  it('skill 未知 / 索引未回填（解析器 null）/ 解析器抛错 → 跳过注入不硬失败；无 skill 参数 → task 只 {prompt}', async () => {
    const ok = {
      ok: true,
      report: 'ok',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      estimated: false,
      durationMs: 0,
    };
    const { pool: poolA, spawned: a } = fakePool(ok);
    const toolA = createSubagentTool({ pool: poolA, skillContent: async () => null });
    await toolA.execute(
      {
        id: 'c1',
        name: 'spawn_subagent',
        arguments: JSON.stringify({ prompt: 'p', skill: 'ghost' }),
      },
      { sessionId: 's1' },
    );
    expect(a[0]).toEqual({ prompt: 'p', skillId: 'ghost', sessionId: 's1' }); // skillId 记录，内容跳过

    const { pool: poolB, spawned: b } = fakePool(ok);
    const toolB = createSubagentTool({ pool: poolB }); // 未接线解析器
    await toolB.execute(
      {
        id: 'c2',
        name: 'spawn_subagent',
        arguments: JSON.stringify({ prompt: 'p', skill: 'code-review' }),
      },
      { sessionId: 's1' },
    );
    expect(b[0]).toEqual({ prompt: 'p', skillId: 'code-review', sessionId: 's1' });
    expect(b[0]?.skillContent).toBeUndefined();

    const { pool: poolC, spawned: c } = fakePool(ok);
    const toolC = createSubagentTool({
      pool: poolC,
      skillContent: async () => {
        throw new Error('index fault');
      },
    });
    const rc = await toolC.execute(
      {
        id: 'c3',
        name: 'spawn_subagent',
        arguments: JSON.stringify({ prompt: 'p', skill: 'code-review' }),
      },
      { sessionId: 's1' },
    );
    // 解析器异常不硬失败：任务仍 spawn（内容跳过），结果普通成功
    expect(rc.ok).toBe(true);
    expect(c[0]).toEqual({ prompt: 'p', skillId: 'code-review', sessionId: 's1' });
    expect(c[0]?.skillContent).toBeUndefined();

    // 无 skill 参数：任务形状仍只 {prompt, sessionId}（不新增空字段）
    const { pool: poolD, spawned: d } = fakePool(ok);
    const toolD = createSubagentTool({ pool: poolD, skillContent: async () => 'x' });
    await toolD.execute(
      { id: 'c4', name: 'spawn_subagent', arguments: JSON.stringify({ prompt: 'p' }) },
      { sessionId: 's1' },
    );
    expect(d[0]).toEqual({ prompt: 'p', sessionId: 's1' });
  });

  it('会话绑定：ctx 缺省/空 sessionId → 任务不带 sessionId 键（容错；绝不因上下文缺失失败）', async () => {
    const ok = {
      ok: true,
      report: 'ok',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      estimated: false,
      durationMs: 0,
    };
    // 无 ctx（执行上下文整体缺省——运行路径上主循环恒传，此处验证容错不硬失败）
    const { pool: poolA, spawned: a } = fakePool(ok);
    const toolA = createSubagentTool({ pool: poolA });
    await toolA.execute(
      { id: 'c1', name: 'spawn_subagent', arguments: JSON.stringify({ prompt: 'p' }) },
      undefined as never,
    );
    expect(a[0]).toEqual({ prompt: 'p' });
    // ctx.sessionId 为空串：同样不带键
    const { pool: poolB, spawned: b } = fakePool(ok);
    const toolB = createSubagentTool({ pool: poolB });
    await toolB.execute(
      { id: 'c2', name: 'spawn_subagent', arguments: JSON.stringify({ prompt: 'p' }) },
      { sessionId: '' },
    );
    expect(b[0]).toEqual({ prompt: 'p' });
  });
});
