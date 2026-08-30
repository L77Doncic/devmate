/**
 * # test/ui-server/context-overflow：E7 自愈链的服务端面（run 不死 + 上限学习）
 *
 * 蓝本 = .scratch/coding-agent/research/limits-effects-and-overflow.md B.c（400 → fatal 现状）
 * + C.2 L2（「从 400 message 免费解析上限」——windowDetail 报「由错误学习」）。
 *
 * VT2-1 修正（learned = run-scoped 的语义钉住）：
 * - a) 用户显式 windowTokens 是最高权威——显式时 learned 绝不 min 钳制/顶替；
 * - b) learned 只对「产生该错误的 run」驻留（run 结束即清，无跨 run 粘滞）。
 * 红→绿：旧实现「一次 context-400 → 全实例钳死」；新实现 A/B 用例证明
 * 「显式 windowTokens 不被 min」＋「下个 run 无学习摘要（windowDetail 无『由错误学习』）」。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { LlmError } from '../../src/shared/llm-types.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import { deferred, echoTool, FakeLlm } from '../loop/support.js';
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

/** 同一形状、更小 hintMax（1000 —— 学习中「钳住显式窗口」的 A/B 复现载荷）。 */
const CONTEXT_400_SMALL = new LlmError({
  kind: 'http',
  status: 400,
  retryable: false,
  message:
    "This model's maximum context length is 1000 tokens. However, your messages resulted in 200000 tokens. Please reduce the length of the messages.",
});

/** 等待 fake 收到第 n 次请求（onEnter 计数；超时 5s 抛错）——注意：第 n 次请求已进入
 * chat 意味着上一脚的错误已分类并触发学习回调（E7：onLimitsError 于重试前调用）。 */
async function waitRun(fake: FakeLlm, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (fake.callCount < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (fake.callCount < count) throw new Error(`fake llm callCount ${fake.callCount} < ${count}`);
}

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

  it('VT2-1 run-scoped：学习值只在「产生错误的 run」内注记——run 结束 GET 即无「由错误学习」', async () => {
    const gate = deferred();
    const llm = new FakeLlm([{ error: CONTEXT_400 }, { content: 'ok', gate: gate.promise }]);
    const { base, server } = await startServer(baseDeps(llm));
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);

    // 重试请求已进入 chat（学习已发生），run 悬停在 gate 上——run 仍在执行中
    await waitRun(llm, 2);
    const midRun = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(midRun.window).toBe(1_024_000);
    expect(midRun.windowDetail).toContain('由错误学习');

    gate.resolve();
    await waitForFrames(client, 5, 10_000);

    // run 结束：learned 清除（run-scoped）——GET 回落到无窗口源（无显式/无探测/preset 无胚）
    const afterRun = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(afterRun.window).toBeUndefined();
    expect(afterRun.windowDetail).toBeUndefined();

    // 「下个 run 无摘要」：下个 run 完成后同样看不到学习注记（无跨 run 粘滞）
    const second = (await (await postJson(base, '/api/chat', { text: 'again' })).json()) as {
      sessionId: string;
    };
    const client2 = await SseClient.connect(base, second.sessionId);
    clients.push(client2);
    await waitForFrames(client2, 5, 10_000);
    const afterRun2 = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(afterRun2.window).toBeUndefined();
    expect(afterRun2.windowDetail).toBeUndefined();
  });

  it('VT2-1 A/B：显式 windowTokens 不被 learned 钳制（hintMax=1000 < 显式 5000 → 仍是 5000）', async () => {
    const llm = new FakeLlm([{ error: CONTEXT_400_SMALL }, { content: 'ok' }]);
    const { base, server } = await startServer(baseDeps(llm));
    servers.push(server);

    // 用户显式设置：windowTokens=5000（最高权威；maxInput 高于它——不叠上限钳）
    const set = await postJson(base, '/api/settings', {
      windowTokens: 5000,
      maxInputTokens: 6000,
      maxOutputTokens: 1000,
    });
    expect(set.status).toBe(200);

    // run 1：context-400（hintMax=1000）→ 自愈 + 学习（旧实现从此处起全实例被钳死）
    const run1 = (await (await postJson(base, '/api/chat', { text: 'first' })).json()) as {
      sessionId: string;
    };
    const client1 = await SseClient.connect(base, run1.sessionId);
    clients.push(client1);
    await waitForFrames(client1, 5, 10_000);

    // 显式值不被 min 到 1000（旧实现：window=1000 + 「由错误学习」注记）
    const after1 = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(after1.window).toBe(5000);
    expect(after1.windowDetail).toContain('用户显式覆盖');
    expect(after1.windowDetail).not.toContain('由错误学习');

    // 下个 run 同样不受影响（回注/预算不继承：显式 5000 恒定）
    const run2 = (await (await postJson(base, '/api/chat', { text: 'second' })).json()) as {
      sessionId: string;
    };
    const client2 = await SseClient.connect(base, run2.sessionId);
    clients.push(client2);
    await waitForFrames(client2, 5, 10_000);
    const after2 = (await (await fetch(new URL('/api/settings', base))).json()) as {
      window?: number;
      windowDetail?: string;
    };
    expect(after2.window).toBe(5000);
    expect(after2.windowDetail).toContain('用户显式覆盖');
    expect(after2.windowDetail).not.toContain('由错误学习');
  });
});
