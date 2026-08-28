/**
 * # test/ui-server/approval：危险操作审批往返（接缝 S12 c 档）
 *
 * 协议：approval-request 到达后 run 停在审批上（不执行工具）；POST /api/approval
 * approve → 工具执行 → tool-result；deny（带备注）→ user-denied 结果+拒因回注，
 * run 继续（模型自愈）；deny（无备注）→ user-interrupted。未答不推进。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import type { FakeScript } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

const ECHO_CALL = { id: 'call-1', name: 'echo', arguments: '{"text":"hi"}' };

function askAllDeps(scripts: FakeScript[]): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([echoTool()], { sessionId: 's1' }),
    llm: new FakeLlm(scripts),
    model: 'test-model',
  };
}

async function chat(base: string, text: string): Promise<string> {
  const res = await postJson(base, '/api/chat', { text });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

describe('ui/server：审批往返', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('c1) 审批前不推进；approve → 工具执行 → tool-result → 下一轮 → completed', async () => {
    const { base, server } = await startServer(
      askAllDeps([
        { content: 'echoing', toolCalls: [ECHO_CALL] },
        { content: 'patched', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      ]),
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
    expect(client.frames[3]!.data).toMatchObject({ id: 'call-1', name: 'echo' });
    expect(client.frames[4]!.data).toMatchObject({ toolCallId: 'call-1', name: 'echo' });

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
      name: 'echo',
      ok: true,
      contentPreview: 'echo:hi',
    });
    expect(events.slice(7)).toEqual(['assistant-done', 'usage', 'run-status']);
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });

  it('c2) deny（带备注）→ user-denied 结果 + 拒因；run 继续', async () => {
    const { base, server } = await startServer(
      askAllDeps([
        { content: 'need tool', toolCalls: [ECHO_CALL] },
        { content: 'fine without it' },
      ]),
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
      name: 'echo',
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
      askAllDeps([{ content: 'need tool', toolCalls: [ECHO_CALL] }]),
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
      askAllDeps([{ content: 'need tool', toolCalls: [ECHO_CALL] }, { content: 'ok2' }]),
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

  it('c5) 自动放行策略（approvalPolicy=false）不产生 approval-request，工具直接执行', async () => {
    const { base, server } = await startServer({
      ...askAllDeps([{ content: 'do it', toolCalls: [ECHO_CALL] }, { content: 'ok' }]),
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
});
