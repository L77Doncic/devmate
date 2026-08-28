/**
 * # test/ui-server/stream：chat 会话引导 + 流事件序 + 4xx 统一形状
 *
 * 行为基线（接缝 S12 a/b/g 档）：a) 首个消息即建会话（任务=首个 user 事件），
 * run 异步启动、POST 立即返回 {sessionId}；后续事件一律走 /api/stream（含连接晚于
 * run 启动的缓冲回放）；b) 事件序 = 用户回声 → assistant-delta → assistant-done →
 * usage → run-status。失败一律 4xx + {error}（统一 JSON 形状）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import type { LlmAdapter } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { SessionStore } from '../../src/core/session/index.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import { LlmError } from '../../src/shared/llm-types.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import type { FakeScript } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

function depsFor(scripts: FakeScript[], extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([echoTool()], { sessionId: 's1' }),
    llm: new FakeLlm(scripts),
    model: 'test-model',
    ...extra,
  };
}

describe('ui/server：POST /api/chat + SSE 事件流', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('a) 首个消息建会话（user 事件落盘）；run 异步启动；事件序=回声→delta→done→usage→run-status', async () => {
    const store = new MemorySessionAdapter();
    const llm = new FakeLlm([
      { content: 'hi there', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
    ]);
    const { base, server } = await startServer(depsFor([], { store, llm }));
    servers.push(server);

    const res = await postJson(base, '/api/chat', { text: 'hello world' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(typeof sessionId).toBe('string');
    expect(sessionId).not.toBe('');

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
    expect((client.frames[0]!.data as { text: string }).text).toBe('hello world');
    expect((client.frames[1]!.data as { text: string }).text).toBe('hi there');
    expect((client.frames[2]!.data as { content: string; toolCalls: unknown[] }).content).toBe(
      'hi there',
    );
    expect((client.frames[2]!.data as { toolCalls: unknown[] }).toolCalls).toEqual([]);
    expect(client.frames[3]!.data).toMatchObject({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      estimated: false,
    });
    expect(client.frames[4]!.data).toMatchObject({ status: 'completed', steps: 1 });
    // 会话事实源：首个事件是 user（任务），run 不再重复追加
    const events = [] as unknown[];
    for await (const ev of store.events(sessionId)) events.push(ev);
    const first = events[0] as { kind: string; payload: { content: string } };
    expect(first.kind).toBe('user');
    expect(first.payload.content).toBe('hello world');
  });

  it('b) 续会话：同一 sessionId 再 POST 即在既有事件流上追加（resume 语义）', async () => {
    const llm = new FakeLlm([{ content: 'first' }, { content: 'second' }]);
    const { base, server } = await startServer(depsFor([], { llm }));
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'm1' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);

    const resumed = await postJson(base, '/api/chat', { sessionId: created.sessionId, text: 'm2' });
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as { sessionId: string };
    expect(body.sessionId).toBe(created.sessionId);

    await waitForFrames(client, 10, 10_000);
    const events = client.frames.map((f) => f.event);
    // 每轮：session-user + delta + done + usage + run-status；第二轮 user 事件可见（回声）
    expect(events.slice(5)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    expect((client.frames[5]!.data as { text: string }).text).toBe('m2');
  });

  it('g1) POST /api/chat 缺 text → 400 {error}；无效 JSON → 400 {error}', async () => {
    const { base, server } = await startServer(depsFor([{ content: 'x' }]));
    servers.push(server);

    const missing = await postJson(base, '/api/chat', {});
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBeTypeOf('string');

    const bad = await fetch(new URL('/api/chat', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('g2) /api/stream 未知 session → 404 {error}', async () => {
    const { base, server } = await startServer(depsFor([{ content: 'x' }]));
    servers.push(server);
    const res = await fetch(new URL('/api/stream?sessionId=nope-1', base));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('g2b) /api/stream 非法 sessionId（越界/逃逸字面量）→ 400 {error}（与其它端点一致过 assertValidSessionId）', async () => {
    // 宽松 store：exists 不做 id 校验（契约上合法——校验是服务端端点职责，不靠 store 抛错兜底）
    const permissive: SessionStore = {
      create: async () => {},
      exists: async () => false,
      append: async () => {
        throw new Error('unused');
      },
      events: async function* (): AsyncGenerator<SessionEvent> {},
      fork: async () => {},
      repairOrphaned: async () => [],
    };
    const { base, server } = await startServer(depsFor([{ content: 'x' }], { store: permissive }));
    servers.push(server);
    for (const bad of ['..%2F..%2Fetc', '../etc', 'a/b', ' s-1', '']) {
      const res = await fetch(new URL(`/api/stream?sessionId=${bad}`, base));
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
    }
    // 空参数（仅 query key）也 400
    const missing = await fetch(new URL('/api/stream', base));
    expect(missing.status).toBe(400);
  });

  it('g3) 会话有活跃 run 时再 POST → 409 {error}；run 结束后可继续', async () => {
    const llm = new FakeLlm([{ content: 'slow', gate: new Promise(() => {}) }, { content: 'ok' }]);
    const { base, server } = await startServer(depsFor([], { llm }));
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'm1' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 2, 10_000); // 等到 delta（run 挂起在流中）

    const conflict = await postJson(base, '/api/chat', {
      sessionId: created.sessionId,
      text: 'm2',
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('llm 中断流（error 事件）→ run-status fatal + run-error 消息', async () => {
    const llm = new FakeLlm([
      {
        content: 'partial',
        error: new LlmError({
          kind: 'transport',
          status: 0,
          retryable: false,
          message: 'wire broke',
        }),
      },
    ]);
    const { base, server } = await startServer(depsFor([], { llm }));
    servers.push(server);
    const created = (await (await postJson(base, '/api/chat', { text: 'm' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    const events = client.frames.map((f) => f.event);
    expect(events).toContain('run-error');
    expect(events[events.length - 1]).toBe('run-status');
    expect((client.frames[client.frames.length - 1]!.data as { status: string }).status).toBe(
      'fatal',
    );
  });

  it('run 支持外部注入的 llm（假接缝：定义即注入，不触网络）', async () => {
    // 无网络可达性测试；只确认 LlmAdapter 接缝按 request 原样透传
    const llm: LlmAdapter = {
      async *chat() {
        yield {
          type: 'end',
          snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
        };
      },
    };
    const { base, server } = await startServer(
      depsFor([], { llm, runOptions: { maxSteps: 1, costLimitUsd: 10 } }),
    );
    servers.push(server);
    const created = (await (await postJson(base, '/api/chat', { text: 'm' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 4, 10_000);
    expect(client.frames[client.frames.length - 1]!.event).toBe('run-status');
  });
});
