import { describe, expect, it } from 'vitest';
import {
  capSkill,
  createSubagentPool,
  DEFAULT_SUBAGENT_QUEUE_LIMIT,
  SKILL_INJECTION_LIMIT_CHARS,
  SKILL_INJECTION_TRUNCATED_MARK,
  sanitizeToolMarkers,
  SUBAGENT_REPORT_LIMIT_CHARS,
  SUBAGENT_SYSTEM_PROMPT,
} from '../../src/core/loop/subagent.js';
import { OUTPUT_TOO_LONG_ADVICE } from '../../src/core/context/truncate.js';
import type {
  SubagentPool,
  SubagentPoolDeps,
  WorkflowConfig,
} from '../../src/core/loop/subagent.js';
import type { LlmAdapter, Pricing } from '../../src/core/loop/index.js';
import { DEFAULT_PRICING } from '../../src/core/loop/types.js';
import { LlmError } from '../../src/shared/llm-types.js';
import type { StreamEvent } from '../../src/shared/llm-types.js';
import { FakeLlm, deferred, sleep } from './support.js';

/**
 * 子代理池（loop/subagent）：切片 a~h。
 * 预期值独立来源（手算，非实现复算）：
 * - DEFAULT_PRICING = {prompt: 1e-6, completion: 3e-6}（ADR-0003 占位价）；
 *   → usage {prompt 600_000} 成本 = 0.6 USD；{prompt 1000, completion 500} = 0.0025 USD；
 * - 报告截断：n ≥ 4000 字符 → 复用 CONTEXT 截断面板（头 2000 + 尾 2000 + elide
 *   标记 + 收窄建议；禁止手写头截断）；n < 4000 原样返回；
 * - 池级成本护栏缺省 $1.00：单任务 0.6×2 → 第 2 个 spawn 预判拒绝（0.6+0.6 > 1.0）；
 * - 队列上限缺省 512（DEFAULT_SUBAGENT_QUEUE_LIMIT）。
 * - maxParallel 0 = 无上限（无信号量：所有任务立即执行，FIFO 队列只保证提交序；
 *   并发受系统资源自然限制），1-8 为显式并发数（归一 0..8 属 shared/workflow 的
 *   clampMaxParallel——池直接消费 config）。
 */

/** 最简池构造（测试注入点），缺省 config = {subagentsEnabled:true, maxParallel:2}。 */
function makePool(
  llm: LlmAdapter,
  options: {
    config?: () => WorkflowConfig;
    now?: () => number;
    pricing?: Pricing;
    costLimitUsd?: number;
    maxQueue?: number;
  } = {},
): SubagentPool {
  const deps: SubagentPoolDeps = {
    llm,
    model: 'test-model',
    config: options.config ?? (() => ({ subagentsEnabled: true, maxParallel: 2 })),
  };
  if (options.now !== undefined) deps.now = options.now;
  if (options.pricing !== undefined) deps.pricing = options.pricing;
  if (options.costLimitUsd !== undefined) deps.costLimitUsd = options.costLimitUsd;
  if (options.maxQueue !== undefined) deps.maxQueue = options.maxQueue;
  return createSubagentPool(deps);
}

describe('subagent：子代理池', () => {
  describe('a) 关闭状态', () => {
    it('enabled=false → spawn 立即 {ok:false,error:"subagents-disabled"}，零 llm 调用、不排队', async () => {
      const llm = new FakeLlm([]);
      const pool = makePool(llm, { config: () => ({ subagentsEnabled: false, maxParallel: 2 }) });

      const r = await pool.spawn({ prompt: 'do something' });

      expect(r).toMatchObject({ ok: false, error: 'subagents-disabled' });
      expect(r.report).toBe('');
      expect(r.durationMs).toBe(0);
      expect(r.totalTokens).toBe(0);
      expect(r.costUsd).toBe(0);
      expect(llm.requests).toHaveLength(0);
      expect(pool.stats()).toEqual({
        enabled: false,
        maxParallel: 2,
        active: 0,
        queued: 0,
        completed: 0,
        rejected: 1,
      });
    });

    it('config 动态恢复后 spawn 放行', async () => {
      let cfg: WorkflowConfig = { subagentsEnabled: false, maxParallel: 2 };
      const llm = new FakeLlm([{ content: 'ok' }]);
      const pool = makePool(llm, { config: () => cfg });

      expect((await pool.spawn({ prompt: 'a' })).error).toBe('subagents-disabled');
      cfg = { subagentsEnabled: true, maxParallel: 2 };
      const r = await pool.spawn({ prompt: 'b' });
      expect(r.ok).toBe(true);
      expect(llm.requests).toHaveLength(1);
    });
  });

  describe('b) 单任务：独立 chat 调用 + 报告截断 + usage 统计', () => {
    it('消息形状：system 固定角色 + user 原样 prompt，无工具、无 maxTokens，report 透传', async () => {
      const prompt = '检查 src/core/loop/agent.ts 是否存在死循环';
      const llm = new FakeLlm([{ content: '结论：存在风险。' }]);
      const pool = makePool(llm);
      const r = await pool.spawn({ prompt });

      expect(r.ok).toBe(true);
      expect(r.report).toBe('结论：存在风险。');
      expect(llm.requests).toHaveLength(1);
      expect(llm.requests[0]?.model).toBe('test-model');
      expect(llm.requests[0]?.messages).toEqual([
        { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ]);
      expect(llm.requests[0]?.tools).toBeUndefined();
      expect(llm.requests[0]?.maxTokens).toBeUndefined();
    });

    it('报告超 4000 字符 → 复用截断器（头 2000 + 尾 2000 + 显式 elide 标记 + 收窄建议；禁止手写头截断）', async () => {
      const long = 'A'.repeat(5000);
      const llm = new FakeLlm([{ content: long }]);
      const pool = makePool(llm);

      const r = await pool.spawn({ prompt: 'x' });

      expect(r.ok).toBe(true);
      const half = SUBAGENT_REPORT_LIMIT_CHARS / 2; // 2000
      expect(r.report.startsWith(OUTPUT_TOO_LONG_ADVICE)).toBe(true);
      expect(
        r.report.slice(OUTPUT_TOO_LONG_ADVICE.length, OUTPUT_TOO_LONG_ADVICE.length + half),
      ).toBe(long.slice(0, half));
      expect(r.report).toContain('\n\n--- 1000 characters elided ---\n\n');
      expect(r.report.slice(-half)).toBe(long.slice(-half));
      // 旧手写头截断标记不再出现（截断面板逐字模板）
      expect(r.report).not.toContain('（截断）');
    });

    it('报告恰 4000 字符：按截断面板重写（0 elided），不手写头截断', async () => {
      const long = 'A'.repeat(SUBAGENT_REPORT_LIMIT_CHARS);
      const llm = new FakeLlm([{ content: long }]);
      const pool = makePool(llm);

      const r = await pool.spawn({ prompt: 'x' });

      expect(r.ok).toBe(true);
      const half = SUBAGENT_REPORT_LIMIT_CHARS / 2; // 2000
      expect(r.report).toBe(
        OUTPUT_TOO_LONG_ADVICE +
          'A'.repeat(half) +
          '\n\n--- 0 characters elided ---\n\n' +
          'A'.repeat(half),
      );
      expect(r.report).not.toContain('（截断）');
    });

    it('报告 3999 字符：阈值内原样返回', async () => {
      const llm = new FakeLlm([{ content: 'A'.repeat(SUBAGENT_REPORT_LIMIT_CHARS - 1) }]);
      const pool = makePool(llm);

      const r = await pool.spawn({ prompt: 'x' });

      expect(r.ok).toBe(true);
      expect(r.report).toBe('A'.repeat(SUBAGENT_REPORT_LIMIT_CHARS - 1));
    });

    it('usage 越界：真实 usage 入账（estimated=false），成本按占位价手算', async () => {
      let clock = 1000;
      const llm = new FakeLlm([
        {
          content: 'report body',
          usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        },
      ]);
      const pool = makePool(llm, { now: () => clock });

      const p = pool.spawn({ prompt: 'p' });
      clock += 50;
      const r = await p;

      expect(r.ok).toBe(true);
      expect(r.promptTokens).toBe(1000);
      expect(r.completionTokens).toBe(500);
      expect(r.totalTokens).toBe(1500);
      expect(r.estimated).toBe(false);
      // 1000×1e-6 + 500×3e-6 = 0.0025
      expect(r.costUsd).toBeCloseTo(0.0025, 12);
      expect(r.durationMs).toBe(50);
    });

    it('usage 缺失 → 本地估算兜底（estimated=true），统计仍齐整', async () => {
      const llm = new FakeLlm([{ content: 'ok' }]);
      const pool = makePool(llm);

      const r = await pool.spawn({ prompt: '清单：请枚举 3 个关键发现' });

      expect(r.ok).toBe(true);
      expect(r.estimated).toBe(true);
      expect(r.promptTokens).toBeGreaterThan(0);
      expect(r.completionTokens).toBeGreaterThan(0);
      expect(r.totalTokens).toBe(r.promptTokens + r.completionTokens);
      expect(r.costUsd).toBeGreaterThan(0);
    });
  });

  describe('c) 信号量：maxParallel + FIFO 队列', () => {
    it('maxParallel=2：第 3 任务排队；前 2 各完成后按先后补齐；stats 计数正确', async () => {
      const gate1 = deferred();
      const gate2 = deferred();
      const gate3 = deferred();
      const llm = new FakeLlm([
        { content: 'report-1', gate: gate1.promise },
        { content: 'report-2', gate: gate2.promise },
        { content: 'report-3', gate: gate3.promise },
      ]);
      let clock = 1000;
      const pool = makePool(llm, { now: () => clock });

      const r1 = pool.spawn({ prompt: 'task-1' });
      const r2 = pool.spawn({ prompt: 'task-2' });
      const r3 = pool.spawn({ prompt: 'task-3' });
      await sleep(0);

      // 仅 2 个并发在跑，第 3 个在队列
      expect(llm.requests).toHaveLength(2);
      expect(llm.requests[0]?.messages[1]).toEqual({ role: 'user', content: 'task-1' });
      expect(llm.requests[1]?.messages[1]).toEqual({ role: 'user', content: 'task-2' });
      expect(pool.stats()).toEqual({
        enabled: true,
        maxParallel: 2,
        active: 2,
        queued: 1,
        completed: 0,
        rejected: 0,
      });

      // task-1 完成释放槽位 → task-3（FIFO）启动，task-2 未动
      clock += 31;
      gate1.resolve();
      const res1 = await r1;
      expect(res1.ok).toBe(true);
      expect(res1.report).toBe('report-1');
      expect(res1.durationMs).toBe(31);
      await sleep(0);
      expect(llm.requests).toHaveLength(3);
      expect(llm.requests[2]?.messages[1]).toEqual({ role: 'user', content: 'task-3' });
      expect(pool.stats()).toEqual({
        enabled: true,
        maxParallel: 2,
        active: 2,
        queued: 0,
        completed: 1,
        rejected: 0,
      });

      clock += 50;
      gate3.resolve();
      const res3 = await r3;
      expect(res3.ok).toBe(true);
      expect(res3.durationMs).toBe(50);
      expect(pool.stats().active).toBe(1);
      expect(pool.stats().completed).toBe(2);

      clock += 70;
      gate2.resolve();
      const res2 = await r2;
      expect(res2.ok).toBe(true);
      expect(pool.stats()).toEqual({
        enabled: true,
        maxParallel: 2,
        active: 0,
        queued: 0,
        completed: 3,
        rejected: 0,
      });
    });
  });

  describe('d) 成本护栏（池级累计，缺省 $1.00）', () => {
    it('单任务 $0.6×2 → 第 2 个 spawn 预判拒绝 cost-guard，不再触达 llm', async () => {
      const llm = new FakeLlm([
        {
          content: 'heavy',
          usage: { promptTokens: 600_000, completionTokens: 0, totalTokens: 600_000 },
        },
        { content: 'should not run' },
      ]);
      const pool = makePool(llm); // 缺省 costLimitUsd = 1.0

      const r1 = await pool.spawn({ prompt: 'a' });
      expect(r1.ok).toBe(true);
      expect(r1.costUsd).toBeCloseTo(0.6, 12); // 600_000 × 1e-6

      const r2 = await pool.spawn({ prompt: 'b' });
      expect(r2).toMatchObject({ ok: false, error: 'cost-guard' });
      expect(r2.report).toBe('');

      const r3 = await pool.spawn({ prompt: 'c' }); // 护栏粘性：继续拒绝
      expect(r3.error).toBe('cost-guard');

      expect(llm.requests).toHaveLength(1);
      expect(pool.stats()).toMatchObject({ completed: 1, rejected: 2, active: 0, queued: 0 });
    });

    it('自定义上限：耗尽后拒绝；仍在预算内的任务正常放行', async () => {
      const llm = new FakeLlm([
        { content: 'small', usage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 } },
        { content: 'ok', usage: { promptTokens: 3000, completionTokens: 0, totalTokens: 3000 } },
        { content: 'ok', usage: { promptTokens: 3000, completionTokens: 0, totalTokens: 3000 } },
      ]);
      const pool = makePool(llm, { costLimitUsd: 0.008 }); // 0.001 + 0.003 ≈ 0.004 后仍有余量

      expect((await pool.spawn({ prompt: 'a' })).ok).toBe(true); // 0.001
      expect((await pool.spawn({ prompt: 'b' })).ok).toBe(true); // 0.004 累计
      // 累计 0.004 + 预判 0.003 = 0.007 ≤ 0.008 放行；下一个 0.004+0.003+0.003 = 0.010 > 0.008
      expect((await pool.spawn({ prompt: 'c' })).ok).toBe(true);
      const r4 = await pool.spawn({ prompt: 'd' });
      expect(r4.error).toBe('cost-guard');
    });
  });

  describe('e) 队列满 512 → reject queue-full', () => {
    it('缺省上限 512：第 515 个 spawn 拒绝，前 514 个完成后正常', async () => {
      const gate1 = deferred();
      const gate2 = deferred();
      // 2 个在跑 + 512 个排队 → 514 接受，第 515 个拒绝（queue-full）
      const llm = new FakeLlm([
        { content: 'a', gate: gate1.promise },
        { content: 'b', gate: gate2.promise },
        ...Array.from({ length: DEFAULT_SUBAGENT_QUEUE_LIMIT }, () => ({ content: 'ok' })),
      ]);
      const pool = makePool(llm); // 缺省 maxQueue = 512（DEFAULT_SUBAGENT_QUEUE_LIMIT）

      const spawned = Array.from({ length: DEFAULT_SUBAGENT_QUEUE_LIMIT + 3 }, (_, i) =>
        pool.spawn({ prompt: `t-${i}` }),
      );
      await sleep(0);

      expect(llm.requests).toHaveLength(2);
      expect(pool.stats()).toMatchObject({
        active: 2,
        queued: DEFAULT_SUBAGENT_QUEUE_LIMIT,
        rejected: 1,
      });
      const over = await spawned[DEFAULT_SUBAGENT_QUEUE_LIMIT + 2];
      expect(over).toMatchObject({ ok: false, error: 'queue-full' });

      gate1.resolve();
      gate2.resolve();
      const results = await Promise.all(spawned.slice(0, DEFAULT_SUBAGENT_QUEUE_LIMIT + 2));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(pool.stats()).toMatchObject({
        completed: DEFAULT_SUBAGENT_QUEUE_LIMIT + 2,
        rejected: 1,
        active: 0,
        queued: 0,
      });
    });
  });

  describe('f) llm 抛错 → {ok:false} 不 throw、信号量释放', () => {
    it('error 事件（传输层）→ ok:false 报告错误；后续任务继续', async () => {
      const llm = new FakeLlm([
        {
          error: new LlmError({
            kind: 'transport',
            status: 0,
            retryable: false,
            message: 'network down',
          }),
        },
        { content: 'ok-report' },
      ]);
      const pool = makePool(llm);

      const r1 = await pool.spawn({ prompt: 'boom task' });
      expect(r1.ok).toBe(false);
      expect(r1.error).toBe('network down');
      expect(r1.report).toBe('');
      expect(pool.stats()).toMatchObject({ active: 0, completed: 1, queued: 0 });

      const r2 = await pool.spawn({ prompt: 'second' });
      expect(r2.ok).toBe(true);
      expect(r2.report).toBe('ok-report');
      expect(pool.stats()).toMatchObject({ active: 0, completed: 2, rejected: 0 });
    });

    it('chat() 同步 throw（adapter 异常）→ 收敛为 ok:false，spawn 绝不 throw', async () => {
      const throwingLlm: LlmAdapter = {
        chat(): AsyncIterable<StreamEvent> {
          throw new Error('sync boom from transport');
        },
      };
      const pool = makePool(throwingLlm);

      const r1 = await pool.spawn({ prompt: 'never throws' });
      expect(r1.ok).toBe(false);
      expect(r1.error).toBe('sync boom from transport');
      const r2 = await pool.spawn({ prompt: 'again' });
      expect(r2.ok).toBe(false);
      expect(pool.stats()).toMatchObject({ active: 0, completed: 2 });
    });
  });

  describe('g) dispose：新任务拒绝 + 排队任务取消', () => {
    it('dispose 后 queued 失败 disposed、active 完成后池关闭', async () => {
      const gate1 = deferred();
      const llm = new FakeLlm([
        { content: 'one', gate: gate1.promise },
        { content: 'two' },
        { content: 'three' },
      ]);
      const pool = makePool(llm, { config: () => ({ subagentsEnabled: true, maxParallel: 1 }) });

      const r1 = pool.spawn({ prompt: 'one' });
      const r2 = pool.spawn({ prompt: 'two' });
      const r3 = pool.spawn({ prompt: 'three' });
      await sleep(0);
      expect(pool.stats()).toMatchObject({ active: 1, queued: 2 });

      pool.dispose();

      const res2 = await r2;
      const res3 = await r3;
      expect(res2).toMatchObject({ ok: false, error: 'disposed' });
      expect(res3).toMatchObject({ ok: false, error: 'disposed' });
      expect(pool.stats()).toMatchObject({ active: 1, queued: 0, rejected: 2 });

      // dispose 后新 spawn 同样拒绝
      const r4 = pool.spawn({ prompt: 'after' });
      expect((await r4).error).toBe('disposed');
      expect(pool.stats().rejected).toBe(3);

      // 正在执行的子代理照常完成
      gate1.resolve();
      const res1 = await r1;
      expect(res1.ok).toBe(true);
      expect(res1.report).toBe('one');
      expect(pool.stats()).toEqual({
        enabled: true,
        maxParallel: 1,
        active: 0,
        queued: 0,
        completed: 1,
        rejected: 3,
      });
    });
  });

  describe('h) 并发一致性（120 并发速测）', () => {
    it('120 并发：全部完成、无死锁、计数无泄漏', async () => {
      const llm = new FakeLlm(
        Array.from({ length: 121 }, () => ({
          content: 'ok',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })),
      );
      const pool = makePool(llm, { config: () => ({ subagentsEnabled: true, maxParallel: 120 }) });

      const results = await Promise.all(
        Array.from({ length: 120 }, (_, i) => pool.spawn({ prompt: `task-${i}` })),
      );

      expect(results.every((r) => r.ok)).toBe(true);
      expect(
        results.every(
          (r) =>
            r.costUsd ===
            100 * DEFAULT_PRICING.promptPerToken + 50 * DEFAULT_PRICING.completionPerToken,
        ),
      ).toBe(true);
      expect(llm.requests).toHaveLength(120);
      expect(pool.stats()).toEqual({
        enabled: true,
        maxParallel: 120,
        active: 0,
        queued: 0,
        completed: 120,
        rejected: 0,
      });

      // 池未泄漏：完成后仍可继续 spawn
      const extra = await pool.spawn({ prompt: 'extra' });
      expect(extra.ok).toBe(true);
      expect(pool.stats().completed).toBe(121);
    });
  });

  describe('i) maxParallel=0（无上限：无信号量，全部立即执行）', () => {
    it('8 任务立即全并发（零排队）；逐门放行后全部完成；计数/统计齐整', async () => {
      const gates = Array.from({ length: 8 }, () => deferred());
      const llm = new FakeLlm(
        gates.map((gate, i) => ({ content: `report-${i}`, gate: gate.promise })),
      );
      let clock = 1000;
      const pool = makePool(llm, {
        config: () => ({ subagentsEnabled: true, maxParallel: 0 }),
        now: () => clock,
      });

      const results = gates.map((_g, i) => pool.spawn({ prompt: `task-${i}` }));
      await sleep(0);

      // 无信号量：全部任务在提交序上立即进入执行，队列恒空
      expect(llm.requests).toHaveLength(8);
      expect(llm.requests.map((r) => r.messages[1])).toEqual(
        gates.map((_g, i) => ({ role: 'user', content: `task-${i}` })),
      );
      expect(pool.stats()).toEqual({
        enabled: true,
        maxParallel: 0,
        active: 8,
        queued: 0,
        completed: 0,
        rejected: 0,
      });

      // 逐个放行（各任务独立计时点：duration = 放行时刻 − 起动时刻，互不相同）
      for (let i = 0; i < gates.length; i += 1) {
        clock += 10;
        gates[i]!.resolve();
        const r = await results[i]!;
        expect(r.ok).toBe(true);
        expect(r.report).toBe(`report-${i}`);
      }
      expect(pool.stats()).toEqual({
        enabled: true,
        maxParallel: 0,
        active: 0,
        queued: 0,
        completed: 8,
        rejected: 0,
      });
    });

    it('无上限不豁免成本护栏：累计 + 预判超限同样 cost-guard', async () => {
      const llm = new FakeLlm([
        {
          content: 'heavy',
          usage: { promptTokens: 600_000, completionTokens: 0, totalTokens: 600_000 },
        },
        { content: 'should not run' },
      ]);
      const pool = makePool(llm, {
        config: () => ({ subagentsEnabled: true, maxParallel: 0 }),
      });

      expect((await pool.spawn({ prompt: 'a' })).ok).toBe(true);
      const r = await pool.spawn({ prompt: 'b' });
      expect(r).toMatchObject({ ok: false, error: 'cost-guard' });
      expect(llm.requests).toHaveLength(1);
      expect(pool.stats()).toMatchObject({ maxParallel: 0, completed: 1, rejected: 1 });
    });
  });

  describe('j) skillContent 注入（方法论全文机械进 system；无则不变）', () => {
    it('skillContent 给定：system = 固定角色 + 「# 方法论（注入）」节（内容全文透传）', async () => {
      const methodology = '## 审查双轴\n- 标准轴：与仓库规范对照；\n- 规格轴：与需求条目对照。';
      const llm = new FakeLlm([{ content: 'ok' }]);
      const pool = makePool(llm);

      const r = await pool.spawn({
        prompt: '审查 diff',
        skillId: 'code-review',
        skillContent: methodology,
      });

      expect(r.ok).toBe(true);
      expect(llm.requests).toHaveLength(1);
      expect(llm.requests[0]?.messages[0]).toEqual({
        role: 'system',
        content: SUBAGENT_SYSTEM_PROMPT + '\n\n## 方法论（注入）\n' + methodology,
      });
      expect(llm.requests[0]?.messages[1]).toEqual({ role: 'user', content: '审查 diff' });
    });

    it('无 skillContent / 空串 / 纯空白 → system 与既有完全一致（零注入）', async () => {
      const msgShape = [
        { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
        { role: 'user', content: 'p ' },
      ];
      for (const task of [
        { prompt: 'p ' },
        { prompt: 'p ', skillContent: '' },
        { prompt: 'p ', skillContent: '   \n' },
      ]) {
        const llm = new FakeLlm([{ content: 'ok' }]);
        const pool = makePool(llm);
        await pool.spawn(task);
        expect(llm.requests[0]?.messages).toEqual(msgShape);
      }
    });

    it('超 SKILL_INJECTION_LIMIT_CHARS → capSkill 头截断 + 「…（截断）」标记；恰在界内原样', async () => {
      const long = 'A'.repeat(SKILL_INJECTION_LIMIT_CHARS + 700); // >8000
      const llm = new FakeLlm([{ content: 'ok' }]);
      const pool = makePool(llm);

      await pool.spawn({ prompt: 'p', skillContent: long });

      const system = llm.requests[0]?.messages[0]?.content as string;
      const prefix = SUBAGENT_SYSTEM_PROMPT + '\n\n## 方法论（注入）\n';
      expect(system.startsWith(prefix)).toBe(true);
      expect(system.slice(prefix.length)).toBe(
        'A'.repeat(SKILL_INJECTION_LIMIT_CHARS) + SKILL_INJECTION_TRUNCATED_MARK,
      );
      expect(system).not.toContain('A'.repeat(SKILL_INJECTION_LIMIT_CHARS + 1));

      // 边界：恰 8000 → 原样（不截断、无标记）；capSkill 纯函数直测
      const exactly = 'B'.repeat(SKILL_INJECTION_LIMIT_CHARS);
      expect(capSkill(exactly)).toBe(exactly);
      expect(
        capSkill('C'.repeat(SKILL_INJECTION_LIMIT_CHARS + 1)).endsWith(
          SKILL_INJECTION_TRUNCATED_MARK,
        ),
      ).toBe(true);

      // astral（代理对）码点边界：8000 个 emoji = 16000 UTF-16 单元 → 按码点不截断；
      // 超出一个码点 → 头截（无孤立高位代理——不产生 U+FFFD 破烂）
      const emoji = '😀'.repeat(SKILL_INJECTION_LIMIT_CHARS);
      expect(capSkill(emoji)).toBe(emoji);
      expect(capSkill(emoji + 'x')).toBe(emoji + SKILL_INJECTION_TRUNCATED_MARK);
      expect(capSkill(emoji + 'x')).not.toContain('�');
    });
  });

  describe('k) 报告净化：sanitizeToolMarkers（p1 实证——纯推理子代理伪造工具块生肉）', () => {
    it('剥除 <tool_calls> 生肉段：成对 XML 工具块整体移除（含嵌套 <invoke>/<parameter>），前后正文保留', () => {
      const raw =
        '结论：需先核查实现是否遵循既有命名。\n\n' +
        '<tool_calls>\n' +
        '<invoke name="Read">\n<parameter name="file_path">src/shared/strings.ts</parameter>\n</invoke>\n' +
        '<invoke name="Read">\n<parameter name="file_path">test/shared/strings.test.ts</parameter>\n</invoke>\n' +
        '</tool_calls>\n\n' +
        '总体：通过。';
      const out = sanitizeToolMarkers(raw);
      expect(out).not.toContain('<tool_calls');
      expect(out).not.toContain('</tool_calls>');
      expect(out).not.toContain('<invoke');
      expect(out).not.toContain('file_path');
      expect(out).not.toContain('src/shared/strings.ts');
      expect(out).toContain('结论：需先核查实现是否遵循既有命名。');
      expect(out).toContain('总体：通过。');
    });

    it('invoke 等号周边空白同剥：<invoke name = "Read"> 成对块整体移除，前后正文保留', () => {
      const raw =
        '要点：结论通过。\n\n' +
        '<invoke name = "Read">\n<parameter name="file_path">src/shared/strings.ts</parameter>\n</invoke>\n\n' +
        '依据：测试 6 绿。';
      const out = sanitizeToolMarkers(raw);
      expect(out).not.toContain('<invoke');
      expect(out).not.toContain('file_path');
      expect(out).not.toContain('src/shared/strings.ts');
      expect(out).toContain('要点：结论通过。');
      expect(out).toContain('依据：测试 6 绿。');
    });

    it('正常正文不动：普通尖括号序列（a < b、c > d、HTML <div>、<表达式>）原样保留', () => {
      const body =
        '接口惯例：比较 a < b 且 c > d 时用 <表达式>；HTML 标签 <div> 仅作示例；空串归空白。';
      expect(sanitizeToolMarkers(body)).toBe(body);
    });

    it('「<工具调用」开头未闭合的整段残迹 → 剥至文末（工具块被截断的兜底）', () => {
      const raw = '要点：结论通过。\n<工具调用 name="Read">\n参数 src/a.ts\n（无闭合标签）';
      expect(sanitizeToolMarkers(raw)).toBe('要点：结论通过。\n');
    });

    it('孤立/残边标记标签：<invoke name="…"> 与 </tool_calls> 单现也剥除', () => {
      const raw = '说明：<invoke name="Read"> 出现在报告中；</tool_calls> 亦是残迹。';
      expect(sanitizeToolMarkers(raw)).toBe('说明： 出现在报告中； 亦是残迹。');
    });

    it('池级端到端：execute 组装时净化（text 流含伪造工具块 → 报告无 <tool_calls 残迹）', async () => {
      const llm = new FakeLlm([
        {
          content:
            '核查结论：实现正确。\n<tool_calls>\n<invoke name="Read">\n<parameter name="file_path">src/x.ts</parameter>\n</invoke>\n</tool_calls>\n依据：测试 7 绿。',
        },
      ]);
      const pool = makePool(llm);
      const r = await pool.spawn({ prompt: '审查' });
      expect(r.ok).toBe(true);
      expect(r.report).not.toContain('<tool_calls');
      expect(r.report).not.toContain('<invoke');
      expect(r.report).toContain('核查结论：实现正确。');
      expect(r.report).toContain('依据：测试 7 绿。');
    });
  });
});
