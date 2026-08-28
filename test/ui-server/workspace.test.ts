/**
 * # test/ui-server/workspace：会话按项目文件夹分组（workspaceRoot 元数据）
 *
 * A 档契约：
 * - 会话首建（POST /api/sessions 与 POST /api/chat 的首建路径）在事件流落一条 meta：
 *   {kind:'event', payload:{type:'session-workspace', data:{workspaceRoot}}}（data 只此一键）；
 * - resume 旧会话（事件流无此 meta）不新增事件；
 * - GET /api/sessions/:id 显式回 workspaceRoot: string | null（无 meta → null）；
 * - GET /api/sessions（lister 注入的数据源）逐会话带来 workspaceRoot: string | null
 *   （新会话 = meta 值；旧会话 = null；畸形 meta（无 data/非 string）→ null 映射不崩）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { assembleDeps } from '../../src/ui/server/deps.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

const WS = '/tmp/ws-example-project';

function depsFor(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'ok' }]),
    model: 'test-model',
    ...extra,
  };
}

async function eventsOf(store: MemorySessionAdapter, sessionId: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const ev of store.events(sessionId)) events.push(ev);
  return events;
}

const workspaceEvents = (events: SessionEvent[]): SessionEvent[] =>
  events.filter(
    (ev) => ev.kind === 'event' && (ev.payload as { type?: string }).type === 'session-workspace',
  );

describe('ui/server：会话 workspaceRoot 元数据（事件流注入）', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('w1) POST /api/sessions {text}：会话首条事件为 session-workspace meta（workspaceRoot），其后才是 user', async () => {
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(depsFor({ store, workspaceRoot: WS }));
    servers.push(server);

    const res = await postJson(base, '/api/sessions', { text: 'hello workspace' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const events = await eventsOf(store, sessionId);
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe('event');
    expect(events[0]!.payload).toEqual({
      type: 'session-workspace',
      data: { workspaceRoot: WS },
    });
    expect(events[1]!.kind).toBe('user');
    expect((events[1]!.payload as { content: string }).content).toBe('hello workspace');
  });

  it('w2) POST /api/chat 首建会话：workspace meta 落事件流；resume 旧会话不重复注入', async () => {
    const store = new MemorySessionAdapter();
    const llm = new FakeLlm([{ content: 'one' }, { content: 'two' }]);
    const { base, server } = await startServer(depsFor({ store, llm, workspaceRoot: WS }));
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'first' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    await waitForFrames(client, 5, 10_000);
    client.close();

    let events = await eventsOf(store, created.sessionId);
    expect(events[0]!.kind).toBe('event');
    expect(events[0]!.payload).toEqual({
      type: 'session-workspace',
      data: { workspaceRoot: WS },
    });
    expect(events[1]!.kind).toBe('user');
    expect(workspaceEvents(events)).toHaveLength(1);

    // resume：第二次 chat（会话已存在）不再追加 workspace meta
    await postJson(base, '/api/chat', { sessionId: created.sessionId, text: 'second' });
    const resumed = await SseClient.connect(base, created.sessionId);
    await waitForFrames(resumed, 5, 10_000);
    resumed.close();

    events = await eventsOf(store, created.sessionId);
    expect(workspaceEvents(events)).toHaveLength(1);
    expect(events.filter((ev) => ev.kind === 'user')).toHaveLength(2);
  });

  it('w3) 无 workspaceRoot 注入（假 deps / 旧服务）：不落 workspace 事件；详情显式 workspaceRoot:null', async () => {
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(depsFor({ store }));
    servers.push(server);

    const res = await postJson(base, '/api/sessions', { text: 'legacy' });
    const { sessionId } = (await res.json()) as { sessionId: string };
    const events = await eventsOf(store, sessionId);
    expect(events).toHaveLength(1); // 只有 user，无 workspace meta
    expect(events[0]!.kind).toBe('user');

    const detail = (await (await fetch(new URL(`/api/sessions/${sessionId}`, base))).json()) as {
      workspaceRoot: unknown;
    };
    expect(detail.workspaceRoot).toBeNull();
  });

  it('w4) 详情：新会话 workspaceRoot=注入值；旧会话（无 meta）= null；畸形 meta 不崩 → null', async () => {
    const store = new MemorySessionAdapter();
    await store.create('s-legacy');
    await store.append('s-legacy', { kind: 'user', payload: { content: 'old' } });
    await store.create('s-malformed');
    await store.append('s-malformed', {
      kind: 'event',
      payload: { type: 'session-workspace', data: { notWorkspace: 1 } },
    });
    const { base, server } = await startServer(depsFor({ store, workspaceRoot: WS }));
    servers.push(server);

    const created = (await (await postJson(base, '/api/sessions', {})).json()) as {
      sessionId: string;
    };

    const fresh = (await (
      await fetch(new URL(`/api/sessions/${created.sessionId}`, base))
    ).json()) as { workspaceRoot: string };
    expect(fresh.workspaceRoot).toBe(WS);

    const legacy = (await (await fetch(new URL('/api/sessions/s-legacy', base))).json()) as {
      workspaceRoot: string | null;
    };
    expect(legacy.workspaceRoot).toBeNull();

    // 畸形（data 缺 workspaceRoot / 非字符串）：映射不崩 → null
    const malformed = (await (await fetch(new URL('/api/sessions/s-malformed', base))).json()) as {
      workspaceRoot: unknown;
      events: unknown[];
    };
    expect(malformed.workspaceRoot).toBeNull();
    expect(malformed.events).toEqual([]); // session-workspace 非协议帧，不进 events
  });
});

describe('ui/server：workspaceRoot 列表映射（makeSessionLister）', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('w5) lister：新会话带 workspaceRoot；旧会话 null；畸形 null；映射不崩', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-workspace-'));
    tempDirs.push(dir);
    // workspaceRoot 必须是真实目录（createJail fail-closed；值本身即分组键）
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 's'),
      model: 'm',
    });
    const store = deps.store;

    // 新会话：首建语义与服务端一致（store.create + workspace meta 事件 + user）
    await store.create('s-new');
    await store.append('s-new', {
      kind: 'event',
      payload: { type: 'session-workspace', data: { workspaceRoot: dir } },
    });
    await store.append('s-new', { kind: 'user', payload: { content: 'in ws' } });
    // 旧会话：直接落盘（无 workspace 事件——模拟 resume 前的历史会话）
    await store.create('s-old');
    await store.append('s-old', { kind: 'user', payload: { content: 'old' } });
    // 畸形 meta
    await store.create('s-weird');
    await store.append('s-weird', {
      kind: 'event',
      payload: { type: 'session-workspace', data: {} },
    });
    await store.append('s-weird', { kind: 'user', payload: { content: 'w' } });

    const listed = await deps.sessionLister!();
    const fresh = listed.find((s) => s.sessionId === 's-new');
    const old = listed.find((s) => s.sessionId === 's-old');
    const weird = listed.find((s) => s.sessionId === 's-weird');
    expect(fresh).toBeDefined();
    expect(fresh!.workspaceRoot).toBe(dir);
    expect(old!.workspaceRoot).toBeNull();
    expect(weird!.workspaceRoot).toBeNull();
    await deps.dispose?.();
  });
});
