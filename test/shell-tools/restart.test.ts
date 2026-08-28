/**
 * # 常驻 Shell 行为切片 d：shell 死亡（被外部 kill / 自杀）→ 自动重启
 *
 * 真进程验证：测试直接 SIGKILL 真实 shell 进程（系统级行为），
 * 下一条命令触发重启（重启懒发生：在下次执行时），结果注明状态丢失，
 * cwd 回 workspaceRoot。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { realpathSync } from 'node:fs';

import type { ShellFixture } from './support.js';
import { cleanupShellFixtures, makeShellFixture, payloadOf, run, shellCwdForm } from './support.js';
import type { ToolResult } from '../../src/core/loop/types.js';

let fx: ShellFixture;

beforeAll(async () => {
  fx = await makeShellFixture();
});

afterAll(async () => {
  await fx.dispose();
  cleanupShellFixtures();
});

/** 从工具侧拿到当前 shell 主进程 pid（$$ 展开为 shell 自身 pid），系统级 kill。 */
async function getShellPid(sessionId: string = fx.sessionId): Promise<number> {
  const r = await run(fx, 'echo "SHELL_PID:$$"', sessionId);
  expect(r.ok).toBe(true);
  const m = /SHELL_PID:(\d+)/.exec(r.content);
  expect(m, '输出应包含 shell pid').not.toBeNull();
  return Number(m![1]);
}

/** 系统级探测 pid 已死（ESRCH）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 击杀后运行直到观察到重启（信号送达时刻不可控，两种合法路径：
 * 击杀落在「写入前」→ 工具自主重开，本结果即带注记；落在「执行中」→ 本次报
 * shell-exited、下一条命令触发重启注记——工具侧两种都是「异常即重启」语义。
 */
async function runAfterKill(command: string, sessionId?: string): Promise<ToolResult> {
  for (let i = 0; i < 3; i += 1) {
    const r = await run(fx, command, sessionId);
    if (r.error?.type === 'shell-exited') continue; // 死亡注入在命令执行中：下一条触重启
    expect(r.ok).toBe(true);
    return r;
  }
  throw new Error('runAfterKill: no restart observed after killing the shell');
}

describe('d) 外部 kill 后自动重启（懒发生：下次执行时）', () => {
  it('kill -9 真实 shell 进程 → 下条命令触发重启：结果注明 shell restarted + cwd 回 workspaceRoot', async () => {
    const pid = await getShellPid();
    // 系统级击杀（行为级：工具本身不配合、不感知此击杀）
    process.kill(pid, 'SIGKILL');
    const r = await runAfterKill('pwd -P');
    expect(r.content).toContain('shell restarted');
    // git-bash（win32）下 pwd -P 输出 MSYS 形态 /c/... —— shellCwdForm 化再比
    expect(r.content).toContain(shellCwdForm(realpathSync(fx.ws)));
  });

  it('重启后得到全新 shell 进程：新 pid ≠ 旧 pid', async () => {
    const first = await getShellPid();
    process.kill(first, 'SIGKILL');
    const r = await runAfterKill('echo "SHELL_PID:$$"');
    const m = /SHELL_PID:(\d+)/.exec(r.content);
    expect(m).not.toBeNull();
    expect(Number(m![1])).not.toBe(first);
  });

  it('重启前 cd 出的目录状态丢失：重启后的 shell 从 workspaceRoot 出发', async () => {
    // 与上面用例独立的会话起点：先 cd 离开根目录，再杀，pwd 证明丢失
    await run(fx, 'cd /tmp');
    const pid = await getShellPid();
    process.kill(pid, 'SIGKILL');
    const r = await runAfterKill('pwd -P');
    expect(r.content).toContain(shellCwdForm(realpathSync(fx.ws)));
  });

  it('重启只影响本 session：parallel session 的 shell 进程未被波及', async () => {
    // session-b（独立 shell 实例）：先确保其已起、记下 pid
    await run(fx, 'pwd -P', 'parallel-b');
    const bPid = await getShellPid('parallel-b');
    const aPid = await getShellPid();
    expect(bPid).not.toBe(aPid);
    // 系统级击杀 session-a（不经过工具）→ a 死于下次命令时重启；b 的进程必须完好
    process.kill(aPid, 'SIGKILL');
    await runAfterKill('pwd -P');
    expect(isAlive(bPid)).toBe(true);
  });
});

describe('d) 命令中途 shell 死亡', () => {
  it('kill -9 $$（命令自杀 shell）：本次运行报 shell-exited（失败是普通消息），不崩进程', async () => {
    const r = await run(fx, 'kill -9 $$');
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('shell-exited');
    expect(payloadOf(r).error.type).toBe('shell-exited');
    // 工具自身不崩：后续命令正常
    const r2 = await run(fx, 'echo still-here');
    expect(r2.ok).toBe(true);
    expect(r2.content).toContain('[out] still-here');
  });

  it('命令中途死亡后：下一条命令正常执行（会话自愈）', async () => {
    const r = await run(fx, 'echo probe');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('[out] probe');
  });
});
