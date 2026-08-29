/**
 * # test/ui-server/settings：设置往返 + apiKey 掩码（接缝 S12 f 档）
 *
 * GET/POST /api/settings {baseUrl, model, apiKey?}；apiKey 只回掩码（前 4 尾 4），
 * 绝不出现在任何响应里；model 变更即时作用于后续 run（真实 llm 请求带新 model）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { echoTool, FakeLlm, runCommandTool } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

const RAW_KEY = 'sk-1234567890abcdef';

function baseDeps(llm: FakeLlm): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([echoTool()], { sessionId: 's1' }),
    llm,
    model: 'm0',
    settings: { baseUrl: 'https://default.example/v1', model: 'm0' },
  };
}

describe('ui/server：settings', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('f1) GET 初始设置；POST 更新后返回掩码 apiKey（前 4 尾 4）；GET 一致且默认响应不透出原值', async () => {
    const { base, server } = await startServer(baseDeps(new FakeLlm([{ content: 'x' }])));
    servers.push(server);

    const before = (await (await fetch(new URL('/api/settings', base))).json()) as {
      baseUrl: string;
      model: string;
      apiKey?: string;
    };
    expect(before).toMatchObject({ baseUrl: 'https://default.example/v1', model: 'm0' });
    expect(before.apiKey).toBeUndefined();

    const res = await postJson(base, '/api/settings', {
      baseUrl: 'https://new.example/v1',
      model: 'm1',
      apiKey: RAW_KEY,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(RAW_KEY);
    const saved = JSON.parse(text) as { baseUrl: string; model: string; apiKey: string };
    expect(saved).toMatchObject({ baseUrl: 'https://new.example/v1', model: 'm1' });
    expect(saved.apiKey).toBe('sk-1****cdef');

    const after = (await (await fetch(new URL('/api/settings', base))).json()) as {
      apiKey: string;
    };
    expect(after.apiKey).toBe('sk-1****cdef');
  });

  it('f2) 掩码形状：>12 前 4 尾 4、中间遮蔽；≤12（含 9~12 边界）全遮蔽', async () => {
    const { base, server } = await startServer(baseDeps(new FakeLlm([{ content: 'x' }])));
    servers.push(server);

    const long = (await (await postJson(base, '/api/settings', { apiKey: RAW_KEY })).json()) as {
      apiKey: string;
    };
    expect(long.apiKey).toBe(`${RAW_KEY.slice(0, 4)}****${RAW_KEY.slice(-4)}`);

    // 9~12 字符边界（此前实现 ≤8 才全掩，9~12 会漏出首尾 —— 现按单一实现全掩）
    for (const len of [9, 10, 11, 12]) {
      const key = 'k'.repeat(len);
      const res = await postJson(base, '/api/settings', { apiKey: key });
      expect(((await res.json()) as { apiKey: string }).apiKey).toBe('****');
    }
    // >12 的分界（13 字符）：显首尾 4
    const edge = (await (
      await postJson(base, '/api/settings', { apiKey: 'm'.repeat(13) })
    ).json()) as { apiKey: string };
    expect(edge.apiKey).toBe('mmmm****mmmm');
  });

  it('f3) 部分更新保留未指字段；model 变更即时作用于后续 run', async () => {
    const llm = new FakeLlm([{ content: 'one' }, { content: 'two' }]);
    const { base, server } = await startServer(baseDeps(llm));
    servers.push(server);

    const v1 = (await (await postJson(base, '/api/settings', { model: 'm2' })).json()) as {
      baseUrl: string;
      model: string;
    };
    expect(v1).toMatchObject({ baseUrl: 'https://default.example/v1', model: 'm2' });

    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(llm.requests[0]!.model).toBe('m2');
  });

  it('f5) persistSettings：POST 后按应用值调用（含 apiKey）；GET 不触发；空 key 清除时不带 apiKey', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      persistSettings: (s: unknown) => {
        persisted.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
      },
    });
    servers.push(server);

    await postJson(base, '/api/settings', {
      baseUrl: 'https://persist.example/v1',
      model: 'm-p',
      apiKey: RAW_KEY,
    });
    expect(persisted).toEqual([
      { baseUrl: 'https://persist.example/v1', model: 'm-p', apiKey: RAW_KEY },
    ]);

    await fetch(new URL('/api/settings', base)); // GET 不触发持久化
    expect(persisted).toHaveLength(1);

    const cleared = await postJson(base, '/api/settings', { apiKey: '' });
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as { baseUrl: string; model: string; apiKey?: string };
    expect(body).toMatchObject({ baseUrl: 'https://persist.example/v1', model: 'm-p' });
    expect(body.apiKey).toBeUndefined(); // 空 key = 显式删除：响应不出现掩码
    expect(persisted).toEqual([
      { baseUrl: 'https://persist.example/v1', model: 'm-p', apiKey: RAW_KEY },
      { baseUrl: 'https://persist.example/v1', model: 'm-p' },
    ]);
  });

  it('f6) 每次 run 从 settingsRef 重建 llm 接缝：POST 后的下一条 chat 用新 baseUrl/apiKey/model', async () => {
    const runLlm = new FakeLlm([{ content: 'wired' }, { content: 'wired again' }]);
    const createLlm = vi.fn((_s: unknown) => runLlm);
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'unused' }])),
      createLlm,
    });
    servers.push(server);

    await postJson(base, '/api/settings', {
      baseUrl: 'https://run.example/v1',
      model: 'm-run',
      apiKey: 'sk-llm-1234567890abcd',
    });

    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(createLlm).toHaveBeenCalledWith({
      baseUrl: 'https://run.example/v1',
      apiKey: 'sk-llm-1234567890abcd',
    });
    expect(runLlm.requests[0]!.model).toBe('m-run');

    // 清空 key：下一次 run 的 llm 接缝拿 apiKey undefined
    await postJson(base, '/api/settings', { apiKey: '' });
    const created2 = (await (await postJson(base, '/api/chat', { text: 'again' })).json()) as {
      sessionId: string;
    };
    const client2 = await SseClient.connect(base, created2.sessionId);
    clients.push(client2);
    await waitForFrames(client2, 5, 10_000);
    expect(createLlm).toHaveBeenLastCalledWith({
      baseUrl: 'https://run.example/v1',
      apiKey: undefined,
    });
  });

  it('f4) 空字段/非对象体 → 400 {error}', async () => {
    const { base, server } = await startServer(baseDeps(new FakeLlm([{ content: 'x' }])));
    servers.push(server);
    const empty = await postJson(base, '/api/settings', {});
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBeTypeOf('string');
    const badType = await postJson(base, '/api/settings', { model: 42 });
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { error: string }).error).toBeTypeOf('string');
  });
});

// ---------------------------------------------------------------------------
// R2-S2：评审哨兵开关（reviewMode —— run 级 gate 注入；缺省 true / 布尔补丁 / 触碰持久化）
// ---------------------------------------------------------------------------

describe('ui/server：reviewMode（R2-S2 评审哨兵开关）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('v1) GET 缺省 true；POST 校验（非 boolean → 400）；触碰持久化；未触碰不带键', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      persistSettings: (s: unknown) => {
        persisted.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
      },
    });
    servers.push(server);

    const initial = (await (await fetch(new URL('/api/settings', base))).json()) as {
      reviewMode: boolean;
    };
    expect(initial.reviewMode).toBe(true);

    // 未触碰不带键（补丁语义——与 methodFirst 同规）
    await postJson(base, '/api/settings', { model: 'm1' });
    expect(persisted[0]).toEqual({ baseUrl: 'https://default.example/v1', model: 'm1' });

    const off = await postJson(base, '/api/settings', { reviewMode: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { reviewMode: boolean }).reviewMode).toBe(false);
    expect(persisted[1]).toEqual({
      baseUrl: 'https://default.example/v1',
      model: 'm1',
      reviewMode: false,
    });
    expect(
      (await (await fetch(new URL('/api/settings', base))).json()) as { reviewMode: boolean },
    ).toEqual(expect.objectContaining({ reviewMode: false }));

    const bad = await postJson(base, '/api/settings', { reviewMode: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('v2) reviewMode:false → run_command 实质变更后自然结束也不注入哨兵（开关关闭链路）', async () => {
    const llm = new FakeLlm([
      {
        content: '执行',
        toolCalls: [
          { id: 'c1', name: 'run_command', arguments: '{"command":"echo hi"}' },
        ],
      },
      { content: 'done' },
    ]);
    const { base, server } = await startServer({
      store: new MemorySessionAdapter(),
      tools: defineRegistry([runCommandTool()], { sessionId: 's1' }),
      llm,
      model: 'm0',
      settings: { reviewMode: false },
      // 本用例只锁哨兵开关链路：echo 属 ask 级 → 审批直放（审批链在 approval 测试覆盖）
      approvalPolicy: () => false,
    });
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: '跑命令' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 9, 10_000);
    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'tool-start',
      'tool-result',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({
      status: 'completed',
      steps: 2,
    });
    // 无哨兵注入：只有首个任务 user（无第二个 session-user 帧；无请求 #3）
    expect(client.frames.filter((f) => f.event === 'session-user')).toHaveLength(1);
    expect(llm.requests).toHaveLength(2);
  });
});
