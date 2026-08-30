/**
 * # test/loop/context-overflow：E7 超限自愈链（400 → 不再 fatal）+ E8 输出截断提示（ADR-0016）
 *
 * 蓝本 = .scratch/coding-agent/research/limits-effects-and-overflow.md B.c（400 现行 fatal 缺口）
 * + C.2 M2/M3/L3。红→绿锚点：本文件在实现前运行 = 现状（runTurn 400 → fatal）全红；
 * 实现后全绿（不倒退既有 1771/1）。
 *
 * 行为契约（实现裁决）：
 * - 命中「上下文超窗（context-exceeded）」→ 本 turn 不 fatal：升级压缩（forceLevel 0→1→2，
 *   升到 2 再失败 → fatal，即 ≤2 次/轮重试）后重试同一轮；升级在成功轮（tool-round/continue）
 *   后归零（跨轮重置——「≤2 次/轮」语义）。
 * - 学习：解析出的 hintMax 记为该 run 的窗口预算（min 钳制）与输出上限（min 钳制），
 *   并经 RunOptions.onLimitsError 上报（服务端会话级记账/UI 注记）。
 * - output-limit（max_tokens 区间错）→ 同链把 maxTokens 钳为 hintMax 后重试。
 * - 重试计入步数/成本（steps 逐轮 +1），不触熔断（格式错误计数无关）。
 * - E8：finish_reason='length' → 注入系统样式「更简洁」提示 + 续跑一次（≤1 次/run）；
 *   「纯提示，不自动重发」——不自动重发同一请求，模型自然续跑（新请求、正常计步）。
 */
import { describe, expect, it } from 'vitest';
import { LlmError } from '../../src/shared/llm-types.js';
import { defineRegistry, run, TRUNCATION_HINT_USER_CONTENT } from '../../src/core/loop/index.js';
import type { RunOptions } from '../../src/core/loop/index.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import { collectEvents, echoTool, FakeLlm, readyStore } from './support.js';
import type { MemorySessionAdapter } from '../../src/core/session/index.js';

function http400(message: string): LlmError {
  return new LlmError({ kind: 'http', status: 400, retryable: false, message });
}

/** OpenAI 形状上下文超窗 400（hintMax=1024000）。 */
const CONTEXT_400 = http400(
  "This model's maximum context length is 1024000 tokens. However, your messages resulted in 200000 tokens. Please reduce the length of the messages.",
);
/** DeepSeek 实测形状输出区间 400（[1, 393216]）。 */
const OUTPUT_400 = http400(
  'Invalid max_tokens value, the valid range of max_tokens is [1, 393216]',
);

/** 大会话（5 组 ls 工具对 + 首条 user）：forceLevel=1 裁剪会把旧 2 组清出（投影消息变少）。 */
async function seededOverflowStore(): Promise<MemorySessionAdapter> {
  const store = readyStore();
  await store.create('s1');
  await store.append('s1', { kind: 'user', payload: { content: 'task' } });
  for (let i = 1; i <= 5; i += 1) {
    await store.append('s1', {
      kind: 'assistant',
      payload: { content: '', toolCalls: [{ id: `c${i}`, name: 'ls', arguments: '{}' }] },
    });
    await store.append('s1', {
      kind: 'tool',
      payload: { toolCallId: `c${i}`, content: 'z'.repeat(100) + `#${i}` },
    });
  }
  return store;
}

/** 运行单个 run（测试共用口径：echo 单工具、无窗口、无摘要器；opts 先展开、必要键后覆盖）。 */
function runOnce(llm: FakeLlm, store: MemorySessionAdapter, opts: Partial<RunOptions> = {}) {
  return run(
    { sessionId: 's1', task: 'go' },
    {
      ...opts,
      store,
      tools: defineRegistry([echoTool()], { sessionId: 's1' }),
      llm,
      model: 'm',
    },
  );
}

describe('E7 超限自愈链（ADR-0016）：context 400 不死、升级重试转绿', () => {
  it('context-exceeded 400 → 一次重试（forceLevel=1 裁剪）+ 转 green；重试计入步数', async () => {
    const llm = new FakeLlm([
      { error: CONTEXT_400 },
      // 第二次请求：被裁剪后的投影 → 正常流结束（无工具调用）
      { content: 'recovered' },
    ]);
    const store = await seededOverflowStore();
    const result = await runOnce(llm, store);

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2); // 失败轮 + 重试轮：计入步数
    expect(llm.requests).toHaveLength(2);
    const req0 = llm.requests[0]!;
    const req1 = llm.requests[1]!;
    // forceLevel=1 裁剪生效：旧组工具结果被替换为占位符（首轮无占位符）
    const prunedInRetry = req1.messages.filter(
      (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('removed'),
    );
    expect(prunedInRetry.length).toBeGreaterThan(0);
    expect(
      req0.messages.filter(
        (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('removed'),
      ),
    ).toHaveLength(0);
  });

  it('学习 hintMax（窗口 1024000）经 onLimitsError 上报（服务端记账/UI 注记的数据源）', async () => {
    const learnings: Array<Record<string, unknown>> = [];
    const llm = new FakeLlm([{ error: CONTEXT_400 }, { content: 'ok' }]);
    const store = await seededOverflowStore();
    const result = await runOnce(llm, store, {
      onLimitsError: (learning) => {
        learnings.push({ ...learning });
      },
    });
    expect(result.status).toBe('completed');
    expect(learnings).toEqual([
      {
        kind: 'context-exceeded',
        message: CONTEXT_400.message,
        hintMax: 1_024_000,
        escalation: 1,
      },
    ]);
  });

  it('升级上限：连续 context 400 → 0→1→2 各一次后 fatal（≤2 次/轮），errorMessage 保留原始信息', async () => {
    const llm = new FakeLlm([
      { error: CONTEXT_400 },
      { error: CONTEXT_400 },
      { error: CONTEXT_400 },
    ]);
    const store = await seededOverflowStore();
    const result = await runOnce(llm, store);
    expect(result.status).toBe('fatal');
    expect(result.error).toContain('maximum context length'); // 原始 message 上达
    expect(llm.requests).toHaveLength(3);
  });

  it('output-limit（max_tokens 区间错）→ 重试钳 maxTokens=hintMax（393216）', async () => {
    const llm = new FakeLlm([
      { error: OUTPUT_400 },
      { content: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);
    const store = readyStore(); // 无大会话（不涉裁剪断言）
    const result = await runOnce(llm, store, { maxTokens: 500_000 });
    expect(result.status).toBe('completed');
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]!.maxTokens).toBe(500_000);
    expect(llm.requests[1]!.maxTokens).toBe(393_216); // 同链钳制后重试
  });

  it('跨轮重置：成功工具轮后升级归零（失败序列在下一轮重新 0→1→2）', async () => {
    const llm = new FakeLlm([
      { error: CONTEXT_400 }, // 轮 1：升到 1
      {
        content: 'tool',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"x"}' }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }, // 轮 1 重试成功 → 工具轮 → 升级归零
      { error: CONTEXT_400 }, // 轮 2：重新 0→1
      { error: CONTEXT_400 }, // 轮 2：1→2
      { error: CONTEXT_400 }, // 轮 2：2 → fatal
    ]);
    const store = readyStore();
    const result = await runOnce(llm, store);
    expect(result.status).toBe('fatal');
    expect(llm.requests).toHaveLength(5); // 若升级不重置则为 4
    expect(result.steps).toBe(5);
  });

  it('非超限 fatal（API key 错等）不触发链（保留 400 fatal 语义）', async () => {
    const err = http400('Invalid API key provided');
    const llm = new FakeLlm([{ error: err }]);
    const store = readyStore();
    const result = await runOnce(llm, store);
    expect(result.status).toBe('fatal');
    expect(llm.requests).toHaveLength(1);
  });
});

describe('E8 输出截断提示（finish_reason=length；ADR-0016 L3）', () => {
  it('length → 注入系统用户提示「更简洁」+ 续跑一次（≤1 次）；纯提示不自动重发', async () => {
    const llm = new FakeLlm([
      {
        content: 'LONG-'.repeat(200),
        finishReason: 'length',
        usage: { promptTokens: 1, completionTokens: 16, totalTokens: 17 },
      },
      { content: '短答复', usage: { promptTokens: 1, completionTokens: 5, totalTokens: 6 } },
    ]);
    const store = readyStore();
    const result = await runOnce(llm, store);
    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2); // 续跑一次（新请求、正常计步）
    expect(llm.requests).toHaveLength(2);

    const events = await collectEvents(store, 's1');
    const userEvents = events.filter(
      (ev): ev is Extract<SessionEvent, { kind: 'user' }> => ev.kind === 'user',
    );
    const hint = userEvents.find((ev) => ev.payload.content === TRUNCATION_HINT_USER_CONTENT);
    expect(hint).toBeDefined();
    expect(hint!.meta?.system).toBe(true); // 系统样式
    // 续跑不自动重发：第二条请求是全新内容，非原样重放
    expect(llm.requests[1]!.messages).not.toEqual(llm.requests[0]!.messages);
  });

  it('length 提示只注入一次（第二次 length 不再注入，自然结束）', async () => {
    const llm = new FakeLlm([
      {
        content: 'LONG-'.repeat(200),
        finishReason: 'length',
        usage: { promptTokens: 1, completionTokens: 16, totalTokens: 17 },
      },
      {
        content: '还是长',
        finishReason: 'length',
        usage: { promptTokens: 1, completionTokens: 16, totalTokens: 17 },
      },
    ]);
    const store = readyStore();
    const result = await runOnce(llm, store);
    expect(result.status).toBe('completed');
    expect(llm.requests).toHaveLength(2); // 第二次 length 不再续跑
    const events = await collectEvents(store, 's1');
    const userEvents = events.filter(
      (ev): ev is Extract<SessionEvent, { kind: 'user' }> => ev.kind === 'user',
    );
    expect(
      userEvents.filter((ev) => ev.payload.content === TRUNCATION_HINT_USER_CONTENT),
    ).toHaveLength(1);
  });

  it('退出提示不注入零输出 length 空轮（length + 空 content：仍注入——截断事实宣告）', async () => {
    // 空 content 的 length 表示「0 输出即被截断」（如 max_tokens 过小）——同样应提示
    const llm = new FakeLlm([
      {
        content: '',
        finishReason: 'length',
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      },
      { content: '短' },
    ]);
    const store = readyStore();
    const result = await runOnce(llm, store);
    expect(result.status).toBe('completed');
    expect(llm.requests).toHaveLength(2);
  });
});
