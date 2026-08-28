/**
 * # test/ui-server/isolation：会话隔离（接缝 S12 d 档）
 *
 * 两个会话并行 run：事件不串（各自 broker、各自审批）、审批应答互不影响、
 * 会话事实源（store）各自独立；E2E 级：两会话 run_command 的 cd/cwd 互不影响
 * （常驻 shell 每会话独立实例 —— createSessionToolsFactory 契约）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJail } from '../../src/core/jail/index.js';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import type { LlmAdapter } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { ChatRequest, StreamEvent } from '../../src/shared/llm-types.js';
import { createSessionToolsFactory } from '../../src/ui/server/deps.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import { canonicalTmpBase, shellCwdForm } from '../shell-tools/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

/** 按「首个 user 消息（=任务文本）」路由到不同 FakeLlm：两 run 并行互不共享脚本序。 */
class RoutingLlm implements LlmAdapter {
  constructor(private readonly routes: Map<string, FakeLlm>) {}

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const first = request.messages.find((m) => m.role === 'user');
    const key = first !== undefined && first.role === 'user' ? first.content : '';
    const fake = this.routes.get(key);
    if (fake === undefined) {
      throw new Error(`RoutingLlm: no route for ${JSON.stringify(key)}`);
    }
    yield* fake.chat(request, signal);
  }
}

const CALL_A = { id: 'call-a', name: 'echo', arguments: '{"text":"a"}' };
const CALL_B = { id: 'call-b', name: 'echo', arguments: '{"text":"b"}' };

describe('ui/server：会话隔离', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) {
      // win32：残留 bash 挂住目录/cwd → rmdir EBUSY（windows CI 实测）→ 重试屈从
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });

  it('d1) 两会话并行 run：事件流互不渗透，审批互不串扰', async () => {
    const routes = new Map<string, FakeLlm>([
      ['task-a', new FakeLlm([{ content: 'need a', toolCalls: [CALL_A] }, { content: 'a done' }])],
      ['task-b', new FakeLlm([{ content: 'need b', toolCalls: [CALL_B] }, { content: 'b done' }])],
    ]);
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer({
      store,
      tools: defineRegistry([echoTool()], { sessionId: 's1' }),
      llm: new RoutingLlm(routes),
      model: 'test-model',
    });
    servers.push(server);

    const bodyA = (await (await postJson(base, '/api/chat', { text: 'task-a' })).json()) as {
      sessionId: string;
    };
    const bodyB = (await (await postJson(base, '/api/chat', { text: 'task-b' })).json()) as {
      sessionId: string;
    };
    expect(bodyA.sessionId).not.toBe(bodyB.sessionId);

    const clientA = await SseClient.connect(base, bodyA.sessionId);
    const clientB = await SseClient.connect(base, bodyB.sessionId);
    clients.push(clientA, clientB);
    await waitForFrames(clientA, 5, 10_000);
    await waitForFrames(clientB, 5, 10_000);

    // 各自挂着各自的审批请求
    expect(clientA.frames[4]).toMatchObject({
      event: 'approval-request',
      data: { toolCallId: 'call-a' },
    });
    expect(clientB.frames[4]).toMatchObject({
      event: 'approval-request',
      data: { toolCallId: 'call-b' },
    });

    // 只答 A：A 推进，B 一丝不动
    const approveA = await postJson(base, '/api/approval', {
      sessionId: bodyA.sessionId,
      toolCallId: 'call-a',
      approve: true,
    });
    expect(approveA.status).toBe(200);
    await waitForFrames(clientA, 10, 10_000);
    expect(clientA.frames[5]!.event).toBe('tool-result');
    expect(await clientB.next(300)).toBeNull();
    expect(clientB.frames).toHaveLength(5);

    // 再答 B：B 单独推进
    const approveB = await postJson(base, '/api/approval', {
      sessionId: bodyB.sessionId,
      toolCallId: 'call-b',
      approve: true,
    });
    expect(approveB.status).toBe(200);
    await waitForFrames(clientB, 10, 10_000);
    expect(clientB.frames[5]).toMatchObject({ event: 'tool-result', data: { id: 'call-b' } });

    // 互检：A 的事件里没有 B 的调用 id，反之亦然
    const dumpA = JSON.stringify(clientA.frames);
    const dumpB = JSON.stringify(clientB.frames);
    expect(dumpA).not.toContain('call-b');
    expect(dumpB).not.toContain('call-a');

    // 会话事实源各自独立：task 事件只在自己的会话里
    const usersA: string[] = [];
    const usersB: string[] = [];
    for await (const ev of store.events(bodyA.sessionId)) {
      if (ev.kind === 'user') usersA.push(ev.payload.content);
    }
    for await (const ev of store.events(bodyB.sessionId)) {
      if (ev.kind === 'user') usersB.push(ev.payload.content);
    }
    expect(usersA).toEqual(['task-a']);
    expect(usersB).toEqual(['task-b']);
  });

  it('d2) E2E：两会话 run_command 的 cd/cwd 互不影响（常驻 shell 每会话独立实例）', async () => {
    // canonicalTmpBase：bash 长名拼写基址（win32 短/长名一致性；见该函数头注）
    const dir = await mkdtemp(join(canonicalTmpBase(), 'devmate-isolation-'));
    tempDirs.push(dir);
    const jail = await createJail({ workspaceRoot: dir });
    // 真实工具面：fs 共享一组 + shell 按会话懒建（S10 契约真正发生）。
    // shellPlatform 'posix'：bash 语义固定——win32 宿主经 PATH 解析 Git Bash 的
    // bash.exe 真跑 git-bash（用例为 bash 语法；宿主缺省 win32→powershell 走不通）。
    const factory = createSessionToolsFactory({ workspaceRoot: dir, jail, shellPlatform: 'posix' });

    const CALL_A = {
      id: 'shell-a1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'mkdir -p sub && cd sub' }),
    };
    const CALL_B = {
      id: 'shell-b1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'pwd' }),
    };
    const routes = new Map<string, FakeLlm>([
      ['cd-a', new FakeLlm([{ content: 'cd', toolCalls: [CALL_A] }, { content: 'a done' }])],
      ['pwd-b', new FakeLlm([{ content: 'pwd', toolCalls: [CALL_B] }, { content: 'b done' }])],
    ]);
    const { base, server } = await startServer({
      store: new MemorySessionAdapter(),
      tools: defineRegistry([], { sessionId: 'e2e-unused' }), // 单例兜底：run 走工厂
      llm: new RoutingLlm(routes),
      model: 'test-model',
      approvalPolicy: () => false, // 自动放行：E2E 只测 shell 隔离
      createSessionTools: factory.createSessionTools,
      dispose: factory.dispose,
    });
    servers.push(server);

    const bodyA = (await (await postJson(base, '/api/chat', { text: 'cd-a' })).json()) as {
      sessionId: string;
    };
    const bodyB = (await (await postJson(base, '/api/chat', { text: 'pwd-b' })).json()) as {
      sessionId: string;
    };
    const clientA = await SseClient.connect(base, bodyA.sessionId);
    const clientB = await SseClient.connect(base, bodyB.sessionId);
    clients.push(clientA, clientB);
    // 每会话 9 帧：回声 / 2×(delta+done) / tool-start / tool-result / usage / run-status
    await waitForFrames(clientA, 9, 30_000);
    await waitForFrames(clientB, 9, 30_000);

    const aResult = clientA.frames.find(
      (f): f is Extract<typeof f, { event: 'tool-result' }> =>
        f.event === 'tool-result' && (f.data as { id: string }).id === 'shell-a1',
    );
    const bResult = clientB.frames.find(
      (f): f is Extract<typeof f, { event: 'tool-result' }> =>
        f.event === 'tool-result' && (f.data as { id: string }).id === 'shell-b1',
    );
    expect(aResult).toBeDefined();
    expect(bResult).toBeDefined();
    // A 确实 cd 进了子目录；B 的 shell cwd 仍是 workspaceRoot —— 两会话 shell 互不渗透。
    // git-bash（win32）下 pwd 输出 MSYS 形态 /c/... —— 与宿主路径同一形态再比（shellCwdForm）。
    expect((bResult as { data: { content: string } }).data.content).toContain(shellCwdForm(dir));
    expect((bResult as { data: { content: string } }).data.content).not.toContain(
      shellCwdForm(join(dir, 'sub')),
    );
  });
});
