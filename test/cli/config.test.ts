import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  configFilePath,
  loadConfig,
  loadStoredConfig,
  maskApiKey,
  mergeConfig,
  saveConfig,
  type CliConfig,
  type StoredConfig,
} from '../../src/cli/config.js';
import { defaultProviderPreset } from '../../src/core/llm/presets.js';
import { maskApiKey as sharedMaskApiKey } from '../../src/shared/masking.js';

/**
 * S14 本地配置（~/.devmate/config.json）规格：
 * - 三源合并优先级：环境变量（DEV_MATE_BASE_URL/MODEL/API_KEY）> 文件 > 供应商 preset 默认；
 * - apiKey 可缺省（Web UI 设置页稍后填写并保存回本文件）；
 * - 文件与目录权限：config 0600、.devmate 目录 0700（密钥永不入仓库——配置只住用户主目录）；
 * - 掩码回读：maskApiKey 仅用于展示，完整密钥只在进程内部传递。
 */

const tmpHome = mkdtempSync(join(tmpdir(), 'devmate-config-'));

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * 0600 断言（POSIX 限定）：Windows 没有 POSIX chmod——Node 在 win32 上把 chmod
 * 映射为只读位（读回 stat.mode & 0o777 = 0o666），0600 语义仅在 POSIX 有效
 * （windows CI 实测：expected 384(0o600) received 438(0o666)，产品对此无可修）。
 * README 已注明该平台限定；此处 win32 只断言文件存在（可读可写的写盘语义不变）。
 */
function expectConfigMode(configPath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
}

describe('configFilePath：主目录 → 配置文件绝对路径', () => {
  it('<home>/.devmate/config.json', () => {
    expect(configFilePath('/home/user')).toBe(join('/home/user', '.devmate', 'config.json'));
  });
});

describe('loadConfig：三源合并（env > 文件 > preset 默认）', () => {
  it('文件缺失 → 回落主默认 preset（deepseek 的 baseUrl/model）', () => {
    const preset = defaultProviderPreset();
    const cfg = loadConfig(join(tmpHome, 'no-such-dir', 'config.json'), {});
    expect(cfg.baseUrl).toBe(preset.baseUrl);
    expect(cfg.model).toBe(preset.defaultModel);
    expect(cfg.apiKey).toBeUndefined();
  });

  it('文件字段全部生效（含可缺省的 maxSteps/costLimitUsd）', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    saveConfig(configPath, {
      baseUrl: 'https://file.example/v1',
      model: 'file-model',
      apiKey: 'sk-file-123',
      maxSteps: 5,
      costLimitUsd: 0.5,
    });
    expect(loadConfig(configPath, {})).toEqual({
      baseUrl: 'https://file.example/v1',
      model: 'file-model',
      apiKey: 'sk-file-123',
      maxSteps: 5,
      costLimitUsd: 0.5,
    });
  });

  it('env 覆盖文件（baseUrl/model/apiKey 三项；文件其余字段保留）', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    saveConfig(configPath, {
      baseUrl: 'https://file.example/v1',
      model: 'file-model',
      apiKey: 'sk-file-123',
      maxSteps: 5,
    });
    const cfg = loadConfig(configPath, {
      DEV_MATE_BASE_URL: 'https://env.example/v1',
      DEV_MATE_MODEL: 'env-model',
      DEV_MATE_API_KEY: 'sk-env-789',
    });
    expect(cfg).toEqual({
      baseUrl: 'https://env.example/v1',
      model: 'env-model',
      apiKey: 'sk-env-789',
      maxSteps: 5,
    });
  });

  it('env 空串视为未设置，回落文件值', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    saveConfig(configPath, {
      baseUrl: 'https://file.example/v1',
      model: 'file-model',
      apiKey: 'sk-file-123',
    });
    const cfg = loadConfig(configPath, {
      DEV_MATE_BASE_URL: '',
      DEV_MATE_MODEL: '',
      DEV_MATE_API_KEY: '',
    });
    expect(cfg.baseUrl).toBe('https://file.example/v1');
    expect(cfg.model).toBe('file-model');
    expect(cfg.apiKey).toBe('sk-file-123');
  });

  it('文件仅含 apiKey 时，baseUrl/model 仍走默认（UI 设置页只存密钥为合法形态）', () => {
    const preset = defaultProviderPreset();
    const configPath = join(tmpHome, '.devmate', 'config.json');
    saveConfig(configPath, { apiKey: 'sk-only-key' });
    const cfg = loadConfig(configPath, {});
    expect(cfg.baseUrl).toBe(preset.baseUrl);
    expect(cfg.model).toBe(preset.defaultModel);
    expect(cfg.apiKey).toBe('sk-only-key');
  });

  it('模型名读取即净化（A 档）：文件/env 带 `[1m]` UI 标记后缀 → CLI 生效模型名剥离（全链根除）', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    saveConfig(configPath, { model: 'deepseek-v4-flash[1m]' });
    const fromFile = loadConfig(configPath, {});
    expect(fromFile.model).toBe('deepseek-v4-flash');
    const fromEnv = loadConfig(configPath, { DEV_MATE_MODEL: 'my/stack[2m]' });
    expect(fromEnv.model).toBe('my/stack');
    // 非尾部标注不误伤（模型 ID 本体可含 `[`/`m`）
    saveConfig(configPath, { model: 'my-model-1m' });
    expect(loadConfig(configPath, {}).model).toBe('my-model-1m');
  });

  it('损坏 JSON → ConfigError 且消息含文件路径', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mkdirSync(join(tmpHome, '.devmate'), { recursive: true });
    writeFileSync(configPath, '{oops', 'utf8');
    expect(() => loadConfig(configPath, {})).toThrow(ConfigError);
    expect(() => loadConfig(configPath, {})).toThrow(/config\.json/);
  });
});

describe('saveConfig：0600 落盘 + 目录自建', () => {
  it('创建父目录、写 0600；已存在 0644 也被纠正为 0600', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mkdirSync(join(tmpHome, '.devmate'), { recursive: true });
    writeFileSync(configPath, '{}', { mode: 0o644 });
    saveConfig(configPath, { model: 'm1', apiKey: 'sk-roundtrip' });

    expect(existsSync(join(tmpHome, '.devmate'))).toBe(true);
    expectConfigMode(configPath);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      model: 'm1',
      apiKey: 'sk-roundtrip',
    });
  });
});

describe('loadStoredConfig：三节初值的 raw 来源', () => {
  it('文件缺失 → {}', () => {
    expect(loadStoredConfig(join(tmpHome, 'no-such', 'config.json'))).toEqual({});
  });

  it('skills/workflow/mcp 三节 + settings 字段原样往返', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    const stored: StoredConfig = {
      baseUrl: 'https://stored.example/v1',
      model: 'stored-model',
      maxSteps: 4,
      skills: { tdd: false, research: true },
      workflow: { subagentsEnabled: false, maxParallel: 3 },
      mcp: [{ name: 'fs', command: 'npx', args: ['-y', '@x/fs'], enabled: true }],
    };
    saveConfig(configPath, stored);
    expect(loadStoredConfig(configPath)).toEqual(stored);
  });

  it('损坏 JSON → ConfigError（与 loadConfig 同路径；不回归）', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mkdirSync(join(tmpHome, '.devmate'), { recursive: true });
    writeFileSync(configPath, '{oops', 'utf8');
    expect(() => loadStoredConfig(configPath)).toThrow(ConfigError);
  });
});

describe('mergeConfig / mergeStored：单点合并写（三节 + settings 共用）', () => {
  function readJson(configPath: string): StoredConfig {
    return JSON.parse(readFileSync(configPath, 'utf8')) as StoredConfig;
  }

  it('缺失文件：首次写只含 patch；目录自建', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mergeConfig(configPath, { skills: { tdd: false } });
    expect(readJson(configPath)).toEqual({ skills: { tdd: false } });
    expect(existsSync(join(tmpHome, '.devmate'))).toBe(true);
    expectConfigMode(configPath);
  });

  it('skill 节深合：既有键保留、冲突键 patch 优先', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mergeConfig(configPath, { skills: { a: true, stale: true } });
    mergeConfig(configPath, { skills: { a: false, b: false } });
    expect(readJson(configPath).skills).toEqual({ a: false, b: false, stale: true });
  });

  it('workflow 节深合：部分字段补丁保留未指字段', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mergeConfig(configPath, { workflow: { subagentsEnabled: false } });
    mergeConfig(configPath, { workflow: { maxParallel: 3 } });
    expect(readJson(configPath).workflow).toEqual({ subagentsEnabled: false, maxParallel: 3 });
  });

  it('mcp 清单整节替换（服务端全量快照为准；按名合并不复活已删服务器）', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    const a = { name: 'a', command: 'x', args: [], enabled: true };
    const b = { name: 'b', command: 'y', args: ['-z'], enabled: false };
    mergeConfig(configPath, { mcp: [a, b] });
    mergeConfig(configPath, { mcp: [a] });
    expect(readJson(configPath).mcp).toEqual([a]);
  });

  it('workspaces 清单整节替换（服务端全量快照为准；已删根不复活——同 mcp 语义）', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mergeConfig(configPath, { workspaces: ['/ws-a', '/ws-b'] });
    mergeConfig(configPath, { workspaces: ['/ws-b'] });
    expect(readJson(configPath).workspaces).toEqual(['/ws-b']);
  });

  it('patch 显式 undefined = 删除该键（apiKey 清空语义）', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mergeConfig(configPath, { model: 'm0', apiKey: 'sk-old' });
    mergeConfig(configPath, { model: 'm1', apiKey: undefined });
    expect(readJson(configPath)).toEqual({ model: 'm1' });
  });

  it('连续三次修改（skills→workflow→mcp）只改各自节、其余键保留', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mergeConfig(configPath, { baseUrl: 'https://keep/v1', model: 'keep-model', maxSteps: 5 });
    mergeConfig(configPath, { skills: { tdd: false } });
    expect(readJson(configPath)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'keep-model',
      maxSteps: 5,
      skills: { tdd: false },
    });
    mergeConfig(configPath, { workflow: { subagentsEnabled: true, maxParallel: 2 } });
    expect(readJson(configPath)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'keep-model',
      maxSteps: 5,
      skills: { tdd: false },
      workflow: { subagentsEnabled: true, maxParallel: 2 },
    });
    mergeConfig(configPath, { mcp: [{ name: 'fs', command: 'npx', args: ['-y'], enabled: true }] });
    expect(readJson(configPath)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'keep-model',
      maxSteps: 5,
      skills: { tdd: false },
      workflow: { subagentsEnabled: true, maxParallel: 2 },
      mcp: [{ name: 'fs', command: 'npx', args: ['-y'], enabled: true }],
    });
  });

  it('合并写损坏文件 → ConfigError（读路径先跑；不回归）', () => {
    const configPath = join(tmpHome, '.devmate', 'config.json');
    mkdirSync(join(tmpHome, '.devmate'), { recursive: true });
    writeFileSync(configPath, '{broken', 'utf8');
    expect(() => mergeConfig(configPath, { skills: { tdd: false } })).toThrow(ConfigError);
  });
});

describe('maskApiKey：掩码回读（只做展示，不进进程外通道的完整值）', () => {
  it('长度 > 12：保留前后各 4 位；<= 12：全掩码；undefined 透传', () => {
    expect(maskApiKey('sk-abcdefghijklm')).toBe('sk-a****jklm');
    expect(maskApiKey('short')).toBe('****');
    expect(maskApiKey(undefined)).toBeUndefined();
    // 单一实现已迁至 shared/masking.ts（层间倒置修复）；cli/config re-export 同一函数
    expect(sharedMaskApiKey('sk-abcdefghijklm')).toBe(maskApiKey('sk-abcdefghijklm'));
    expect(sharedMaskApiKey('short')).toBe('****');
    expect(sharedMaskApiKey(undefined)).toBeUndefined();
  });
});

describe('CliConfig 命名（重名修复：CLI 侧与 S12 引擎 DevmateConfig 两型区分）', () => {
  it('CLI 侧生效配置类型名为 CliConfig（原 DevmateConfig 更名；引擎侧保留原名）', () => {
    const cfg: CliConfig = { baseUrl: 'https://u', model: 'm' };
    expect(Object.keys(cfg)).toEqual(['baseUrl', 'model']);
  });
});
