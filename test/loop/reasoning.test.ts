/**
 * # test/loop/reasoning：RunOptions.reasoning → ChatRequest.reasoningEffort 透传；
 * run_result/UsageSummary 的 contextEstimateTokens（projection 估算透传）
 *
 * C 档契约：
 * - run() 的 RunOptions.reasoning（'off'|'low'|'medium'|'high'）逐字进入 ChatRequest；
 *   未提供 → 请求不带 reasoningEffort（adapter 层退回 preset 行为，见 provider-adapter 单测）；
 * - RunResult.usage.contextEstimateTokens = 最后一次投影的 stats.estimatedTokens（>0）；
 *   无投影路径（run 在任何投影前终止）→ 不带该键；
 * - run_result 事件载荷同源携带（可选键）。
 */
import { describe, expect, it } from 'vitest';
import { run } from '../../src/core/loop/index.js';
import type { RunOptions } from '../../src/core/loop/index.js';
import { FakeLlm, collectEvents, makeRegistry, readyStore } from './support.js';
import type { SessionEvent } from '../../src/shared/session-types.js';

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return {
    store: readyStore(),
    tools: makeRegistry().registry,
    llm: new FakeLlm([{ content: 'done' }]),
    model: 'm',
    ...over,
  };
}

describe('run：reasoningEffort 透传（RunOptions.reasoning → ChatRequest）', () => {
  it('c1) reasoning: high → 请求带 reasoningEffort "high"（逐字透传）', async () => {
    const llm = new FakeLlm([{ content: 'done' }]);
    const result = await run({ sessionId: 's1', task: 'hello' }, opts({ llm, reasoning: 'high' }));
    expect(result.status).toBe('completed');
    expect(llm.requests[0]!.reasoningEffort).toBe('high');
  });

  it('c2) reasoning: off → 请求带 reasoningEffort "off"（adapter 层按家映射/显式禁用）', async () => {
    const llm = new FakeLlm([{ content: 'done' }]);
    await run({ sessionId: 's1', task: 'hello' }, opts({ llm, reasoning: 'off' }));
    expect(llm.requests[0]!.reasoningEffort).toBe('off');
  });

  it('c3) 未提供 → 请求不带 reasoningEffort（preset 行为由 adapter 决定）', async () => {
    const llm = new FakeLlm([{ content: 'done' }]);
    await run({ sessionId: 's1', task: 'hello' }, opts({ llm }));
    expect(llm.requests[0]!.reasoningEffort).toBeUndefined();
  });
});

describe('run：usage 的 contextEstimateTokens（projection 估算透传）', () => {
  it('c4) 正常终态：usage.contextEstimateTokens 为 >0 数字；run_result 事件同源携带', async () => {
    const store = readyStore();
    const llm = new FakeLlm([{ content: 'done' }]);
    const result = await run(
      { sessionId: 's1', task: 'count this projection' },
      opts({ store, llm }),
    );
    expect(result.usage.contextEstimateTokens).toBeTypeOf('number');
    expect(result.usage.contextEstimateTokens!).toBeGreaterThan(0);

    const events = await collectEvents(store, 's1');
    const rr = events.find(
      (ev): ev is SessionEvent & { kind: 'event' } =>
        ev.kind === 'event' && (ev.payload as { type?: string }).type === 'run_result',
    );
    const data = (rr?.payload as { data?: Record<string, unknown> }).data ?? {};
    expect(data.contextEstimateTokens).toBe(result.usage.contextEstimateTokens);
  });

  it('c5) 无投影路径（run 前即中断）：usage 不带 contextEstimateTokens 键', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(
      { sessionId: 's1', task: 'never consulted' },
      opts({ signal: controller.signal }),
    );
    expect(result.status).toBe('user-interrupted');
    expect('contextEstimateTokens' in result.usage).toBe(false);
  });
});
