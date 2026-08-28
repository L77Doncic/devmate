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

import { mkdtempSync, symlinkSync } from 'node:fs';
import { join, win32 as pathWin32 } from 'node:path';
import { tmpdir } from 'node:os';

import type { ToolCall } from '../../src/shared/session-types.js';
import type { ShellFixture } from './support.js';
import { cleanupShellFixtures, makeShellFixture, run } from './support.js';
import {
  createPersistentShell,
  normalizeGitBashCwd,
  rebaseTrackedCwd,
  resolveShellBinary,
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

describe('h) resolveShellBinary：PATH 逐段解析 bash（windows CI 修复核心，纯函数）', () => {
  /** 目录簿注入：真机 Windows 路径在 Linux 宿主上不存在——由注入谓词替代 FS 探测。 */
  function catalogOf(paths: string[]): (candidate: string) => boolean {
    const set = new Set(paths);
    return (candidate) => set.has(candidate);
  }

  it('posix PATH 命中 /usr/bin/bash（逐段扫，不硬编码 /bin/bash）', () => {
    expect(
      resolveShellBinary({ PATH: '/usr/bin:/bin' }, 'posix', catalogOf(['/usr/bin/bash'])),
    ).toBe('/usr/bin/bash');
  });

  it('win32 PATH 命中 Git Bash 的 bash.exe（bash.exe 优先于裸名 bash）', () => {
    expect(
      resolveShellBinary(
        { PATH: 'C:\\Windows\\system32;C:\\Program Files\\Git\\usr\\bin' },
        'win32',
        catalogOf(['C:\\Program Files\\Git\\usr\\bin\\bash.exe']),
      ),
    ).toBe('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  });

  it('win32：目录里只有裸名 bash 也命中（无 .exe 后缀场景）', () => {
    expect(
      resolveShellBinary(
        { PATH: 'C:\\opt\\msys;C:\\Windows' },
        'win32',
        catalogOf(['C:\\Windows\\bash']),
      ),
    ).toBe('C:\\Windows\\bash');
  });

  it('未命中回退：posix → /bin/bash（原字面量语义）；win32 → git-bash（原 spawn 名）', () => {
    expect(resolveShellBinary({ PATH: '/usr/local/bin:/opt/bin' }, 'posix', catalogOf([]))).toBe(
      '/bin/bash',
    );
    expect(resolveShellBinary({ PATH: 'C:\\Windows' }, 'win32', catalogOf([]))).toBe('git-bash');
  });

  it('PATH 逐段：靠前段有名字但非文件 → 继续扫后段；引号段剥除', () => {
    expect(
      resolveShellBinary(
        { PATH: '"C:\\no-such-bash";C:\\real\\usr\\bin' },
        'win32',
        catalogOf(['C:\\real\\usr\\bin\\bash.exe']),
      ),
    ).toBe('C:\\real\\usr\\bin\\bash.exe');
  });

  it('PATH 缺失/空 → 回退', () => {
    expect(resolveShellBinary({}, 'posix', catalogOf([]))).toBe('/bin/bash');
    expect(resolveShellBinary({ PATH: '' }, 'win32', catalogOf([]))).toBe('git-bash');
  });
});

describe('h) normalizeGitBashCwd：git-bash MSYS 形态 → 宿主形态（纯函数）', () => {
  it('/c/Users/x → C:/Users/x（盘符大写 + 正斜杠）', () => {
    expect(normalizeGitBashCwd('/c/Users/x')).toBe('C:/Users/x');
    expect(normalizeGitBashCwd('/d/prog/test')).toBe('D:/prog/test');
  });

  it('非 MSYS 形态原样：win32 反斜杠 / 正斜杠盘符 / 纯 posix 路径', () => {
    expect(normalizeGitBashCwd('C:\\Users\\x')).toBe('C:\\Users\\x');
    expect(normalizeGitBashCwd('C:/Users/x')).toBe('C:/Users/x');
    expect(normalizeGitBashCwd('/tmp/foo')).toBe('/tmp/foo');
    expect(normalizeGitBashCwd('/c:/x')).toBe('/c:/x'); // '/C:' 不是盘符前缀形态（无 / 紧跟）
  });

  it('根与单段形态', () => {
    expect(normalizeGitBashCwd('/c/')).toBe('C:/');
    expect(normalizeGitBashCwd('/c')).toBe('/c');
  });
});

describe('h) rebaseTrackedCwd：git-bash 长名 $PWD → workspaceRoot 字面拼写（win32 重定向误拦修复，纯函数）', () => {
  // windows CI 实测根因：git-bash 的 $PWD 恒报长名（C:\Users\runneradmin\...），
  // Node 侧 workspaceRoot 保有 8.3 短名（C:\Users\RUNNER~1\...，镜像 TMP）——
  // 同一目录两种拼写，相对重定向目标按 trackedCwd 拼绝对后与 jail 边界比对必
  // 「字面越界」（`> ./out.txt` 界内被误拦）。rebaseTrackedCwd 把 cwd 重拼到
  // workspaceRoot 字面下，边界拼写归一（本组为纯函数注入测试，跨宿主可跑）。
  const WS_SHORT = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\devmate-shell-ws-1';
  const WS_LONG = 'C:/Users/runneradmin/AppData/Local/Temp/devmate-shell-ws-1';

  it('首个标记（anchor=null）：$PWD 长名 → anchor；cwd 落回 workspaceRoot 字面', () => {
    const r = rebaseTrackedCwd(WS_LONG, null, WS_SHORT, 'win32');
    expect(r.anchor).toBe(WS_LONG);
    expect(r.cwd).toBe(pathWin32.normalize(WS_SHORT));
  });

  it('后续 cd 子目录：相对部分拼回 workspaceRoot 字面 → 界内相对重定向不再误拦', () => {
    const r = rebaseTrackedCwd(`${WS_LONG}/sub-keep`, WS_LONG, WS_SHORT, 'win32');
    expect(r.cwd).toBe(pathWin32.normalize(`${WS_SHORT}\\sub-keep`));
    // 重定向目标形态：echo hi > ./out.txt 按重拼 cwd 拼绝对 → 落在边界（短名拼写）内
    const resolved = pathWin32.normalize(pathWin32.join(r.cwd, 'out.txt'));
    expect(resolved).toBe(pathWin32.normalize(`${WS_SHORT}\\sub-keep\\out.txt`));
    expect(
      pathWin32
        .resolve(resolved)
        .toLowerCase()
        .startsWith(pathWin32.resolve(WS_SHORT).toLowerCase()),
    ).toBe(true);
  });

  it('cwd 在 anchor 外（cd /tmp）：保留原值不重拼（目标本就界外，保守拦截方向正确）', () => {
    const r = rebaseTrackedCwd('/tmp', WS_LONG, WS_SHORT, 'win32');
    expect(r.cwd).toBe('/tmp');
    expect(r.anchor).toBe(WS_LONG);
  });

  it('大小写不敏感前缀命中（win32）：盘符/段大小写差异仍重拼（长度一致的分量替换）', () => {
    const r = rebaseTrackedCwd(
      'C:/USERS/RUNNERADMIN/AppData/Local/Temp/devmate-shell-ws-1/sub',
      WS_LONG,
      WS_SHORT,
      'win32',
    );
    expect(r.cwd.toLowerCase()).toBe(pathWin32.normalize(`${WS_SHORT}\\sub`).toLowerCase());
  });

  it('workspaceRoot 本身长名（大多数用户机器）：重拼后仍等于长名拼写（幂等不毁形）', () => {
    const r = rebaseTrackedCwd(`${WS_LONG}/sub`, WS_LONG, WS_LONG, 'win32');
    expect(r.cwd).toBe(pathWin32.normalize(`${WS_LONG}\\sub`));
  });

  it('posix：原样返回、不建立 anchor（无拼写别名问题）', () => {
    expect(rebaseTrackedCwd('/home/u/ws', null, '/home/u/ws', 'posix')).toEqual({
      cwd: '/home/u/ws',
      anchor: null,
    });
  });
});

describe('h) 平台注入强制（与 S9 同法）', () => {
  // Windows 宿主上 win32 平台构造是合法路径（不抛）——约束只在非 win32 宿主触发；
  // 若在 Windows 宿主上跑本用例会误红（toThrow 期望落空），按宿主跳过。
  it.skipIf(process.platform === 'win32')(
    'win32 平台在非 Windows 宿主构造 → 抛错（不启用未验证分支）',
    async () => {
      const jail = {
        checkPath: () => Promise.resolve(true),
        checkRedirect: () => Promise.resolve(true),
      } as unknown as Jail;
      expect(() =>
        createPersistentShell({ workspaceRoot: fx.ws, jail, platform: 'win32' }),
      ).toThrow();
    },
  );

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

// 复现 windows CI 崩溃路径的宿主验证（Linux 可跑）：把 bash 以一个非标准 PATH 段
// 里的名字放上 PATH（模拟 Git Bash 只把 usr/bin 挂进 PATH 的场景），platform 'posix'
// 下持久 shell 必须经 PATH 解析成功拉起并执行（旧实现硬编码 /bin/bash 起不来）。
// win32 专用名字顺序（bash.exe 优先）由上方注入谓词的纯函数用例覆盖；真机 Git Bash
// 的 bash.exe 解析由 windows-latest CI 实测。
describe.skipIf(process.platform === 'win32')(
  'h) PATH 解析复现验证：bash 在 PATH 前缀目录 → resolve → spawn 可达',
  () => {
    it('resolveShellBinary 命中 PATH 段绝对路径；经其拉起的持久 shell 正常执行命令', async () => {
      const binDir = mkdtempSync(join(tmpdir(), 'devmate-bashpath-'));
      symlinkSync('/bin/bash', join(binDir, 'bash')); // 非标准 PATH 段里的 bash
      const jail = {
        checkPath: () => Promise.resolve({ allowed: true }),
        checkRedirect: () => Promise.resolve({ allowed: true }),
      } as unknown as Jail;
      expect(resolveShellBinary({ PATH: binDir }, 'posix')).toBe(join(binDir, 'bash'));
      const api = createPersistentShell({
        workspaceRoot: fx.ws,
        jail,
        platform: 'posix',
        env: { PATH: binDir }, // PATH 覆盖：只此一段，必须命中 PATH 解析才能起
      });
      const r = await api.tool.execute(
        {
          id: 'call_bashpath',
          name: 'run_command',
          arguments: JSON.stringify({ command: 'echo hi-from-bashpath' }),
        },
        { sessionId: 'bashpath' },
      );
      expect(r.ok).toBe(true);
      expect(r.content).toContain('[out] hi-from-bashpath');
      await api.dispose();
    });
  },
);

// Windows 宿主上的最小 smoke（当前 Linux CI 不执行——分支实现未在 Windows 验证，如实记录）
describe.skipIf(process.platform !== 'win32')('h) Windows 端到端（仅在 Windows 宿主启用）', () => {
  it('git-bash 分支下 echo 正常回传（fixture 固定 posix 契约 → PATH 解析 bash.exe）', async () => {
    const r = await run(fx, 'echo hi-from-win');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('hi-from-win');
  });
});
