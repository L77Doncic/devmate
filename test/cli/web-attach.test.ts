import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWeb } from '../../src/cli/web.js';
import type { RunWebIo, ServerModule } from '../../src/cli/web.js';
import { saveConfig } from '../../src/cli/config.js';
import { clampMaxParallel } from '../../src/shared/workflow.js';

/**
 * S14 CLI `web` attach 模式（新增）：createDevmateServer 的 deps 叠加
 * - 三个落盘回调 saveSkillsConfig / saveWorkflow / saveMcpConfig（→ mergeConfig 单点合并写）；
 * - 三节初值 workflow（归一 0-8：0 = 无上限）/ skillsRecord（缺省 {}）/ mcpServers（缺省 []）。
 * 初值来源 config.json（loadStoredConfig）；损坏 JSON 走 ConfigError 路径（不回归）。
 */

const tmpHome = mkdtempSync(join(tmpdir(), 'devmate-attach-'));

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** attach 后 deps 的消费形状（服务端 DevmateServerDeps 的相关子集）。 */
interface AttachedDeps {
  persistSettings: (s: { baseUrl: string; model: string; apiKey?: string }) => void;
  saveSkillsConfig: (skills: Record<string, boolean>) => void;
  saveWorkflow: (workflow: { subagentsEnabled?: boolean; maxParallel?: number }) => void;
  saveMcpConfig: (
    servers: Array<{ name: string; command: string; args: string[]; enabled: boolean }>,
  ) => void;
  saveWorkspaces: (roots: string[]) => void;
  workspaces: string[];
  workflow: { subagentsEnabled: boolean; maxParallel: number };
  skillsRecord: Record<string, boolean>;
  mcpServers: Array<{ name: string; command: string; args: string[]; enabled: boolean }>;
}

interface Captured {
  deps: unknown;
  events: string[];
  onSignal: (() => void) | undefined;
}

function makeIo(
  configPath: string,
  captured: Captured,
  moduleOverrides: Partial<ServerModule> = {},
): RunWebIo {
  const server = {
    listen: async (port?: number) => {
      captured.events.push(`listen:${port}`);
      return { host: '127.0.0.1', port: 4321 };
    },
    close: async () => {
      captured.events.push('close');
    },
  };
  return {
    cwd: '/ws',
    env: {},
    configPath,
    platform: 'linux',
    isDir: () => true,
    findOnPath: () => true,
    openBrowser: () => {
      captured.events.push('browser');
    },
    loadServerModule: async () => ({
      assembleDeps: async () => ({ assembled: true }),
      createDevmateServer: (deps: unknown) => {
        captured.deps = deps;
        return server;
      },
      ...moduleOverrides,
    }),
    println: (line) => {
      captured.events.push(`print:${line}`);
    },
    printErr: (line) => {
      captured.events.push(`err:${line}`);
    },
    setSignalHandler: (cb: () => void) => {
      captured.onSignal = cb;
    },
  };
}

function depsOf(captured: Captured): AttachedDeps {
  return captured.deps as AttachedDeps;
}

function readConfig(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
}

describe('runWeb attach 模式：三节初值缺省（首次无配置）', () => {
  it('a1) 初值 = 缺省：workflow true/2、skillsRecord {}（全开）、mcpServers []；回调已注入', async () => {
    const captured: Captured = { deps: undefined, events: [], onSignal: undefined };
    const configPath = join(tmpHome, '.devmate', 'config.json');
    const code = await runWeb(['--no-open'], makeIo(configPath, captured));
    expect(code).toBe(0);

    const deps = depsOf(captured);
    expect(deps.workflow).toEqual({ subagentsEnabled: true, maxParallel: 2 });
    expect(deps.skillsRecord).toEqual({}); // 开关表为空 = 全开（服务端 enabled 缺省 true）
    expect(deps.mcpServers).toEqual([]);
    expect(deps.workspaces).toEqual(['/ws']); // 缺省 = [workspace]（--workspace 传入值）
    expect(deps.persistSettings).toBeTypeOf('function');
    expect(deps.saveSkillsConfig).toBeTypeOf('function');
    expect(deps.saveWorkflow).toBeTypeOf('function');
    expect(deps.saveMcpConfig).toBeTypeOf('function');
    expect(deps.saveWorkspaces).toBeTypeOf('function');

    // saveSkillsConfig({tdd:false}) → skills 节落盘（configPath == RunWebIo.configPath）
    deps.saveSkillsConfig({ tdd: false });
    expect(readConfig(configPath)).toEqual({ skills: { tdd: false } });
    expect(join(tmpHome, '.devmate', 'config.json')).toBe(configPath);
  });

  it('a1b) workspaces 初值读回（config.json workspaces 节）：注入 deps.workspaces；saveWorkspaces 全量整节替换落盘且其余键保留', async () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    saveConfig(configPath, {
      workspaces: ['/ws-a', '/ws-b'],
      skills: { tdd: false },
      baseUrl: 'https://keep/v1',
    });
    const captured: Captured = { deps: undefined, events: [], onSignal: undefined };
    const code = await runWeb(['--no-open'], makeIo(configPath, captured));
    expect(code).toBe(0);
    expect(depsOf(captured).workspaces).toEqual(['/ws-a', '/ws-b']);

    // 全量快照整节替换（以服务端为准；已删根不复活——同 mcp 语义）
    depsOf(captured).saveWorkspaces(['/ws-b', '/ws-c']);
    expect(readConfig(configPath)).toEqual({
      workspaces: ['/ws-b', '/ws-c'],
      skills: { tdd: false },
      baseUrl: 'https://keep/v1',
    });
  });

  it('a2) 初值加载：workflow maxParallel 归一 0-8（9→8、-1→0、7 保留）；0 = 无上限保留；skills/mcp 原样注入', async () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    saveConfig(configPath, {
      workflow: { subagentsEnabled: false, maxParallel: 7 },
      skills: { tdd: false },
      mcp: [{ name: 'fs', command: 'npx', args: ['-y', '@x/fs'], enabled: false }],
    });

    const captured: Captured = { deps: undefined, events: [], onSignal: undefined };
    const code = await runWeb(['--no-open'], makeIo(configPath, captured));
    expect(code).toBe(0);
    // 7 ∈ 1-8：原样保留（不再是旧的「>4 → 4」夹紧口径）
    expect(depsOf(captured).workflow).toEqual({ subagentsEnabled: false, maxParallel: 7 });
    expect(depsOf(captured).skillsRecord).toEqual({ tdd: false });
    expect(depsOf(captured).mcpServers).toEqual([
      { name: 'fs', command: 'npx', args: ['-y', '@x/fs'], enabled: false },
    ]);

    saveConfig(configPath, { workflow: { subagentsEnabled: true, maxParallel: 9 } });
    const second: Captured = { deps: undefined, events: [], onSignal: undefined };
    await runWeb(['--no-open'], makeIo(configPath, second));
    expect(depsOf(second).workflow).toEqual({ subagentsEnabled: true, maxParallel: 8 });

    saveConfig(configPath, { workflow: { subagentsEnabled: true, maxParallel: -1 } });
    const third: Captured = { deps: undefined, events: [], onSignal: undefined };
    await runWeb(['--no-open'], makeIo(configPath, third));
    expect(depsOf(third).workflow).toEqual({ subagentsEnabled: true, maxParallel: 0 });

    saveConfig(configPath, { workflow: { subagentsEnabled: false, maxParallel: 0 } });
    const fourth: Captured = { deps: undefined, events: [], onSignal: undefined };
    await runWeb(['--no-open'], makeIo(configPath, fourth));
    expect(depsOf(fourth).workflow).toEqual({ subagentsEnabled: false, maxParallel: 0 });
  });
});

describe('runWeb attach 模式：落盘回调（merge 单点）', () => {
  it('b1) saveWorkflow 透传不归一：越界 0/7 原样落盘（归一属服务端 POST 400，CLI 只透传）', async () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    const captured: Captured = { deps: undefined, events: [], onSignal: undefined };
    await runWeb(['--no-open'], makeIo(configPath, captured));
    const deps = depsOf(captured);

    deps.saveWorkflow({ subagentsEnabled: true, maxParallel: 7 });
    expect(readConfig(configPath).workflow).toEqual({ subagentsEnabled: true, maxParallel: 7 });
    deps.saveWorkflow({ subagentsEnabled: false, maxParallel: 0 });
    expect(readConfig(configPath).workflow).toEqual({ subagentsEnabled: false, maxParallel: 0 });
  });

  it('b2) mcp 添加/开关轮换：saveMcpConfig 全量快照替换 mcp 节；skills 节保留', async () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    const captured: Captured = { deps: undefined, events: [], onSignal: undefined };
    await runWeb(['--no-open'], makeIo(configPath, captured));
    const deps = depsOf(captured);
    const fs = { name: 'fs', command: 'npx', args: ['-y', '@x/fs'], enabled: true };
    const code = { name: 'code', command: 'code', args: ['--mcp'], enabled: true };

    deps.saveSkillsConfig({ tdd: false });
    deps.saveMcpConfig([fs]);
    expect(readConfig(configPath)).toEqual({ skills: { tdd: false }, mcp: [fs] });

    // 添加第二个服务器（全量快照：fs 开关轮换为 false，code 新增）
    deps.saveMcpConfig([{ ...fs, enabled: false }, code]);
    expect(readConfig(configPath)).toEqual({
      skills: { tdd: false },
      mcp: [{ ...fs, enabled: false }, code],
    });

    // 再轮换回来：文件反映最新清单；skills 节不变
    deps.saveMcpConfig([fs, { ...code, enabled: false }]);
    expect(readConfig(configPath)).toEqual({
      skills: { tdd: false },
      mcp: [fs, { ...code, enabled: false }],
    });
  });

  it('b3) persistSettings 走同一 merge 单点：apiKey 清空删除该键、maxSteps/skills 等保留', async () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    saveConfig(configPath, {
      baseUrl: 'https://old/v1',
      model: 'old-model',
      apiKey: 'sk-old',
      maxSteps: 5,
      skills: { tdd: false },
    });
    const captured: Captured = { deps: undefined, events: [], onSignal: undefined };
    await runWeb(['--no-open'], makeIo(configPath, captured));
    const deps = depsOf(captured);

    deps.persistSettings({ baseUrl: 'https://new/v1', model: 'new-model', apiKey: 'sk-new' });
    expect(readConfig(configPath)).toEqual({
      baseUrl: 'https://new/v1',
      model: 'new-model',
      apiKey: 'sk-new',
      maxSteps: 5,
      skills: { tdd: false },
    });

    // apiKey 缺省（undefined）= 清空该键；既有键保留
    deps.persistSettings({ baseUrl: 'https://new/v1', model: 'new-model' });
    expect(readConfig(configPath)).toEqual({
      baseUrl: 'https://new/v1',
      model: 'new-model',
      maxSteps: 5,
      skills: { tdd: false },
    });
  });

  it('b4) 三个回调连续修改：各自节独立、其余键保留（端到端 merge 单点）', async () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    saveConfig(configPath, { baseUrl: 'https://keep/v1', model: 'keep-model', maxSteps: 8 });
    const captured: Captured = { deps: undefined, events: [], onSignal: undefined };
    await runWeb(['--no-open'], makeIo(configPath, captured));
    const deps = depsOf(captured);

    deps.saveSkillsConfig({ tdd: false });
    expect(readConfig(configPath)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'keep-model',
      maxSteps: 8,
      skills: { tdd: false },
    });
    deps.saveWorkflow({ subagentsEnabled: false, maxParallel: 3 });
    expect(readConfig(configPath)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'keep-model',
      maxSteps: 8,
      skills: { tdd: false },
      workflow: { subagentsEnabled: false, maxParallel: 3 },
    });
    deps.saveMcpConfig([{ name: 'fs', command: 'npx', args: ['-y'], enabled: true }]);
    expect(readConfig(configPath)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'keep-model',
      maxSteps: 8,
      skills: { tdd: false },
      workflow: { subagentsEnabled: false, maxParallel: 3 },
      mcp: [{ name: 'fs', command: 'npx', args: ['-y'], enabled: true }],
    });
  });
});

describe('runWeb attach 模式：损坏 JSON / 非对象 deps', () => {
  it('c1) 损坏 JSON → ConfigError 路径：返回 1、err 打印、不触碰 server（不回归）', async () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mkdirSync(join(tmpHome, '.devmate'), { recursive: true });
    writeFileSync(configPath, '{oops', 'utf8');
    const captured: Captured = { deps: undefined, events: [], onSignal: undefined };
    const code = await runWeb(['--no-open'], makeIo(configPath, captured));
    expect(code).toBe(1);
    expect(captured.events.some((e) => e.startsWith('err:配置读取失败'))).toBe(true);
    expect(captured.deps).toBeUndefined(); // assembleDeps/createDevmateServer 未发生
  });

  it('c2) deps 非对象（字符串假件）→ attach 原样透传，不叠加', async () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    const module: Partial<ServerModule> = {
      assembleDeps: async () => 'fake-deps-string',
    };
    const captured: Captured = { deps: undefined, events: [], onSignal: undefined };
    const code = await runWeb(['--no-open'], makeIo(configPath, captured, module));
    expect(code).toBe(0);
    expect(captured.deps).toBe('fake-deps-string');
  });
});

describe('clampMaxParallel：初值夹紧 0-8（纯函数；subagent 无上限语义）', () => {
  it('undefined → 2；0 → 0（无上限）；7 → 7；2.5 → 2；负 → 0；9 → 8', () => {
    expect(clampMaxParallel(undefined)).toBe(2);
    expect(clampMaxParallel(0)).toBe(0);
    expect(clampMaxParallel(7)).toBe(7);
    expect(clampMaxParallel(2.5)).toBe(2);
    expect(clampMaxParallel(-3)).toBe(0);
    expect(clampMaxParallel(9)).toBe(8);
  });
});
