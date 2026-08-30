/**
 * permissions.js 单测：权限预设纯逻辑 —— 档位归一 / 标签与描述（展示单一来源）/
 * 已确认判定 / 风险门计算（full-access 一次性确认）。
 * 契约对应 src/ui/server/index.ts：permission ∈ read-only/workspace-write/full-access
 * （缺省 workspace-write）；permissionConfirmedAt = epoch ms（GET 无记录不带键）。
 */
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_VALUES,
  PERMISSION_DEFAULT,
  PERMISSION_LABELS,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_GLYPHS,
  RISK_CONFIRM_TITLE,
  RISK_CONFIRM_TEXT,
  normalizePermission,
  permissionLabel,
  permissionDescription,
  permissionGlyph,
  normalizeConfirmedAt,
  isPermissionConfirmed,
  shouldConfirmRisk,
} from '../../src/ui/web/permissions.js';

describe('档位归一（normalizePermission）', () => {
  it('三枚举原样返回', () => {
    expect(normalizePermission('read-only')).toBe('read-only');
    expect(normalizePermission('workspace-write')).toBe('workspace-write');
    expect(normalizePermission('full-access')).toBe('full-access');
  });

  it('非法/缺失/非字符串 → 缺省 workspace-write（闭集不抛）', () => {
    expect(normalizePermission(undefined)).toBe('workspace-write');
    expect(normalizePermission(null)).toBe('workspace-write');
    expect(normalizePermission('')).toBe('workspace-write');
    expect(normalizePermission('danger-full-access')).toBe('workspace-write');
    expect(normalizePermission('ask')).toBe('workspace-write');
    expect(normalizePermission(42)).toBe('workspace-write');
  });

  it('枚举与缺省与服务端 PERMISSION_PRESETS/DEFAULT 同形（三档、缺省工作区写）', () => {
    expect(PERMISSION_VALUES).toEqual(['read-only', 'workspace-write', 'full-access']);
    expect(PERMISSION_DEFAULT).toBe('workspace-write');
  });
});

describe('档位标签/描述/glyph（展示单一来源；非法值回缺省）', () => {
  it('三档标签（chip 与菜单行共用）', () => {
    expect(PERMISSION_LABELS['read-only']).toBe('只读');
    expect(PERMISSION_LABELS['workspace-write']).toBe('工作区写入');
    expect(PERMISSION_LABELS['full-access']).toBe('全部访问');
    expect(permissionLabel('workspace-write')).toBe('工作区写入');
  });

  it('非法值按缺省档标签/描述返回（不裸露未知串）', () => {
    expect(permissionLabel('bogus')).toBe(PERMISSION_LABELS['workspace-write']);
    expect(permissionDescription('bogus')).toBe(PERMISSION_DESCRIPTIONS['workspace-write']);
  });

  it('描述覆盖三档矩阵契约（workspace-write 含风险声明；full-access 含「不再问询/删除」）', () => {
    expect(PERMISSION_DESCRIPTIONS['read-only']).toContain('只读');
    expect(PERMISSION_DESCRIPTIONS['read-only']).toContain('逐项确认');
    expect(PERMISSION_DESCRIPTIONS['workspace-write']).toContain('信任的工作区内使用');
    expect(PERMISSION_DESCRIPTIONS['workspace-write']).toContain('破坏性命令');
    expect(PERMISSION_DESCRIPTIONS['full-access']).toContain('不再问询');
    expect(PERMISSION_DESCRIPTIONS['full-access']).toContain('删除');
  });

  it('glyph 种类：只读=check / 工作区写入=lock（锁形）/ 全部访问=alert', () => {
    expect(PERMISSION_GLYPHS).toEqual({
      'read-only': 'check',
      'workspace-write': 'lock',
      'full-access': 'alert',
    });
    expect(permissionGlyph('full-access')).toBe('alert');
    expect(permissionGlyph('nope')).toBe('lock'); // 非法 → 缺省档（工作区写入）
  });
});

describe('已确认判定（normalizeConfirmedAt / isPermissionConfirmed）', () => {
  it('非负整数时间戳 → 已确认', () => {
    expect(normalizeConfirmedAt(1_728_000_000_000)).toBe(1_728_000_000_000);
    expect(normalizeConfirmedAt(0)).toBe(0);
    expect(isPermissionConfirmed(1_728_000_000_000)).toBe(true);
  });

  it('缺失/非法（null/undefined/字符串/负数/小数）→ 未确认', () => {
    expect(normalizeConfirmedAt(undefined)).toBeNull();
    expect(normalizeConfirmedAt(null)).toBeNull();
    expect(normalizeConfirmedAt('1728000000000')).toBeNull();
    expect(normalizeConfirmedAt(-1)).toBeNull();
    expect(normalizeConfirmedAt(1.5)).toBeNull();
    expect(isPermissionConfirmed(null)).toBe(false);
    expect(isPermissionConfirmed(undefined)).toBe(false);
  });
});

describe('风险门计算（shouldConfirmRisk：切 full-access 且未确认 → 一次性确认门）', () => {
  it('目标 full-access + 无确认记录 → 过门', () => {
    expect(shouldConfirmRisk('full-access', null)).toBe(true);
    expect(shouldConfirmRisk('full-access', undefined)).toBe(true);
  });

  it('目标 full-access + 已确认过（GET 返回 confirmedAt）→ 直接生效', () => {
    expect(shouldConfirmRisk('full-access', 1_728_000_000_000)).toBe(false);
  });

  it('read-only / workspace-write 一键切换零确认（无论确认记录有无）', () => {
    expect(shouldConfirmRisk('read-only', null)).toBe(false);
    expect(shouldConfirmRisk('workspace-write', null)).toBe(false);
    expect(shouldConfirmRisk('read-only', 1_728_000_000_000)).toBe(false);
    expect(shouldConfirmRisk('workspace-write', 1_728_000_000_000)).toBe(false);
  });

  it('非法目标按缺省档（workspace-write）裁决 —— 不误触风险门', () => {
    expect(shouldConfirmRisk('danger-full-access', null)).toBe(false);
  });
});

describe('风险确认门文案（复用删除确认视觉；逐字断言防漂移）', () => {
  it('标题/正文与任务书语义一致', () => {
    expect(RISK_CONFIRM_TITLE).toBe('启用全部访问');
    expect(RISK_CONFIRM_TEXT).toBe(
      '全部放行：任何命令直接执行（含删除/破坏性操作），不再问询。确认？',
    );
  });
});
