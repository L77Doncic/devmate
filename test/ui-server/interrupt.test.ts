/**
 * # test/ui-server/interrupt：用户中断（接缝 S12 e 档）
 *
 * POST /api/interrupt → AbortSignal → run 收尾 run-status user-interrupted。
 * 挂起处：审批等待（这是 UI 现实里最常见的中断时机；信号一边中止审批 prompt
 * 一边被 run 在工具边界观察）。空闲中断（无活跃 run）→ 409 {error}。
 * P2-3（e5）：真实 run_command 挂起脚本时中断 → 服务端经 killActiveCommand
 * 杀进程组 + interrupted partial 回注（进程组零残留）——「停止」即杀，不等到
 * sleep-30 自然结束。短超时 fixture（50s 名义 + 轮询）作兜底。
 */
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { SessionStore } from '../../src/core/session/index.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import { makeShellFixture } from '../shell-tools/support.js';
import { cleanupShellFixtures } from '../shell-tools/support.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { FakeLlm, runCommandTool } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

// ask 级命令（echo=未知→ask）：只读档下触发 approval-request（矩阵判定见 server）——
// 审批面只在 read-only 档保留（默认档零弹窗），e1 的「审批挂起时中断」挂点播种 read-only
const ASK_CALL = { id: 'call-1', name: 'run_command', arguments: '{"command":"echo hi"}' };

function askAllDeps(): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([runCommandTool()], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'need tool', toolCalls: [ASK_CALL] }]),
    model: 'test-model',
    settings: { permission: 'read-only' },
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

  it.skipIf(process.platform === 'win32')(
    'e5) P2-3 停止杀命令树：真实 run_command 挂起 sleep-30 → 中断即杀进程组 + interrupted partial 回注（<3s，非自然结束）+ run-status user-interrupted',
    async () => {
      const fx = await makeShellFixture({ timeoutMs: 50_000 });
      const call = {
        id: 'call-1',
        name: 'run_command',
        arguments: JSON.stringify({ command: 'echo in-sleep-before-kill && sleep 32.5' }),
      };
      const registry = defineRegistry([fx.tool], { sessionId: 's1' });
      const { base, server } = await startServer({
        store: new MemorySessionAdapter(),
        createSessionTools: async () => registry,
        llm: new FakeLlm([{ content: 'need tool', toolCalls: [call] }]),
        model: 'test-model',
        settings: { permission: 'workspace-write' },
        killActiveCommand: (sessionId) => fx.shell.killActiveCommand(sessionId),
      } as DevmateServerDeps);
      servers.push(server);
      const startedAt = Date.now();

      const created = (await (await postJson(base, '/api/chat', { text: 'task' })).json()) as {
        sessionId: string;
      };
      const client = await SseClient.connect(base, created.sessionId);
      clients.push(client);
      // 帧序（与 e1 对齐）：session-user(0) assistant-delta(1) assistant-done(2) tool-start(3)
      await waitForFrames(client, 4, 10_000); // 到 tool-start：命令已派发
      expect(client.frames[3]!.event).toBe('tool-start');
      // 留出 bash 真正开始执行 sleep-30 的时间（kill 必须命中活动命令而非派发瞬间）
      await new Promise((resolve) => setTimeout(resolve, 400));

      const res = await postJson(base, '/api/interrupt', { sessionId: created.sessionId });
      expect(res.status).toBe(200);

      await waitForFrames(client, 7, 10_000);
      const events = client.frames.map((f) => f.event);
      expect(events).toEqual([
        'session-user',
        'assistant-delta',
        'assistant-done',
        'tool-start',
        'tool-result',
        'usage',
        'run-status',
      ]);
      // interrupted partial 回注：工具结果 error 带 interrupted（已捕获输出在 content 里）
      const toolResult = client.frames[4]!.data as { ok: boolean; error?: string };
      expect(toolResult.ok).toBe(false);
      expect(String(toolResult.error)).toContain('interrupted');
      const usageFrame = client.frames[5]!.data as { status?: string };
      expect(usageFrame).toBeTypeOf('object');
      expect(client.frames[6]!.data as { status: string }).toMatchObject({
        status: 'user-interrupted',
      });
      const durationMs = (client.frames[6]!.data as { durationMs: number }).durationMs;
      expect(durationMs).toBeLessThan(3000); // 即杀即回注——绝不等到 sleep-30 自然结束
      expect(Date.now() - startedAt).toBeLessThan(8000);

      // 进程组零残留取证：sleep 32.5 无任何存活进程（壳外直查；轮询 ≤1.5s——SIGKILL 送达有毫秒级松弛）
      let residue: string[] = [];
      const deadline = Date.now() + 1500;
      for (;;) {
        try {
          const out = execFileSync('pgrep', ['-af', '^sleep 32.5$'], { encoding: 'utf8' });
          residue = out.split('\n').filter((line) => line.trim() !== '');
        } catch {
          residue = []; // pgrep 非零退出 = 无匹配
        }
        if (residue.length === 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(residue).toEqual([]);
      await fx.dispose();
      cleanupShellFixtures();
    },
    20_000,
  );
});
