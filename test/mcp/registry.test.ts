/**
 * # test/mcp/registry：createMcpTools——每服务器每工具一个 Tool（CTO 语义 c/f）
 *
 * c) 服务器崩溃（exit）→ 后续 execute 'mcp-server-unavailable'；负缓存 60s 不重连
 *    （工厂调用计数；时钟注入快进窗口后恢复）。
 * f) 工具名清洗（`my-server.my tool` → `mcp_my_server_my_tool`）、description 附注、
 *    parameters=inputSchema 原样（缺失 {type:'object'}）、参数校验（非对象/JSON 解析失败
 *    → invalid-arguments 回注）、content 渲染（text 拼接 + 非 text 标记 [非文本内容]）、
 *    20k 截断加标记、未启用（工厂 null / 不在 map）→ 不产生工具。
 *    判型映射：unknown-tool→tool-not-found；timeout→mcp-call-timeout；isError→content-error。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  connectMcpServer,
  McpError,
  type McpCallResult,
  type McpClient,
  type McpContentBlock,
  type McpToolDef,
} from '../../src/core/mcp/client.js';
import {
  createMcpTools,
  mcpToolFullName,
  renderMcpContent,
  sanitizeMcpPart,
  DEFAULT_MCP_CONTENT_TRUNCATE_CHARS,
  DEFAULT_MCP_NEGATIVE_CACHE_MS,
} from '../../src/core/mcp/registry.js';
import type { Tool, ToolResult } from '../../src/core/loop/types.js';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { ToolCall } from '../../src/shared/session-types.js';
import { fixtureSpec, mkLogPath, waitForPidGone, waitForStart } from './support.js';

// ---------------------------------------------------------------------------
// 假 McpClient（registry 层用例不需要真进程；c 用例用真 fixture）
// ---------------------------------------------------------------------------

interface FakeClientOptions {
  name?: string;
  tools?: McpToolDef[];
  callLog?: Array<{ name: string; args: unknown; timeoutMs?: number }>;
  onCall?: (name: string, args: unknown, timeoutMs: number | undefined) => Promise<McpCallResult>;
  closeSpy?: () => void;
}

function fakeClient(opts: FakeClientOptions): McpClient {
  return {
    name: opts.name ?? 'fake',
    async tools(): Promise<McpToolDef[]> {
      return (opts.tools ?? []).map((t) => ({ ...t }));
    },
    async call(name, args, timeoutMs): Promise<McpCallResult> {
      opts.callLog?.push({ name, args, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      if (opts.onCall !== undefined) return opts.onCall(name, args, timeoutMs);
      return { content: [], isError: false };
    },
    async close(): Promise<void> {
      opts.closeSpy?.();
    },
    isDead(): boolean {
      return false;
    },
  };
}

function textBlock(text: string): McpContentBlock {
  return { type: 'text', text };
}

async function execute(tool: Tool, raw: string, id = 'c1'): Promise<ToolResult> {
  const call: ToolCall = { id, name: tool.name, arguments: raw };
  return tool.execute(call, { sessionId: 's1' });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('core/mcp：registry（工具面装配）', () => {
  const opened: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const o of opened.splice(0)) await o.close();
  });

  // -- f) 清洗与命名 -------------------------------------------------------

  it('f1) 清洗：非 [A-Za-z0-9_] → _；`my-server.my tool` → `mcp_my_server_my_tool`', () => {
    expect(sanitizeMcpPart('my-server')).toBe('my_server');
    expect(sanitizeMcpPart('my tool')).toBe('my_tool');
    expect(sanitizeMcpPart('a.b-c/d')).toBe('a_b_c_d');
    expect(mcpToolFullName('my-server', 'my tool')).toBe('mcp_my_server_my_tool');
    expect(mcpToolFullName('anysearch', 'web_search')).toBe('mcp_anysearch_web_search');
  });

  it('f2) 每工具一个 Tool：name/description/parameters 形状（inputSchema 原样，缺失兜底）', async () => {
    const clients = new Map<string, () => Promise<McpClient | null>>([
      [
        'anysearch',
        () =>
          Promise.resolve(
            fakeClient({
              tools: [
                {
                  name: 'search',
                  description: 'Search the internet',
                  inputSchema: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                  },
                },
                { name: 'no_schema', description: 'No schema tool' },
              ],
            }),
          ),
      ],
    ]);
    const tools = await createMcpTools({ clients });
    expect(tools.length).toBe(2);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const search = byName.get('mcp_anysearch_search');
    expect(search).toBeDefined();
    expect(search?.description).toContain('源自 MCP 服务器 anysearch');
    expect(search?.description).toContain('Search the internet');
    expect(search?.parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
    // inputSchema 缺失 → {type:'object'}
    expect(byName.get('mcp_anysearch_no_schema')?.parameters).toEqual({ type: 'object' });
  });

  it('f3) 未启用服务器（工厂 null / 不在 map）→ 不产生该服务器工具（list 过滤）', async () => {
    const clients = new Map<string, () => Promise<McpClient | null>>([
      ['enabled', () => Promise.resolve(fakeClient({ tools: [{ name: 'a', description: 'a' }] }))],
      ['disabled', () => Promise.resolve(null)],
    ]);
    const tools = await createMcpTools({ clients });
    const names = tools.map((t) => t.name);
    expect(names).toContain('mcp_enabled_a');
    expect(names.some((n) => n.startsWith('mcp_disabled_'))).toBe(false);
    // 不在 map = 未登记：同样不产生
    const onlyEmpty = await createMcpTools({ clients: new Map() });
    expect(onlyEmpty).toEqual([]);
  });

  // -- f) 参数校验 ---------------------------------------------------------

  it('f4) 参数校验：JSON 解析失败 / 非对象 → invalid-arguments 回注（合法对象才转发）', async () => {
    const callLog: Array<{ name: string; args: unknown; timeoutMs?: number }> = [];
    const clients = new Map<string, () => Promise<McpClient | null>>([
      [
        'srv',
        () =>
          Promise.resolve(
            fakeClient({ name: 'srv', tools: [{ name: 't', description: 'd' }], callLog }),
          ),
      ],
    ]);
    const tools = await createMcpTools({ clients });
    const tool = tools[0]!;

    const badJson = await execute(tool, '{oops');
    expect(badJson.ok).toBe(false);
    expect(badJson.error?.type).toBe('invalid-arguments');
    expect(JSON.parse(badJson.content)).toMatchObject({
      ok: false,
      error: { type: 'invalid-arguments' },
    });
    expect(callLog.length).toBe(0); // 没转发

    const notObject = await execute(tool, '[1,2]');
    expect(notObject.ok).toBe(false);
    expect(notObject.error?.type).toBe('invalid-arguments');

    const good = await execute(tool, '{"text":"hi"}');
    expect(good.ok).toBe(true);
    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toEqual({ name: 't', args: { text: 'hi' } });
  });

  // -- f) content 渲染 ------------------------------------------------------

  it('f5) content 渲染：text 拼接 + 非 text 标记 [非文本内容]', () => {
    expect(
      renderMcpContent([
        textBlock('head'),
        { type: 'image', data: 'xx', mimeType: 'image/png' },
        textBlock('tail'),
      ]),
    ).toBe('head\n[非文本内容]\ntail');
    expect(renderMcpContent([textBlock('only')])).toBe('only');
    expect(renderMcpContent([])).toBe('');
  });

  it('f6) 工具结果 20k 截断加标记（注意力成本）；isError → content-error', async () => {
    const big = 'A'.repeat(DEFAULT_MCP_CONTENT_TRUNCATE_CHARS + 5000);
    const clients = new Map<string, () => Promise<McpClient | null>>([
      [
        'srv',
        () =>
          Promise.resolve(
            fakeClient({
              name: 'srv',
              tools: [{ name: 'big', description: 'd' }],
              onCall: async () => ({ content: [textBlock(big)], isError: false }),
            }),
          ),
      ],
      [
        'err',
        () =>
          Promise.resolve(
            fakeClient({
              name: 'err',
              tools: [{ name: 'boom', description: 'd' }],
              onCall: async () => ({ content: [textBlock('boom text')], isError: true }),
            }),
          ),
      ],
    ]);
    const tools = await createMcpTools({ clients });
    const trunc = await execute(
      tools.find((t) => t.name === 'mcp_srv_big')!,
      '{}',
    );
    expect(trunc.ok).toBe(true);
    // 20k 截断：保留前 20000 字符 + 简短标记（总长严格落在上限+标记内）
    expect(trunc.content.startsWith('A'.repeat(DEFAULT_MCP_CONTENT_TRUNCATE_CHARS))).toBe(true);
    expect(trunc.content.length).toBeGreaterThan(DEFAULT_MCP_CONTENT_TRUNCATE_CHARS);
    expect(trunc.content.length).toBeLessThan(DEFAULT_MCP_CONTENT_TRUNCATE_CHARS + 200);
    expect(trunc.content).toContain('mcp content truncated');
    expect(trunc.content).toContain('5000 chars dropped');

    const contentErr = await execute(
      tools.find((t) => t.name === 'mcp_err_boom')!,
      '{}',
    );
    expect(contentErr.ok).toBe(false);
    expect(contentErr.error?.type).toBe('content-error');
    expect(contentErr.content).toBe('boom text');
  });

  // -- 调错判型（client 错误 kind → registry 错误分层） ----------------------

  it('f7) 判型映射：unknown-tool→tool-not-found；timeout→mcp-call-timeout；无客户机→mcp-server-unavailable', async () => {
    const clients = new Map<string, () => Promise<McpClient | null>>([
      [
        'unk',
        () =>
          Promise.resolve(
            fakeClient({
              name: 'unk',
              tools: [{ name: 'ghost', description: 'd' }],
              onCall: async () => {
                throw new McpError('unknown-tool', 'server says: unknown tool: ghost');
              },
            }),
          ),
      ],
      [
        'slow',
        () =>
          Promise.resolve(
            fakeClient({
              name: 'slow',
              tools: [{ name: 'hang', description: 'd' }],
              onCall: async () => {
                throw new McpError('timeout', 'call timed out after 120000ms');
              },
            }),
          ),
      ],
    ]);
    const tools = await createMcpTools({ clients });
    const unk = await execute(
      tools.find((t) => t.name === 'mcp_unk_ghost')!,
      '{}',
    );
    expect(unk.ok).toBe(false);
    expect(unk.error?.type).toBe('tool-not-found');
    expect(unk.error?.message).toContain('unknown tool');
    const slow = await execute(
      tools.find((t) => t.name === 'mcp_slow_hang')!,
      '{}',
    );
    expect(slow.ok).toBe(false);
    expect(slow.error?.type).toBe('mcp-call-timeout');
  });

  // -- c) 崩溃 + 负缓存 -----------------------------------------------------

  it('c1) 服务器崩溃（exit）→ 后续 call mcp-server-unavailable；负缓存 60s 内不重连', async () => {
    const log = mkLogPath();
    const spec = fixtureSpec({ log, crashAfterCall: true }, 'fixture', log);
    let factoryCalls = 0;
    const clients = new Map<string, () => Promise<McpClient | null>>([
      [
        'fixture',
        () => {
          factoryCalls += 1;
          return connectMcpServer(spec);
        },
      ],
    ]);
    // 注：负缓存窗口走注入时钟（真实 60s 内断言「不重连」即可；快进断言「到期恢复」）
    let nowVal = 1_000_000;
    const tools = await createMcpTools({
      clients,
      now: () => nowVal,
    });
    const registry = defineRegistry(tools, { sessionId: 's1' });
    const pid = await waitForStart(log);

    const first = await registry.execute({
      id: 'c1',
      name: 'mcp_fixture_echo_tool',
      arguments: JSON.stringify({ text: 'hello' }),
    });
    expect(first.ok).toBe(true);
    expect(factoryCalls).toBe(1);
    // 服务器崩溃：应答首个 call 后 20ms 自行退出
    expect(await waitForPidGone(pid)).toBe(true);

    const second = await registry.execute({
      id: 'c2',
      name: 'mcp_fixture_echo_tool',
      arguments: '{}',
    });
    expect(second.ok).toBe(false);
    expect(second.error?.type).toBe('mcp-server-unavailable');
    expect(factoryCalls).toBe(1); // 负缓存生效：60s 内不重连（工厂未再被调用）

    // 快进过 60s 窗口：恢复重连（新 fixture 进程），后续 call 照常
    nowVal += DEFAULT_MCP_NEGATIVE_CACHE_MS + 1;
    const third = await registry.execute({
      id: 'c3',
      name: 'mcp_fixture_echo_tool',
      arguments: '{}',
    });
    expect(third.ok).toBe(true);
    expect(factoryCalls).toBe(2);
  });
});
