/**
 * # test/ui-server/compaction：上下文压缩披露（compaction 帧 / 接缝 S12）
 *
 * 事件源（S5 loop）：摘要写入会话事件流——kind 'event'、payload.type 'compaction'、
 * data.summary（+ 可选 data.tokensBefore/tokensAfter 估算，前端 sessions.js 同构）。
 * 服务端映射为协议 compaction 帧（summary 全文 + 可选 token 估算）：
 * - 流内（观察器实时）：compaction 事件追加 → compaction 帧推给订阅者（顺序 = 事件序）；
 * - 历史（GET /api/sessions/:id）：事件流映射回 compaction 帧（<500 帧窗口内）；
 * - 不含 compaction 事件 → 不发该帧；旧/异常形状（其他 event type、无 data、
 *   非 number token 字段）不崩、不误发、字段按前端同规降级。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
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

describe('ui/server：compaction 帧（流内实时）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('c1) S5 摘要写入事件流 → 订阅者收到 compaction 帧（summary 全文；事件未写 token 估算故无该键）', async () => {
    const store = new MemorySessionAdapter();
    await store.create('s-1');
    // 触发手算（与 context/summary.test 同径）：user 5200 字符 = 1300 token + 5 组工具轮 195
    // + 11 条消息结构 36 = 1531 > compactTrigger 1440（windowTokens 2000）→ 摘要执行
    await store.append('s-1', { kind: 'user', payload: { content: 'a'.repeat(5200) } });
    for (let i = 1; i <= 5; i += 1) {
      await store.append('s-1', {
        kind: 'assistant',
        payload: { content: '', toolCalls: [{ id: `c${i}`, name: 'ls', arguments: '{}' }] },
      });
      await store.append('s-1', {
        kind: 'tool',
        payload: { toolCallId: `c${i}`, content: 'z'.repeat(100) + `#${i}` },
      });
    }
    const summarizer = (): string => `<summary>${'a'.repeat(50)}</summary>`;
    const { base, server } = await startServer(
      depsFor({ store, runOptions: { windowTokens: 2000, summarizer } }),
    );
    servers.push(server);

    const res = await postJson(base, '/api/chat', { sessionId: 's-1', text: 'resume' });
    expect(res.status).toBe(200);
    const client = await SseClient.connect(base, 's-1');
    clients.push(client);
    await waitForFrames(client, 6, 10_000);

    // 事件序：user 回声 →（投影摘要随即落盘并镜像为帧）compaction → 本轮响应收尾
    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'compaction',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    // agent.ts 只写 data.summary（tokenBefore/After 在投影 stats 中，未进事件）→ 帧不带该键
    expect(client.frames[1]!.data).toEqual({ summary: 'a'.repeat(50) });
    // 会话事实源：compaction 事件确已落盘（kind 'event'、type 'compaction'）
    const kinds: string[] = [];
    for await (const ev of store.events('s-1'))
      kinds.push(`${ev.kind}:${ev.kind === 'event' ? ev.payload.type : ''}`);
    expect(kinds).toContain('event:compaction');
  });

  it('c2) 无 compaction 事件 → 流不含 compaction 帧', async () => {
    const llm = new FakeLlm([{ content: 'hi' }]);
    const { base, server } = await startServer(depsFor({ llm }));
    servers.push(server);

    const res = await postJson(base, '/api/chat', { text: 'hello' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);

    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    expect(client.frames.some((f) => f.event === 'compaction')).toBe(false);
  });
});

describe('ui/server：compaction 帧（历史映射 GET /api/sessions/:id）', () => {
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

  it('c3) compaction 事件 → compaction 帧（summary + tokensBefore/tokensAfter 保真，事件序不挪位）', async () => {
    const store = new MemorySessionAdapter();
    await store.create('s-c');
    await store.append('s-c', { kind: 'user', payload: { content: '你好' } });
    await store.append('s-c', {
      kind: 'event',
      payload: {
        type: 'compaction',
        data: { summary: '摘要文本', tokensBefore: 120_000, tokensAfter: 45_000 },
      },
    });
    await store.append('s-c', { kind: 'user', payload: { content: '继续' } });

    const events = await detailOf(store, 's-c');
    expect(events.map((f) => f.event)).toEqual(['session-user', 'compaction', 'session-user']);
    expect(events[1]).toEqual({
      event: 'compaction',
      data: { summary: '摘要文本', tokensBefore: 120_000, tokensAfter: 45_000 },
    });
  });

  it('c4) 旧/异常形状不崩：非 compaction event 类型不发帧；无 data 的压缩记录降级为 summary 空串帧；非 number token 字段剔除', async () => {
    const store = new MemorySessionAdapter();
    await store.create('s-old');
    await store.append('s-old', { kind: 'user', payload: { content: 'hi' } });
    // 映射前的 event 类型（协议无帧 → 丢弃，不 500）
    await store.append('s-old', {
      kind: 'event',
      payload: { type: 'projection_changed', data: { x: 1 } },
    });
    // 旧形状：只有 type，无 data（前端折行显示「上下文已压缩」）
    await store.append('s-old', { kind: 'event', payload: { type: 'compaction' } });
    // 异常字段：tokensBefore 为字符串（仅 number 复制，同前端 toProtocolEvent 规）
    await store.append('s-old', {
      kind: 'event',
      payload: { type: 'compaction', data: { summary: 's2', tokensBefore: '120000' } },
    });
    await store.append('s-old', { kind: 'user', payload: { content: 'later' } });

    const events = await detailOf(store, 's-old');
    expect(events.map((f) => f.event)).toEqual([
      'session-user',
      'compaction',
      'compaction',
      'session-user',
    ]);
    expect(events[1]!.data).toEqual({ summary: '' });
    expect(events[2]!.data).toEqual({ summary: 's2' });
  });
});
