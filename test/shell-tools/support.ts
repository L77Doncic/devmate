/**
 * # test/shell-tools/support：常驻 Shell 测试脚手架——真实 jail + 临时工作区
 *
 * 安全口径（接缝 S8）：本模块的 jail 判定用**真实实现**（src/core/jail/index.js），
 * 安全测试是行为级验证：`cmd > 界外路径` 必须整命令被拒且不产生文件。
 *
 * 真进程策略：每个 fixture 起一个真实 bash（契约固定 bash 语义：platform 'posix'——
 * win32 宿主经 PATH 解析到 Git Bash 的 bash.exe 真跑 git-bash，见 src shell.ts
 * resolveShellBinary）；测试用时短命令；耗时命令（sleep/yes）一律以 fixture 的短
 * timeoutMs 兜底（睡眠进程被整组 SIGKILL）。fixture.dispose() 必须在每个测试末尾
 * 调用（afterEach 兜底）。
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
  /** 平台语义显式覆盖（缺省 'posix'：bash 契约，win32 宿主走 git-bash bash.exe）。 */
  platform?: 'posix' | 'win32';
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
    // 契约固定 bash 语义：win32 宿主经 PATH 解析 Git Bash bash.exe（git-bash 真跑）；
    // 宿主缺省（win32→powershell 探测链）由 platform.test.ts 的 win32 smoke 覆盖。
    platform: opts.platform ?? 'posix',
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

/**
 * 命令文本内嵌绝对路径的 shell 安全形态：win32 反斜杠→正斜杠（bash 词法里未引用
 * 的 `\` 是转义符，`C:\Users\...` 会把路径吃残；`C:/Users/...` 双平台一致）。
 * posix 路径原样（无反斜杠）。
 */
export function shellPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * shell 侧 `pwd`/`$PWD` 输出在宿主上的形态：win32（git-bash，MSYS 语义）为
 * /c/Users/...（盘符小写 + 正斜杠）；posix 原样。用于内容断言与 realpathSync 比对。
 */
export function shellCwdForm(p: string): string {
  if (process.platform !== 'win32') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m === null) return p;
  return `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
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
