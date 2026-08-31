/**
 * # test/ui-server/sessions：会话列表 CRUD（接缝 S12 延伸 A 档）
 *
 * - GET /api/sessions → {sessions:[{sessionId,title,createdAtMs,lastEventMs,stepCount?}]}：
 *   title=首条 user 事件前 40 字符（中文按字符）或 （空会话）；按 lastEventMs 倒序；
 *   lister 由 deps 注入（服务端不直接 fs）。
 * - GET /api/sessions/:id → {sessionId,title,events:[…协议形状帧…]}：事件流映射回
 *   session-user / assistant-done(toolCalls) / tool-start / tool-result；404 统一 {error}；
 *   超出 500 帧只返回最近 500 帧（按帧计 + 剧集边界对齐，见 d6 组）。
 * - POST /api/sessions {text?} → 新建（空或带首消息）→ {sessionId}（不启动 run）。
 * - DELETE /api/sessions/:id → 删文件 + 清 broker/审批挂起/shell（deps.disposeSession 回调）
 *   → {ok:true}；活跃 run → 409；404 统一 {error}。
 */
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { JsonlFileAdapter, MemorySessionAdapter } from '../../src/core/session/index.js';
import type {
  DevmateServer,
  DevmateServerDeps,
  SessionSummary,
} from '../../src/ui/server/index.js';
import { assembleDeps } from '../../src/ui/server/deps.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

const CHINESE_LONG =
  '你好，世界！这是一个用于验证标题按字符裁剪的中文长句子，超过四十个字符就应该被截断了。';

function depsFor(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([echoTool()], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    ...extra,
  };
}

/** 按索引长出的摘要（lastEventMs = 100 * i，方便断言排序）。 */
function summaryAt(i: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: `s-${i}`,
    title: `会话 ${i}`,
    createdAtMs: 100 * i,
    lastEventMs: 100 * i + 50,
    stepCount: i,
    ...extra,
  };
}

describe('ui/server：会话列表 GET /api/sessions', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('l1) 注入 lister 的摘要按 lastEventMs 倒序返回（形状完整）', async () => {
    const lister = vi.fn(async (): Promise<SessionSummary[]> => {
      // 故意乱序：服务端排序；a 在 b 前
      return [summaryAt(2), summaryAt(1), summaryAt(3)];
    });
    const { base, server } = await startServer(depsFor({ sessionLister: lister }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions', base));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: SessionSummary[] };
    expect(body.sessions).toHaveLength(3);
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['s-3', 's-2', 's-1']);
    expect(body.sessions[0]).toEqual(summaryAt(3));
    expect(body.sessions[0]).toMatchObject({ sessionId: 's-3', title: '会话 3' });
  });

  it('l2) 空列表：{sessions: []}', async () => {
    const { base, server } = await startServer(depsFor({ sessionLister: async () => [] }));
    servers.push(server);
    const res = await fetch(new URL('/api/sessions', base));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });

  it('l3) 注入 lister 缺失回退空列表（不 500，服务端不直接 fs）', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);
    const res = await fetch(new URL('/api/sessions', base));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });

  it('l4) deps 装配的 sessionLister：真 JSONL 目录扫描；中文标题按字符裁 40；空会话（空会话）；stepCount=assistant 数', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-sessions-list-'));
    tempDirs.push(dir);
    const deps = await assembleDeps({ workspaceRoot: dir, sessionsDir: dir, model: 'm-x' });
    const store = deps.store;
    // 会话 1：长中文首消息（>40 字符）
    await store.create('s-cn');
    await store.append('s-cn', { kind: 'user', payload: { content: CHINESE_LONG } });
    await store.append('s-cn', {
      kind: 'assistant',
      payload: { content: '好', toolCalls: [] },
    });
    // 会话 2：空会话（只有 create 有文件，无事件）
    await store.create('s-empty');
    // 会话 3：单行 user（标题=原文）
    await store.create('s-short');
    await store.append('s-short', { kind: 'user', payload: { content: '短标题' } });

    const listed = await deps.sessionLister!();
    const cn = listed.find((s) => s.sessionId === 's-cn');
    const empty = listed.find((s) => s.sessionId === 's-empty');
    const short = listed.find((s) => s.sessionId === 's-short');
    expect(cn).toBeDefined();
    expect(cn!.title).toBe(CHINESE_LONG.slice(0, 40));
    expect(cn!.title.length).toBe(40);
    expect(cn!.stepCount).toBe(1);
    expect(typeof cn!.createdAtMs).toBe('number');
    expect(cn!.createdAtMs).toBeGreaterThan(0);
    expect(cn!.lastEventMs).toBeGreaterThanOrEqual(cn!.createdAtMs);
    expect(empty!.title).toBe('（空会话）');
    expect(empty!.stepCount).toBe(0);
    expect(empty!.lastEventMs).toBeGreaterThan(0); // 空文件回退 mtime
    expect(short!.title).toBe('短标题');
  });
});

describe('ui/server：会话详情 GET /api/sessions/:id', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  async function seedStore(
    events: Array<
      | { kind: 'user'; payload: { content: string } }
      | {
          kind: 'assistant';
          payload: {
            content: string;
            toolCalls: Array<{ id: string; name: string; arguments: string }>;
          };
        }
      | { kind: 'tool'; payload: { toolCallId: string; content: string } }
      | { kind: 'event'; payload: { type: string; data?: Record<string, unknown> } }
    >,
  ) {
    const store = new MemorySessionAdapter();
    await store.create('s-1');
    for (const ev of events) {
      await store.append('s-1', ev as never);
    }
    return store;
  }

  it('d1) 会话事件映射为协议帧：session-user / assistant-done(toolCalls) / tool-start / tool-result', async () => {
    const store = await seedStore([
      { kind: 'user', payload: { content: 'hello world' } },
      {
        kind: 'assistant',
        payload: {
          content: 'hi',
          toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{"text":"a"}' }],
        },
      },
      { kind: 'tool', payload: { toolCallId: 'call-1', content: 'echo:a' } },
    ]);
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions/s-1', base));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      title: string;
      events: Array<{ event: string; data: Record<string, unknown> }>;
    };
    expect(body.sessionId).toBe('s-1');
    expect(body.title).toBe('hello world');
    expect(body.events.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-done',
      'tool-start',
      'tool-result',
    ]);
    expect(body.events[0]!.data).toEqual({ text: 'hello world' });
    const done = body.events[1]!.data;
    expect(done.content).toBe('hi');
    expect(done.toolCalls).toEqual([{ id: 'call-1', name: 'echo', arguments: '{"text":"a"}' }]);
    expect(body.events[2]!.data).toEqual({
      id: 'call-1',
      name: 'echo',
      arguments: '{"text":"a"}',
    });
    expect(body.events[3]!.data).toMatchObject({
      id: 'call-1',
      name: 'echo',
      ok: true,
      contentPreview: 'echo:a',
      content: 'echo:a',
    });
  });

  it('d2) 未知会话 → 404 {error}', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);
    const res = await fetch(new URL('/api/sessions/nope-1', base));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('d3) 标题规则：首条 user 前 40 字符（中文按字符）；无 user 事件 → （空会话）且 events 空', async () => {
    const store = await seedStore([{ kind: 'user', payload: { content: CHINESE_LONG } }]);
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const detail = (await (await fetch(new URL('/api/sessions/s-1', base))).json()) as {
      title: string;
    };
    expect(detail.title).toBe(CHINESE_LONG.slice(0, 40));
    expect(detail.title.length).toBe(40);

    const emptyStore = new MemorySessionAdapter();
    await emptyStore.create('s-empty');
    const second = await startServer(depsFor({ store: emptyStore }));
    servers.push(second.server);
    const empty = (await (await fetch(new URL('/api/sessions/s-empty', second.base))).json()) as {
      title: string;
      events: unknown[];
    };
    expect(empty.title).toBe('（空会话）');
    expect(empty.events).toEqual([]);
  });

  it('d4) 超出 500 帧只返回最近 500 帧（450+ 场景；前序事件被裁剪）', async () => {
    const store = new MemorySessionAdapter();
    await store.create('s-big');
    for (let i = 1; i <= 550; i += 1) {
      await store.append('s-big', { kind: 'user', payload: { content: `msg-${i}` } });
    }
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions/s-big', base));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string;
      events: Array<{ event: string; data: { text: string } }>;
    };
    expect(body.title).toBe('msg-1');
    expect(body.events).toHaveLength(500);
    expect(body.events[0]!.data.text).toBe('msg-51'); // 前 50 条已裁剪
    expect(body.events[499]!.data.text).toBe('msg-550');
  });

  it('d5) 中断占位 tool 事件与悬空调用：name 回退 unknown、ok:false + error 回注', async () => {
    const store = await seedStore([
      { kind: 'user', payload: { content: 'task' } },
      { kind: 'tool', payload: { toolCallId: 'orphan-9', content: 'x' } },
      {
        kind: 'assistant',
        payload: { content: 'need', toolCalls: [{ id: 'call-7', name: 'boom', arguments: '{}' }] },
      },
      {
        kind: 'tool',
        payload: {
          toolCallId: 'call-7',
          content: JSON.stringify({ ok: false, error: { type: 'interrupted', message: 'gone' } }),
        },
      },
    ]);
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions/s-1', base));
    const body = (await res.json()) as {
      events: Array<{ event: string; data: Record<string, unknown> }>;
    };
    // ① 无 assistant 登记的 tool 事件：tool-result(name=unknown)，无 tool-start
    const orphan = body.events.find((f) => f.data.id === 'orphan-9');
    expect(orphan).toMatchObject({ event: 'tool-result' });
    expect((orphan!.data as { name: string }).name).toBe('unknown');
    // ② 正常 pair：tool-start(name 来自 assistant) + tool-result(中断占位 → ok:false + error)
    expect(body.events.map((f) => f.event)).toEqual([
      'session-user',
      'tool-result',
      'assistant-done',
      'tool-start',
      'tool-result',
    ]);
    const done = body.events[2]!;
    expect((done.data as { toolCalls: unknown[] }).toolCalls).toEqual([
      { id: 'call-7', name: 'boom', arguments: '{}' },
    ]);
    const started = body.events[3]!;
    expect(started).toMatchObject({ event: 'tool-start' });
    expect(started.data).toMatchObject({ id: 'call-7', name: 'boom', arguments: '{}' });
    const result = body.events[4]!;
    expect(result.event).toBe('tool-result');
    expect(result.data).toMatchObject({ id: 'call-7', name: 'boom', ok: false });
    expect(JSON.stringify(result.data)).toContain('gone');
  });

  it('d6a) 按帧计数裁剪：501+ 帧 → 恰 ≤500 帧；半途（无主 tool-start）推进，不输出悬空起始帧', async () => {
    // 事件 = 100 head user + A(30 调用 30 结果) + 460 tail user = 591 事件；
    // 帧 = 100 + (1+30) + 30 + 460 = 621 → 从尾部取 500 帧的切点落在 A 的 tool-start 段中
    // （done + 20 个 start 被裁，残余 start 无主）→ 对齐规则把无主 start 段推出窗口，
    // 孤儿 tool-result 段保留（d5 语义）。
    const store = new MemorySessionAdapter();
    await store.create('s-1');
    for (let i = 1; i <= 100; i += 1) {
      await store.append('s-1', { kind: 'user', payload: { content: `head-${i}` } });
    }
    const calls = Array.from({ length: 30 }, (_, i) => ({
      id: `call-${i + 1}`,
      name: 'echo',
      arguments: '{}',
    }));
    await store.append('s-1', { kind: 'assistant', payload: { content: 'big', toolCalls: calls } });
    for (let i = 1; i <= 30; i += 1) {
      await store.append('s-1', {
        kind: 'tool',
        payload: { toolCallId: `call-${i}`, content: `out-${i}` },
      });
    }
    for (let i = 1; i <= 460; i += 1) {
      await store.append('s-1', { kind: 'user', payload: { content: `tail-${i}` } });
    }
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions/s-1', base));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ event: string; data: Record<string, unknown> }>;
    };
    // 按帧计：响应帧数恰 ≤500（旧实现按事件数 500 → 可到 500+ 帧）
    expect(body.events.length).toBeLessThanOrEqual(500);
    expect(body.events.length).toBe(490); // 500 - 无主 start 段(10)
    // 推进语义：窗口中绝不输出无主 tool-start；孤儿 tool-result 段保留（d5：name 回退）
    const starts = body.events.filter((f) => f.event === 'tool-start');
    expect(starts).toHaveLength(0);
    expect(body.events[0]!.event).toBe('tool-result');
    expect((body.events[0]!.data as { id: string; name: string }).id).toBe('call-1');
    expect((body.events[0]!.data as { name: string }).name).toBe('echo');
    expect((body.events[29]!.data as { id: string }).id).toBe('call-30'); // 30 个孤儿结果，后接 tail 段
    const tailText = (body.events[30]!.data as { text: string }).text;
    expect(tailText).toBe('tail-1');
    expect(body.events.length - 30).toBe(460);
  });

  it('d6b) 半途点为孤儿工具结果：保持 name 回退（d5 语义），不推进', async () => {
    // 100 head + A(30 调用 30 结果) + 478 tail = 639 帧 → 裁 139 帧：
    // 恰落在 A 的 tool-result 段（done+全部 tool-start 被裁）→ 孤儿结果保留、name 由声明映射。
    const store = new MemorySessionAdapter();
    await store.create('s-1');
    for (let i = 1; i <= 100; i += 1) {
      await store.append('s-1', { kind: 'user', payload: { content: `head-${i}` } });
    }
    const calls = Array.from({ length: 30 }, (_, i) => ({
      id: `call-${i + 1}`,
      name: 'echo',
      arguments: '{}',
    }));
    await store.append('s-1', { kind: 'assistant', payload: { content: 'big', toolCalls: calls } });
    for (let i = 1; i <= 30; i += 1) {
      await store.append('s-1', {
        kind: 'tool',
        payload: { toolCallId: `call-${i}`, content: `out-${i}` },
      });
    }
    for (let i = 1; i <= 478; i += 1) {
      await store.append('s-1', { kind: 'user', payload: { content: `tail-${i}` } });
    }
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions/s-1', base));
    const body = (await res.json()) as {
      events: Array<{ event: string; data: Record<string, unknown> }>;
    };
    expect(body.events.length).toBeLessThanOrEqual(500);
    expect(body.events.length).toBe(500); // 恰 500 帧：孤儿结果段 + tail 段
    // 孤儿结果：无 tool-start 前置；name 按声明映射（未声明会话 fallback unknown）
    expect(body.events[0]!.event).toBe('tool-result');
    expect((body.events[0]!.data as { id: string; name: string }).id).toBe('call-9');
    expect((body.events[0]!.data as { name: string }).name).toBe('echo');
    expect(body.events.slice(0, 22).every((f) => f.event === 'tool-result')).toBe(true);
  });

  it('d6c) 窗口起点恰为完整剧集（done 在窗内）：toolCalls 与 tool-start/result 帧齐全', async () => {
    // 100 head + A(30 调用 30 结果) + 439 tail = 600 帧 → 裁 100 帧：
    // 窗口起点 = A 的 assistant-done，整组 61 帧都在窗内。
    const store = new MemorySessionAdapter();
    await store.create('s-1');
    for (let i = 1; i <= 100; i += 1) {
      await store.append('s-1', { kind: 'user', payload: { content: `head-${i}` } });
    }
    const calls = Array.from({ length: 30 }, (_, i) => ({
      id: `call-${i + 1}`,
      name: 'echo',
      arguments: '{}',
    }));
    await store.append('s-1', { kind: 'assistant', payload: { content: 'big', toolCalls: calls } });
    for (let i = 1; i <= 30; i += 1) {
      await store.append('s-1', {
        kind: 'tool',
        payload: { toolCallId: `call-${i}`, content: `out-${i}` },
      });
    }
    for (let i = 1; i <= 439; i += 1) {
      await store.append('s-1', { kind: 'user', payload: { content: `tail-${i}` } });
    }
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions/s-1', base));
    const body = (await res.json()) as {
      events: Array<{ event: string; data: Record<string, unknown> }>;
    };
    expect(body.events.length).toBeLessThanOrEqual(500);
    expect(body.events.length).toBe(500);
    expect(body.events[0]!.event).toBe('assistant-done');
    const done = body.events[0]!.data as { content: string; toolCalls: Array<{ id: string }> };
    expect(done.toolCalls).toHaveLength(30);
    const starts = body.events.filter((f) => f.event === 'tool-start');
    const results = body.events.filter((f) => f.event === 'tool-result');
    expect(starts).toHaveLength(30); // done 在窗内 → 整组帧齐全
    expect(results).toHaveLength(30);
    expect(starts.map((f) => f.data.id)).toEqual(done.toolCalls.map((tc) => tc.id));
  });

  it('d7) run_result 事件 → 派生 usage + run-status 帧（与 chat 终态同形；compaction 仍出现、其它事件不入侵）', async () => {
    // 存储侧（agent.ts finalize）run_result 载荷：status/steps/durationMs + usage 五（六）字段（+ 可选 error）；
    // 此处按真实落盘形状（含 contextEstimateTokens）造数，验证重放派生与 live 直推同形。
    const store = await seedStore([
      { kind: 'user', payload: { content: '任务开始' } },
      {
        kind: 'assistant',
        payload: { content: '完成', toolCalls: [] },
      },
      {
        kind: 'event',
        payload: {
          type: 'run_result',
          data: {
            status: 'completed',
            steps: 11,
            durationMs: 82116,
            promptTokens: 94051,
            completionTokens: 4677,
            totalTokens: 98728,
            costUsd: 0.10808199999999998,
            estimated: false,
            contextEstimateTokens: 17771,
          },
        },
      },
      {
        kind: 'event',
        payload: { type: 'compaction', data: { summary: '摘要文本' } },
      },
      { kind: 'event', payload: { type: 'projection_changed', data: { x: 1 } } },
      { kind: 'user', payload: { content: '继续' } },
    ]);
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions/s-1', base));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ event: string; data: Record<string, unknown> }>;
    };
    // 帧序 = 事件序：run_result 派生组（usage → run-status）原位；compaction 仍出现；
    // projection_changed 无协议帧 → 不侵入
    expect(body.events.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-done',
      'usage',
      'run-status',
      'compaction',
      'session-user',
    ]);
    // usage：token 账本 + costUsd/estimated 保真（totalTokens/contextEstimateTokens 原值）
    expect(body.events[2]!.data).toEqual({
      promptTokens: 94051,
      completionTokens: 4677,
      totalTokens: 98728,
      costUsd: 0.10808199999999998,
      estimated: false,
      contextEstimateTokens: 17771,
    });
    expect(body.events[3]!.data).toEqual({ status: 'completed', steps: 11, durationMs: 82116 });
    expect(body.events[4]!.data).toEqual({ summary: '摘要文本' });
  });

  it('d8) run_result 残缺/旧形状不崩：缺 costUsd → usage 帧该字段 undefined；无 data / 字符串数字字段按 undefined 收敛', async () => {
    const store = await seedStore([
      { kind: 'user', payload: { content: 'old' } },
      {
        kind: 'event',
        payload: {
          type: 'run_result',
          data: {
            status: 'completed',
            steps: 2,
            durationMs: 10,
            promptTokens: '94051', // 旧形状字符串 → 收敛 undefined
            completionTokens: 4677,
            totalTokens: 98728,
            // costUsd/estimated/contextEstimateTokens 缺失
          },
        },
      },
      { kind: 'event', payload: { type: 'run_result' } }, // 无 data
      { kind: 'user', payload: { content: 'later' } },
    ]);
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions/s-1', base));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ event: string; data: Record<string, unknown> }>;
    };
    expect(body.events.map((f) => f.event)).toEqual([
      'session-user',
      'usage',
      'run-status',
      'usage',
      'run-status',
      'session-user',
    ]);
    const usage = body.events[1]!.data;
    expect(usage.promptTokens).toBeUndefined(); // 字符串字段不伪造
    expect(usage.totalTokens).toBe(98728);
    expect(usage.costUsd).toBeUndefined(); // 缺字段 → undefined（wire 键略去）
    expect(usage.estimated).toBeUndefined();
    expect(body.events[2]!.data).toEqual({ status: 'completed', steps: 2, durationMs: 10 });
    // 无 data → 派生帧字段全 undefined（键全略去），流/详情不 500
    expect(body.events[3]!.data).toEqual({});
    expect(body.events[4]!.data).toEqual({});
  });

  it('d9) run_result 派生帧不干扰在线流：chat 全程恰一条 usage + 一条 run-status（观察器不双发）', async () => {
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(
      depsFor({
        store,
        llm: new FakeLlm([
          {
            content: 'hi',
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
        ]),
      }),
    );
    servers.push(server);

    const res = await postJson(base, '/api/chat', { sessionId: 's-1', text: 'hello' });
    expect(res.status).toBe(200);
    const client = await SseClient.connect(base, 's-1');
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    expect(client.frames.filter((f) => f.event === 'usage')).toHaveLength(1);
    expect(client.frames.filter((f) => f.event === 'run-status')).toHaveLength(1);
    // usage 帧由 chat 终态直推（非 run_result 观察器派生）：token 账本保真、estimated 非兜底
    expect(client.frames[3]!.data).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimated: false,
    });
  });
});

describe('ui/server：会话创建 POST /api/sessions', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('p1) 空会话（无 body）：{sessionId}，会话落盘为空、不启动 run', async () => {
    const llm = new FakeLlm([{ content: 'never' }]);
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(depsFor({ store, llm }));
    servers.push(server);

    const res = await postJson(base, '/api/sessions', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toMatch(/^s-/);
    expect(await store.exists(body.sessionId)).toBe(true);
    const events: Array<{ kind: string }> = [];
    for await (const ev of store.events(body.sessionId)) events.push(ev);
    expect(events).toHaveLength(0);
    expect(llm.callCount).toBe(0); // 新建不启动 run
  });

  it('p2) 带首消息 {text}：首事件 user（回声不依赖流）、不启动 run、可被列表与详情联动', async () => {
    const llm = new FakeLlm([{ content: 'never' }]);
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(depsFor({ store, llm }));
    servers.push(server);

    const res = await postJson(base, '/api/sessions', { text: '你好，DevMate' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    const events = [] as unknown[];
    for await (const ev of store.events(body.sessionId)) events.push(ev);
    expect(events).toHaveLength(1);
    const first = events[0] as { kind: string; payload: { content: string } };
    expect(first.kind).toBe('user');
    expect(first.payload.content).toBe('你好，DevMate');
    expect(llm.callCount).toBe(0);

    const detail = (await (
      await fetch(new URL(`/api/sessions/${body.sessionId}`, base))
    ).json()) as { title: string; events: Array<{ event: string }> };
    expect(detail.title).toBe('你好，DevMate');
    expect(detail.events.map((f) => f.event)).toEqual(['session-user']);
  });

  it('p3) 非对象体 / text 非字符串 → 400 {error}', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);
    const arr = await postJson(base, '/api/sessions', [1, 2]);
    expect(arr.status).toBe(400);
    expect(((await arr.json()) as { error: string }).error).toBeTypeOf('string');

    const bad = await postJson(base, '/api/sessions', { text: 42 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('p4) 空 body（无 JSON）按 body{text?} 语义接受：text 缺省 → 空会话', async () => {
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions', base), { method: 'POST' }); // 无 body / 无 content-type
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toMatch(/^s-/);
    expect(await store.exists(body.sessionId)).toBe(true);
    const events: Array<{ kind: string }> = [];
    for await (const ev of store.events(body.sessionId)) events.push(ev);
    expect(events).toHaveLength(0); // 空会话（text 缺省）
  });
});

describe('ui/server：会话删除 DELETE /api/sessions/:id', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('x1) 成功：{ok:true}；disposeSession(id) 回调；文件删除后 GET :id → 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-sessions-del-'));
    tempDirs.push(dir);
    const store = new JsonlFileAdapter({ dir });
    await store.create('s-del');
    await store.append('s-del', { kind: 'user', payload: { content: 'bye' } });
    const disposeSession = vi.fn(async (_id: string) => {
      await rm(join(dir, 's-del.jsonl'), { force: true });
    });
    const { base, server } = await startServer(depsFor({ store, disposeSession }));
    servers.push(server);

    const res = await fetch(new URL('/api/sessions/s-del', base), { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(disposeSession).toHaveBeenCalledTimes(1);
    expect(disposeSession).toHaveBeenCalledWith('s-del');
    expect(await store.exists('s-del')).toBe(false);

    const after = await fetch(new URL('/api/sessions/s-del', base));
    expect(after.status).toBe(404);
  });

  it('x2) 未知会话 → 404 {error}', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);
    const res = await fetch(new URL('/api/sessions/nope-9', base), { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('x3) 活跃 run → 409 {error}，disposeSession 未被调用', async () => {
    const store = new MemorySessionAdapter();
    const disposeSession = vi.fn();
    const { base, server } = await startServer(
      depsFor({
        store,
        disposeSession,
        llm: new FakeLlm([{ content: 'slow', gate: new Promise(() => {}) }]),
      }),
    );
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'm1' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 2, 10_000); // delta 已到：run 活跃

    const res = await fetch(new URL(`/api/sessions/${created.sessionId}`, base), {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
    expect(disposeSession).not.toHaveBeenCalled();
    // 不断言 run 收尾：gate 永不释放的 run 留在测试尾（与 stream.test g3 同模式，
    // afterEach 关服务即释放 socket；run 不再产生事件）
  });

  it('x4) 非法会话 id → 400 {error}（路径逃逸字面量不进磁盘操作）', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);
    const res = await fetch(new URL('/api/sessions/..%2f..%2fetc', base), {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('x7) 重复 DELETE 幂等语义：之后再次删除 → 明确 404 {error}', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-sessions-del2-'));
    tempDirs.push(dir);
    const store = new JsonlFileAdapter({ dir });
    await store.create('s-again');
    await store.append('s-again', { kind: 'user', payload: { content: 'bye' } });
    const disposeSession = vi.fn(async (_id: string) => {
      await rm(join(dir, 's-again.jsonl'), { force: true });
    });
    const { base, server } = await startServer(depsFor({ store, disposeSession }));
    servers.push(server);

    const first = await fetch(new URL('/api/sessions/s-again', base), { method: 'DELETE' });
    expect(first.status).toBe(200);
    expect(disposeSession).toHaveBeenCalledTimes(1);

    const second = await fetch(new URL('/api/sessions/s-again', base), { method: 'DELETE' });
    expect(second.status).toBe(404);
    expect(disposeSession).toHaveBeenCalledTimes(1); // 幂等：不再触发联动
    expect(((await second.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('x5) 删除后 broker 清空：连接中的 SSE 不崩；同 id 可重新作为新会话使用', async () => {
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(
      depsFor({
        store,
        llm: new FakeLlm([{ content: 'first' }, { content: 'second' }, { content: 'third' }]),
      }),
    );
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'first' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000); // run 完成

    const res = await fetch(new URL(`/api/sessions/${created.sessionId}`, base), {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);

    // 同 id 再 chat：会话复活（新 broker/新 ctx）。旧 SSE 连接绑定的是已删旧 broker
    // （前端单流模型：删除后再打开即重新 /api/stream）——新连接拿到新 run 的完整序。
    const again = await postJson(base, '/api/chat', {
      sessionId: created.sessionId,
      text: 'second',
    });
    expect(again.status).toBe(200);
    const revived = await SseClient.connect(base, created.sessionId);
    clients.push(revived);
    await waitForFrames(revived, 5, 10_000);
    const texts = revived.frames
      .map((f) => (f.event === 'session-user' ? f.data.text : null))
      .filter((t): t is string => t !== null);
    expect(texts).toEqual(['second']); // 新 broker：无删除前事件的回放

    // sessionGuards 断环：重建后的会话可再删（200）→ 再重建（200）——链不随删除遗留
    const second = await fetch(new URL(`/api/sessions/${created.sessionId}`, base), {
      method: 'DELETE',
    });
    expect(second.status).toBe(200);
    const third = await postJson(base, '/api/chat', {
      sessionId: created.sessionId,
      text: 'third',
    });
    expect(third.status).toBe(200);
    expect(await store.exists(created.sessionId)).toBe(true);
  });

  it('x6) DELETE 与 POST /api/chat 并发（慢 dispose 放大窗口）：per-session 串行化，无一致性错误', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-sessions-race-'));
    tempDirs.push(dir);
    const store = new JsonlFileAdapter({ dir });
    await store.create('s-race');
    await store.append('s-race', { kind: 'user', payload: { content: 'hi' } });

    // 慢 dispose：让 DELETE 停在“已删 ctx、rm 未执行”的窗口内（竞态放大）
    let enteredResolve!: () => void;
    let gateResolve!: () => void;
    const disposeEntered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const disposeGate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });
    const disposeSession = vi.fn(async (_id: string) => {
      enteredResolve();
      await disposeGate;
      await rm(join(dir, 's-race.jsonl'), { force: true });
    });
    const llm = new FakeLlm([
      {
        content: 'need tool',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"a"}' }],
      },
      { content: 'second' },
    ]);
    const { base, server } = await startServer(
      depsFor({ store, disposeSession, llm, approvalPolicy: () => false }),
    );
    servers.push(server);

    // DELETE 先发起：等其进入慢 dispose（存在检查已过、rm 未执行）
    const deleting = fetch(new URL('/api/sessions/s-race', base), { method: 'DELETE' });
    await disposeEntered;

    // 并发 POST /api/chat 重启同 id run（旧实现：append/rm 交错 → SessionNotFound 一致性错误）
    const chatResult = postJson(base, '/api/chat', { sessionId: 's-race', text: 'm1' });

    // 放行删除 → DELETE 与 chat 在 per-session 串行化下各自一致收尾
    gateResolve();
    const [chat, del] = await Promise.all([chatResult, deleting]);
    expect(del.status).toBe(200);
    expect(chat.status).toBe(200);

    // run 完整收尾：无 run-error；会话（重建后）内容一致存在
    const client = await SseClient.connect(base, 's-race');
    clients.push(client);
    const deadline = Date.now() + 10_000;
    let finished = false;
    while (Date.now() < deadline) {
      const frame = await client.next(deadline - Date.now());
      if (frame === null) break;
      if (frame.event === 'run-status' || frame.event === 'run-error') {
        finished = true;
        break;
      }
    }
    expect(finished, 'run 应正常收尾（run-status）').toBe(true);
    expect(client.frames.filter((f) => f.event === 'run-error')).toHaveLength(0);
    expect(await store.exists('s-race')).toBe(true);
    const kinds: string[] = [];
    for await (const ev of store.events('s-race')) kinds.push(ev.kind);
    expect(kinds.filter((k) => k === 'user')).toHaveLength(1); // m1 落盘（删除后重建）
    expect(kinds.filter((k) => k === 'assistant')).toHaveLength(2); // 两回合
  });
});

// ---------------------------------------------------------------------------
// VT-8：全损坏会话（不可解析行 > 80%）显示语义
// ---------------------------------------------------------------------------

describe('ui/server：全损坏会话标记（VT-8：不冒充（空会话））', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('l5) 100% 损坏文件 → 列表「（会话损坏）」+ corrupted 标记；详情同样标记；events 为空不冒充（空会话）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-sessions-corrupt-'));
    tempDirs.push(dir);
    const deps = await assembleDeps({ workspaceRoot: dir, sessionsDir: dir, model: 'm-x' });
    writeFileSync(join(dir, 's-vt-garbage.jsonl'), 'not json at all {{{');
    // 正常会话对照
    await deps.store.create('s-ok');
    await deps.store.append('s-ok', { kind: 'user', payload: { content: '正常' } });

    const listed = await deps.sessionLister!();
    const garbage = listed.find((s) => s.sessionId === 's-vt-garbage');
    const ok = listed.find((s) => s.sessionId === 's-ok');
    expect(garbage).toBeDefined();
    expect(garbage!.title).toBe('（会话损坏）');
    expect(garbage!.corrupted).toBe(true);
    expect(garbage!.stepCount).toBe(0);
    expect(ok!.title).toBe('正常');
    expect(ok!.corrupted).toBeUndefined();

    // HTTP 列表 + 详情：用同一套装配 deps（真 JsonlFileAdapter 在 dir 上——store 与 lister 同源）
    const { base, server } = await startServer(deps);
    const res = await fetch(new URL('/api/sessions', base));
    const body = (await res.json()) as { sessions: SessionSummary[] };
    const httpGarbage = body.sessions.find((s) => s.sessionId === 's-vt-garbage');
    expect(httpGarbage).toBeDefined();
    expect(httpGarbage!.title).toBe('（会话损坏）');
    expect(httpGarbage!.corrupted).toBe(true);

    const detail = await fetch(
      new URL(`/api/sessions/${encodeURIComponent('s-vt-garbage')}`, base),
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      title: string;
      corrupted?: boolean;
      events: unknown[];
    };
    expect(detailBody.title).toBe('（会话损坏）');
    expect(detailBody.corrupted).toBe(true);
    expect(detailBody.events).toEqual([]);
    await server.close();
  });

  it('l6) 阈值语义：部分损坏（1/3 坏行）不误标；空文件仍「（空会话）」', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-sessions-partial-'));
    tempDirs.push(dir);
    const deps = await assembleDeps({ workspaceRoot: dir, sessionsDir: dir, model: 'm-x' });
    // 完整行 ×2 + 脏行 ×1（33% < 80%）——正常崩溃的「完整行+截断尾行」形态在阈值下
    const line = (seq: number, content: string): string =>
      `${JSON.stringify({ v: 1, seq, ts: 1, kind: 'user', payload: { content } })}\n`;
    writeFileSync(join(dir, 's-partial.jsonl'), `${line(1, 'a')}${line(2, 'b')}not json {{{`);
    // 空文件（真空会话）
    writeFileSync(join(dir, 's-empty.jsonl'), '');

    const listed = await deps.sessionLister!();
    const partial = listed.find((s) => s.sessionId === 's-partial');
    const empty = listed.find((s) => s.sessionId === 's-empty');
    expect(partial!.title).toBe('a');
    expect(partial!.corrupted).toBeUndefined();
    expect(empty!.title).toBe('（空会话）');
    expect(empty!.corrupted).toBeUndefined();
  });
});
