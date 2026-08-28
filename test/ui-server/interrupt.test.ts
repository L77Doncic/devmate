/**
 * # test/ui-server/interrupt：用户中断（接缝 S12 e 档）
 *
 * POST /api/interrupt → AbortSignal → run 收尾 run-status user-interrupted。
 * 挂起处：审批等待（这是 UI 现实里最常见的中断时机；信号一边中止审批 prompt
 * 一边被 run 在工具边界观察）。空闲中断（无活跃 run）→ 409 {error}。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { SessionStore } from '../../src/core/session/index.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

const ECHO_CALL = { id: 'call-1', name: 'echo', arguments: '{"text":"hi"}' };

function askAllDeps(): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([echoTool()], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'need tool', toolCalls: [ECHO_CALL] }]),
    model: 'test-model',
  };
}

describe('ui/server：用户中断', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('e1) 审批挂起时中断 → 审批不答、工具不执行 → run-status user-interrupted', async () => {
    const { base, server } = await startServer(askAllDeps());
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'task' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000); // 到 approval-request：已确认 run 挂在审批上
    expect(client.frames[4]!.event).toBe('approval-request');

    const res = await postJson(base, '/api/interrupt', { sessionId: created.sessionId });
    expect(res.status).toBe(200);

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
    // 中断后用户仍可读盘：无工具执行结果（无 tool-result 帧）
    expect(events).not.toContain('tool-result');
  });

  it('e2) 中断是幂等目标：run 已结束后 POST /api/interrupt → 409 {error}', async () => {
    const { base, server } = await startServer({
      ...askAllDeps(),
      llm: new FakeLlm([{ content: 'done' }]),
    });
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'task' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(client.frames[4]!.data).toMatchObject({ status: 'completed' });

    const res = await postJson(base, '/api/interrupt', { sessionId: created.sessionId });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('e3) 未知 session 中断 → 404 {error}', async () => {
    const { base, server } = await startServer(askAllDeps());
    servers.push(server);
    const res = await postJson(base, '/api/interrupt', { sessionId: 'missing-1' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('e4) 非法 sessionId（越界/逃逸字面量）→ 400 {error}（与其它端点一致过 assertValidSessionId）', async () => {
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
    const { base, server } = await startServer({ ...askAllDeps(), store: permissive });
    servers.push(server);
    for (const bad of ['../etc', 'a/b', ' s-1', 's-1/../x', '%2e%2e']) {
      const res = await postJson(base, '/api/interrupt', { sessionId: bad });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
    }
  });
});
