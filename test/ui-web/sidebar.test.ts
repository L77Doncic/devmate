import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SIDEBAR_LS_KEY,
  SIDEBAR_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_NARROW_MAX_WIDTH,
  BUILD_VERSION,
  normalizeSidebarCollapsed,
  resolveSidebarCollapsed,
  loadSidebarState,
  saveSidebarState,
} from '../../src/ui/web/sidebar.js';

/**
 * 侧边栏状态纯逻辑（sidebar.js）：宽屏默认展开 + 持久化仅 'true' 字面量服从
 * （损坏/未定义 → 展开 —— localStorage 默认风险修复）。
 */

interface StorageLike {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}

function storageWith(initial: string | null = null): StorageLike & { _value: () => string | null } {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_k: string, v: string) => {
      value = v;
    },
    _value: () => value,
  };
}

describe('sideBarState 归一：仅字面量 "true" 服从', () => {
  it('字面量 "true" → 折叠（服从）', () => {
    expect(normalizeSidebarCollapsed('true')).toBe(true);
    expect(loadSidebarState(storageWith('true'))).toBe(true);
  });

  it('undefined/未写键 → 展开（默认安全态）', () => {
    expect(normalizeSidebarCollapsed(undefined)).toBe(false);
    expect(loadSidebarState(storageWith(null))).toBe(false);
    expect(loadSidebarState(storageWith())).toBe(false);
    expect(loadSidebarState({} as unknown as StorageLike)).toBe(false);
  });

  it('损坏值（历史 "1" 记法 / "yes" / "false" / 空串）一律展开', () => {
    // "1"、旧版 '0'/'1' 记法均属损坏：本版仅 'true' 字面量服从
    expect(normalizeSidebarCollapsed('1')).toBe(false);
    expect(normalizeSidebarCollapsed('0')).toBe(false);
    expect(normalizeSidebarCollapsed('yes')).toBe(false);
    expect(normalizeSidebarCollapsed('true ')).toBe(false);
    expect(normalizeSidebarCollapsed('TRUE')).toBe(false);
    expect(normalizeSidebarCollapsed('')).toBe(false);
  });

  it('storage 读异常（隐私模式等）静默回落展开，绝不 throw', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
    } as unknown as StorageLike;
    expect(() => loadSidebarState(throwing)).not.toThrow();
    expect(loadSidebarState(throwing)).toBe(false);
    expect(loadSidebarState(null)).toBe(false);
    expect(loadSidebarState(undefined)).toBe(false);
  });
});

describe('saveSidebarState（统一写 String(boolean) 字面量，读侧唯一服从语义成立）', () => {
  it('写 "true"/"false"；round-trip 与你写我读一致', () => {
    const s = storageWith(null);
    saveSidebarState(s, true);
    expect(s._value()).toBe('true');
    expect(loadSidebarState(s)).toBe(true);
    saveSidebarState(s, false);
    expect(s._value()).toBe('false');
    expect(loadSidebarState(s)).toBe(false);
  });

  it('非布尔输入按 Boolean 归一后写（true/false 闭合）', () => {
    const s = storageWith(null);
    saveSidebarState(s, 'true' as unknown as boolean);
    expect(s._value()).toBe('true');
    saveSidebarState(s, 0 as unknown as boolean);
    expect(s._value()).toBe('false');
  });

  it('写异常静默（不 throw），返回归一值', () => {
    const throwing = {
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as StorageLike;
    expect(() => saveSidebarState(throwing, true)).not.toThrow();
    expect(saveSidebarState(throwing, false)).toBe(false);
  });
});

describe('持久化键 = devdev.sidebarCollapsed（与主题键 devdev.theme 同族）', () => {
  it('键名按任务书原文，无漂移', () => {
    expect(SIDEBAR_LS_KEY).toBe('devdev.sidebarCollapsed');
  });
});

describe('dsh 几何常量：展开 260 / rail 56 / 窄屏阈值 899（与 CSS --sidebar-w 同值）', () => {
  it('宽度常量与 CSS 保持同值（防两者漂移）', () => {
    expect(SIDEBAR_WIDTH).toBe(260);
    expect(SIDEBAR_RAIL_WIDTH).toBe(56);
    expect(SIDEBAR_NARROW_MAX_WIDTH).toBe(899);
  });

  it('BUILD_VERSION = package.json version（本地构建徽章单一来源）', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8'));
    expect(BUILD_VERSION).toBe(pkg.version);
  });
});

describe('resolveSidebarCollapsed（dsh AppFrame：窄屏自动折叠 + 运行时展开覆盖）', () => {
  it('宽屏：完全由持久化偏好决定（true=rail / false=展开）', () => {
    expect(resolveSidebarCollapsed(true, false, false)).toBe(true);
    expect(resolveSidebarCollapsed(false, false, false)).toBe(false);
    expect(resolveSidebarCollapsed(true, false, true)).toBe(true); // 宽屏忽略 narrowExpanded
  });

  it('窄屏：默认自动折叠（dsh SIDEBAR_AUTO_COLLAPSE 语义）', () => {
    expect(resolveSidebarCollapsed(false, true, false)).toBe(true);
    expect(resolveSidebarCollapsed(true, true, false)).toBe(true);
  });

  it('窄屏：手动展开（narrowExpanded）为运行时覆盖，不落盘', () => {
    expect(resolveSidebarCollapsed(false, true, true)).toBe(false);
    expect(resolveSidebarCollapsed(true, true, true)).toBe(false);
  });
});
