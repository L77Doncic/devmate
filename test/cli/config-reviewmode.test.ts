/**
 * # test/cli/config-reviewmode：评审哨兵开关的持久化面（StoredConfig 顶层键）
 *
 * 与 methodFirst/reasoning/permission 同规则：loadStoredConfig 原样往返；mergeStored 的
 * 顶层 spread 天然透传（不需特判）；显式 undefined = 删除；
 * （服务端 persistSettings 快照在「reviewMode 被触碰」时携带——见 ui-server/settings 测试。）
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

const tmpHome = mkdtempSync(join(tmpdir(), 'devmate-config-reviewmode-'));

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('StoredConfig：reviewMode', () => {
  it('原样往返（loadStoredConfig / saveConfig）', () => {
    const path = join(tmpHome, '.devmate', 'config.json');
    saveConfig(path, {
      baseUrl: 'https://u/v1',
      model: 'm',
      reviewMode: false,
    });
    expect(loadStoredConfig(path)).toEqual({
      baseUrl: 'https://u/v1',
      model: 'm',
      reviewMode: false,
    });
  });

  it('mergeStored 顶层透传：补丁 reviewMode 覆盖（false）、显式 undefined 删除、既有键保留', () => {
    const stored: StoredConfig = {
      baseUrl: 'https://keep/v1',
      model: 'm0',
      reviewMode: true,
      methodFirst: false,
    };
    const patched = mergeStored(stored, { reviewMode: undefined, methodFirst: true });
    expect('reviewMode' in patched).toBe(false);
    expect(patched.methodFirst).toBe(true);
    expect(patched.baseUrl).toBe('https://keep/v1');

    const off = mergeStored({ reviewMode: true }, { reviewMode: false });
    expect(off.reviewMode).toBe(false);
  });

  it('既有 methodFirst/reviewMode 独立共存（互不干扰）', () => {
    const merged = mergeStored(
      { methodFirst: true, reviewMode: false },
      { methodFirst: false },
    );
    expect(merged.methodFirst).toBe(false);
    expect(merged.reviewMode).toBe(false);
  });

  it('文件级往返（mergeConfig 写读一致；既有键保留）', () => {
    const path = join(tmpHome, '.devmate', 'config.json');
    saveConfig(path, { baseUrl: 'https://keep/v1', model: 'm0', reviewMode: true });
    mergeConfig(path, { reviewMode: false });
    expect(loadStoredConfig(path)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'm0',
      reviewMode: false,
    });
  });
});
