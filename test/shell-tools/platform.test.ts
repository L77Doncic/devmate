/**
 * # 常驻 Shell 行为切片 h：平台策略
 *
 * 覆盖策略声明（坦白）：
 * - win32 主进程分支只在 Windows 宿主启用（构造器强制，与 S9 同法：非宿主平台
 *   注入直接被拒绝）；Linux CI 上 win32 的 **纯函数** 逻辑（shell 探测顺序、
 *   命令负载构造）全部可测并在此覆盖；win32 端到端（真实 child_process 路径）
 *   需要 Windows 宿主，本文件提供 skipIf(非 win32) 的 smoke 用例，当前 CI 上
 *   不执行（如实记录为「未在 Windows 上验证」）。
 * - posix 分支在 Linux 宿主上全量行为测试（其余 test/shell-tools 文件）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ToolCall } from '../../src/shared/session-types.js';
import type { ShellFixture } from './support.js';
import { cleanupShellFixtures, makeShellFixture, run } from './support.js';
import {
  createPersistentShell,
  selectWindowsShell,
  spawnFailureType,
} from '../../src/core/tools/shell.js';
import type { Jail } from '../../src/core/jail/index.js';

let fx: ShellFixture;

beforeAll(async () => {
  fx = await makeShellFixture();
});

afterAll(async () => {
  await fx.dispose();
  cleanupShellFixtures();
});

describe('h) Windows shell 探测顺序（纯函数）', () => {
  it('powershell.exe 优先：全可用时选 powershell.exe（命中即止，不探测后续）', () => {
    const calls: string[] = [];
    const chosen = selectWindowsShell((name) => {
      calls.push(name);
      return true;
    });
    expect(chosen).toBe('powershell.exe');
    expect(calls.join(',')).toBe('powershell.exe');
  });

  it('powershell 缺失 → cmd.exe（第二位）', () => {
    const chosen = selectWindowsShell((name) => name === 'cmd.exe');
    expect(chosen).toBe('cmd.exe');
  });

  it('powershell/cmd 缺失 → git-bash（第三位）', () => {
    const chosen = selectWindowsShell((name) => name === 'git-bash');
    expect(chosen).toBe('git-bash');
  });

  it('全部缺失 → null（启动失败路径，不猜测）', () => {
    expect(selectWindowsShell(() => false)).toBeNull();
  });
});

describe('h) 平台注入强制（与 S9 同法）', () => {
  it('win32 平台在非 Windows 宿主构造 → 抛错（不启用未验证分支）', async () => {
    const jail = {
      checkPath: () => Promise.resolve(true),
      checkRedirect: () => Promise.resolve(true),
    } as unknown as Jail;
    expect(() =>
      createPersistentShell({ workspaceRoot: fx.ws, jail, platform: 'win32' }),
    ).toThrow();
  });

  it('posix 平台显式声明：Linux 宿主可构造', async () => {
    const jail = {
      checkPath: () => Promise.resolve(true),
      checkRedirect: () => Promise.resolve(true),
    } as unknown as Jail;
    const api = createPersistentShell({ workspaceRoot: fx.ws, jail, platform: 'posix' });
    await api.dispose();
  });
});

describe('h) 进程启动失败路径：一律普通 ToolResult，不击穿队列', () => {
  function allowJail(): Jail {
    return {
      checkPath: () => Promise.resolve({ allowed: true }),
      checkRedirect: () => Promise.resolve({ allowed: true }),
    } as unknown as Jail;
  }

  function call(command: string): ToolCall {
    return {
      id: `call_${Math.random().toString(36).slice(2)}`,
      name: 'run_command',
      arguments: JSON.stringify({ command }),
    };
  }

  it('spawn 同步异常（cwd 含 NUL）→ shell-spawn-failed 普通结果（execute 不抛）', async () => {
    const api = createPersistentShell({
      workspaceRoot: '/tmp/devmate\0bad-cwd',
      jail: allowJail(),
      platform: 'posix',
    });
    const r = await api.tool.execute(call('echo hi'), { sessionId: 'bad-cwd' });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('shell-spawn-failed');
    // 队列未被击穿：再次调用同样返回普通结果（无未处理拒绝）
    const r2 = await api.tool.execute(call('echo hi'), { sessionId: 'bad-cwd' });
    expect(r2.ok).toBe(false);
    expect(r2.error?.type).toBe('shell-spawn-failed');
    await api.dispose();
  });

  it('spawnFailureType 纯函数：win32 无 shell → shell-unavailable；其它错误 → shell-spawn-failed', () => {
    expect(
      spawnFailureType(
        new Error('shell: no Windows shell available (powershell/cmd/git-bash all missing)'),
      ),
    ).toBe('shell-unavailable');
    expect(spawnFailureType(new TypeError('bad cwd'))).toBe('shell-spawn-failed');
    expect(spawnFailureType('cwd with a NUL byte')).toBe('shell-spawn-failed');
  });
});

// Windows 宿主上的最小 smoke（当前 Linux CI 不执行——分支实现未在 Windows 验证，如实记录）
describe.skipIf(process.platform !== 'win32')('h) Windows 端到端（仅在 Windows 宿主启用）', () => {
  it('powershell 分支下 echo 正常回传', async () => {
    const r = await run(fx, 'echo hi-from-win');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('hi-from-win');
  });
});
