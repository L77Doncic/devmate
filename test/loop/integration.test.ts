import { describe, expect, it } from 'vitest';
import { run, defineRegistry } from '../../src/core/loop/index.js';
import type { ConversationSummarizer } from '../../src/core/context/index.js';
import {
  FakeLlm,
  boomTool,
  collectEvents,
  echoTool,
  eventPayload,
  kindsOf,
  readyStore,
  toolPayload,
} from './support.js';

/**
 * 集成切片（j）：真 MemorySessionAdapter + 真 context.project（假 summarizer）+ 假 LLM，
 * 走完整两轮工具循环（冒烟级）。另额外观测两条压缩接线：
 * - 大窗口：两级压缩不触发（summarizer 不被调用、无 compaction 事件）；
 * - 小窗口：summary 触发时「摘要写入事件流」（CONTEXT「对话摘要」）且下一次投射以摘要为前缀。
 * 手算（S4 estimator 口径，见 loop.test.ts 头注）：
 * - user「write a test」+ 无工具 = 12 token；
 * - echo 工具定义结构开销 = 12(收尾) + 7(函数) + name'echo'2 + property(3+3) = 27；
 * - 窗口 50 → clearTrigger=22、compactTrigger=36；round1 估算 12+27=39 > 36 → 摘要触发。
 */
const TASK = 'write a test';

describe('loop：集成（真 store + 真 project + 假 llm）', () => {
  it('两轮工具循环冒烟：status=completed、steps=2、事件链与配对完整、工具定义随请求发送', async () => {
    const store = readyStore();
    const registry = defineRegistry([echoTool()], { sessionId: 'integ1' });
    const summarizer = () => {
      throw new Error('summarizer must not be called with big window');
    };
    const llm = new FakeLlm([
      { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
      { content: 'done' },
    ]);

    const result = await run(
      { sessionId: 'integ1', task: TASK },
      { store, tools: registry, llm, model: 'test-model', windowTokens: 100_000, summarizer },
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);

    const events = await collectEvents(store, 'integ1');
    expect(kindsOf(events)).toEqual([
      'user',
      'assistant(1tc)',
      'tool(call_1)',
      'assistant(0tc)',
      'event(run_result)',
    ]);
    expect(toolPayload(events[2])?.content).toBe('echo:hi');
    // 投影真实驱动请求：第二请求含配对 tool 消息
    const toolMsg = llm.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toEqual({ role: 'tool', content: 'echo:hi', toolCallId: 'call_1' });
    // 工具定义随请求发送（echo 在列）
    expect(llm.requests[0]?.tools?.map((t) => t.function.name)).toEqual(['echo']);
    expect(llm.requests[1]?.tools?.map((t) => t.function.name)).toEqual(['echo']);
  });

  it('小窗口触发摘要：摘要作为 compaction 事件落盘、后续请求以摘要为系统消息；摘要后估算已回窗口内 → 防抖清零、两轮后正常 completed', async () => {
    const store = readyStore();
    const registry = defineRegistry([echoTool()], { sessionId: 'integ2' });
    const calls: string[] = [];
    const summarizer: ConversationSummarizer = async (request) => {
      calls.push(request.prompt);
      return `<summary>packed ${calls.length}</summary>`;
    };
    const llm = new FakeLlm([
      { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
      { content: 'done' },
    ]);

    const result = await run(
      { sessionId: 'integ2', task: TASK },
      { store, tools: registry, llm, model: 'test-model', windowTokens: 50, summarizer },
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);
    expect(calls).toHaveLength(2); // 两轮投影都触顶 → 摘要两次（把历史压进摘要，不重发原文）

    const events = await collectEvents(store, 'integ2');
    expect(kindsOf(events)).toEqual([
      'user',
      'event(compaction)',
      'assistant(1tc)',
      'tool(call_1)',
      'event(compaction)',
      'assistant(0tc)',
      'event(run_result)',
    ]);
    expect(eventPayload(events[1])?.type).toBe('compaction');
    expect((eventPayload(events[1])?.data as { summary?: string } | undefined)?.summary).toBe(
      'packed 1',
    );
    // 摘要后请求只见摘要系统消息（原始历史被折叠进摘要，不再重发原文）
    expect(llm.requests[0]?.messages).toEqual([{ role: 'system', content: 'packed 1' }]);
    expect(llm.requests[1]?.messages).toEqual([{ role: 'system', content: 'packed 2' }]);
    // 事件流永不被改写：原始 user 事件仍在
    expect(events[0]?.kind).toBe('user');
  });

  it('小窗口连续超限：摘要后估算仍超窗口 → 第 3 次摘要记录（恰在 2 次容忍之后）compaction-debounce，原因回注', async () => {
    const store = readyStore();
    const registry = defineRegistry([echoTool()], { sessionId: 'integ4' });
    const calls: string[] = [];
    const summarizer: ConversationSummarizer = async () => {
      calls.push('summarize');
      return `<summary>${'x'.repeat(300)}</summary>`; // 摘要体 ~84 token → 超窗口 50 → 压不收敛
    };
    const llm = new FakeLlm([
      { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"a"}' }] },
      { toolCalls: [{ id: 'call_2', name: 'echo', arguments: '{"text":"b"}' }] },
      { content: 'never reached' },
    ]);

    const result = await run(
      { sessionId: 'integ4', task: TASK },
      { store, tools: registry, llm, model: 'test-model', windowTokens: 50, summarizer },
    );

    expect(result.status).toBe('compaction-debounce');
    expect(result.steps).toBe(2); // 三轮投影触发摘要、两次查询后熔断（第 3 次记录 > 容忍 2 次）
    expect(calls).toHaveLength(3);
    expect(llm.requests).toHaveLength(2);
    expect(result.error).toMatch(/did not converge/); // 原因回注给用户

    const events = await collectEvents(store, 'integ4');
    expect(kindsOf(events)).toEqual([
      'user',
      'event(compaction)',
      'assistant(1tc)',
      'tool(call_1)',
      'event(compaction)',
      'assistant(1tc)',
      'tool(call_2)',
      'event(compaction)',
      'event(run_result)',
    ]);
    const rrData = eventPayload(events.at(-1))?.data as
      { status?: string; error?: string } | undefined;
    expect(rrData?.status).toBe('compaction-debounce');
    expect(rrData?.error).toMatch(/did not converge/); // run_result 载荷同样回注
  });

  it('中断占位模型语义：工具失败后自然结束（失败=普通消息，完成态）', async () => {
    const store = readyStore();
    const registry = defineRegistry([boomTool()], { sessionId: 'integ3' });
    const llm = new FakeLlm([
      { toolCalls: [{ id: 'call_1', name: 'boom', arguments: '{}' }] },
      { content: 'fine' },
    ]);
    const result = await run(
      { sessionId: 'integ3', task: TASK },
      { store, tools: registry, llm, model: 'test-model' },
    );
    expect(result.status).toBe('completed');
    const events = await collectEvents(store, 'integ3');
    const toolEv = events.find((ev) => ev.kind === 'tool');
    const parsed = JSON.parse(toolPayload(toolEv)?.content ?? '{}') as {
      ok: boolean;
      error: { type: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.type).toBe('boom');
  });
});
