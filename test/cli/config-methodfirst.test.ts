/**
 * # test/cli/config-methodfirst：方法论前置门开关的持久化面（StoredConfig 顶层键）
 *
 * 与 reasoning/permission 同规则：loadStoredConfig 原样往返；mergeStored 的顶层
 * spread 天然透传（不需特判）；显式 undefined = 删除；
 * （服务端 persistSettings 快照在「methodFirst 被触碰」时携带——见 ui-server/route 测试。）
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

const tmpHome = mkdtempSync(join(tmpdir(), 'devmate-config-methodfirst-'));

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('StoredConfig：methodFirst', () => {
  it('原样往返（loadStoredConfig / saveConfig）', () => {
    const path = join(tmpHome, '.devmate', 'config.json');
    saveConfig(path, {
      baseUrl: 'https://u/v1',
      model: 'm',
      methodFirst: false,
    });
    expect(loadStoredConfig(path)).toEqual({
      baseUrl: 'https://u/v1',
      model: 'm',
      methodFirst: false,
    });
  });

  it('mergeStored 顶层透传：补丁 methodFirst 覆盖（false）、显式 undefined 删除、既有键保留', () => {
    const stored: StoredConfig = {
      baseUrl: 'https://keep/v1',
      model: 'm0',
      methodFirst: true,
      permission: 'read-only',
    };
    const patched = mergeStored(stored, { methodFirst: undefined, permission: 'full-access' });
    expect('methodFirst' in patched).toBe(false);
    expect(patched.permission).toBe('full-access');
    expect(patched.baseUrl).toBe('https://keep/v1');

    const on = mergeStored({ methodFirst: false }, { methodFirst: true });
    expect(on.methodFirst).toBe(true);
  });

  it('既有 reasoning/permission/methodFirst 独立共存（互不干扰）', () => {
    const merged = mergeStored(
      { reasoning: 'high', permission: 'read-only', methodFirst: false },
      { permission: 'full-access' },
    );
    expect(merged.reasoning).toBe('high');
    expect(merged.methodFirst).toBe(false);
    expect(merged.permission).toBe('full-access');
  });

  it('文件级往返（mergeConfig 写读一致；既有键保留）', () => {
    const path = join(tmpHome, '.devmate', 'config.json');
    saveConfig(path, { baseUrl: 'https://keep/v1', model: 'm0', methodFirst: true });
    mergeConfig(path, { methodFirst: false });
    expect(loadStoredConfig(path)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'm0',
      methodFirst: false,
    });
  });
});
