/**
 * # test/ui-server/guard：POST /api/chat 的 maxRunTokens（Token 护栏 · 对话级）
 *
 * 2026-08-31 用户定调：护栏判据 = 本轮 run 累计 totalTokens 超上限 → 下轮发送前停机
 * （run-status 终态仍为 'cost-guard'——状态值兼容历史；UI 文案「Token 护栏停机」）；
 * **默认关闭**（缺失/未设置 = 不限制）；作用域 = 对话级——前端按会话记忆、
 * 经本轮 POST /api/chat 的可选字段 `maxRunTokens: number` 透传；非法值**拒收 400**
 * （复用 settings 校验风格：类型/正整数严格校验——非法输入不静默忽略，暴露客户端缺陷）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

function depsFor(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([echoTool()], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    ...extra,
  };
}

describe('ui/server：POST /api/chat 的 maxRunTokens（Token 护栏 · 对话级）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('携带上限（极小）→ 闸门 A 请求前截停：零查询、run-status = cost-guard（Token 护栏停机）', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);
    const res = await postJson(base, '/api/chat', { text: 'm', maxRunTokens: 50 });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 3, 10_000);
    // 事件序：用户回声 → usage → run-status（零查询 → 无 assistant/delta 帧）
    expect(client.frames.map((f) => f.event)).toEqual(['session-user', 'usage', 'run-status']);
    expect(client.frames[1]!.data).toMatchObject({ totalTokens: 0, costUsd: 0, estimated: false });
    expect(client.frames[2]!.data).toMatchObject({ status: 'cost-guard', steps: 0 });
  });

  it('缺失 maxRunTokens（默认关闭）→ 护栏不拦：usage 记录照常、自然结束', async () => {
    const llm = new FakeLlm([
      { content: 'ok', usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } },
    ]);
    const { base, server } = await startServer(depsFor({ llm }));
    servers.push(server);
    const res = await postJson(base, '/api/chat', { text: 'm' });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    // 成本统计照旧（judge 换 token，costUsd 只做显示）：12×1e-6 + 3×3e-6 = 21e-6
    expect(client.frames[3]!.data).toMatchObject({ totalTokens: 15, estimated: false });
    expect((client.frames[3]!.data as { costUsd: number }).costUsd).toBeCloseTo(21e-6, 12);
    expect(client.frames[4]!.data).toMatchObject({ status: 'completed', steps: 1 });
  });

  it('非法值 → 400 {error}（字符串/0/负数/小数/null——严格正整数，不静默忽略）', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);
    for (const bad of ['abc', 0, -1, 1.5, null]) {
      const res = await postJson(base, '/api/chat', { text: 'm', maxRunTokens: bad });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/maxRunTokens must be a positive integer/);
    }
    // 已建会话的副作用：全部非法请求被拒 → 无 run 启动（无活跃 run 残留干扰后续）
  });

  it('同会话第二轮不带上限 → 本 run 护栏关闭（对话级 = 每轮透传：数值只对当轮生效）', async () => {
    const store = new MemorySessionAdapter();
    const llm = new FakeLlm([
      { content: 'x' }, // 第一轮未被消费（maxRunTokens=1 在闸门 A 截停）
      { content: 'y', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } },
    ]);
    const { base, server } = await startServer(
      depsFor({
        store,
        llm,
        runOptions: { maxRunTokens: 1 }, // deps 级兜底值：每轮被请求字段刷新（第二轮缺失 → 删除）
      }),
    );
    servers.push(server);

    const first = (await (
      await postJson(base, '/api/chat', { text: 'm', maxRunTokens: 1 })
    ).json()) as { sessionId: string };

    // 等第一轮 run 落幕（cost-guard）再启动第二轮：避免并发 run 的 409 竞态
    const client = await SseClient.connect(base, first.sessionId);
    clients.push(client);
    const trailing = await waitForRunStatus(client, 'cost-guard', 10_000);
    expect(trailing.steps).toBe(0);

    const second = await postJson(base, '/api/chat', { text: 'm2', sessionId: first.sessionId });
    expect(second.status).toBe(200);

    // 第二轮的 run（缺省关闭）自然结束——同一会话、不同轮上限互不串染
    const mark = await waitForRunStatus(client, 'completed', 10_000);
    expect(mark.steps).toBe(1);
  });
});

/** 等待指定 run-status 帧出现（跳过回放/中间帧；把终局帧返回）。 */
async function waitForRunStatus(
  client: SseClient,
  status: string,
  timeoutMs: number,
): Promise<{ status: string; steps: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      throw new Error(`no run-status ${status} in time: ${JSON.stringify(client.frames)}`);
    }
    const frame = await client.next(remain);
    if (frame !== null && frame.event === 'run-status') {
      const data = frame.data as { status: string; steps: number };
      if (data.status === status) {
        client.drain();
        return data;
      }
    }
  }
}
