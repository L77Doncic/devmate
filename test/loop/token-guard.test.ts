import { describe, expect, it } from 'vitest';
import { run, defineRegistry } from '../../src/core/loop/index.js';
import {
  FakeLlm,
  assistantPayload,
  collectEvents,
  echoTool,
  eventPayload,
  kindsOf,
  makeRegistry,
  readyStore,
} from './support.js';

/**
 * Token 护栏三道闸门（2026-08-31 用户定调：护栏判据从 costUsd 改为**累计 totalTokens**
 * ——status 值保留 'cost-guard' 兼容；默认**关闭**：上限缺省 = 不限制）。
 * 手算预期值：
 * - 无工具时「write a test」投影估算 = 12 token（见 loop.test.ts 头注）；
 * - 闸门 A（请求前，保守裁决「累计 + 单轮上限」）：累计 totalTokens + 本轮 prompt 估算 +
 *   输出预留 maxTokens（缺省 DEFAULT_MAX_TOKENS = 8192；§8 A-1）> 上限 ⇒ 不发请求；
 * - 闸门 B：4000 个 'a' 输出 → 估算 1000 token；maxTokens=50 → 闸门 A：0+12+50 = 62 ≤ 100
 *   放行；闸门 B 在途 12 + 1000 = 1012 > 100 → 中止（记账 12+1000，estimated=true）；
 * - 闸门 C：usage {prompt:20000} → 累计 20000 > 上限 5000 → 下一轮查询前 cost-guard；
 * - 默认关闭：不设 maxRunTokens → 累计 20000 照常继续（completed）。
 */
const TASK = 'write a test';

type Options = Parameters<typeof run>[1];

function opts(overrides: Options): Options {
  return { ...overrides };
}

describe('loop：Token 护栏（闸门 A/B/C；判据 = 累计 totalTokens）', () => {
  describe('默认关闭（2026-08-31 定调：无上限 = 不限制）', () => {
    it('不设 maxRunTokens → 护栏从不触发：累计 20000 token 后照常自然结束', async () => {
      const store = readyStore();
      const { registry } = makeRegistry();
      const llm = new FakeLlm([
        {
          content: 'done',
          usage: { promptTokens: 20_000, completionTokens: 0, totalTokens: 20_000 },
        },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'test-model' }),
      );

      expect(result.status).toBe('completed');
      expect(result.usage.promptTokens).toBe(20_000);
      expect(result.usage.totalTokens).toBe(20_000);
      expect(llm.requests).toHaveLength(1);
    });

    it('坏值防御：非正整数上限（负数/小数）按关闭处理——不拦（护栏故障不放大）', async () => {
      const store = readyStore();
      const llm = new FakeLlm([{ content: 'done' }]);
      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({
          store,
          tools: defineRegistry([], { sessionId: 's1' }),
          llm,
          model: 'm',
          maxRunTokens: -5,
        }),
      );
      expect(result.status).toBe('completed');
      expect(llm.requests).toHaveLength(1);

      const store2 = readyStore();
      const llm2 = new FakeLlm([{ content: 'done' }]);
      const result2 = await run(
        { sessionId: 's1', task: TASK },
        opts({
          store: store2,
          tools: defineRegistry([], { sessionId: 's1' }),
          llm: llm2,
          model: 'm',
          maxRunTokens: 12.5,
        }),
      );
      expect(result2.status).toBe('completed');
      expect(llm2.requests).toHaveLength(1);
    });
  });

  describe('闸门 A：请求前预判（累计 + 本轮 prompt 估算 + 输出预留；§5.3 演进）', () => {
    it('上限不足 → cost-guard，零查询零花费（累计 0 + 12 + 8192 > 12）', async () => {
      const store = readyStore();
      const llm = new FakeLlm([]); // 不该被调用
      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({
          store,
          tools: defineRegistry([], { sessionId: 's1' }),
          llm,
          model: 'test-model',
          pricing: { promptPerToken: 1e-6, completionPerToken: 1e-6 },
          maxRunTokens: 12, // 单轮上限（12 prompt + 8192 输出预留）远超 → 一发都不发
        }),
      );

      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(0);
      expect(llm.requests).toHaveLength(0);
      expect(result.usage.costUsd).toBe(0);
      expect(result.usage.promptTokens).toBe(0);
      expect(result.usage.totalTokens).toBe(0);
      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual(['user', 'event(run_result)']);
      expect((eventPayload(events[1])?.data as { status: string } | undefined)?.status).toBe(
        'cost-guard',
      );
    });

    it('输出侧预判：prompt 估算不超但 prompt+输出预留超限 → 不发请求', async () => {
      const store = readyStore();
      const llm = new FakeLlm([]); // 不该被调用
      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({
          store,
          tools: defineRegistry([], { sessionId: 's1' }),
          llm,
          model: 'test-model',
          maxRunTokens: 61,
          maxTokens: 50, // 请求侧输出上限：12 + 50 = 62 > 61；单看 prompt（12）并不超
        }),
      );

      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(0);
      expect(llm.requests).toHaveLength(0);
    });
  });

  describe('闸门 C：响应后真实 usage 累计', () => {
    it('累计超限（usage 20000 > 5000）→ 下一轮查询前 cost-guard；本轮工具结果已落盘', async () => {
      const store = readyStore();
      const { registry } = makeRegistry();
      const llm = new FakeLlm([
        {
          toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }],
          usage: { promptTokens: 20_000, completionTokens: 0, totalTokens: 20_000 },
        },
        { content: 'should never run' },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({
          store,
          tools: registry,
          llm,
          model: 'test-model',
          maxRunTokens: 5000,
          maxTokens: 50, // 首轮闸门 A：0 + 12 + 50 = 62 ≤ 5000 → 放行（轮到闸门 C）
        }),
      );

      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(1);
      expect(llm.requests).toHaveLength(1);
      // 真实 usage 已入账（estimated=false；costUsd 照旧统计——只换判据不改统计）
      expect(result.usage.promptTokens).toBe(20_000);
      expect(result.usage.completionTokens).toBe(0);
      expect(result.usage.totalTokens).toBe(20_000);
      expect(result.usage.costUsd).toBeCloseTo(0.02, 12);
      expect(result.usage.estimated).toBe(false);

      // 本轮工具结果仍然落盘（失败轮也照记、结果完整）
      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual([
        'user',
        'assistant(1tc)',
        'tool(call_1)',
        'event(run_result)',
      ]);
    });
  });

  describe('闸门 B：流式中累计触顶中止', () => {
    it('text 增量触顶即中止流，尽力保留已生成部分；usage 记账（估算标记）；流被提前关闭', async () => {
      const store = readyStore();
      const big = 'a'.repeat(4000); // 估算 1000 token
      const llm = new FakeLlm([
        { content: big }, // 首条 text 后累计已超 → 消费者中止，end 不再被消费
        { content: 'should never run' },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({
          store,
          tools: defineRegistry([], { sessionId: 's1' }),
          llm,
          model: 'test-model',
          pricing: { promptPerToken: 1e-6, completionPerToken: 1e-4 },
          maxRunTokens: 100,
          maxTokens: 50, // 闸门 A：0 + 12 + 50 = 62 ≤ 100 → 放行到闸门 B
        }),
      );

      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(1);
      expect(llm.requests).toHaveLength(1);
      // 消费端已中止流（end 未送达 → 生成器 finally 记录 cancelled）
      expect(llm.cancelled).toContain(0);
      // 记账：prompt 12（估算）+ completion 1000（估算）——costUsd 照旧按占位价算
      expect(result.usage.promptTokens).toBe(12);
      expect(result.usage.completionTokens).toBe(1000);
      expect(result.usage.totalTokens).toBe(1012);
      expect(result.usage.costUsd).toBeCloseTo(12 * 1e-6 + 1000 * 1e-4, 12);
      expect(result.usage.estimated).toBe(true);

      // 已生成部分作为 assistant 事件保留（内容完整、无 toolCalls）
      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual(['user', 'assistant(0tc)', 'event(run_result)']);
      expect(assistantPayload(events[1])?.content).toBe(big);
      expect(assistantPayload(events[1])?.toolCalls).toEqual([]);
    });

    it('cached 计价：缓存命中按 cachedPerToken、未命中按 promptPerToken、推理 token 按输出价', async () => {
      const store = readyStore();
      const { registry } = makeRegistry();
      const llm = new FakeLlm([
        {
          content: 'done',
          usage: {
            promptTokens: 1000,
            completionTokens: 500,
            totalTokens: 1500,
            cachedTokens: 600,
            reasoningTokens: 100,
          },
        },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({
          store,
          tools: registry,
          llm,
          model: 'test-model',
          pricing: { promptPerToken: 2e-6, completionPerToken: 6e-6, cachedPerToken: 5e-7 },
        }),
      );

      expect(result.status).toBe('completed');
      // 手算：600×5e-7 + 400×2e-6 + 500×6e-6 = 0.0003 + 0.0008 + 0.003 = 0.0041
      expect(result.usage.costUsd).toBeCloseTo(0.0041, 12);
      expect(result.usage.estimated).toBe(false);
    });
  });

  describe('校正系数（ADR-0012 L0 事后校准：真实 usage 滑动更新，闸门 A 采用校正估算）', () => {
    it('先低估后校准：真实 usage 抬升系数，下一轮闸门 A 按校正 token 估算预判（偏差缩小）', async () => {
      const store = readyStore();
      const registry = defineRegistry([echoTool()], { sessionId: 's1' }); // 工具轮让循环进入第二轮
      const llm = new FakeLlm([
        {
          toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }],
          usage: { promptTokens: 60, completionTokens: 0, totalTokens: 60 },
        },
        { content: 'should never run' }, // 校准后闸门 A 截停，不该被轮到
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({
          store,
          tools: registry,
          llm,
          model: 'test-model',
          pricing: { promptPerToken: 1e-6, completionPerToken: 1e-6 },
          maxRunTokens: 120,
          maxTokens: 1, // 输出侧极小，突出 prompt 校正系数效果
        }),
      );

      // 手算（echo 工具段开销 26 = 12 收尾 + 7 函数 + name 1 + property/key 6）：
      // round1 投影估算 38（正文/结构 12 + 工具段 26）；闸门 A：0 + 38 + 1 = 39 ≤ 120 → 放行；
      //   真实 prompt usage 60（估 38 → ratio ≈ 1.58）→ 系数 EMA(0.5) = 0.5×1 + 0.5×1.58 ≈ 1.29（先低估 → 抬升）；
      // round2 投影估算 57（消息 31 + 工具段 26）→ 校正 round(57×1.29) ≈ 74；
      //   闸门 A：60（累计）+ 74（校正）+ 1 = 135 > 120 → cost-guard；
      // 未经校正：60 + 57 + 1 = 118 ≤ 120 → 会再发第二轮查询（校正确实改变裁决）。
      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(1);
      expect(llm.requests).toHaveLength(1);
      expect(result.usage.promptTokens).toBe(60);
      expect(result.usage.totalTokens).toBe(60);
      expect(result.usage.costUsd).toBeCloseTo(6.0e-5, 12);
      expect(result.usage.estimated).toBe(false);
    });
  });
});
