/**
 * # test/ui-server/settings：设置往返 + apiKey 掩码（接缝 S12 f 档）
 *
 * GET/POST /api/settings {baseUrl, model, apiKey?}；apiKey 只回掩码（前 4 尾 4），
 * 绝不出现在任何响应里；model 变更即时作用于后续 run（真实 llm 请求带新 model）。
 * A 档（2026-08-30 用户实测修正）：模型名 `[N]m/k` UI 标记后缀**全链净化**——
 * GET/POST 响应恒净化名；POST 保存即净化（persist/config 净化值）；有效窗口
 * （网关探测匹配）按净化名。
 * B 档（2026-08-30 用户强制）：maxInputTokens/maxOutputTokens **必填**——POST 缺任一
 * → 400 code=max-input-output-required / 非正整数 → code=invalid；GET 恒回显
 * （存量缺失回填缺省：输出 8192=DEFAULT_MAX_TOKENS、输入=供应商 preset，并挂
 * `*Default` 提示键——「已用默认，请修改保存」不静默）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { buildRequest, PROVIDER_PRESETS } from '../../src/core/llm/index.js';
import { echoTool, FakeLlm, runCommandTool } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

const RAW_KEY = 'sk-1234567890abcdef';
/** B 档：POST 必填上限对（测试共用值；断言只用存在性/数字等同——见各用例）。 */
const TEST_TOKENS = { maxInputTokens: 4096, maxOutputTokens: 2048 };
const DEFAULT_OUTPUT_TOKENS = 8192; // DEFAULT_MAX_TOKENS（core/loop/types）
const DEFAULT_PRESET_WINDOW = 1_000_000; // deepseek preset 窗口（实测过 1M；输入上限缺省回填，ADR-0016）

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
      ...TEST_TOKENS,
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

    const long = (await (
      await postJson(base, '/api/settings', { apiKey: RAW_KEY, ...TEST_TOKENS })
    ).json()) as { apiKey: string };
    expect(long.apiKey).toBe(`${RAW_KEY.slice(0, 4)}****${RAW_KEY.slice(-4)}`);

    // 9~12 字符边界（此前实现 ≤8 才全掩，9~12 会漏出首尾 —— 现按单一实现全掩）
    for (const len of [9, 10, 11, 12]) {
      const key = 'k'.repeat(len);
      const res = await postJson(base, '/api/settings', { apiKey: key, ...TEST_TOKENS });
      expect(((await res.json()) as { apiKey: string }).apiKey).toBe('****');
    }
    // >12 的分界（13 字符）：显首尾 4
    const edge = (await (
      await postJson(base, '/api/settings', { apiKey: 'm'.repeat(13), ...TEST_TOKENS })
    ).json()) as { apiKey: string };
    expect(edge.apiKey).toBe('mmmm****mmmm');
  });

  it('f3) 部分更新保留未指字段；model 变更即时作用于后续 run', async () => {
    const llm = new FakeLlm([{ content: 'one' }, { content: 'two' }]);
    const { base, server } = await startServer(baseDeps(llm));
    servers.push(server);

    const v1 = (await (
      await postJson(base, '/api/settings', { model: 'm2', ...TEST_TOKENS })
    ).json()) as { baseUrl: string; model: string };
    expect(v1).toMatchObject({ baseUrl: 'https://default.example/v1', model: 'm2' });

    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(llm.requests[0]!.model).toBe('m2');
  });

  it('f5) persistSettings：POST 后按应用值调用（含 apiKey 与必填上限对）；GET 不触发；空 key 清除时不带 apiKey', async () => {
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
      ...TEST_TOKENS,
    });
    expect(persisted).toEqual([
      {
        baseUrl: 'https://persist.example/v1',
        model: 'm-p',
        apiKey: RAW_KEY,
        maxInputTokens: TEST_TOKENS.maxInputTokens,
        maxOutputTokens: TEST_TOKENS.maxOutputTokens,
      },
    ]);

    await fetch(new URL('/api/settings', base)); // GET 不触发持久化
    expect(persisted).toHaveLength(1);

    const cleared = await postJson(base, '/api/settings', { apiKey: '', ...TEST_TOKENS });
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as { baseUrl: string; model: string; apiKey?: string };
    expect(body).toMatchObject({ baseUrl: 'https://persist.example/v1', model: 'm-p' });
    expect(body.apiKey).toBeUndefined(); // 空 key = 显式删除：响应不出现掩码
    expect(persisted).toEqual([
      {
        baseUrl: 'https://persist.example/v1',
        model: 'm-p',
        apiKey: RAW_KEY,
        maxInputTokens: TEST_TOKENS.maxInputTokens,
        maxOutputTokens: TEST_TOKENS.maxOutputTokens,
      },
      {
        baseUrl: 'https://persist.example/v1',
        model: 'm-p',
        maxInputTokens: TEST_TOKENS.maxInputTokens,
        maxOutputTokens: TEST_TOKENS.maxOutputTokens,
      },
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
      ...TEST_TOKENS,
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
    await postJson(base, '/api/settings', { apiKey: '', ...TEST_TOKENS });
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

  it('f4) 空字段/非对象体 → 400 {error}（B 档：空体先被「上限必填」拦截——仍是 400）', async () => {
    const { base, server } = await startServer(baseDeps(new FakeLlm([{ content: 'x' }])));
    servers.push(server);
    const empty = await postJson(base, '/api/settings', {});
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBeTypeOf('string');
    const badType = await postJson(base, '/api/settings', { model: 42, ...TEST_TOKENS });
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { error: string }).error).toBeTypeOf('string');
  });
});

// ---------------------------------------------------------------------------
// A 档：模型名全链净化（2026-08-30 用户实测修正——`[N]m/k` UI 标记后缀残留）
// ---------------------------------------------------------------------------

describe('ui/server：模型名全链净化（A 档）', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('g1) 存量 settings.model 带 `[1m]` 尾标（历史残留 config）→ GET 显示净化名 + modelSanitized 标记', async () => {
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      settings: { baseUrl: 'https://default.example/v1', model: 'm0[1m]' },
    });
    servers.push(server);

    const get = (await (await fetch(new URL('/api/settings', base))).json()) as {
      model: string;
      modelSanitized?: boolean;
    };
    expect(get.model).toBe('m0');
    expect(get.model).not.toMatch(/\[(?:[0-9.]+)(?:[km])/i);
    expect(get.modelSanitized).toBe(true); // 前端据此提示「模型名已自动校正」一次

    // 无尾标的存量 → 无标记（不误提示）
    const { base: base2, server: server2 } = await startServer(
      baseDeps(new FakeLlm([{ content: 'x' }])),
    );
    servers.push(server2);
    const clean = (await (await fetch(new URL('/api/settings', base2))).json()) as {
      model: string;
      modelSanitized?: boolean;
    };
    expect(clean.model).toBe('m0');
    expect(clean.modelSanitized).toBeUndefined();
  });

  it('g2) POST {model:[1m] 尾标} → 保存即净化：persist 净化值 + 响应/GET 净化名 + run 用净化名', async () => {
    const llm = new FakeLlm([{ content: 'x' }]);
    const persisted: Array<Record<string, unknown>> = [];
    const { base, server } = await startServer({
      ...baseDeps(llm),
      persistSettings: (s: unknown) => {
        persisted.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
      },
    });
    servers.push(server);

    const posted = await postJson(base, '/api/settings', { model: 'm-p[1m]', ...TEST_TOKENS });
    expect(posted.status).toBe(200);
    const saved = (await posted.json()) as { model: string };
    expect(saved.model).toBe('m-p');
    expect(persisted[persisted.length - 1]!).toMatchObject({ model: 'm-p' });

    const after = (await (await fetch(new URL('/api/settings', base))).json()) as {
      model: string;
      modelSanitized?: boolean;
    };
    expect(after.model).toBe('m-p');
    expect(after.modelSanitized).toBeUndefined(); // 新保存值不触发「存量已校正」提示

    // run：current.model 恒净化（摘要器/llm 接缝同源——FakeLlm 收到的模型名净化）
    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    await waitForFrames(client, 5, 10_000);
    expect(llm.requests[0]!.model).toBe('m-p');
    client.close();
  });

  it('g3) 规则：非尾标/无后缀名原样（不误伤 my-model-1m / my[m]model）', async () => {
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      settings: { baseUrl: 'https://default.example/v1', model: 'my[m]model[128k]' },
    });
    servers.push(server);
    const get = (await (await fetch(new URL('/api/settings', base))).json()) as {
      model: string;
    };
    expect(get.model).toBe('my[m]model');
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

    // 未触碰不带键（补丁语义——与 methodFirst 同规）；上限对恒携带（B 档必填）
    await postJson(base, '/api/settings', { model: 'm1', ...TEST_TOKENS });
    expect(persisted[0]).toEqual({
      baseUrl: 'https://default.example/v1',
      model: 'm1',
      maxInputTokens: TEST_TOKENS.maxInputTokens,
      maxOutputTokens: TEST_TOKENS.maxOutputTokens,
    });

    const off = await postJson(base, '/api/settings', { reviewMode: false, ...TEST_TOKENS });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { reviewMode: boolean }).reviewMode).toBe(false);
    expect(persisted[1]).toEqual({
      baseUrl: 'https://default.example/v1',
      model: 'm1',
      reviewMode: false,
      maxInputTokens: TEST_TOKENS.maxInputTokens,
      maxOutputTokens: TEST_TOKENS.maxOutputTokens,
    });
    expect(
      (await (await fetch(new URL('/api/settings', base))).json()) as { reviewMode: boolean },
    ).toEqual(expect.objectContaining({ reviewMode: false }));

    const bad = await postJson(base, '/api/settings', { reviewMode: 'yes', ...TEST_TOKENS });
    expect(bad.status).toBe(400);
  });

  it('v2) reviewMode:false → run_command 实质变更后自然结束也不注入哨兵（开关关闭链路）', async () => {
    const llm = new FakeLlm([
      {
        content: '执行',
        toolCalls: [{ id: 'c1', name: 'run_command', arguments: '{"command":"echo hi"}' }],
      },
      { content: 'done' },
    ]);
    const { base, server } = await startServer({
      store: new MemorySessionAdapter(),
      tools: defineRegistry([runCommandTool()], { sessionId: 's1' }),
      llm,
      model: 'm0',
      settings: {
        reviewMode: false,
        baseUrl: 'https://default.example/v1',
        model: 'm0',
      },
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

// ---------------------------------------------------------------------------
// A/B 档：maxInputTokens / maxOutputTokens（必填；GET 缺省回填+提示键；即时生效）
// ---------------------------------------------------------------------------

describe('ui/server：settings 输入/输出上限（A/B 档必填）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('b1) GET 存量缺失 → 恒回显缺省（输出 8192=DEFAULT_MAX_TOKENS；输入=供应商 preset 128000）且带 `*Default` 提示键', async () => {
    const { base, server } = await startServer(baseDeps(new FakeLlm([{ content: 'x' }])));
    servers.push(server);

    const initial = (await (await fetch(new URL('/api/settings', base))).json()) as Record<
      string,
      unknown
    >;
    expect(initial.maxInputTokens).toBe(DEFAULT_PRESET_WINDOW);
    expect(initial.maxOutputTokens).toBe(DEFAULT_OUTPUT_TOKENS);
    expect(initial.maxInputTokensDefault).toBe(true);
    expect(initial.maxOutputTokensDefault).toBe(true);
  });

  it('b2) 显式存储值 → GET 恒回显现值；`*Default` 键消失（保存后缺省升格为存量）', async () => {
    const { base, server } = await startServer(baseDeps(new FakeLlm([{ content: 'x' }])));
    servers.push(server);

    await postJson(base, '/api/settings', { maxInputTokens: 4096, maxOutputTokens: 2048 });
    const after = (await (await fetch(new URL('/api/settings', base))).json()) as Record<
      string,
      unknown
    >;
    expect(after.maxInputTokens).toBe(4096);
    expect(after.maxOutputTokens).toBe(2048);
    expect(after.maxInputTokensDefault).toBeUndefined();
    expect(after.maxOutputTokensDefault).toBeUndefined();

    // 只改输入（上限对恒携带）：输出保持现值不被覆盖
    await postJson(base, '/api/settings', { maxInputTokens: 8192, maxOutputTokens: 2048 });
    const partial = (await (await fetch(new URL('/api/settings', base))).json()) as Record<
      string,
      unknown
    >;
    expect(partial.maxInputTokens).toBe(8192);
    expect(partial.maxOutputTokens).toBe(2048);
  });

  it('b3) POST 缺任一上限 → 400 code=max-input-output-required', async () => {
    const { base, server } = await startServer(baseDeps(new FakeLlm([{ content: 'x' }])));
    servers.push(server);

    const missingIn = await postJson(base, '/api/settings', { maxOutputTokens: 2048 });
    expect(missingIn.status).toBe(400);
    expect(((await missingIn.json()) as { code: string }).code).toBe('max-input-output-required');

    const missingOut = await postJson(base, '/api/settings', { maxInputTokens: 4096 });
    expect(missingOut.status).toBe(400);
    expect(((await missingOut.json()) as { code: string }).code).toBe('max-input-output-required');

    // 单字段补丁（等 POST 语义）也恒要求上限对
    const patch = await postJson(base, '/api/settings', { reasoning: 'high' });
    expect(patch.status).toBe(400);
    expect(((await patch.json()) as { code: string }).code).toBe('max-input-output-required');

    const empty = await postJson(base, '/api/settings', {});
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { code: string }).code).toBe('max-input-output-required');
  });

  it('b4) 非严格正整数（0/-1/1.5/字符串/布尔）→ 400 code=invalid', async () => {
    const { base, server } = await startServer(baseDeps(new FakeLlm([{ content: 'x' }])));
    servers.push(server);
    for (const bad of [0, -1, 1.5, '4096', true]) {
      const res = await postJson(base, '/api/settings', {
        maxInputTokens: bad,
        maxOutputTokens: 2048,
      });
      expect(res.status, `maxInputTokens=${String(bad)}`).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('invalid');
      const res2 = await postJson(base, '/api/settings', {
        maxInputTokens: 4096,
        maxOutputTokens: bad,
      });
      expect(res2.status, `maxOutputTokens=${String(bad)}`).toBe(400);
      expect(((await res2.json()) as { code: string }).code).toBe('invalid');
    }
  });

  it('b5) 生效：POST maxOutputTokens 后下一条 run 的请求带 maxTokens；POST 前按缺省（未设不发送）', async () => {
    const fake = new FakeLlm([
      { content: 'a', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      { content: 'b', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);
    const { base, server } = await startServer(baseDeps(fake));
    servers.push(server);

    // 未设置（缺省回填仅是 GET 回显——不自动注入 run）：请求不带 maxTokens / maxInputTokens
    const r1 = await postJson(base, '/api/chat', { text: 'x' });
    expect(r1.status).toBe(200);
    const s1 = (await r1.json()) as { sessionId: string };
    await waitRun(fake, 1);
    expect(fake.requests[0]!.maxTokens).toBeUndefined();
    expect(fake.requests[0]!.maxInputTokens).toBeUndefined();

    // 设置后：message 请求带新值（每次 run 现读）
    await postJson(base, '/api/settings', { maxInputTokens: 1111, maxOutputTokens: 2222 });
    const r2 = await postJson(base, '/api/chat', { sessionId: s1.sessionId, text: 'y' });
    expect(r2.status).toBe(200);
    await waitRun(fake, 2);
    expect(fake.requests[1]!.maxTokens).toBe(2222);
    expect(fake.requests[1]!.maxInputTokens).toBe(1111);
  });

  it('b6) 持久化往返：persistSettings 携带上限对；重读注入（CLI 读回键）后 GET 一致', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      persistSettings: (s: unknown) => {
        persisted.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
      },
    });
    servers.push(server);

    await postJson(base, '/api/settings', { maxInputTokens: 1111, maxOutputTokens: 2222 });
    expect(persisted[persisted.length - 1]!).toMatchObject({
      maxInputTokens: 1111,
      maxOutputTokens: 2222,
    });
    // 模拟 CLI 读回注入（web.ts 同键读回 → settings 初值）
    const { base: base2, server: server2 } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      settings: {
        baseUrl: 'https://default.example/v1',
        model: 'm0',
        maxInputTokens: 1111,
        maxOutputTokens: 2222,
      },
    });
    servers.push(server2);
    const got = (await (await fetch(new URL('/api/settings', base2))).json()) as Record<
      string,
      unknown
    >;
    expect(got.maxInputTokens).toBe(1111);
    expect(got.maxOutputTokens).toBe(2222);
    expect(got.maxOutputTokensDefault).toBeUndefined();
  });

  it('b7) S 档输出钳制：POST 1000000（deepseek）→ 回执 393216 + maxOutputTokensClamped；钳制值持久化；后续 run 发钳后值', async () => {
    const fake = new FakeLlm([
      { content: 'a' },
      { content: 'b', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);
    const persisted: Array<Record<string, unknown>> = [];
    const { base, server } = await startServer({
      ...baseDeps(fake),
      persistSettings: (s: unknown) => {
        persisted.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
      },
    });
    servers.push(server);

    const res = await postJson(base, '/api/settings', {
      maxInputTokens: 4096,
      maxOutputTokens: 1_000_000,
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Record<string, unknown>;
    expect(saved.maxOutputTokens).toBe(393_216); // 实测 valid-range 上界
    expect(saved.maxOutputTokensClamped).toBe(true);
    expect(saved.maxInputTokensClamped).toBeUndefined();
    // 钳制值持久化（存的是钳后值——保存的即生效值）
    expect(persisted[persisted.length - 1]!).toMatchObject({ maxOutputTokens: 393_216 });

    const got = (await (await fetch(new URL('/api/settings', base))).json()) as Record<
      string,
      unknown
    >;
    expect(got.maxOutputTokens).toBe(393_216);
    expect(got.maxOutputTokensClamped).toBe(true);

    // 后续 run：runOptions.maxTokens = 钳后值（FakeLlm 停留在 ChatRequest 层）
    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(fake.requests[0]!.maxTokens).toBe(393_216);

    // 再保存非钳制值 → 标记随之清除（标记为触碰语义）
    const again = await postJson(base, '/api/settings', {
      maxInputTokens: 4096,
      maxOutputTokens: 6480,
    });
    const savedAgain = (await again.json()) as Record<string, unknown>;
    expect(savedAgain.maxOutputTokens).toBe(6480);
    expect(savedAgain.maxOutputTokensClamped).toBeUndefined();
  });

  it('b8) S 档输入钳制：POST 2000000（deepseek 窗口 1M）→ 1000000 + maxInputTokensClamped；持久化钳后值', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      persistSettings: (s: unknown) => {
        persisted.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
      },
    });
    servers.push(server);

    const res = await postJson(base, '/api/settings', {
      maxInputTokens: 2_000_000,
      maxOutputTokens: 2048,
    });
    const saved = (await res.json()) as Record<string, unknown>;
    expect(saved.maxInputTokens).toBe(1_000_000);
    expect(saved.maxInputTokensClamped).toBe(true);
    expect(persisted[persisted.length - 1]!).toMatchObject({ maxInputTokens: 1_000_000 });
  });

  it('b9) 无据供应商不钳：dashscope/openai 无 maxOutputTokens → 输出超值保留、标记缺席；输入仍窗口钳', async () => {
    const { base, server } = await startServer(baseDeps(new FakeLlm([{ content: 'x' }])));
    servers.push(server);

    const dash = await postJson(base, '/api/settings', {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-coder-plus',
      maxInputTokens: 500_000,
      maxOutputTokens: 500_000,
    });
    const savedDash = (await dash.json()) as Record<string, unknown>;
    expect(savedDash.maxOutputTokens).toBe(500_000); // 无据不钳（待实测）
    expect(savedDash.maxOutputTokensClamped).toBeUndefined();
    expect(savedDash.maxInputTokens).toBe(128_000); // 窗口 128000（估算）照钳
    expect(savedDash.maxInputTokensClamped).toBe(true);
  });

  it('e2e 补审计缺口：settings 输出 64 → wire body.max_tokens=64（deepseek 无 max_input_tokens/无 max_completion_tokens）', async () => {
    // 录制 adapter：把 ChatRequest 经真实 preset 序列化为 wire（body 字节口径），
    // 再按 FakeLlm 出流——settings → run → adapter → wire 全链一口径。
    const recorded: Record<string, unknown>[] = [];
    const fake = new FakeLlm([{ content: 'ok' }]);
    const { base, server } = await startServer({
      ...baseDeps(fake),
      createLlm: () => ({
        async *chat(request, signal) {
          const wire = buildRequest(request, PROVIDER_PRESETS.deepseek);
          recorded.push(JSON.parse(JSON.stringify(wire.body)));
          yield* fake.chat(request, signal);
        },
      }),
    });
    servers.push(server);

    await postJson(base, '/api/settings', {
      baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
      model: PROVIDER_PRESETS.deepseek.defaultModel,
      maxInputTokens: 8192,
      maxOutputTokens: 64,
    });
    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);

    expect(recorded).toHaveLength(1);
    const body = recorded[0]!;
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.max_tokens).toBe(64);
    expect('max_completion_tokens' in body).toBe(false);
    expect('max_input_tokens' in body).toBe(false); // 仅 DashScope/Qwen 白名单
  });
});

/** 等待 fake 收到第 n 次请求（onEnter 计数；超时 5s 抛错）。 */
async function waitRun(fake: FakeLlm, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (fake.callCount < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (fake.callCount < count) throw new Error(`fake llm callCount ${fake.callCount} < ${count}`);
}

describe('ui/server：P2-7 工作区目录回显（GET /api/settings）', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('f-w1) deps.workspaceRoot 注入 → GET 带 workspaceDir（缺省根）；未注入 → 无键（UI 占位兜底）', async () => {
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      workspaceRoot: '/work/default-root',
    });
    servers.push(server);
    const body = (await (await fetch(new URL('/api/settings', base))).json()) as {
      workspaceDir?: string;
    };
    expect(body.workspaceDir).toBe('/work/default-root');

    const { base: base2, server: server2 } = await startServer(
      baseDeps(new FakeLlm([{ content: 'x' }])),
    );
    servers.push(server2);
    const body2 = (await (await fetch(new URL('/api/settings', base2))).json()) as {
      workspaceDir?: string;
    };
    expect(body2.workspaceDir).toBeUndefined(); // 未注入根 → 不带键（「由启动目录决定」）
  });

  it('f-w2) GET /api/settings?sessionId=<带 meta 的会话> → 回该会话登记的根；无 meta → 缺省根', async () => {
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      workspaceRoot: '/work/default-root',
    });
    servers.push(server);

    // 会话 s1 携带 session-workspace meta（根 = /work/session-root）
    const store = new MemorySessionAdapter();
    await store.create('s1');
    await store.append('s1', {
      kind: 'event',
      payload: { type: 'session-workspace', data: { workspaceRoot: '/work/session-root' } },
    });
    // 该测试接缝：把带 meta 的 store 挂到另一台服务器
    const { base: base2, server: server2 } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      store,
      workspaceRoot: '/work/default-root',
    });
    servers.push(server2);

    const rooted = (await (
      await fetch(new URL(`/api/settings?sessionId=${encodeURIComponent('s1')}`, base2))
    ).json()) as { workspaceDir?: string };
    expect(rooted.workspaceDir).toBe('/work/session-root');

    // 无 meta 会话（不存在 → 读不到 meta）：回退缺省根
    const missing = (await (
      await fetch(new URL(`/api/settings?sessionId=${encodeURIComponent('no-meta-1')}`, base))
    ).json()) as { workspaceDir?: string };
    expect(missing.workspaceDir).toBe('/work/default-root');
  });

  it('f-w3) 非法 sessionId（越界字面量）→ 400 {error}（与其它端点一致过 assertValidSessionId）', async () => {
    const { base, server } = await startServer({
      ...baseDeps(new FakeLlm([{ content: 'x' }])),
      workspaceRoot: '/work/default-root',
    });
    servers.push(server);
    for (const bad of ['../etc', 'a/b', '%2e%2e']) {
      const res = await fetch(new URL(`/api/settings?sessionId=${encodeURIComponent(bad)}`, base));
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
    }
  });
});
