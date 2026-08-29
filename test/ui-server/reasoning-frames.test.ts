/**
 * # test/ui-server/reasoning-frames：reasoning 协议帧（Wave 2；接缝 S12）
 *
 * Wave 2 契约（CTO 协议 11 类帧新增 reasoning；前端 messages.js 消费增量帧）：
 * - 流内（在线）：llm tee 把 StreamEvent{type:'reasoning'} 逐条镜像为 reasoning{text} 增量帧
 *   （模型边思考边推送；帧序 = 流内增量序）。存储侧整轮推理全文事件（kind:'reasoning'）
 *   追加时经 store 观察器只推**尚未推送的尾部增量**（观察器模式与 compaction 同源；
 *   对账基线 ctx.pendingReasoning）——与 tee 已推内容同前缀 → 不重发（唯一来源防重）。
 * - 历史（GET /api/sessions/:id）：reasoning 事件折叠为**一条** {text: 完整推理正文}
 *   帧，按事件序置于其 assistant 之前；正文 ≤ REASONING_TEXT_CAP（20k）截断注记。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import {
  REASONING_TEXT_CAP,
  REASONING_TRUNCATED_MARK,
  reasoningDeltaOf,
  reasoningFrameText,
} from '../../src/ui/server/index.js';
import type { SseEventData } from '../../src/ui/server/emit.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

function depsFor(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'ok' }]),
    model: 'test-model',
    ...extra,
  };
}

describe('ui/server：reasoning 帧（在线流）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('s1) 流内增量序列：每条 reasoning 分片即一帧（帧序=增量序），存储全文事件不重发（去重防双份）', async () => {
    const store = new MemorySessionAdapter();
    const llm = new FakeLlm([
      {
        reasoning: ['I am ', 'thinking', ' hard'],
        content: 'done',
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      },
    ]);
    const { base, server } = await startServer(depsFor({ store, llm }));
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'ask' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 8, 10_000);

    // 帧序：user 回声 → 思考增量×3（逐条）→ 正文 delta → done → usage → run-status
    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'reasoning',
      'reasoning',
      'reasoning',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    const reasoning = client.frames
      .filter((f) => f.event === 'reasoning')
      .map((f) => (f.data as { text: string }).text);
    // 恰为三个阶段增量，无「整轮全文」重复帧（存储事件经观察器对账后零重发）
    expect(reasoning).toEqual(['I am ', 'thinking', ' hard']);
    // 事实源：推理全文一条落盘（kind 'reasoning'；payload.content = 拼接全文）
    const kinds: string[] = [];
    const contents: string[] = [];
    for await (const ev of store.events(created.sessionId)) {
      kinds.push(ev.kind);
      if (ev.kind === 'reasoning') contents.push(ev.payload.content);
    }
    expect(kinds).toContain('reasoning');
    expect(contents).toEqual(['I am thinking hard']);
  });

  it('s2) 跨轮次增量序列：第二轮推理重新从头计（不跨轮污染），每段正文恰好一帧组', async () => {
    const llm = new FakeLlm([
      { reasoning: ['alpha'], content: 'first' },
      { reasoning: ['beta ', 'again'], content: 'second' },
    ]);
    const { base, server } = await startServer(depsFor({ llm }));
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'm1' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);

    const resumed = await postJson(base, '/api/chat', {
      sessionId: created.sessionId,
      text: 'm2',
    });
    expect(resumed.status).toBe(200);
    // 两轮共 13 帧：6（首轮）+ 7（续轮：user 回声 + 推理×2 + delta + done + usage + run-status）
    await waitForFrames(client, 13, 10_000);

    const reasoning = client.frames
      .filter((f) => f.event === 'reasoning')
      .map((f) => (f.data as { text: string }).text);
    // 第二轮基线已清零：'beta '、'again' 逐条推送（而非把 'alpha' 计为已推基线而吞掉）
    expect(reasoning).toEqual(['alpha', 'beta ', 'again']);
  });

  it('s3) reasoningDeltaOf 纯函数：未推送→全文；同前缀→尾部增量；两源漂移→全文兜底', () => {
    expect(reasoningDeltaOf('full text', '')).toBe('full text');
    expect(reasoningDeltaOf('abcdef', 'abc')).toBe('def');
    expect(reasoningDeltaOf('abcd', 'ab')).toBe('cd');
    // 已全部推送 → 无增量（存储事件不重发）
    expect(reasoningDeltaOf('abc', 'abc')).toBe('');
    // 漂移（前缀不匹配——正常不可达）：兜底全文
    expect(reasoningDeltaOf('abc', 'xyz')).toBe('abc');
    // 空文本不产生空帧
    expect(reasoningDeltaOf('', '')).toBe('');
  });
});

describe('ui/server：reasoning 帧（历史回放 GET /api/sessions/:id）', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  async function detailOf(store: MemorySessionAdapter, sessionId: string): Promise<SseEventData[]> {
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);
    const res = await fetch(new URL(`/api/sessions/${sessionId}`, base));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SseEventData[] };
    return body.events;
  }

  it('r1) 回放折叠：连续多条 reasoning 事件折叠为一条（完整正文 = 拼接），置于其 assistant 之前', async () => {
    const store = new MemorySessionAdapter();
    await store.create('s-r');
    await store.append('s-r', { kind: 'user', payload: { content: '你好' } });
    // 同一 assistant 预案：两条相邻推理事件（防御形状）→ 折叠为一条帧
    await store.append('s-r', { kind: 'reasoning', payload: { content: '思考第一段。' } });
    await store.append('s-r', { kind: 'reasoning', payload: { content: '继续第二段。' } });
    await store.append('s-r', {
      kind: 'assistant',
      payload: { content: '给定答案', toolCalls: [] },
    });
    // 下一轮：单条推理事件 → 单条折叠帧（不再合并到上一轮）
    await store.append('s-r', { kind: 'reasoning', payload: { content: '第二轮推理' } });
    await store.append('s-r', {
      kind: 'assistant',
      payload: { content: '第二轮答案', toolCalls: [] },
    });

    const events = await detailOf(store, 's-r');
    expect(events.map((f) => f.event)).toEqual([
      'session-user',
      'reasoning',
      'assistant-done',
      'reasoning',
      'assistant-done',
    ]);
    expect(events[1]).toEqual({ event: 'reasoning', data: { text: '思考第一段。继续第二段。' } });
    expect(events[2]!.data).toEqual({ content: '给定答案', toolCalls: [] });
    expect(events[3]).toEqual({ event: 'reasoning', data: { text: '第二轮推理' } });
  });

  it('r2) 20k 护栏：正文超上限 → 截断 + 注记；恰逢上限不截断', () => {
    const mark = REASONING_TRUNCATED_MARK;
    expect(reasoningFrameText('x'.repeat(REASONING_TEXT_CAP + 5))).toBe(
      'x'.repeat(REASONING_TEXT_CAP) + mark,
    );
    expect(reasoningFrameText('x'.repeat(REASONING_TEXT_CAP - 1))).toBe(
      'x'.repeat(REASONING_TEXT_CAP - 1),
    );
    expect(reasoningFrameText('x'.repeat(REASONING_TEXT_CAP))).toBe('x'.repeat(REASONING_TEXT_CAP));
    // 与前端展示护栏同值（format.js THINK_TEXT_CAP = 20_000；双端同规防 20k 差一）
    expect(REASONING_TEXT_CAP).toBe(20_000);
  });

  it('r3) 回放截断：超限正文经事件流映射为「截断 + 注记」一条帧', async () => {
    const store = new MemorySessionAdapter();
    await store.create('s-cap');
    await store.append('s-cap', { kind: 'user', payload: { content: 'hi' } });
    const long = 'y'.repeat(REASONING_TEXT_CAP + 123);
    await store.append('s-cap', { kind: 'reasoning', payload: { content: long } });
    await store.append('s-cap', {
      kind: 'assistant',
      payload: { content: 'answer', toolCalls: [] },
    });

    const events = await detailOf(store, 's-cap');
    expect(events.map((f) => f.event)).toEqual(['session-user', 'reasoning', 'assistant-done']);
    const text = events[1]!.data as { text: string };
    expect(text.text.length).toBe(REASONING_TEXT_CAP + REASONING_TRUNCATED_MARK.length);
    expect(text.text.endsWith(REASONING_TRUNCATED_MARK)).toBe(true);
    expect(text.text.slice(0, REASONING_TEXT_CAP)).toBe('y'.repeat(REASONING_TEXT_CAP));
  });
});
