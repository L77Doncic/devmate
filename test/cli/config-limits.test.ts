/**
 * # test/cli/config-limits：A 档 settings 扩展键（maxInputTokens / maxOutputTokens）
 * 的持久化面（与 reasoning/windowTokens 同规则：StoredConfig 原样往返、
 * loadConfig 读进 CliConfig、mergeStored 顶层补丁——未触碰键保留）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, mergeStored, saveConfig } from '../../src/cli/config.js';
import type { StoredConfig } from '../../src/cli/config.js';

describe('cli/config：maxInputTokens / maxOutputTokens（A 档）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('saveConfig → loadStoredConfig 原样往返（正整数保留；不需要的键不出现）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devmate-limits-'));
    dirs.push(dir);
    const path = join(dir, 'config.json');
    const stored: StoredConfig = {
      baseUrl: 'https://x.example/v1',
      model: 'm1',
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
    };
    saveConfig(path, stored);
    const loaded = loadConfig(path, {});
    expect(loaded.maxInputTokens).toBe(4096);
    expect(loaded.maxOutputTokens).toBe(2048);
  });

  it('未配置：loadConfig 不带键（缺省=不发送/厂商默认），env 无对应覆盖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devmate-limits-none-'));
    dirs.push(dir);
    const path = join(dir, 'config.json');
    saveConfig(path, { baseUrl: 'https://x.example/v1', model: 'm1' });
    const loaded = loadConfig(path, {});
    expect(loaded.maxInputTokens).toBeUndefined();
    expect(loaded.maxOutputTokens).toBeUndefined();
  });

  it('mergeStored 顶层补丁：只改上限键，既有键保留（merge 语义同行 reasoning）', () => {
    const merged = mergeStored(
      { model: 'm1', windowTokens: 16000, maxOutputTokens: 999 },
      { maxInputTokens: 12345 },
    );
    expect(merged.maxInputTokens).toBe(12345);
    expect(merged.maxOutputTokens).toBe(999);
    expect(merged.windowTokens).toBe(16000);
    expect(merged.model).toBe('m1');
  });
});
