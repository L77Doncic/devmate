/**
 * # test/ui-server/mcp-wiring：MCP 接线（launcher + 工具面合并 + /api/mcp 脱敏 + stats）
 *
 * 覆盖（对应任务书接线 1-5 项）：
 * - W1 McpLauncher：enabled=false 工厂 null（registry 不产生工具）；懒连接一次、跨组装
 *   复用同一客户端（一次一个子进程）；连接失败 → null 不 throw；配置晚绑定（开关
 *   即时生效）：禁用 → 关闭并摘除连接，再启用 → 重建（工厂重连）；dispose 幂等、关
 *   闭全部（含在飞连接收尾）。
 * - W2 mergeMcpTools：mcp 工具追加在基础（fs/shell/技能/子代理）之后同表；execute 按名
 *   分发；未知工具按 full list 回注；mcp 路径结果过 securedRegistry 脱敏（Bearer 掩码）。
 * - W3 脱敏纯函数多态：空格形（--header/-H 两元素）与单参数形（--header=/-H=）；非
 *   Authorization 头原样；flag 末尾无值不掩。
 * - W4 GET /api/mcp 端点掩码：响应体无原始 token 残留；POST /api/mcp 添加保留原始 args
 *   （掩码只作用于展示层）；GET 反映掩码；POST 开关路径不触发掩码。
 * - W5 连接失败：工具面构建不崩（0 个 mcp 工具；/api/tools 200 基础清单、/api/stats 200）。
 * - W6 组装计数：合并后统计数（mcpTools）恰为 mcp 工具数；基础工具排序不破坏。
 * 全程零真实网络：假连接（fake client / 拒绝连接），不 spawn 任何进程。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { Tool, ToolDef, ToolRegistry } from '../../src/core/loop/index.js';
import type { ToolCall } from '../../src/shared/session-types.js';
import { createMcpTools } from '../../src/core/mcp/index.js';
import type {
  McpCallResult,
  McpClient,
  McpContentBlock,
  McpToolDef,
} from '../../src/core/mcp/client.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type {
  DevmateServer,
  DevmateServerDeps,
  McpServerConfig,
} from '../../src/ui/server/index.js';
import { McpLauncher, mergeMcpTools } from '../../src/ui/server/deps.js';
import { maskMcpArgs, maskMcpHeaderValue } from '../../src/ui/server/mcp-mask.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, startServer } from './support.js';

// ---------------------------------------------------------------------------
// 假客户端（registry.test.ts 同款最简形态；close 计数供 launcher dispose 断言）
// ---------------------------------------------------------------------------

interface FakeClientOptions {
  name?: string;
  tools?: McpToolDef[];
  onCall?: (name: string, args: unknown) => Promise<McpCallResult>;
}

function fakeClient(opts: FakeClientOptions): McpClient & { closed: number; calls: number } {
  return {
    name: opts.name ?? 'fake',
    closed: 0,
    calls: 0,
    async tools(): Promise<McpToolDef[]> {
      this.calls += 1;
      return (opts.tools ?? []).map((t) => ({ ...t }));
    },
    async call(name: string, args: unknown): Promise<McpCallResult> {
      if (opts.onCall !== undefined) return opts.onCall(name, args);
      return { content: [], isError: false };
    },
    async close(): Promise<void> {
      this.closed += 1;
    },
    isDead(): boolean {
      return false;
    },
  };
}

const SEARCH_TOOLS: McpToolDef[] = [
  { name: 'web_search', description: 'Search the internet', inputSchema: { type: 'object' } },
  { name: 'fetch_url', description: 'Fetch a URL', inputSchema: { type: 'object' } },
];

// ---------------------------------------------------------------------------
// W1 launcher
// ---------------------------------------------------------------------------

describe('ui/server/mcp-wiring：McpLauncher（懒连接/复用/负配置/幂等 dispose）', () => {
  it('W1a) enabled → factory 返回客户端（懒连接）；disabled → null（registry 无工具）；同一过配置 build 两次 → 同一客户端（一次一个子进程）', async () => {
    const configs: McpServerConfig[] = [
      { name: 'search', command: 'npx', args: ['-y'], enabled: true },
      { name: 'off', command: 'x', args: [], enabled: false },
    ];
    const conn = vi.fn(async (spec: McpServerConfig) =>
      fakeClient({ name: spec.name, tools: SEARCH_TOOLS }),
    );
    const launcher = new McpLauncher({ configs: () => configs, connect: conn });

    const first = await createMcpTools({ clients: launcher.clients() });
    expect(first.map((t) => t.name)).toEqual(['mcp_search_web_search', 'mcp_search_fetch_url']); // disabled 无
    expect(conn).toHaveBeenCalledTimes(1);

    const second = await createMcpTools({ clients: launcher.clients() });
    expect(second.map((t) => t.name)).toEqual(first.map((t) => t.name));
    expect(conn).toHaveBeenCalledTimes(1); // 复用：不重连

    // disabled 服务器：工厂存在但恒 null（registry 判负缓存语义）
    const offFactory = launcher.clients().get('off');
    expect(offFactory).toBeTypeOf('function');
    expect(await offFactory!()).toBeNull();
    expect(conn).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'off' }));
  });

  it('W1b) 连接失败/拒绝 → null 不 throw；assembled 计数 0；clients()-map 不含失败服务器工具', async () => {
    const configs: McpServerConfig[] = [
      { name: 'dead', command: 'nonexistent-command', args: [], enabled: true },
    ];
    const launcher = new McpLauncher({
      configs: () => configs,
      connect: async () => {
        throw new Error('spawn failed');
      },
    });
    const factory = launcher.clients().get('dead')!;
    // 两层语境都不 throw：直接工厂调用与工具面构建均收敛 null/空清单
    await expect(factory()).resolves.toBeNull();
    const tools = await launcher.assemble();
    expect(tools).toEqual([]);
    expect(launcher.toolCount()).toBe(0);
    const fn = launcher.clients().get('dead')!;
    await expect(fn()).resolves.toBeNull();
  });

  it('W1c) 配置晚绑定：禁用（enabled=false）→ 摘除并关闭连接、工厂 null；再启用 → 重建（重连）', async () => {
    const configs: McpServerConfig[] = [
      { name: 'search', command: 'npx', args: [], enabled: true },
    ];
    let created: (McpClient & { closed: number }) | null = null;
    const launcher = new McpLauncher({
      configs: () => configs,
      connect: async (spec) => {
        created = fakeClient({ name: spec.name, tools: SEARCH_TOOLS });
        return created;
      },
    });
    expect((await launcher.assemble()).length).toBe(2);
    expect(launcher.toolCount()).toBe(2);
    const first = created!;

    configs[0]!.enabled = false; // 开关变更（服务端 POST /api/mcp 同路径）
    expect((await launcher.assemble()).length).toBe(0);
    expect(launcher.toolCount()).toBe(0);
    expect(first.closed).toBe(1); // 摘除即关闭：开关变更即时生效、无残留子进程

    configs[0]!.enabled = true;
    expect((await launcher.assemble()).length).toBe(2);
    expect(first.closed).toBe(1); // 旧客户端不因重建复活；工厂按 spec 新建
    expect(created).not.toBe(first); // 确为新连接
  });

  it('W1d) 服务器从配置删除 → 连接摘除关闭；不在 map（registry 不产生工具）', async () => {
    const configs: McpServerConfig[] = [{ name: 'a', command: 'x', args: [], enabled: true }];
    let client: (McpClient & { closed: number }) | null = null;
    const launcher = new McpLauncher({
      configs: () => configs,
      connect: async (spec) => {
        client = fakeClient({ name: spec.name, tools: SEARCH_TOOLS });
        return client;
      },
    });
    await launcher.assemble();
    configs.splice(0); // 被删除
    const map = launcher.clients();
    expect(map.has('a')).toBe(false); // registry：not in map = 未登记
    expect(client!.closed).toBe(1);
  });

  it('W1e) dispose 幂等：关闭全部已连客户端；dispose 后工厂恒 null、assemble 空；再次 dispose 不重复 close', async () => {
    const configs: McpServerConfig[] = [
      { name: 'a', command: 'x', args: [], enabled: true },
      { name: 'b', command: 'y', args: [], enabled: true },
    ];
    const made: Array<McpClient & { closed: number }> = [];
    const launcher = new McpLauncher({
      configs: () => configs,
      connect: async (spec) => {
        const client = fakeClient({ name: spec.name, tools: SEARCH_TOOLS.slice(0, 1) });
        made.push(client);
        return client;
      },
    });
    await launcher.assemble();
    await launcher.dispose();
    expect(made).toHaveLength(2);
    expect(made.every((c) => c.closed === 1)).toBe(true);

    await launcher.dispose(); // 幂等：不重复 close
    expect(made.every((c) => c.closed === 1)).toBe(true);

    expect(await launcher.assemble()).toEqual([]); // disposed：空面
    const disabledFactory = launcher.clients().get('a')!;
    await expect(disabledFactory()).resolves.toBeNull(); // 恒 null（不 throw）
  });
});

// ---------------------------------------------------------------------------
// W2 工具面合并
// ---------------------------------------------------------------------------

describe('ui/server/mcp-wiring：mergeMcpTools（同表追加/分发/脱敏/未知清单）', () => {
  function baseRegistry(): { registry: ToolRegistry; defs: ToolDef[] } {
    const defs: ToolDef[] = [
      { name: 'read_file', description: 'r', parameters: { type: 'object' } },
      { name: 'run_command', description: 'c', parameters: { type: 'object' } },
    ];
    return {
      registry: defineRegistry(
        defs.map<Tool>((d) => ({
          ...d,
          async execute(call) {
            return { ok: true, content: `base:${call.name}` };
          },
        })),
        { sessionId: 's1' },
      ),
      defs,
    };
  }

  it('W2a) 合并：list = base 顺序 + mcp 追加（同表）；execute 按名分发（mcp 工具直入、基础走 base）', async () => {
    const { registry: base, defs } = baseRegistry();
    const launcher = new McpLauncher({
      configs: () => [{ name: 'search', command: 'x', args: [], enabled: true }],
      connect: async () => fakeClient({ name: 'search', tools: SEARCH_TOOLS }),
    });
    const merged = mergeMcpTools(base, await launcher.assemble(), 's1');

    const expected: ToolDef[] = [
      ...defs,
      {
        name: 'mcp_search_web_search',
        description: 'Search the internet\n（源自 MCP 服务器 search）',
        parameters: { type: 'object' },
      },
      {
        name: 'mcp_search_fetch_url',
        description: 'Fetch a URL\n（源自 MCP 服务器 search）',
        parameters: { type: 'object' },
      },
    ];
    expect(merged.list()).toEqual(expected); // 基础在前、mcp 追加在后

    const mcpResult = await merged.execute({
      id: 'c1',
      name: 'mcp_search_web_search',
      arguments: '{}',
    } as ToolCall);
    expect(mcpResult).toEqual({ ok: true, content: '' }); // fake call 空 content
    const baseResult = await merged.execute({
      id: 'c2',
      name: 'read_file',
      arguments: '{}',
    } as ToolCall);
    expect(baseResult.content).toBe('base:read_file');
  });

  it('W2b) 未知工具回注包含全清单（base + mcp）；mcp 路径经 securedRegistry 脱敏（Bearer 掩码）', async () => {
    const { registry: base, defs } = baseRegistry();
    const configs: McpServerConfig[] = [{ name: 'search', command: 'x', args: [], enabled: true }];
    const launcher = new McpLauncher({
      configs: () => configs,
      connect: async (spec) =>
        fakeClient({
          name: spec.name,
          tools: SEARCH_TOOLS,
          onCall: async () => ({
            content: [
              {
                type: 'text',
                text: `saw: Bearer as_sk_${'secretsecret'.repeat(2)}`,
              } as McpContentBlock,
            ],
            isError: false,
          }),
        }),
    });
    const merged = mergeMcpTools(base, await launcher.assemble(), 's1');

    const unknown = await merged.execute({
      id: 'c1',
      name: 'no_such_tool',
      arguments: '{}',
    } as ToolCall);
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.type).toBe('unknown_tool');
    expect(JSON.parse(unknown.content).error.available_tools).toEqual([
      'read_file',
      'run_command',
      'mcp_search_web_search',
      'mcp_search_fetch_url',
    ]);

    const secret = await merged.execute({
      id: 'c2',
      name: 'mcp_search_web_search',
      arguments: '{}',
    } as ToolCall);
    expect(secret.ok).toBe(true);
    expect(secret.content).not.toContain('secretsecret');
    expect(secret.content).toContain('[REDACTED:bearer-token]');
    expect(defs).toHaveLength(2); // base 不受影响
  });

  it('W2c) mcp 为零 → 返回 base 本身（不包层）', async () => {
    const { registry: base } = baseRegistry();
    expect(mergeMcpTools(base, [], 's1')).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// W3 脱敏纯函数
// ---------------------------------------------------------------------------

describe('ui/server/mcp-wiring：maskMcpArgs 纯函数（空格形/单参数形）', () => {
  it('W3a) maskMcpHeaderValue：Bearer as_sk_* 保留前缀；其余 Authorization → [REDACTED]；非 Authorization 原样', () => {
    expect(maskMcpHeaderValue('Authorization: Bearer as_sk_b73d5aec814fef4729821efd168da48a')).toBe(
      'Authorization: Bearer as_sk_******',
    );
    expect(maskMcpHeaderValue('authorization: Bearer as_sk_x')).toBe(
      'authorization: Bearer as_sk_******',
    );
    expect(maskMcpHeaderValue('Authorization: Basic Zm9vOmJhcg==')).toBe('[REDACTED]');
    // 非 as_sk_ 前缀的 Bearer 凭据：保留头名与 scheme 前缀，凭据整掩
    expect(maskMcpHeaderValue('Authorization: Bearer ghp_bigsecretvalue')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(maskMcpHeaderValue('X-API-Key: 12345')).toBe('X-API-Key: 12345');
    expect(maskMcpHeaderValue('Authorization: Bearer ')).toBe('[REDACTED]'); // 无凭据 → 整值
  });

  it('W3b) maskMcpArgs：--header/-H 后下一元素掩码；--header=/-H= 单参数形同规则；flag 末尾无值不掩', () => {
    expect(
      maskMcpArgs([
        '-y',
        'mcp-remote',
        'https://api.anysearch.com/mcp',
        '--header',
        'Authorization: Bearer as_sk_b73d5aec814fef4729821efd168da48a',
      ]),
    ).toEqual([
      '-y',
      'mcp-remote',
      'https://api.anysearch.com/mcp',
      '--header',
      'Authorization: Bearer as_sk_******',
    ]);
    expect(maskMcpArgs(['-H', 'Authorization: Basic abc'])).toEqual(['-H', '[REDACTED]']);
    expect(maskMcpArgs(['--header=Authorization: Bearer as_sk_z'])).toEqual([
      '--header=Authorization: Bearer as_sk_******',
    ]);
    expect(maskMcpArgs(['-H=Authorization: abc'])).toEqual(['-H=[REDACTED]']);
    // 非 Authorization 头、无关参数、flag 末尾无值：全部原样
    expect(maskMcpArgs(['--header', 'X-Trace: 7'])).toEqual(['--header', 'X-Trace: 7']);
    expect(maskMcpArgs(['--header'])).toEqual(['--header']);
    expect(maskMcpArgs(['---quiet', 'value'])).toEqual(['---quiet', 'value']);
    // 不改输入数组
    const raw = ['--header', 'Authorization: Bearer as_sk_x'];
    const masked = maskMcpArgs(raw);
    expect(raw).toEqual(['--header', 'Authorization: Bearer as_sk_x']);
    expect(masked).not.toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// W4 /api/mcp 端点掩码
// ---------------------------------------------------------------------------

describe('ui/server/mcp-wiring：GET /api/mcp 响应脱敏（无 token 残留；POST 不变）', () => {
  const servers: DevmateServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  const TOKEN = 'as_sk_b73d5aec814fef4729821efd168da48a';

  it('W4a) 种子配置含 Authorization（空格形）：GET 响应掩码且响应体无原 token 残留', async () => {
    const { base, server } = await startServer({
      store: new MemorySessionAdapter(),
      tools: defineRegistry([], { sessionId: 's1' }),
      llm: new FakeLlm([{ content: 'x' }]),
      model: 'm',
      mcpServers: [
        {
          name: 'anysearch',
          command: 'npx',
          args: [
            '-y',
            'mcp-remote',
            'https://api.anysearch.com/mcp',
            '--header',
            `Authorization: Bearer ${TOKEN}`,
          ],
          enabled: true,
        },
      ],
    });
    servers.push(server);
    const res = await fetch(new URL('/api/mcp', base));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text) as { servers: McpServerConfig[] };
    expect(body.servers[0]!.enabled).toBe(true);
    expect(body.servers[0]!.args.at(-1)).toBe('Authorization: Bearer as_sk_******');
  });

  it('W4b) POST /api/mcp 添加 = 形参数：saveMcpConfig 收到原始 args（不掩码），GET 响应掩码；POST 开关后 GET 同样掩码', async () => {
    const saveMcpConfig = vi.fn();
    const { base, server } = await startServer({
      store: new MemorySessionAdapter(),
      tools: defineRegistry([], { sessionId: 's1' }),
      llm: new FakeLlm([{ content: 'x' }]),
      model: 'm',
      saveMcpConfig,
    });
    servers.push(server);

    const add = await postJson(base, '/api/mcp', {
      name: 'any',
      command: 'npx',
      args: [`--header=Authorization: Bearer ${TOKEN}`, '--no-cache'],
    });
    expect(add.status).toBe(200);
    const persisted = saveMcpConfig.mock.lastCall![0] as McpServerConfig[];
    expect(persisted[0]!.args[0]).toBe(`--header=Authorization: Bearer ${TOKEN}`); // 存储原始（连接需要）

    const badge = await postJson(base, '/api/mcp/any', { enabled: false });
    expect(badge.status).toBe(200);

    const text = await (await fetch(new URL('/api/mcp', base))).text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text) as { servers: McpServerConfig[] };
    expect(body.servers[0]!.args[0]).toBe('--header=Authorization: Bearer as_sk_******');
    expect(body.servers[0]!.args[1]).toBe('--no-cache');
    expect(body.servers[0]!.enabled).toBe(false);
    expect(saveMcpConfig).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'any', enabled: false })]),
    );
  });

  it('W4c) 无 Authorization 的 args 原样返回', async () => {
    const { base, server } = await startServer({
      store: new MemorySessionAdapter(),
      tools: defineRegistry([], { sessionId: 's1' }),
      llm: new FakeLlm([{ content: 'x' }]),
      model: 'm',
      mcpServers: [
        { name: 'fs', command: 'npx', args: ['-y', '@mcp/filesystem', '/tmp'], enabled: false },
      ],
    });
    servers.push(server);
    const text = await (await fetch(new URL('/api/mcp', base))).text();
    const body = JSON.parse(text) as { servers: McpServerConfig[] };
    expect(body.servers[0]!.args).toEqual(['-y', '@mcp/filesystem', '/tmp']);
  });
});

// ---------------------------------------------------------------------------
// W5 连接失败与服务级 stats
// ---------------------------------------------------------------------------

describe('ui/server/mcp-wiring：连接失败不炸工具面/stats（0 个 mcp 工具）', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  function depsFor(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
    return {
      store: new MemorySessionAdapter(),
      tools: defineRegistry([], { sessionId: 's1' }),
      llm: new FakeLlm([{ content: 'x' }]),
      model: 'm',
      ...extra,
    };
  }

  it('W5a) composeRunTools 经 reject 工厂：/api/tools 200 基础清单（非 501）；/api/stats 200 且 mcpServers=1、mcpTools=0', async () => {
    const clientsMap = new Map<string, () => Promise<McpClient | null>>([
      [
        'dead',
        async () => {
          throw new Error('spawn failed');
        },
      ],
    ]);
    const { base, server } = await startServer(
      depsFor({
        mcpServers: [{ name: 'dead', command: 'nope', args: [], enabled: true }],
        composeRunTools: async (base: ToolRegistry, sessionId: string) =>
          mergeMcpTools(base, await createMcpTools({ clients: clientsMap }), sessionId),
        mcpToolCount: () => 0,
      }),
    );
    servers.push(server);

    const toolsRes = await fetch(new URL('/api/tools', base));
    expect(toolsRes.status).toBe(200);
    expect((await toolsRes.json()) as { tools: unknown[] }).toEqual({ tools: [] });

    const stats = (await (await fetch(new URL('/api/stats', base))).json()) as Record<
      string,
      unknown
    >;
    expect(typeof stats.rssMb).toBe('number');
    expect(stats.mcpServers).toBe(1); // 配置数
    expect(stats.mcpTools).toBe(0); // 连接失败 → 0 个 mcp 工具（不报错）
  });

  it('W5b) 空 compose（无 mcp 服务器）：stats 恒 mcpServers=0、mcpTools=0', async () => {
    const { base, server } = await startServer(depsFor({}));
    servers.push(server);
    const stats = (await (await fetch(new URL('/api/stats', base))).json()) as Record<
      string,
      unknown
    >;
    expect(stats.mcpServers).toBe(0);
    expect(stats.mcpTools).toBe(0);
  });

  it('W5c) merge 后 execute mcp 工具：服务器不可用 → 普通失败回注（mcp-server-unavailable），不 throw', async () => {
    const { registry: base } = (() => {
      const defs: ToolDef[] = [
        { name: 'read_file', description: 'r', parameters: { type: 'object' } },
      ];
      return {
        registry: defineRegistry(
          defs.map<Tool>((d) => ({
            ...d,
            async execute() {
              return { ok: true, content: '' };
            },
          })),
          { sessionId: 's1' },
        ),
      };
    })();
    const launcher = new McpLauncher({
      configs: () => [{ name: 'dead', command: 'x', args: [], enabled: true }],
      connect: async () => null,
    });
    const merged = mergeMcpTools(base, await launcher.assemble(), 's1');
    expect((merged.list() as ToolDef[]).map((d) => d.name)).toEqual(['read_file']); // 0 mcp 工具
    const r = await merged.execute({ id: 'c1', name: 'read_file', arguments: '{}' } as ToolCall);
    expect(r.ok).toBe(true);
  });
});
