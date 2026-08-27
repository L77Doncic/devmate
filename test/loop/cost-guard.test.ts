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
 * 成本护栏三道闸门（ADR-0003 成本护栏：A 请求前估算、B 流式中超阈值中止、C 响应后真实 usage 校准）。
 * 手算预期值：
 * - 无工具时「write a test」投影估算 = 12 token（见 loop.test.ts 头注）；
 * - 闸门 A（请求前，§5.3 原文）：est_prompt×prompt 价 + max_tokens×completion 价 + 累计已花费 > 预算 ⇒ 不发请求；
 *   模型默认输出预留 DEFAULT_MAX_TOKENS = 8192（§8 A-1：max_completion_tokens 默认 8192）；
 * - 闸门 B：4000 个 'a' 输出 → 估算 1000 token × {completion:1e-4} = 0.1 USD；
 *   maxTokens=50 → 闸门 A：12×1e-6 + 50×1e-4 = 0.005012 ≤ 0.05 放行；在途 0.005012 + 0.1 > 0.05 → 中止（记账 12+1000）。
 * - 闸门 C：usage {prompt:20000} × 1e-6 = 0.02 USD > 预算 0.01 → 下一轮查询前 cost-guard。
 */
const TASK = 'write a test';

type Options = Parameters<typeof run>[1];

function opts(overrides: Options): Options {
  return { ...overrides };
}

describe('loop：成本护栏（闸门 A/B/C）', () => {
  describe('闸门 A：请求前估算（prompt 侧 + maxTokens 输出侧，§5.3）', () => {
    it('预算不足 → cost-guard，零查询零花费', async () => {
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
          costLimitUsd: 1e-6, // prompt 侧 12×1e-6 = 1.2e-5 > 1e-6（输出预留 8192×1e-6 更超）
        }),
      );

      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(0);
      expect(llm.requests).toHaveLength(0);
      expect(result.usage.costUsd).toBe(0);
      expect(result.usage.promptTokens).toBe(0);
      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual(['user', 'event(run_result)']);
      expect((eventPayload(events[1])?.data as { status: string } | undefined)?.status).toBe(
        'cost-guard',
      );
    });

    it('输出侧估价：prompt 侧不超限但 maxTokens 输出预留超限 → 不发请求', async () => {
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
          costLimitUsd: 2e-5,
          maxTokens: 50, // 请求侧输出上限：50×1e-6 = 5e-5；12×1e-6 + 5e-5 = 6.2e-5 > 2e-5
        }),
      );

      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(0);
      expect(llm.requests).toHaveLength(0);
    });
  });

  describe('闸门 C：响应后真实 usage 校准累计', () => {
    it('校准后超预算 → 下一轮查询前 cost-guard；本轮工具结果已落盘', async () => {
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
          pricing: { promptPerToken: 1e-6, completionPerToken: 1e-6 },
          costLimitUsd: 0.01, // 20_000 × 1e-6 = 0.02 > 0.01
        }),
      );

      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(1);
      expect(llm.requests).toHaveLength(1);
      // 真实 usage 已入账（估算估算+校准 = 0.02，estimated=false）
      expect(result.usage.promptTokens).toBe(20_000);
      expect(result.usage.completionTokens).toBe(0);
      expect(result.usage.costUsd).toBeCloseTo(0.02, 12);
      expect(result.usage.estimated).toBe(false);

      // 本轮工具结果仍然落盘（失败轮也记成本、结果完整）
      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual([
        'user',
        'assistant(1tc)',
        'tool(call_1)',
        'event(run_result)',
      ]);
    });
  });

  describe('闸门 B：流式中超预算中止', () => {
    it('text 增量触顶即中止流，尽力保留已生成部分；usage 记账（估算标记）；流被提前关闭', async () => {
      const store = readyStore();
      const big = 'a'.repeat(4000); // 估算 1000 token
      const llm = new FakeLlm([
        { content: big }, // 首条 text 后预算已超 → 消费者中止，end 不再被消费
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
          costLimitUsd: 0.05,
          maxTokens: 50, // 闸门 A：12×1e-6 + 50×1e-4 = 0.005012 ≤ 0.05 → 放行到闸门 B
        }),
      );

      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(1);
      expect(llm.requests).toHaveLength(1);
      // 消费端已中止流（end 未送达 → 生成器 finally 记录 cancelled）
      expect(llm.cancelled).toContain(0);
      // 记账：prompt 12（估算）+ completion 1000（估算）×价
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
    it('先低估后校准：真实 usage 抬升系数，下一轮闸门 A 按校正估算估价（偏差缩小）', async () => {
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
          costLimitUsd: 1.25e-4,
          maxTokens: 1, // 输出侧极小，突出 prompt 校正系数效果
        }),
      );

      // 手算（echo 工具段开销 26 = 12 收尾 + 7 函数 + name 1 + property/key 6）：
      // round1 投影估算 38（正文/结构 12 + 工具段 26）；闸门 A：0 + 38×1e-6 + 1×1e-6 = 3.9e-5 ≤ 1.25e-4 → 放行；
      //   真实 prompt usage 60（估 38 → ratio ≈ 1.58）→ 系数 EMA(0.5) = 0.5×1 + 0.5×1.58 ≈ 1.29（先低估 → 抬升）；
      // round2 投影估算 57（消息 31 + 工具段 26）→ 校正 round(57×1.29) ≈ 74；
      //   闸门 A：6.0e-5（累计）+ 74×1e-6 + 1×1e-6 = 13.5e-5 > 1.25e-4 → cost-guard；
      // 未经校正：6.0e-5 + 57×1e-6 + 1e-6 = 11.8e-5（≤ 1.25e-4）→ 会再发第二轮查询。
      expect(result.status).toBe('cost-guard');
      expect(result.steps).toBe(1);
      expect(llm.requests).toHaveLength(1);
      expect(result.usage.promptTokens).toBe(60);
      expect(result.usage.costUsd).toBeCloseTo(6.0e-5, 12);
      expect(result.usage.estimated).toBe(false);
    });
  });
});
