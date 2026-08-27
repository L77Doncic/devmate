/**
 * # test/shell-tools/support：常驻 Shell 测试脚手架——真实 jail + 临时工作区
 *
 * 安全口径（接缝 S8）：本模块的 jail 判定用**真实实现**（src/core/jail/index.js），
 * 安全测试是行为级验证：`cmd > 界外路径` 必须整命令被拒且不产生文件。
 *
 * 真进程策略：每个 fixture 起一个真实 bash；测试用时短命令；耗时命令
 * （sleep/yes）一律以 fixture 的短 timeoutMs 兜底（睡眠进程被整组 SIGKILL）。
 * fixture.dispose() 必须在每个测试末尾调用（afterEach 兜底）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJail } from '../../src/core/jail/index.js';
import type { Tool, ToolResult } from '../../src/core/loop/types.js';
import { createPersistentShell } from '../../src/core/tools/shell.js';
import type { ToolCall } from '../../src/shared/session-types.js';

export interface ShellFixture {
  /** 工作区根（jail 默认边界，也是 shell 初值 cwd）。 */
  ws: string;
  /** 兄弟目录（越界代表；不登记为 extraRoot）。 */
  outside: string;
  tool: Tool;
  sessionId: string;
  dispose: () => Promise<void>;
}

export interface FixtureOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const created: string[] = [];

export async function makeShellFixture(
  opts: FixtureOptions & { sessionId?: string } = {},
): Promise<ShellFixture> {
  const ws = mkdtempSync(join(tmpdir(), 'devmate-shell-ws-'));
  const outside = mkdtempSync(join(tmpdir(), 'devmate-shell-out-'));
  created.push(ws, outside);
  const jail = await createJail({ workspaceRoot: ws });
  const { tool, dispose } = createPersistentShell({
    workspaceRoot: ws,
    jail,
    timeoutMs: opts.timeoutMs ?? 5_000,
    ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
  });
  return {
    ws,
    outside,
    tool,
    sessionId: opts.sessionId ?? 'test-session',
    dispose,
  };
}

/** 执行一次 run_command（loop 契约形状：call + ctx.sessionId；timeoutMs 走模型可申请参数）。 */
export async function run(
  fx: ShellFixture,
  command: string,
  sessionId: string = fx.sessionId,
  timeoutMs?: number,
): Promise<ToolResult> {
  const call: ToolCall = {
    id: `call_${Math.random().toString(36).slice(2)}`,
    name: 'run_command',
    arguments: JSON.stringify(
      timeoutMs === undefined ? { command } : { command, timeout_ms: timeoutMs },
    ),
  };
  return fx.tool.execute(call, { sessionId });
}

/** 轮询等待 pid 从系统中消失（SIGKILL 送达后进程组退出有微秒级延迟）。 */
export async function pidEventuallyGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH：已不存在
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 借用 fs-tools 的做法：失败结果的回注载荷恒为合法 JSON（§4.4）。 */
export function payloadOf(result: ToolResult): {
  ok: boolean;
  error: Record<string, unknown>;
} {
  const payload = JSON.parse(result.content) as { ok: boolean; error: Record<string, unknown> };
  return payload;
}

/** 每文件 afterAll 兜底清理（临时目录 force 删除；shell 进程由 fixture.dispose 杀）。 */
export function cleanupShellFixtures(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
