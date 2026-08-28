/**
 * # test/ui-server/memory-guard：内存防线（波 B：契约 A4）
 *
 * 服务端内置 MemoryGuard：注入 deps.memorySampler（rss 字节，可编程）即安装；
 * 每 memorySweepMs（缺省 60s）采样判档：
 * - ≥1.5GB：警戒档 —— disposeAllIdle（deps；跳过活跃 run 会话）+ 全会话 broker 清窗
 *   （保留在线订阅）+ stats.memoryGuard {tripped:true,lastAt,reason:'memory-pressure'}；新 run 仍允许；
 * - ≥2GB：停机档 —— 追加拒绝新 run 启动（POST /api/chat → 409 {error:'memory-pressure'} + 中文提示）；
 * - <1.2GB：恢复档 —— 自动解锁（tripped:false，run 恢复）；
 * - 1.2–1.5GB 区间为迟滞带（停机后停留原地，不提前解锁）。
 * 不注入 memorySampler → 不安装守卫（stats 无 memoryGuard；chat 不限）。
 * SessionBroker.clear()：清窗保在线——已清窗口不重放，绝对序号后续新帧照投。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import { SessionBroker } from '../../src/ui/server/index.js';
import type { DevmateServer, DevmateServerDeps, TickHandle } from '../../src/ui/server/index.js';
import type { SseEventData } from '../../src/ui/server/emit.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

const MB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

function baseDeps(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    ...extra,
  };
}

/** 可编程 rss 采样器 + 按 interval 捕获 handler 的调度器（每 server 一份）。 */
function guardedDeps() {
  let rssBytes = 300 * MB; // 程序化 rss
  const handlers = new Map<number, () => void>();
  const cancels: Array<number> = [];
  return {
    rss: (value: number): void => {
      rssBytes = value;
    },
    tick: (intervalMs: number): (() => void) | undefined => handlers.get(intervalMs),
    intervals: (): number[] => [...handlers.keys()],
    scheduleTick: (handler: () => void, intervalMs: number): TickHandle => {
      handlers.set(intervalMs, handler);
      return {
        cancel: () => {
          cancels.push(intervalMs);
        },
      };
    },
    cancelCount: (): number => cancels.length,
    sampler: (): number => rssBytes,
  };
}

describe('ui/server：内存守卫（MemoryGuard）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('g1) 未注入 memorySampler → 不安装守卫：stats 无 memoryGuard 键，chat 不受限', async () => {
    const { base, server } = await startServer(baseDeps());
    servers.push(server);
    const stats = (await (await fetch(new URL('/api/stats', base))).json()) as Record<
      string,
      unknown
    >;
    expect('memoryGuard' in stats).toBe(false);
    const chat = await postJson(base, '/api/chat', { text: 'hi' });
    expect(chat.status).toBe(200);
  });

  it('g1b) stats 扩展：queuedSubagents 仅在注入 queuedSubagentCount 数据源时出现', async () => {
    const { base, server } = await startServer(baseDeps({ queuedSubagentCount: () => 3 }));
    servers.push(server);
    const stats = (await (await fetch(new URL('/api/stats', base))).json()) as Record<
      string,
      unknown
    >;
    expect(stats.queuedSubagents).toBe(3);

    const { base: base2, server: server2 } = await startServer(baseDeps());
    servers.push(server2);
    const stats2 = (await (await fetch(new URL('/api/stats', base2))).json()) as Record<
      string,
      unknown
    >;
    expect('queuedSubagents' in stats2).toBe(false);
  });

  it('g2) 安装守卫：按 memorySweepMs 注册 tick（缺省 60s）；低占用 tick 不做任何处置；stats 初始 tripped:false', async () => {
    const g = guardedDeps();
    const disposeAllIdle = vi.fn(async (_active?: ReadonlySet<string>) => {});
    const { base, server } = await startServer(
      baseDeps({ memorySampler: g.sampler, scheduleTick: g.scheduleTick, disposeAllIdle }),
    );
    servers.push(server);

    expect(g.intervals()).toEqual([60_000]); // 缺省采样节拍一分钟
    const stats1 = (await (await fetch(new URL('/api/stats', base))).json()) as {
      memoryGuard: { tripped: boolean; lastAt: number | null; reason: string | null };
    };
    expect(stats1.memoryGuard).toEqual({ tripped: false, lastAt: null, reason: null });

    await g.tick(60_000)!(); // 300MB：警戒线以下
    expect(disposeAllIdle).not.toHaveBeenCalled();
    const stats2 = (await (await fetch(new URL('/api/stats', base))).json()) as {
      memoryGuard: { tripped: boolean };
    };
    expect(stats2.memoryGuard.tripped).toBe(false);
  });

  it('g3) 警戒档（≥1.5GB）：disposeAllIdle(activeRunSessions) 被调；broker 清窗（新客户端无回放、在线客户端续收）；run 仍允许；stats tripped:true', async () => {
    const g = guardedDeps();
    const disposeAllIdle = vi.fn(async (_active?: ReadonlySet<string>) => {});
    const { base, server } = await startServer(
      baseDeps({ memorySampler: g.sampler, scheduleTick: g.scheduleTick, disposeAllIdle }),
    );
    servers.push(server);

    // 制造一个 broker 有帧的会话：一次 run（FakeLlm 短脚本跑完）
    const created = (await (await postJson(base, '/api/chat', { text: 'hi' })).json()) as {
      sessionId: string;
    };
    const online = await SseClient.connect(base, created.sessionId);
    clients.push(online);
    await waitForFrames(online, 5); // 等 run 全部帧（完成回放）
    online.drain();

    g.rss(1.6 * GIB);
    await g.tick(60_000)!();
    expect(disposeAllIdle).toHaveBeenCalledTimes(1);
    expect(disposeAllIdle).toHaveBeenLastCalledWith(expect.any(Set)); // activeRunSessions（此刻空）

    // 清窗：后连客户端看不到清窗前的老帧
    const late = await SseClient.connect(base, created.sessionId);
    clients.push(late);
    expect(await late.next(400)).toBeNull();

    // 在线客户端续收：再来一条消息 → online 收到新帧
    await waitForChatOk(base, created.sessionId);
    const frame = await online.next(5000);
    expect(frame).not.toBeNull();
    expect((frame as SseEventData).event).toBe('session-user');

    const stats = (await (await fetch(new URL('/api/stats', base))).json()) as {
      memoryGuard: { tripped: boolean; lastAt: number | null; reason: string | null };
    };
    expect(stats.memoryGuard.tripped).toBe(true);
    expect(stats.memoryGuard.lastAt).toBeTypeOf('number');
    expect(stats.memoryGuard.reason).toBe('memory-pressure');

    // 未到停机线：新 run 仍允许
    const beforeHalt = await postJson(base, '/api/chat', { text: 'again' });
    expect(beforeHalt.status).toBe(200);
  });

  it('g4) 停机档（≥2GB）：新 run 409 {error:"memory-pressure"}+提示；迟滞带不解锁；恢复（<1.2GB）自动解锁且 tripped 复位', async () => {
    const g = guardedDeps();
    const disposeAllIdle = vi.fn(async (_active?: ReadonlySet<string>) => {});
    const { base, server } = await startServer(
      baseDeps({ memorySampler: g.sampler, scheduleTick: g.scheduleTick, disposeAllIdle }),
    );
    servers.push(server);

    g.rss(2.2 * GIB);
    await g.tick(60_000)!();
    const refused = await postJson(base, '/api/chat', { text: 'hi' });
    expect(refused.status).toBe(409);
    const refusedBody = (await refused.json()) as { error: string; message?: string };
    expect(refusedBody.error).toBe('memory-pressure');
    expect(refusedBody.message).toBeTypeOf('string'); // 恢复提示由 message 承载

    // 迟滞带（1.2-2GB 之间回落）：停机锁不解
    g.rss(1.7 * GIB);
    await g.tick(60_000)!();
    const still = await postJson(base, '/api/chat', { text: 'hi' });
    expect(still.status).toBe(409);
    g.rss(1.3 * GIB);
    await g.tick(60_000)!();
    const still2 = await postJson(base, '/api/chat', { text: 'hi' });
    expect(still2.status).toBe(409);

    // 恢复档（<1.2GB）：自动解锁
    g.rss(1.1 * GIB);
    await g.tick(60_000)!();
    const ok = await postJson(base, '/api/chat', { text: 'hi' });
    expect(ok.status).toBe(200);
    const stats = (await (await fetch(new URL('/api/stats', base))).json()) as {
      memoryGuard: { tripped: boolean; lastAt: number | null; reason: string | null };
    };
    expect(stats.memoryGuard.tripped).toBe(false);
    expect(stats.memoryGuard.reason).toBeNull();
    expect(stats.memoryGuard.lastAt).toBeTypeOf('number'); // 上次触发时刻保留（历史）
  });

  it('g5) 无 disposeAllIdle 时回退 disposeIdleShells(Infinity, active)；close 取消守卫 tick', async () => {
    const g = guardedDeps();
    const disposeIdleShells = vi.fn(async (_now: number, _active?: ReadonlySet<string>) => {});
    const { base, server } = await startServer(
      baseDeps({
        memorySampler: g.sampler,
        scheduleTick: g.scheduleTick,
        idleSweepMs: 30_000, // 与守卫 60s 错开：按 interval 分别注册
        disposeIdleShells,
      }),
    );
    servers.push(server);

    g.rss(1.6 * GIB);
    await g.tick(60_000)!();
    expect(disposeIdleShells).toHaveBeenCalledTimes(1);
    expect(disposeIdleShells).toHaveBeenLastCalledWith(Number.POSITIVE_INFINITY, expect.any(Set));

    await server.close();
    expect(g.cancelCount()).toBe(2); // close 必须取消空闲清扫 + 守卫采样两个定时器
    expect(base.startsWith('http://127.0.0.1')).toBe(true);
  });

  it('g6) SessionBroker.clear()：清空回放窗但绝对序号延续——在线订阅游标不失效、后续新帧照常抵达', async () => {
    const broker = new SessionBroker();
    for (let i = 0; i < 3; i += 1) {
      broker.push({ event: 'assistant-delta', data: { text: `old${i}` } });
    }
    const online = broker.consume();
    await online.next(); // 消费了 old0
    broker.clear(); // 清窗：old1/old2 回放窗口消失
    broker.push({ event: 'assistant-delta', data: { text: 'new1' } });

    const { value } = await online.next();
    expect((value as SseEventData).data).toEqual({ text: 'new1' });
    // 在线游标已越过清窗的空隙，绝不会把已清掉的 old1/old2 送来（断言上面已覆盖）

    // 后进订阅者：只见清窗后的新帧
    const late = broker.consume();
    const lateFirst = await late.next();
    expect((lateFirst.value as SseEventData).data).toEqual({ text: 'new1' });
  });
});

/** POST /api/chat 重试到不再 409（run 结束推进重试窗口；最多约 2s）。 */
async function waitForChatOk(base: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const res = await postJson(base, '/api/chat', { text: 'next message', sessionId });
    if (res.status === 200) return;
    if (res.status !== 409 || Date.now() > deadline) {
      throw new Error(`POST /api/chat retry failed: ${res.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
