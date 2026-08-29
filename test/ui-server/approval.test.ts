/**
 * # test/ui-server/approval：危险操作审批往返（接缝 S12 c 档；权限预设定案后语义迁移）
 *
 * 协议：approval-request 只由权限预设矩阵的 ask 项触发；默认档（workspace-write）下
 * fs 全类与只读命令放行（不弹窗）、ask 级命令（未知命令等）弹窗、deny 级命令
 * （rm -rf 等）不弹窗直拒（permission-denied 回注，纯工具节点，模型继续）。
 * POST /api/approval 协议不变：approve → 工具执行 → tool-result；deny（带备注）→
 * user-denied 结果+拒因回注，run 继续；deny（无备注）→ user-interrupted。未答不推进。
 * 用例全部经假 run_command/write_file 触发真实矩阵决策（矩阵逐格 + 真装配级见
 * permission.test.ts）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import type { Tool } from '../../src/core/loop/types.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import { FakeLlm, runCommandTool, type FakeScript } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

const ASK_CALL = { id: 'call-1', name: 'run_command', arguments: '{"command":"echo hi"}' };
const DENY_CALL = { id: 'call-2', name: 'run_command', arguments: '{"command":"rm -rf foo"}' };

function toolDeps(scripts: FakeScript[], tools: Tool[]): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry(tools, { sessionId: 's1' }),
    llm: new FakeLlm(scripts),
    model: 'test-model',
  };
}

/** 假 write_file（权限矩阵按名判定；execute 只模拟写出）。 */
function fakeWriteTool(): Tool {
  return {
    name: 'write_file',
    description: 'Write a file (fake).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async execute() {
      return { ok: true, content: 'wrote:ok' };
    },
  };
}

async function chat(base: string, text: string): Promise<string> {
  const res = await postJson(base, '/api/chat', { text });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

describe('ui/server：审批往返（权限预设矩阵驱动）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('c1) 默认档 ask 级命令（echo=未知→ask）：审批前不推进；approve → 工具执行 → tool-result → 下一轮 → completed', async () => {
    const { base, server } = await startServer(
      toolDeps(
        [
          { content: 'echoing', toolCalls: [ASK_CALL] },
          { content: 'patched', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
        ],
        [runCommandTool()],
      ),
    );
    servers.push(server);
    const sessionId = await chat(base, 'task');

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000); // 回声/delta/done/tool-start/approval-request

    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'tool-start',
      'approval-request',
    ]);
    expect(client.frames[3]!.data).toMatchObject({ id: 'call-1', name: 'run_command' });
    expect(client.frames[4]!.data).toMatchObject({ toolCallId: 'call-1', name: 'run_command' });

    // 未答：不推进（无 tool-result / 无 run-status）
    expect(await client.next(300)).toBeNull();
    expect(client.frames).toHaveLength(5);

    const approved = await postJson(base, '/api/approval', {
      sessionId,
      toolCallId: 'call-1',
      approve: true,
    });
    expect(approved.status).toBe(200);

    await waitForFrames(client, 10, 10_000);
    const events = client.frames.map((f) => f.event);
    expect(events.slice(5, 7)).toEqual(['tool-result', 'assistant-delta']); // 工具先执行，再进下一轮
    expect(client.frames[5]!.data).toMatchObject({
      id: 'call-1',
      name: 'run_command',
      ok: true,
      contentPreview: expect.stringContaining('[out] echo hi'),
    });
    expect(events.slice(7)).toEqual(['assistant-done', 'usage', 'run-status']);
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });

  it('c2) deny（带备注）→ user-denied 结果 + 拒因；run 继续（弹窗拒绝语义不变）', async () => {
    const { base, server } = await startServer(
      toolDeps(
        [{ content: 'need tool', toolCalls: [ASK_CALL] }, { content: 'fine without it' }],
        [runCommandTool()],
      ),
    );
    servers.push(server);
    const sessionId = await chat(base, 'task');

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);

    const denied = await postJson(base, '/api/approval', {
      sessionId,
      toolCallId: 'call-1',
      approve: false,
      reason: 'not needed',
    });
    expect(denied.status).toBe(200);

    await waitForFrames(client, 10, 10_000);
    const result = client.frames[5]!;
    expect(result.event).toBe('tool-result');
    expect(result.data).toMatchObject({
      id: 'call-1',
      name: 'run_command',
      ok: false,
      error: 'not needed',
    });
    expect(JSON.stringify(result.data)).toContain('not needed');
    // 拒因回注 → 模型继续，第二次查询随后发生
    expect(client.frames[6]!.event).toBe('assistant-delta');
    expect(client.frames[client.frames.length - 1]!.event).toBe('run-status');
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });

  it('c3) deny（无备注）→ run-status user-interrupted（无工具结果、无第二次查询）', async () => {
    const { base, server } = await startServer(
      toolDeps([{ content: 'need tool', toolCalls: [ASK_CALL] }], [runCommandTool()]),
    );
    servers.push(server);
    const sessionId = await chat(base, 'task');

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);

    const denied = await postJson(base, '/api/approval', {
      sessionId,
      toolCallId: 'call-1',
      approve: false,
    });
    expect(denied.status).toBe(200);

    await waitForFrames(client, 7, 10_000);
    const events = client.frames.map((f) => f.event);
    expect(events).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'tool-start',
      'approval-request',
      'usage',
      'run-status',
    ]);
    expect(client.frames[6]!.data).toMatchObject({ status: 'user-interrupted' });
  });

  it('c4) 未知 toolCallId / 未知 session → 404 {error}', async () => {
    const { base, server } = await startServer(
      toolDeps(
        [{ content: 'need tool', toolCalls: [ASK_CALL] }, { content: 'ok2' }],
        [runCommandTool()],
      ),
    );
    servers.push(server);
    const sessionId = await chat(base, 'task');

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);

    const badId = await postJson(base, '/api/approval', {
      sessionId,
      toolCallId: 'nope',
      approve: true,
    });
    expect(badId.status).toBe(404);
    expect(((await badId.json()) as { error: string }).error).toBeTypeOf('string');

    const badSession = await postJson(base, '/api/approval', {
      sessionId: 'other-1',
      toolCallId: 'call-1',
      approve: true,
    });
    expect(badSession.status).toBe(404);
    expect(((await badSession.json()) as { error: string }).error).toBeTypeOf('string');

    // 未答的审批仍然悬挂：合法应答照常生效
    const ok = await postJson(base, '/api/approval', {
      sessionId,
      toolCallId: 'call-1',
      approve: true,
    });
    expect(ok.status).toBe(200);
    await waitForFrames(client, 10, 10_000);
    expect(client.frames[5]!.event).toBe('tool-result');
  });

  it('c5) 审批策略覆写（approvalPolicy=false）不产生 approval-request，工具直接执行', async () => {
    const { base, server } = await startServer({
      ...toolDeps(
        [{ content: 'do it', toolCalls: [ASK_CALL] }, { content: 'ok' }],
        [runCommandTool()],
      ),
      approvalPolicy: () => false,
    });
    servers.push(server);
    const sessionId = await chat(base, 'task');

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 9, 10_000);
    const events = client.frames.map((f) => f.event);
    expect(events).toContain('tool-start');
    expect(events).not.toContain('approval-request');
    expect(events).toContain('tool-result');
  });

  it('c6) 默认档 fs 写（write_file）放行不弹窗：无 approval-request，工具直接执行', async () => {
    const { base, server } = await startServer(
      toolDeps(
        [
          {
            content: 'write it',
            toolCalls: [
              { id: 'w1', name: 'write_file', arguments: '{"path":"a.txt","content":"x"}' },
            ],
          },
          { content: 'done' },
        ],
        [fakeWriteTool()],
      ),
    );
    servers.push(server);
    const sessionId = await chat(base, 'task');

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 9, 10_000);
    const events = client.frames.map((f) => f.event);
    expect(events).toContain('tool-start');
    expect(events).not.toContain('approval-request');
    const result = client.frames.find((f) => f.event === 'tool-result')!;
    expect(result.data).toMatchObject({ id: 'w1', name: 'write_file', ok: true });
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });

  it('c7) 默认档 deny 级命令（rm -rf）：不弹窗直接拒绝——permission-denied 回注，模型继续', async () => {
    const { base, server } = await startServer(
      toolDeps(
        [{ content: 'do it', toolCalls: [DENY_CALL] }, { content: '收尾，不动它了' }],
        [runCommandTool()],
      ),
    );
    servers.push(server);
    const sessionId = await chat(base, 'task');

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 9, 10_000);
    const events = client.frames.map((f) => f.event);
    // deny 不产生 approval-request（纯工具节点）；工具未执行而是直接回注失败
    expect(events).not.toContain('approval-request');
    expect(events).toContain('tool-start');
    const result = client.frames.find((f) => f.event === 'tool-result')!;
    expect(result.data).toMatchObject({
      id: 'call-2',
      name: 'run_command',
      ok: false,
      error:
        '[permission: 命令被安全策略拒绝 under workspace-write mode]：rm 是危险命令（不可恢复的破坏性操作）',
    });
    expect(result.data).toMatchObject({
      contentPreview: expect.stringContaining('permission-denied'),
    });
    expect(result.data).toMatchObject({ content: expect.stringContaining('permission-denied') });
    // 普通回注 → 模型继续 → completed
    expect(client.frames.filter((f) => f.event === 'assistant-delta')).toHaveLength(2);
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });
});
