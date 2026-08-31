import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildServerConfig,
  detectPlatformCmd,
  parseWebArgs,
  renderBanner,
  runWeb,
} from '../../src/cli/web.js';
import { mergeConfig } from '../../src/cli/config.js';
import type { RunWebIo, ServerConfig, ServerModule } from '../../src/cli/web.js';

/**
 * S14 CLI `web` 子命令规格：
 * - 参数解析纯函数：--port 1..65535、--workspace 存在性、--no-open、未知 flag 报错；
 * - 平台打开命令选择纯函数（darwin/win32/linux 分支，Linux 走 xdg-open||x-www-browser 探测）；
 * - runWeb 冒烟：注入假 ServerModule（不真监听），断言 assembleDeps 的 config、
 *   listen 端口、banner 输出、打开浏览器调用序列、Ctrl-C 后 close。
 */

const tmpHome = mkdtempSync(join(tmpdir(), 'devmate-web-'));

let tmpWork: string;
beforeEach(() => {
  tmpWork = mkdtempSync(join(tmpdir(), 'devmate-ws-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpWork, { recursive: true, force: true });
});

const isDir = (p: string) => existsSync(p);

describe('parseWebArgs：参数解析（纯函数，存在性校验注入）', () => {
  it('缺省值：port=0（自动分配）、workspace=cwd、noOpen=false', () => {
    const r = parseWebArgs([], { cwd: tmpWork, isDir });
    expect(r).toEqual({ ok: true, args: { port: 0, workspace: tmpWork, noOpen: false } });
  });

  it('--port 接受合法范围；非法值报错且不产生副作用', () => {
    const ok = parseWebArgs(['--port', '4321'], { cwd: tmpWork, isDir });
    expect(ok).toEqual({ ok: true, args: { port: 4321, workspace: tmpWork, noOpen: false } });

    for (const bad of ['0', '-1', '65536', 'abc', '1.5']) {
      const r = parseWebArgs(['--port', bad], { cwd: tmpWork, isDir });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toContain('--port');
    }
  });

  it('--workspace 校验目录存在性（不存在 → 报错；存在 → 保留）', () => {
    const ws = join(tmpWork, 'ws');
    mkdirSync(ws);
    const ok = parseWebArgs(['--workspace', ws], { cwd: tmpWork, isDir });
    expect(ok).toEqual({ ok: true, args: { port: 0, workspace: ws, noOpen: false } });

    const bad = parseWebArgs(['--workspace', join(tmpWork, 'nope')], { cwd: tmpWork, isDir });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain('workspace');
  });

  it('flag 组合：--no-open --port 8080 --workspace <dir>', () => {
    const r = parseWebArgs(['--no-open', '--port', '8080', '--workspace', tmpWork], {
      cwd: tmpWork,
      isDir,
    });
    expect(r).toEqual({ ok: true, args: { port: 8080, workspace: tmpWork, noOpen: true } });
  });

  it('未知 flag 报错', () => {
    const r = parseWebArgs(['--bogus'], { cwd: tmpWork, isDir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('--bogus');
  });
});

describe('detectPlatformCmd：跨平台打开命令选择（纯函数）', () => {
  it('darwin → open', () => {
    expect(detectPlatformCmd('darwin')).toEqual({ cmd: 'open', args: [] });
  });
  it('win32 → cmd /c start ""（URL 作为末位参数追加）', () => {
    expect(detectPlatformCmd('win32')).toEqual({ cmd: 'cmd', args: ['/c', 'start', ''] });
  });
  it('linux → xdg-open；不可用 → x-www-browser；都不可用 → null', () => {
    expect(detectPlatformCmd('linux', () => true)).toEqual({ cmd: 'xdg-open', args: [] });
    expect(detectPlatformCmd('linux', (c) => c === 'x-www-browser')).toEqual({
      cmd: 'x-www-browser',
      args: [],
    });
    expect(detectPlatformCmd('linux', () => false)).toBeNull();
  });
});

describe('renderBanner：中文启动横幅', () => {
  it('包含 地址/端口/工作区/模型 四要素与 Ctrl-C 提示', () => {
    const banner = renderBanner({ port: 4321, workspace: tmpWork, model: 'deepseek-v4-flash' });
    expect(banner).toContain('http://127.0.0.1:4321/');
    expect(banner).toContain(tmpWork);
    expect(banner).toContain('deepseek-v4-flash');
    expect(banner).toContain('Ctrl-C');
  });
});

describe('runWeb：启动冒烟（注入假 ServerModule，不真监听）', () => {
  function fakeModule(events: string[]): ServerModule {
    const server = {
      listen: vi.fn(async (port: number) => {
        events.push(`listen:${port}`);
        return { host: '127.0.0.1', port: 4321 };
      }),
      close: vi.fn(async () => {
        events.push('close');
      }),
    };
    return {
      assembleDeps: vi.fn(async (config: { workspaceRoot: string }) => {
        events.push(`assemble:${config.workspaceRoot}`);
        return { assembled: true };
      }),
      createDevmateServer: vi.fn((deps: unknown) => {
        events.push(`create:${String(typeof deps)}`);
        return server;
      }),
    };
  }

  function makeRuntime(events: string[], overrides: Partial<RunWebIo> = {}) {
    let onSignal: (() => void) | undefined;
    const rt: RunWebIo = {
      cwd: tmpWork,
      env: {},
      configPath: join(tmpHome, '.devmate', 'config.json'),
      platform: 'linux',
      isDir,
      findOnPath: () => true,
      openBrowser: vi.fn((url: string) => {
        events.push(`browser:${url}`);
      }),
      loadServerModule: async () => fakeModule(events),
      println: (line: string) => {
        events.push(`print:${line}`);
      },
      printErr: (line: string) => {
        events.push(`err:${line}`);
      },
      setSignalHandler: vi.fn((cb: () => void) => {
        onSignal = cb;
      }),
      ...overrides,
    };
    return {
      rt,
      fireSignal: () => {
        expect(onSignal).toBeTypeOf('function');
        onSignal!();
      },
    };
  }

  it('默认：listen(0) → banner 用真实端口 4321 → 打开浏览器 → 注册信号处理', async () => {
    const events: string[] = [];
    const { rt } = makeRuntime(events);
    const code = await runWeb([], rt);

    expect(code).toBe(0);
    expect(events).toContain(`assemble:${tmpWork}`);
    expect(events).toContain('create:object');
    expect(events).toContain('listen:0');
    const printed = events
      .filter((e) => e.startsWith('print:'))
      .map((e) => e.slice('print:'.length))
      .join('\n');
    expect(printed).toContain('http://127.0.0.1:4321/');
    expect(printed).toContain(tmpWork);
    expect(events).toContain('browser:http://127.0.0.1:4321/');
  });

  it('--port 8080 透传 listen(8080)；--no-open 不调 openBrowser', async () => {
    const events: string[] = [];
    const { rt } = makeRuntime(events);
    const code = await runWeb(['--no-open', '--port', '8080'], rt);
    expect(code).toBe(0);
    expect(events).toContain('listen:8080');
    expect(events.find((e) => e.startsWith('browser:'))).toBeUndefined();
  });

  it('解析失败 → printErr + 返回 1，不触碰 server', async () => {
    const events: string[] = [];
    const { rt } = makeRuntime(events);
    const code = await runWeb(['--port', 'bogus'], rt);
    expect(code).toBe(1);
    expect(events.some((e) => e.startsWith('err:'))).toBe(true);
    expect(events.find((e) => e.startsWith('listen:'))).toBeUndefined();
  });

  it('监听成功且已进入待命：Ctrl-C → close 恰好一次', async () => {
    const events: string[] = [];
    const { rt, fireSignal } = makeRuntime(events);
    await runWeb([], rt);
    events.length = 0;
    fireSignal();
    expect(events).toEqual(['close']);
  });

  it('SIGTERM 路径（VT-2 修复 a）：信号回调走完整关闭链——server.close → deps.dispose 恰一次（mcpLauncher/shell 释放）', async () => {
    const events: string[] = [];
    const dispose = vi.fn(async () => {
      events.push('dispose');
    });
    const server = {
      listen: vi.fn(async () => ({ host: '127.0.0.1', port: 4321 })),
      close: vi.fn(async () => {
        // 生产：server.close → deps.dispose（mcpLauncher.dispose + 常驻 shell 全清）
        events.push('close');
        await dispose();
      }),
    };
    const module: ServerModule = {
      assembleDeps: async () => ({ assembled: true }),
      createDevmateServer: vi.fn(() => server),
    };
    const { rt, fireSignal } = makeRuntime([], { loadServerModule: async () => module });
    await runWeb(['--no-open'], rt);
    events.length = 0;
    fireSignal(); // 生产接线把 SIGINT 与 SIGTERM 绑到同一回调（见 cli/index installGracefulSignals）
    expect(events).toEqual(['close', 'dispose']);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('设置读回种子：持久三键写盘 → 重启（同文件重读）→ assembleDeps 收到持久值；清键 → 键缺省不传', async () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    // 模拟上一进程 POST /api/settings 的持久化路径（mergeConfig 单点合并写）
    mergeConfig(configPath, {
      baseUrl: 'https://persist.example/v1',
      model: 'm1',
      reasoning: 'high',
      permission: 'read-only',
      windowTokens: 24_000,
    });
    const captured: Array<ServerConfig> = [];
    const module: ServerModule = {
      assembleDeps: async (config: ServerConfig) => {
        captured.push(config);
        return { assembled: true };
      },
      createDevmateServer: () => ({
        listen: async () => ({ host: '127.0.0.1', port: 4321 }),
        close: async () => undefined,
      }),
    };
    const { rt } = makeRuntime([], { loadServerModule: async () => module });

    await runWeb(['--no-open'], rt); // 启动 #1（读盘）
    await runWeb(['--no-open'], rt); // 启动 #2 = 重启：同文件重读
    expect(captured).toHaveLength(2);
    for (const cfg of captured) {
      expect(cfg).toMatchObject({
        baseUrl: 'https://persist.example/v1',
        model: 'm1',
        reasoning: 'high',
        permission: 'read-only',
        windowTokens: 24_000,
      });
    }

    // 清键（mergeConfig undefined = 删除键）→ 读回缺省：键不传（assembleDeps 回落各自缺省）
    mergeConfig(configPath, {
      reasoning: undefined,
      permission: undefined,
      windowTokens: undefined,
    });
    await runWeb(['--no-open'], rt);
    expect(captured).toHaveLength(3);
    const bare = captured[2]!;
    expect(Object.prototype.hasOwnProperty.call(bare, 'reasoning')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(bare, 'permission')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(bare, 'windowTokens')).toBe(false);
    expect(bare).toMatchObject({ baseUrl: 'https://persist.example/v1', model: 'm1' });
  });

  it('saveConfig 作为 persistSettings 传入 createDevmateServer（POST /api/settings 落盘）', async () => {
    let captured: Record<string, unknown> | null = null;
    const module: ServerModule = {
      assembleDeps: async () => ({ assembled: true }),
      createDevmateServer: vi.fn((deps: unknown) => {
        captured = deps as Record<string, unknown>;
        return {
          listen: async () => ({ host: '127.0.0.1', port: 4321 }),
          close: async () => undefined,
        };
      }),
    };
    const { rt } = makeRuntime([], { loadServerModule: async () => module });
    const code = await runWeb([], rt);
    expect(code).toBe(0);
    expect(captured).not.toBeNull();
    expect(captured!['persistSettings']).toBeTypeOf('function');

    // 模拟 POST /api/settings 的持久化调用：落盘到 configPath（0600；含 baseUrl/model/apiKey）
    const persist = captured!['persistSettings'] as (s: Record<string, unknown>) => void;
    persist({ baseUrl: 'https://persist.example/v1', model: 'm1', apiKey: 'sk-persist' });
    const configPath = join(tmpHome, '.devmate', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      baseUrl: 'https://persist.example/v1',
      model: 'm1',
      apiKey: 'sk-persist',
    });

    // 清空 apiKey（delete 语义）：持久化不含 apiKey 字段
    persist({ baseUrl: 'https://persist.example/v1', model: 'm1' });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      baseUrl: 'https://persist.example/v1',
      model: 'm1',
    });

    // 扩展设置键（reasoning/windowTokens/permission/permissionConfirmedAt）：快照携带即落盘，
    // 未携带的既有键保留（merge 语义——一次 POST 只写被触碰的键）
    persist({
      baseUrl: 'https://persist.example/v1',
      model: 'm1',
      reasoning: 'high',
      permission: 'full-access',
      permissionConfirmedAt: 424242,
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      baseUrl: 'https://persist.example/v1',
      model: 'm1',
      reasoning: 'high',
      permission: 'full-access',
      permissionConfirmedAt: 424242,
    });
  });
});

describe('buildServerConfig：任务书 config 形状（交付给 assembleDeps）', () => {
  it('workspaceRoot/baseUrl/model/apiKey + 可选 maxSteps（护栏键不入 ServerConfig）', () => {
    const cfg = buildServerConfig({
      workspaceRoot: '/ws',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-x',
      maxSteps: 4,
    });
    expect(cfg).toEqual({
      workspaceRoot: '/ws',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-x',
      maxSteps: 4,
    });
    expect(cfg).not.toHaveProperty('costLimitUsd');
  });

  it('无 apiKey 时属性缺省（exactOptionalPropertyTypes：不输出 undefined）', () => {
    const cfg = buildServerConfig({
      workspaceRoot: '/ws',
      baseUrl: 'https://x',
      model: 'm',
    });
    expect(Object.prototype.hasOwnProperty.call(cfg, 'apiKey')).toBe(false);
  });

  it('设置读回三键透传（reasoning/permission/windowTokens）；未提供 → 键缺省不落', () => {
    const cfg = buildServerConfig({
      workspaceRoot: '/ws',
      baseUrl: 'https://x',
      model: 'm',
      reasoning: 'high',
      permission: 'full-access',
      windowTokens: 24_000,
    });
    expect(cfg).toMatchObject({
      workspaceRoot: '/ws',
      baseUrl: 'https://x',
      model: 'm',
      reasoning: 'high',
      permission: 'full-access',
      windowTokens: 24_000,
    });
    const bare = buildServerConfig({ workspaceRoot: '/ws', baseUrl: 'https://x', model: 'm' });
    expect(Object.prototype.hasOwnProperty.call(bare, 'reasoning')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(bare, 'permission')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(bare, 'windowTokens')).toBe(false);
  });
});
