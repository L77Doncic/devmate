/**
 * # test/cli/config-permission：权限预设的持久化面（StoredConfig 顶层键）
 *
 * 与 reasoning/windowTokens 同规则：loadStoredConfig 原样往返；mergeStored 的顶层
 * spread 天然透传（不需特判）；显式 undefined = 删除。
 * （服务端 persistSettings 快照在「字段被触碰」时携带这两键——见 ui-server/permission 测试。）
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

const tmpHome = mkdtempSync(join(tmpdir(), 'devmate-config-permission-'));

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('StoredConfig：permission / permissionConfirmedAt', () => {
  it('原样往返（loadStoredConfig / saveConfig）', () => {
    const path = join(tmpHome, '.devmate', 'config.json');
    saveConfig(path, {
      baseUrl: 'https://u/v1',
      model: 'm',
      permission: 'read-only',
      permissionConfirmedAt: 1234567890,
    });
    expect(loadStoredConfig(path)).toEqual({
      baseUrl: 'https://u/v1',
      model: 'm',
      permission: 'read-only',
      permissionConfirmedAt: 1234567890,
    });
  });

  it('mergeStored 顶层透传：补丁 permission 覆盖、既有键保留、显式 undefined 删除', () => {
    const stored: StoredConfig = {
      baseUrl: 'https://keep/v1',
      model: 'm0',
      permission: 'workspace-write',
      permissionConfirmedAt: 1000,
    };
    const patched = mergeStored(stored, {
      permission: 'full-access',
      permissionConfirmedAt: undefined,
    });
    expect(patched.permission).toBe('full-access');
    expect('permissionConfirmedAt' in patched).toBe(false);
    expect(patched.baseUrl).toBe('https://keep/v1');
    expect(patched.model).toBe('m0');
  });

  it('既有 s12 键不因新键受影响（reasoning/windowTokens 独立共存）', () => {
    const merged = mergeStored(
      { reasoning: 'medium', windowTokens: 16000, permission: 'read-only' },
      { permission: 'full-access', permissionConfirmedAt: 2000 },
    );
    expect(merged.reasoning).toBe('medium');
    expect(merged.windowTokens).toBe(16000);
    expect(merged.permission).toBe('full-access');
    expect(merged.permissionConfirmedAt).toBe(2000);
  });

  it('文件级往返（mergeConfig 写读一致；既有键保留）', () => {
    const path = join(tmpHome, '.devmate', 'config.json');
    saveConfig(path, { baseUrl: 'https://keep/v1', model: 'm0', permission: 'read-only' });
    mergeConfig(path, { permission: 'full-access', permissionConfirmedAt: 3000 });
    expect(loadStoredConfig(path)).toEqual({
      baseUrl: 'https://keep/v1',
      model: 'm0',
      permission: 'full-access',
      permissionConfirmedAt: 3000,
    });
  });
});
