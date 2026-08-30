/**
 * # test/ui-server/context-overflow：E7 自愈链的服务端面（run 不死 + 上限学习 → windowDetail）
 *
 * 蓝本 = .scratch/coding-agent/research/limits-effects-and-overflow.md B.c（400 → fatal 现状）
 * + C.2 L2（「从 400 message 免费解析上限」——windowDetail 报「由错误学习」）。
 * 红→绿：实现前 = 第一次 400 → run fatal（run-error 帧）；实现后 = 重试转绿 +
 * GET /api/settings 的 window/windowDetail 携带学习值。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { LlmError } from '../../src/shared/llm-types.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

function baseDeps(llm: FakeLlm): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([echoTool()], { sessionId: 's1' }),
    llm,
    model: 'm0',
    settings: { baseUrl: 'https://default.example/v1', model: 'm0' },
  };
}

const CONTEXT_400 = new LlmError({
  kind: 'http',
  status: 400,
  retryable: false,
  message:
    "This model's maximum context length is 1024000 tokens. However, your messages resulted in 200000 tokens. Please reduce the length of the messages.",
});

describe('ui/server：E7 超限自愈（run 不死 + 上限学习进 windowDetail）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('context 400 → 自动重试转绿（run-status completed）；学习条目不进 run-error', async () => {
    const llm = new FakeLlm([
      { error: CONTEXT_400 },
      { content: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);
    const { base, server } = await startServer(baseDeps(llm));
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(llm.requests).toHaveLength(2);
    const last = client.frames[client.frames.length - 1]!;
    expect(last.event).toBe('run-status');
    expect(last.data).toMatchObject({ status: 'completed', steps: 2 });
    // 自愈路径不产生 run-error 帧
    expect(client.frames.filter((f) => f.event === 'run-error')).toHaveLength(0);
  });

  it('学习 hintMax → GET /api/settings 的 window/windowDetail 报「由错误学习」', async () => {
    const llm = new FakeLlm([{ error: CONTEXT_400 }, { content: 'ok' }]);
    const { base, server } = await startServer(baseDeps(llm));
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);

    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(settings.window).toBe(1_024_000);
    expect(settings.windowDetail).toContain('由错误学习');
  });
});
