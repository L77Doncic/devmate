/**
 * # test/cli/config-reasoning：settings 扩展键（reasoning / windowTokens）的持久化面
 *
 * StoredConfig 顶层键与既有 settings 键同规则：loadStoredConfig 原样往返；
 * mergeStored 的顶层 spread 天然透传（不需特判）；显式 undefined = 删除。
 * （服务端 persistSettings 快照在「字段被触碰」时携带这两键——见 ui-server/reasoning 测试。）
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadStoredConfig,
  mergeConfig,
  mergeStored,
  saveConfig,
  type StoredConfig,
} from '../../src/cli/config.js';

const tmpHome = mkdtempSync(join(tmpdir(), 'devmate-config-reasoning-'));

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('StoredConfig：reasoning / windowTokens', () => {
  it('原样往返（loadStoredConfig / saveConfig）', () => {
    const path = join(tmpHome, '.devmate', 'config.json');
    saveConfig(path, {
      baseUrl: 'https://u/v1',
      model: 'm',
      reasoning: 'high',
      windowTokens: 32000,
    });
    expect(loadStoredConfig(path)).toEqual({
      baseUrl: 'https://u/v1',
      model: 'm',
      reasoning: 'high',
      windowTokens: 32000,
    });
  });

  it('mergeStored 顶层透传：补丁 reasoning/windowTokens 覆盖、既有键保留、显式 undefined 删除', () => {
    const stored: StoredConfig = {
      baseUrl: 'https://keep/v1',
      model: 'm0',
      reasoning: 'low',
      windowTokens: 16000,
    };
    const patched = mergeStored(stored, { reasoning: 'off', windowTokens: undefined });
    expect(patched.reasoning).toBe('off');
    expect('windowTokens' in patched).toBe(false);
    expect(patched.baseUrl).toBe('https://keep/v1');
    expect(patched.model).toBe('m0');
  });

  it('既有三节键不因新键受影响（skills/workflow/mcp 独立）', () => {
    const merged = mergeStored(
      { skills: { a: false }, workflow: { maxParallel: 3 }, reasoning: 'medium' },
      { reasoning: 'high', windowTokens: 64000 },
    );
    expect(merged.skills).toEqual({ a: false });
    expect(merged.workflow).toEqual({ maxParallel: 3 });
    expect(merged.reasoning).toBe('high');
    expect(merged.windowTokens).toBe(64000);
  });

  it('文件级往返（mergeConfig 写读一致；既有键保留）', () => {
    const path = join(tmpHome, '.devmate', 'config.json');
    saveConfig(path, { baseUrl: 'https://keep/v1', model: 'm0', reasoning: 'medium' });
    mergeConfig(path, { reasoning: 'high', windowTokens: 96000 });
    expect(loadStoredConfig(path)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'm0',
      reasoning: 'high',
      windowTokens: 96000,
    });
  });
});
