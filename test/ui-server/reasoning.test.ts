/**
 * # test/ui-server/reasoning：思考强度设置（/api/settings reasoning）+ 窗口预设 + usage 上下文估算
 *
 * C 档契约：
 * - GET /api/settings 增 reasoning（'off'|'low'|'medium'|'high'，缺省 'medium'）与 window
 *   （窗口 token 数：初值 = 设置覆盖 ?? 供应商 preset contextWindowTokens；无据时省略）；
 * - POST /api/settings 接受 reasoning / windowTokens（覆盖 window），非法值 400；
 * - persist 走现有 persistSettings：快照只在相应字段被本次 POST 触碰时携带
 *   （与 skills/workflow 的「部分字段补丁保留未指字段」同语义；旧快照行为逐字不变）；
 * - run 从当前设置读取 reasoning → ChatRequest.reasoningEffort（FakeLlm.requests 可证）；windowTokens → runOptions；
 * - usage 帧增 contextEstimateTokens（run 内 projection.stats.estimatedTokens 透传；缺省不带键）；
 * - usage 帧序列化协议：contextEstimateTokens 只作为可选键进入 data（前端按协议映射）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import { assembleDeps } from '../../src/ui/server/deps.js';
import { serializeEvent } from '../../src/ui/server/emit.js';
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

describe('ui/server：settings reasoning / window', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('r1) GET 缺省：reasoning=medium、window 来自 preset（assembleDeps：deepseek 估算 64000）；POST 更新后 GET 一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-reasoning-'));
    tempDirs.push(dir);
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 's'),
      model: 'm',
    });
    const { base, server } = await startServer(deps, 0);
    servers.push(server);

    const before = (await (await fetch(new URL('/api/settings', base))).json()) as {
      reasoning: string;
      window?: number;
      baseUrl: string;
    };
    expect(before.reasoning).toBe('medium');
    expect(before.window).toBe(64000); // deepseek preset contextWindowTokens（估算，可在设置覆盖）
    expect(typeof before.baseUrl).toBe('string');

    const res = await postJson(base, '/api/settings', { reasoning: 'high' });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { reasoning: string; window?: number };
    expect(saved.reasoning).toBe('high');
    expect(saved.window).toBe(64000);

    const after = (await (await fetch(new URL('/api/settings', base))).json()) as {
      reasoning: string;
      window?: number;
    };
    expect(after.reasoning).toBe('high');

    const win = await postJson(base, '/api/settings', { windowTokens: 32000 });
    expect(((await win.json()) as { window: number }).window).toBe(32000);
    await deps.dispose?.();
  });

  it('r2) POST 非法 reasoning / windowTokens → 400；无字段 → 400', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);

    const badEffort = await postJson(base, '/api/settings', { reasoning: 'turbo' });
    expect(badEffort.status).toBe(400);
    const badNum = await postJson(base, '/api/settings', { windowTokens: -5 });
    expect(badNum.status).toBe(400);
    const badType = await postJson(base, '/api/settings', { windowTokens: 'big' });
    expect(badType.status).toBe(400);
    const frag = await postJson(base, '/api/settings', {});
    expect(frag.status).toBe(400);
  });

  it('r3) persistSettings 快照：字段只在被本次 POST 触碰时携带（reasoning/windowTokens 补丁语义；既有键保留）', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const { base, server } = await startServer(
      depsFor({
        settings: { baseUrl: 'https://p.example/v1', model: 'm0' },
        persistSettings: (s: unknown) => {
          persisted.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
        },
      }),
    );
    servers.push(server);

    await postJson(base, '/api/settings', { model: 'm1' });
    expect(persisted[0]).toEqual({ baseUrl: 'https://p.example/v1', model: 'm1' }); // 未触碰不掺杂

    await postJson(base, '/api/settings', { reasoning: 'low' });
    expect(persisted[1]).toEqual({
      baseUrl: 'https://p.example/v1',
      model: 'm1',
      reasoning: 'low',
    });

    await postJson(base, '/api/settings', { windowTokens: 16000, reasoning: 'off' });
    expect(persisted[2]).toEqual({
      baseUrl: 'https://p.example/v1',
      model: 'm1',
      windowTokens: 16000,
      reasoning: 'off',
    });

    // 快照形状：SettingsSnapshot 类型面（前端/CLI 合并写直接消费）
    const snapshots = persisted.map((p) => Object.keys(p).sort());
    expect(snapshots[0]).toEqual(['baseUrl', 'model']);
    expect(snapshots[2]).toEqual(['baseUrl', 'model', 'reasoning', 'windowTokens']);
  });

  it('r4) run 从当前设置读 reasoning → ChatRequest.reasoningEffort；windowTokens → runOptions.windowTokens', async () => {
    const llm = new FakeLlm([{ content: 'done' }]);
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(
      depsFor({
        store,
        llm,
        settings: {
          baseUrl: 'https://w.example/v1',
          model: 'm0',
          reasoning: 'low',
          windowTokens: 8000,
        },
      }),
    );
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    await waitForFrames(client, 5, 10_000);
    client.close();
    expect(llm.requests[0]!.reasoningEffort).toBe('low');
    // window 传导：projection 带窗口预算（此处只证明请求面——window 消费属 context 单测）
    // GET /api/settings window 一致
    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      reasoning: string;
      window: number;
    };
    expect(settings.reasoning).toBe('low');
    expect(settings.window).toBe(8000);
  });
});

describe('ui/server：usage 帧 contextEstimateTokens', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('u1) run 完成帧：usage.data.contextEstimateTokens 为 >0 数字（projection 估算透传）', async () => {
    const { base, server } = await startServer(
      depsFor({ llm: new FakeLlm([{ content: 'hello world' }]) }),
    );
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'count me' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    const usage = client.frames.find((f) => f.event === 'usage');
    expect(usage).toBeDefined();
    const data = usage!.data as { contextEstimateTokens?: number };
    expect(typeof data.contextEstimateTokens).toBe('number');
    expect(data.contextEstimateTokens!).toBeGreaterThan(0);
  });

  it('u2) usage 帧序列化：contextEstimateTokens 可选键（不破坏既有形状；缺省不带）', () => {
    const withEst = serializeEvent({
      event: 'usage',
      data: {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        costUsd: 0,
        estimated: false,
        contextEstimateTokens: 4096,
      },
    });
    expect(withEst).toContain('"contextEstimateTokens":4096');
    const without = serializeEvent({
      event: 'usage',
      data: {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        costUsd: 0,
        estimated: false,
      },
    });
    expect(without).not.toContain('contextEstimateTokens');
  });
});
