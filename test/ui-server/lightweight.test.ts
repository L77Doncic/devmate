/**
 * # test/ui-server/lightweight：轻量化（接缝 S12 延伸 B 档）
 *
 * - broker 缓冲上限：每会话帧缓存 5000 帧或 4MB（先到先裁，裁最旧）；后连客户端只见
 *   最近窗口（协议不新增字段）。在线消费不受影响。
 * - 心跳清理：SSE 连接断开必须 clearInterval 心跳定时器（真实短心跳观测无残留写）。
 * - shell 空闲释放：deps 工厂按 idleShellTtlMs 跟踪 lastUsedAt（每次 createSessionTools
 *   刷新），disposeIdleShells(now) 释放超 TTL 的会话 shell（懒重启：再建即新实例）；
 *   服务端经注入的 scheduleTick 每 idleSweepMs 调度（close 取消）。
 * - 会话删除即释放：disposeSession(id) 只释放该会话 shell（幂等）。
 * - /api/stats：{rssMb, heapMb, sessions, activeShells}（process.memoryUsage 单次采样）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJail } from '../../src/core/jail/index.js';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { Tool, ToolResult } from '../../src/core/loop/types.js';
import type { ToolCall } from '../../src/shared/session-types.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { PersistentShell } from '../../src/core/tools/shell.js';
import { createSessionToolsFactory } from '../../src/ui/server/deps.js';
import { BROKER_MAX_BYTES, BROKER_MAX_FRAMES, SessionBroker } from '../../src/ui/server/index.js';
import type { SseEventData } from '../../src/ui/server/emit.js';
import type { DevmateServer, DevmateServerDeps, TickHandle } from '../../src/ui/server/index.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import { canonicalTmpBase, pidEventuallyGone } from '../shell-tools/support.js';
import { postJson, SseClient, startServer } from './support.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function depsFor(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([echoTool()], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    ...extra,
  };
}

describe('ui/server：broker 缓冲上限', () => {
  it('b1a) 超过 5000 帧：裁最旧帧，后进回放只见最近窗口（顺序不坏）', async () => {
    const broker = new SessionBroker();
    for (let i = 0; i < BROKER_MAX_FRAMES + 1; i += 1) {
      broker.push({ event: 'assistant-delta', data: { text: `d${i}` } });
    }
    const it = broker.consume();
    const got: SseEventData[] = [];
    for (let i = 0; i < BROKER_MAX_FRAMES; i += 1) {
      const { value } = await it.next();
      got.push(value as SseEventData);
    }
    expect(got).toHaveLength(BROKER_MAX_FRAMES);
    expect((got[0]!.data as { text: string }).text).toBe('d1'); // 最旧 d0 已裁
    expect((got[BROKER_MAX_FRAMES - 1]!.data as { text: string }).text).toBe(
      `d${BROKER_MAX_FRAMES}`,
    );
  });

  it('b1b) 4MB 字节谓词（未到帧数上限也裁剪）：大帧以字节数为准', async () => {
    const broker = new SessionBroker();
    for (let i = 0; i < 6; i += 1) {
      broker.push({ event: 'assistant-delta', data: { text: `${'a'.repeat(1_000_000)}${i}` } });
    }
    const frames = await collectAll(broker, 4);
    // 每帧 ≈ 1MB：6 帧 ≈ 6MB > 4MB → 裁到 4 帧（恰 < 上限）
    expect(frames).toHaveLength(4);
    expect(((frames[0]!.data as { text: string }).text.match(/\d$/) ?? [])[0]).toBe('2'); // 最旧 0/1 已裁
    const widths = frames.map((f) => JSON.stringify(f).length);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(BROKER_MAX_BYTES);
  });
});

/** 收集 broker 前 N 帧（独立于测试的截断判断）。 */
async function collectAll(broker: SessionBroker, n: number): Promise<SseEventData[]> {
  const it = broker.consume();
  const got: SseEventData[] = [];
  for (let i = 0; i < n; i += 1) {
    const { value } = await it.next();
    got.push(value as SseEventData);
  }
  return got;
}

describe('ui/server：SSE 心跳清理', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  it('w1) 连接关闭后心跳定时器无残留：heartbeatMs=10、关闭后等 50ms 无后续写', async () => {
    const store = new MemorySessionAdapter();
    await store.create('hb-clean');
    const { base, server } = await startServer(depsFor({ store, heartbeatMs: 10 }));
    servers.push(server);

    const client = await SseClient.connect(base, 'hb-clean');
    clients.push(client);
    // 等到至少 2 个 ping（证明心跳在工作）
    const deadline = Date.now() + 2_000;
    while (client.pingCount < 2 && Date.now() < deadline) await sleep(10);
    expect(client.pingCount).toBeGreaterThanOrEqual(2);

    // 稳定窗口后快照，再关闭连接、等待 >5 个心跳间隔：无新 ping、无新帧
    await sleep(30);
    const pings = client.pingCount;
    const frames = client.frames.length;
    client.close();
    await sleep(60);
    expect(client.pingCount).toBe(pings);
    expect(client.frames).toHaveLength(frames);
  });
});

/** 假 shell 工厂产物：dispose 计时 + 执行中计数可视化（hold 让 execute 挂起）。 */
class FakeShell implements PersistentShell {
  disposed = 0;
  /** 执行中的 execute 数（入 +1/出 -1；对 TTL 判据测试可见）。 */
  executions = 0;
  readonly tool: Tool;

  constructor(
    readonly sessionId: string,
    private readonly hold: Promise<void> | undefined = undefined,
  ) {
    this.tool = {
      name: 'run_command',
      description: 'fake shell tool',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: (call) => this.runShell(call),
    };
  }

  /** 假执行：进入/退出计数（hold 时挂起，供在飞 TTL 判据测试）。 */
  private async runShell(_call: ToolCall): Promise<ToolResult> {
    this.executions += 1;
    try {
      if (this.hold !== undefined) await this.hold;
      return { ok: true, content: 'fake' };
    } finally {
      this.executions -= 1;
    }
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

async function makeFactory(
  idleShellTtlMs: number,
  hold?: Promise<void>,
): Promise<{
  factory: ReturnType<typeof createSessionToolsFactory>;
  created: FakeShell[];
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'devmate-idle-shell-'));
  const jail = await createJail({ workspaceRoot: dir });
  const created: FakeShell[] = [];
  const factory = createSessionToolsFactory({
    workspaceRoot: dir,
    jail,
    idleShellTtlMs,
    createShell: (sessionId: string) => {
      const shell = new FakeShell(sessionId, hold);
      created.push(shell);
      return shell;
    },
  });
  return { factory, created, dir };
}

describe('ui/server：shell 空闲释放（deps 工厂）', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      // win32：残留 shell 进程挂住目录/cwd → EBUSY（windows CI 实测）→ 重试屈从
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });

  // 注意：工厂构造不再预建 __fallback__ 壳（懒构建：首次访问 tools 才建；见 i5）——
  // 断言一律按 sessionId 过滤，不与兜底实例混计（本套件不访问 factory.tools）。
  const shellsOf = (created: FakeShell[], sessionId: string): FakeShell[] =>
    created.filter((s) => s.sessionId === sessionId);

  it('i1) TTL=50ms：未超时保留，两 tick（+10 / +100）后 dispose 恰一次；再 tick 幂等', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { factory, created, dir } = await makeFactory(50);
    tempDirs.push(dir);

    factory.createSessionTools('s-1'); // lastUsedAt=1_000_000
    expect(shellsOf(created, 's-1')).toHaveLength(1);
    await factory.disposeIdleShells(Date.now() + 10); // tick1：仅 10ms < TTL
    expect(shellsOf(created, 's-1')[0]!.disposed).toBe(0);

    await factory.disposeIdleShells(Date.now() + 100); // tick2：100ms > TTL → dispose
    expect(shellsOf(created, 's-1')[0]!.disposed).toBe(1);

    await factory.disposeIdleShells(Date.now() + 200); // tick3：幂等
    expect(shellsOf(created, 's-1')[0]!.disposed).toBe(1);
  });

  it('i2) dispose 后再次 createSessionTools：懒重建为新 shell 实例（干净重启语义）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { factory, created, dir } = await makeFactory(50);
    tempDirs.push(dir);

    const r1 = factory.createSessionTools('s-2');
    await factory.disposeIdleShells(Date.now() + 100);
    expect(shellsOf(created, 's-2')[0]!.disposed).toBe(1);
    const r2 = factory.createSessionTools('s-2');
    expect(shellsOf(created, 's-2')).toHaveLength(2); // 新实例
    expect(shellsOf(created, 's-2')[1]!.disposed).toBe(0);
    expect(r2).not.toBe(r1);
    // 新注册表含新 shell 的 run_command（懒重建为干净 shell）
    expect(r2.list().map((d) => d.name)).toEqual(expect.arrayContaining(['run_command']));
  });

  it('i3) disposeSession(id)：只释放该会话的 shell；幂等；activeShellCount 只含常驻实例', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const { factory, created, dir } = await makeFactory(50);
    tempDirs.push(dir);

    factory.createSessionTools('s-a');
    factory.createSessionTools('s-b');
    await factory.disposeSession('s-a');
    expect(shellsOf(created, 's-a')[0]!.disposed).toBe(1);
    expect(shellsOf(created, 's-b')[0]!.disposed).toBe(0);
    await factory.disposeSession('s-a'); // 幂等
    expect(shellsOf(created, 's-a')[0]!.disposed).toBe(1);
    // dispose 后 activeShellCount = 剩余常驻实例（__fallback__ 未访问不建：只 s-b）
    expect(factory.activeShellCount()).toBe(1);
    // dispose 后重建：新实例 + lastUsed 重新起算
    factory.createSessionTools('s-a');
    expect(shellsOf(created, 's-a')).toHaveLength(2);
    expect(factory.activeShellCount()).toBe(2);
  });

  it('i5) 构造即零实例（含 __fallback__）：stats 启动为 0；首次访问 tools 才懒建', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    const { factory, created, dir } = await makeFactory(50);
    tempDirs.push(dir);

    // 修复【幽灵 __fallback__】：构造不再预建兜底 shell（未 spawn 也不计数）
    expect(created).toHaveLength(0);
    expect(factory.activeShellCount()).toBe(0);

    const fallback = factory.tools; // 首次需要时才构建（懒）
    expect(created).toHaveLength(1);
    expect(created[0]!.sessionId).toBe('__fallback__');
    expect(factory.activeShellCount()).toBe(1);
    expect(factory.tools).toBe(fallback); // 幂等：同一实例
  });

  it('i6) 会话 shell 的 execute 也刷新 lastUsedAt（TTL 判据更精确）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const { factory, created, dir } = await makeFactory(50);
    tempDirs.push(dir);

    const reg = factory.createSessionTools('s-x'); // lastUsedAt=5_000_000
    vi.setSystemTime(5_000_070); // 已超 TTL（70 > 50；若只看 createSessionTools 判据已过期）
    await reg.execute({ id: 'c1', name: 'run_command', arguments: '{}' }); // execute 刷新
    await factory.disposeIdleShells(Date.now() + 30); // tick1：+30ms < TTL：不得 dispose
    expect(shellsOf(created, 's-x')[0]!.disposed).toBe(0);
    await factory.disposeIdleShells(Date.now() + 130); // tick2：+130ms > TTL → dispose
    expect(shellsOf(created, 's-x')[0]!.disposed).toBe(1);
  });

  it('i7) 在飞 execute 超过 TTL 也不回收：执行中的 shell 不被空闲扫掉（活跃 run 兜底）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_000_000);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { factory, created, dir } = await makeFactory(50, hold);
    tempDirs.push(dir);

    const reg = factory.createSessionTools('s-busy');
    const exec = reg.execute({ id: 'c1', name: 'run_command', arguments: '{}' });
    vi.setSystemTime(6_000_200); // execute 挂起 200ms > TTL
    await factory.disposeIdleShells(Date.now()); // 在飞：不得 dispose（误杀修复）
    expect(shellsOf(created, 's-busy')[0]!.disposed).toBe(0);
    release();
    await exec;
    await factory.disposeIdleShells(Date.now() + 20); // 执行结束 touch 刷新：+20 < TTL
    expect(shellsOf(created, 's-busy')[0]!.disposed).toBe(0);
    await factory.disposeIdleShells(Date.now() + 120); // 空闲超 TTL → dispose
    expect(shellsOf(created, 's-busy')[0]!.disposed).toBe(1);
  });
});

describe('ui/server：空闲清扫调度（服务端 tick）', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('i4) 注入调度器：按 idleSweepMs 注册 handler，两次 tick 各调 disposeIdleShells(Date.now())；close 取消', async () => {
    let captured: (() => void) | null = null;
    let cancelCount = 0;
    let intervalArg = 0;
    const scheduleTick = (handler: () => void, intervalMs: number): TickHandle => {
      captured = handler;
      intervalArg = intervalMs;
      return {
        cancel: () => {
          cancelCount += 1;
        },
      };
    };
    const disposeIdleShells = vi.fn(async (_now: number, _active?: ReadonlySet<string>) => {});
    const { base, server } = await startServer(
      depsFor({ scheduleTick, idleSweepMs: 250, disposeIdleShells }),
    );
    servers.push(server);

    expect(captured).toBeTypeOf('function');
    expect(intervalArg).toBe(250); // 服务端 tick 间隔 = deps.idleSweepMs（缺省 60s）
    expect(disposeIdleShells).not.toHaveBeenCalled(); // 注册不触发

    captured!(); // tick1
    captured!(); // tick2
    expect(disposeIdleShells).toHaveBeenCalledTimes(2);
    // tick 携带 activeRunSessions（TTL 误杀修复：活跃 run 会话由回收方跳过）
    expect(disposeIdleShells).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Set));

    await server.close();
    expect(cancelCount).toBe(1); // close 必须取消定时器

    // base 仅用于让测试有服务实例（不触发任何网络依赖）
    expect(base.startsWith('http://127.0.0.1')).toBe(true);
  });
});

describe('ui/server：/api/stats', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('s1) {rssMb, heapMb, sessions, activeShells}：一次内存采样 + 计数', async () => {
    const sessionLister = async () => [
      { sessionId: 's-1', title: 'a', createdAtMs: 1, lastEventMs: 2 },
      { sessionId: 's-2', title: 'b', createdAtMs: 3, lastEventMs: 4 },
      { sessionId: 's-3', title: 'c', createdAtMs: 5, lastEventMs: 6 },
    ];
    const activeShellCount = vi.fn(() => 2);
    const { base, server } = await startServer(depsFor({ sessionLister, activeShellCount }));
    servers.push(server);

    const res = await fetch(new URL('/api/stats', base));
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      rssMb: number;
      heapMb: number;
      sessions: number;
      activeShells: number;
    };
    expect(typeof stats.rssMb).toBe('number');
    expect(typeof stats.heapMb).toBe('number');
    expect(stats.rssMb).toBeGreaterThan(0);
    expect(stats.heapMb).toBeGreaterThan(0);
    expect(stats.sessions).toBe(3);
    expect(stats.activeShells).toBe(2);
    expect(activeShellCount).toHaveBeenCalledTimes(1);
  });
});

describe('ui/server：TTL 与活跃 run（真实 shell 集成）', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) {
      // win32：残留 shell 进程挂住目录/cwd → EBUSY（windows CI 实测）→ 重试屈从
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });

  /** 进程是否存活（kill 0 探测；ESRCH = 已死）。 */
  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForEvent(
    client: SseClient,
    event: string,
    timeoutMs = 8000,
  ): Promise<SseEventData> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = await client.next(deadline - Date.now());
      if (frame !== null && frame.event === event) return frame;
      if (frame === null) break;
    }
    throw new Error(`expected ${event} frame, none within ${timeoutMs}ms`);
  }

  it('i8) 活跃 run 期间 tick 不误杀（shell pid 存活）；run 结束空闲超时 dispose 后 pid 消失', async () => {
    // canonicalTmpBase：bash 长名拼写基址（win32 短/长名一致性；见该函数头注）
    const dir = await mkdtemp(join(canonicalTmpBase(), 'devmate-idle-live-'));
    tempDirs.push(dir);
    const jail = await createJail({ workspaceRoot: dir });
    // shellPlatform 'posix'：真实 createPersistentShell 走 bash 契约（win32 宿主经
    // PATH 解析 Git Bash bash.exe）；宿主缺省 win32→powershell 跑不了 $$/bash 语法。
    const factory = createSessionToolsFactory({
      workspaceRoot: dir,
      jail,
      idleShellTtlMs: 50,
      shellPlatform: 'posix',
    });
    let tick: (() => void) | null = null;

    const deps = depsFor({
      store: new MemorySessionAdapter(),
      // 工具面：真实 shell（默认 createPersistentShell）——审批自动放行（无 approval-request）
      approvalPolicy: () => false,
      llm: new FakeLlm([
        {
          content: '需要执行',
          toolCalls: [
            {
              id: 'call-1',
              name: 'run_command',
              // winpid：git-bash 的 $$ 是 MSYS 阴影 pid，Node process.kill 不可见；
              // /proc/$$/winpid 才是真实 Windows pid（posix 回落 $$）
              arguments: JSON.stringify({
                command: 'echo SHELL_PID=$(cat /proc/$$/winpid 2>/dev/null || echo $$); sleep 0.5',
              }),
            },
          ],
        },
        { content: '执行完成' },
      ]),
      createSessionTools: factory.createSessionTools,
      disposeSession: (sessionId: string) => factory.disposeSession(sessionId),
      // 服务端 tick 把 activeRunSessions 传给工厂（活跃 run 跳过回收）
      disposeIdleShells: (now: number, active?: ReadonlySet<string>) =>
        factory.disposeIdleShells(now, active),
      scheduleTick: (handler: () => void): TickHandle => {
        tick = handler;
        return {
          cancel: () => {
            tick = null;
          },
        };
      },
      idleSweepMs: 50,
    });
    const { base, server } = await startServer(deps);
    servers.push(server);

    const created = (await (await postJson(base, '/api/chat', { text: 'go' })).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    await waitForFrameWait(client, 3, 5000);
    client.drain();

    // run 活跃中：等待超过 TTL(50ms) 后 tick——旧实现按 lastUsedAt 判超时即误杀
    await sleep(70);
    tick!();
    tick!();
    expect(factory.activeShellCount()).toBe(1);

    // 等 run_command 结果 → 拿到真实 shell 主进程 pid
    let pid = 0;
    let sawRunStatus = false;
    for (;;) {
      const frame = await client.next(8000);
      expect(frame).not.toBeNull();
      if (frame!.event === 'tool-result') {
        const data = frame!.data as { content: string };
        const match = /SHELL_PID=(\d+)/.exec(data.content);
        if (match !== null) {
          pid = Number(match[1]);
          break;
        }
      }
      if (frame!.event === 'run-status' || frame!.event === 'run-error') {
        sawRunStatus = true;
        break;
      }
    }
    expect(pid, '工具结果应带回 shell pid').toBeGreaterThan(0);
    expect(pidAlive(pid), '活跃 run 期间 shell 进程必须存活').toBe(true);
    expect(factory.activeShellCount()).toBe(1);

    // run 结束（run-status 终态）→ 空闲超 TTL：tick → dispose → pid 消失
    if (!sawRunStatus) await waitForEvent(client, 'run-status');
    client.drain();
    await sleep(80); // 空闲 > TTL(50ms)
    tick!();
    expect(factory.activeShellCount()).toBe(0);
    expect(await pidEventuallyGone(pid)).toBe(true);
  });

  async function waitForFrameWait(
    client: SseClient,
    count: number,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (client.frames.length < count && Date.now() < deadline) {
      await client.next(deadline - Date.now());
    }
    if (client.frames.length < count) {
      throw new Error(`expected >=${count} frames, got ${client.frames.length}`);
    }
  }
});
