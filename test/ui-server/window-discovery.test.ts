/**
 * # test/ui-server/window-discovery：三源取窗整合（用户覆盖 > 网关探测 > preset）
 *
 * 服务端级：GET /api/settings 的 window/windowDetail 优先级（注入 windowDiscovered
 * 读取器与 settings 种子）；POST /api/settings 触碰 windowTokens 后显式覆盖锁定；
 * 触碰 baseUrl/apiKey/model 触发 deps.probeWindow 重探（未注入 → 不探索）。
 * 装配级：assembleDeps 后台探测（注入 fetchImpl；无 apiKey → 不发请求/不惊扰），
 * 探测结果经 windowDiscovered() 现读回填 GET；关闭开关（windowDiscovery:false）
 * → 恒 null。全程 mock/注入（零外部网络）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { assembleDeps } from '../../src/ui/server/deps.js';
import type { DiscoverWindowResult } from '../../src/core/llm/index.js';
import { defaultProviderPreset } from '../../src/core/llm/index.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, startServer } from './support.js';

/** 假 JSON 模型清单响应。 */
function modelListResponse(entries: unknown[]): Response {
  return new Response(JSON.stringify({ data: entries }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 服务端级测试 deps（settings 种子由调用方定）。 */
function baseDeps(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'm0',
    settings: { baseUrl: 'https://g.example/v1', model: 'm0' },
    ...extra,
  };
}

const gatewayDiscovery = {
  window: 200_000,
  source: 'gateway' as const,
  detail: '命中模型「m0」（字段 context_length=200000）',
};

describe('ui/server：三源取窗 GET /api/settings 优先级', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('p1) gateway 探测 > preset：window=探测值 + windowDetail 注来源（无显式覆盖时）', async () => {
    const { base, server } = await startServer(
      baseDeps({
        settings: { baseUrl: 'https://g.example/v1', model: 'm0', windowTokens: 64_000 },
        windowDiscovered: () => gatewayDiscovery,
      }),
    );
    servers.push(server);
    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(settings.window).toBe(200_000);
    expect(settings.windowDetail).toContain('网关');
    expect(settings.windowDetail).toContain('context_length');
  });

  it('p2) 显式覆盖 > 探测：POST windowTokens 后锁定覆盖值（探测不再顶替），detail 注明手动覆盖', async () => {
    const { base, server } = await startServer(
      baseDeps({ windowDiscovered: () => gatewayDiscovery }),
    );
    servers.push(server);
    const posted = (await (
      await postJson(base, '/api/settings', { windowTokens: 300_000 })
    ).json()) as { window?: number; windowDetail?: string };
    expect(posted.window).toBe(300_000);
    expect(posted.windowDetail).toContain('覆盖');
    const after = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
    };
    expect(after.window).toBe(300_000);
  });

  it('p3) 显式种子（windowTokensExplicit:true）> 探测 > preset：初值即覆盖', async () => {
    const { base, server } = await startServer(
      baseDeps({
        settings: {
          baseUrl: 'https://g.example/v1',
          model: 'm0',
          windowTokens: 24_000,
          windowTokensExplicit: true,
        },
        windowDiscovered: () => gatewayDiscovery,
      }),
    );
    servers.push(server);
    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(settings.window).toBe(24_000);
    expect(settings.windowDetail).toContain('覆盖');
  });

  it('p4) 无探测（未注入/结果 null）→ preset 估算兜底 + detail 注明', async () => {
    const { base, server } = await startServer(
      baseDeps({
        settings: { baseUrl: 'https://g.example/v1', model: 'm0', windowTokens: 64_000 },
        windowDiscovered: () => null,
      }),
    );
    servers.push(server);
    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(settings.window).toBe(64_000);
    expect(settings.windowDetail).toContain('preset');
  });

  it('p5) 三源全无（无覆盖/无探测/无种子）→ window 不带键（前端回退内置估算）', async () => {
    const { base, server } = await startServer(baseDeps());
    servers.push(server);
    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
    };
    expect(settings.window).toBeUndefined();
  });

  it('p6) 变更 baseUrl/apiKey/model 触发 probeWindow 重探；未注入 → 不探索', async () => {
    // 服务端级：probeWindow 写入与 windowDiscovered 同一来源（装配层语义——探后回填）
    let currentDiscovery: DiscoverWindowResult | null = null;
    const probe = vi.fn(async () => {
      currentDiscovery = { window: 400_000, source: 'gateway', detail: '重探命中' };
      return currentDiscovery;
    });
    const { base, server } = await startServer(
      baseDeps({ windowDiscovered: () => currentDiscovery, probeWindow: probe }),
    );
    servers.push(server);
    const res = await postJson(base, '/api/settings', { baseUrl: 'https://new.example/v1' });
    expect(res.status).toBe(200);
    expect(probe).toHaveBeenCalledWith({
      baseUrl: 'https://new.example/v1',
      apiKey: undefined,
      model: 'm0',
    });
    // 重探结果回填（后台；轮询读 GET）
    await vi.waitFor(
      async () => {
        const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
          window?: number;
        };
        expect(settings.window).toBe(400_000);
      },
      { timeout: 2_000 },
    );
    // 未注入 probeWindow：POST 变更不报错、不探索（保持 preset）
    const { base: base2, server: server2 } = await startServer(
      baseDeps({
        settings: { baseUrl: 'https://g.example/v1', model: 'm0', windowTokens: 64_000 },
      }),
    );
    servers.push(server2);
    const res2 = await postJson(base2, '/api/settings', { baseUrl: 'https://other.example/v1' });
    expect(res2.status).toBe(200);
  });
});

describe('ui/server：assembleDeps 后台探测接线', () => {
  const tempDirs: string[] = [];
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-window-'));
    tempDirs.push(dir);
    return dir;
  }

  it('a1) apiKey + 注入 fetchImpl → 后台探测回填，GET /api/settings 反映（探测 > preset）', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      modelListResponse([{ id: 'deepseek-v4-flash', context_length: 128_000 }]),
    );
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 'sessions'),
      model: 'deepseek-v4-flash',
      apiKey: 'sk-probe-1234567890abc',
      windowDiscovery: { fetchImpl, timeoutMs: 500 },
    });
    // 启动未阻塞：探测完成前读取器 null（不惊扰）
    await vi.waitFor(() => expect(deps.windowDiscovered?.()).not.toBeNull(), {
      timeout: 2_000,
    });
    const discovered = deps.windowDiscovered!();
    expect(discovered).toMatchObject({ window: 128_000, source: 'gateway' });
    expect(discovered?.detail).toContain('deepseek-v4-flash');
    // 请求形态：缺省 preset baseUrl（无 /v1 → 补）+ GET
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      `${defaultProviderPreset().baseUrl.replace(/\/+$/, '')}/v1/models`,
    );
    const { base, server } = await startServer(deps);
    servers.push(server);
    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(settings.window).toBe(128_000);
    expect(settings.windowDetail).toContain('网关');
  });

  it('a2) 无 apiKey → 不发起请求（注入 fetchImpl 也不调用），读取器恒 null；GET 窗口 = preset', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(async () => modelListResponse([{ id: 'x', context_length: 1 }]));
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 'sessions'),
      model: 'm',
      windowDiscovery: { fetchImpl, timeoutMs: 200 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deps.windowDiscovered?.()).toBeNull();
    const { base, server } = await startServer(deps);
    servers.push(server);
    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(settings.window).toBe(defaultProviderPreset().contextWindowTokens);
    expect(settings.windowDetail).toContain('preset');
  });

  it('a3) windowDiscovery:false 关闭 → 有 apiKey 也不探测；probeWindow 不注入（POST 不再探索）', async () => {
    const dir = await tempDir();
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 'sessions'),
      model: 'm',
      apiKey: 'sk-off',
      windowDiscovery: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deps.windowDiscovered?.()).toBeNull();
    expect(deps.probeWindow).toBeUndefined();
    const { base, server } = await startServer(deps);
    servers.push(server);
    const before = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
    };
    expect(before.window).toBe(defaultProviderPreset().contextWindowTokens);
    const res = await postJson(base, '/api/settings', { baseUrl: 'https://off.example/v1' });
    expect(res.status).toBe(200);
  });

  it('a4) 探测失败（网关 401）→ 静默 none，GET 回退 preset + detail 说明网关不可用', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: 'bad key' }), { status: 401 }),
    );
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 'sessions'),
      model: 'm',
      apiKey: 'sk-bad',
      windowDiscovery: { fetchImpl, timeoutMs: 500 },
    });
    await vi.waitFor(() => expect(deps.windowDiscovered?.()).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(deps.windowDiscovered!()).toMatchObject({ window: null, source: 'none' });
    const { base, server } = await startServer(deps);
    servers.push(server);
    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(settings.window).toBe(defaultProviderPreset().contextWindowTokens);
    expect(settings.windowDetail).toContain('preset');
  });
});
