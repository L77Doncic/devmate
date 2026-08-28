/**
 * # test/ui-server/mcp：/api/mcp 端点（波 B：契约 A3 —— 配置层 ONLY；
 *   协议客户端已实现于 core/mcp，不在本端点）
 *
 * GET /api/mcp → {servers:[{name,command,args[],enabled}]}（deps.mcpServers 注入初值/缺省空）；
 * POST /api/mcp {name,command,args} 添加（enabled 缺省 true；重复 name → 409）；
 * POST /api/mcp/:name {enabled} 开关（未知 → 404）。
 * 持久化经 saveMcpConfig（CLI 注入 config.json；无则仅内存）。本端点只维护配置，
 * 不发起任何服务器连接（MCP 协议客户端已实现于 core/mcp，与此解耦）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type {
  DevmateServer,
  DevmateServerDeps,
  McpServerConfig,
} from '../../src/ui/server/index.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, startServer } from './support.js';

function baseDeps(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    ...extra,
  };
}

describe('ui/server：/api/mcp（配置层）', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('m1) GET 缺省 {servers:[]}；deps.mcpServers 注入原样列出（含 args/enabled）', async () => {
    const { base, server } = await startServer(baseDeps());
    servers.push(server);
    expect(
      ((await (await fetch(new URL('/api/mcp', base))).json()) as { servers: unknown[] }).servers,
    ).toEqual([]);

    const seed: McpServerConfig[] = [
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        enabled: true,
      },
      { name: 'memory', command: 'memory-server', args: [], enabled: false },
    ];
    const { base: base2, server: server2 } = await startServer(baseDeps({ mcpServers: seed }));
    servers.push(server2);
    const got = (await (await fetch(new URL('/api/mcp', base2))).json()) as {
      servers: McpServerConfig[];
    };
    expect(got.servers).toEqual(seed);
  });

  it('m2) POST /api/mcp 添加：enabled 缺省 true；saveMcpConfig 全量快照；GET 反映', async () => {
    const saveMcpConfig = vi.fn();
    const { base, server } = await startServer(baseDeps({ saveMcpConfig }));
    servers.push(server);

    const added = await postJson(base, '/api/mcp', {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@mcp/filesystem'],
    });
    expect(added.status).toBe(200);
    expect(saveMcpConfig).toHaveBeenCalledTimes(1);
    expect(saveMcpConfig).toHaveBeenLastCalledWith([
      { name: 'filesystem', command: 'npx', args: ['-y', '@mcp/filesystem'], enabled: true },
    ]);

    const got = (await (await fetch(new URL('/api/mcp', base))).json()) as {
      servers: McpServerConfig[];
    };
    expect(got.servers).toEqual([
      { name: 'filesystem', command: 'npx', args: ['-y', '@mcp/filesystem'], enabled: true },
    ]);
  });

  it('m3) 校验：缺 name/command、空串、args 非字符串数组 → 400；重复 name → 409', async () => {
    const { base, server } = await startServer(baseDeps());
    servers.push(server);

    for (const bad of [
      {},
      { command: 'cmd', args: [] },
      { name: '', command: 'cmd', args: [] },
      { name: 'a', args: [] },
      { name: 'a', command: '', args: [] },
      { name: 'a', command: 'cmd', args: [1] },
      { name: 'a', command: 'cmd', args: 'nope' },
    ]) {
      const res = await postJson(base, '/api/mcp', bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }

    await postJson(base, '/api/mcp', { name: 'dup', command: 'c', args: [] });
    const dupRes = await postJson(base, '/api/mcp', { name: 'dup', command: 'c2', args: [] });
    expect(dupRes.status).toBe(409);
  });

  it('m4) POST /api/mcp/:name {enabled} 开关并持久化；未知 name → 404；enabled 非 boolean → 400', async () => {
    const saveMcpConfig = vi.fn();
    const { base, server } = await startServer(
      baseDeps({
        saveMcpConfig,
        mcpServers: [
          { name: 'filesystem', command: 'npx', args: ['-y', '@mcp/fs'], enabled: true },
        ],
      }),
    );
    servers.push(server);

    const off = await postJson(base, '/api/mcp/filesystem', { enabled: false });
    expect(off.status).toBe(200);
    expect(saveMcpConfig).toHaveBeenLastCalledWith([
      { name: 'filesystem', command: 'npx', args: ['-y', '@mcp/fs'], enabled: false },
    ]);

    const got = (await (await fetch(new URL('/api/mcp', base))).json()) as {
      servers: McpServerConfig[];
    };
    expect(got.servers[0]!.enabled).toBe(false);

    const unknown = await postJson(base, '/api/mcp/ghost', { enabled: false });
    expect(unknown.status).toBe(404);
    const bad = await postJson(base, '/api/mcp/filesystem', { enabled: 'no' });
    expect(bad.status).toBe(400);
  });

  it('m5) 无 saveMcpConfig → 仅内存；开关互不串扰', async () => {
    const { base, server } = await startServer(
      baseDeps({
        mcpServers: [{ name: 'a', command: 'x', args: [], enabled: true }],
      }),
    );
    servers.push(server);
    await postJson(base, '/api/mcp', { name: 'b', command: 'y', args: ['--quiet'] });
    await postJson(base, '/api/mcp/a', { enabled: false });
    const got = (await (await fetch(new URL('/api/mcp', base))).json()) as {
      servers: McpServerConfig[];
    };
    expect(got.servers).toEqual([
      { name: 'a', command: 'x', args: [], enabled: false },
      { name: 'b', command: 'y', args: ['--quiet'], enabled: true },
    ]);
  });

  it('m6) 尺寸限制：name ≤64、command ≤256、args ≤16 项且每项 ≤128 → 超限 400 带原因', async () => {
    const { base, server } = await startServer(baseDeps());
    servers.push(server);

    const name65 = 'n'.repeat(65);
    const command257 = 'c'.repeat(257);
    const arg129 = 'a'.repeat(129);
    const args17 = Array.from({ length: 17 }, (_, i) => `arg-${i}`);
    const cases: Array<{ body: unknown; fragment: string }> = [
      { body: { name: name65, command: 'cmd', args: [] }, fragment: 'name' },
      { body: { name: 'ok', command: command257, args: [] }, fragment: 'command' },
      { body: { name: 'ok', command: 'cmd', args: args17 }, fragment: 'args' },
      { body: { name: 'ok', command: 'cmd', args: ['-x', arg129] }, fragment: 'arg' },
    ];
    for (const { body, fragment } of cases) {
      const res = await postJson(base, '/api/mcp', body);
      expect(res.status, fragment).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain(fragment); // {error} 带原因
    }

    // 边界内放行（64/256/16×128）
    const okRes = await postJson(base, '/api/mcp', {
      name: 'n'.repeat(64),
      command: 'c'.repeat(256),
      args: Array.from({ length: 16 }, () => 'a'.repeat(128)),
    });
    expect(okRes.status).toBe(200);
  });

  it('m7) 超限校验不持久化：越界 POST 后 saveMcpConfig 不被调用，GET 仍空', async () => {
    const saveMcpConfig = vi.fn();
    const { base, server } = await startServer(baseDeps({ saveMcpConfig }));
    servers.push(server);
    const res = await postJson(base, '/api/mcp', { name: 'n'.repeat(65), command: 'c', args: [] });
    expect(res.status).toBe(400);
    expect(saveMcpConfig).not.toHaveBeenCalled();
    const got = (await (await fetch(new URL('/api/mcp', base))).json()) as {
      servers: McpServerConfig[];
    };
    expect(got.servers).toEqual([]);
  });
});
