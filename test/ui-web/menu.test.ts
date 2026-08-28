import { describe, expect, it } from 'vitest';
import {
  MENU_GAP,
  MENU_VIEWPORT_PAD,
  SESSION_MENU_ITEMS,
  menuItemById,
  menuPosition,
} from '../../src/ui/web/menu.js';

/**
 * menu.js 单测：行菜单纯逻辑（dsh Menu 语义的本地裁决层）——
 * 条目模型（id/label/danger）、id → action 白名单匹配（未知 id 不落破坏性分支）、
 * 锚点定位（先下后上、右缘对齐、视口钳制）。
 */

describe('SESSION_MENU_ITEMS（会话行菜单条目模型）', () => {
  it('只有删除一项且标记 danger（我们无 rename/fork/archive 语义）', () => {
    expect(SESSION_MENU_ITEMS).toHaveLength(1);
    expect(SESSION_MENU_ITEMS[0]).toEqual({ id: 'delete', label: '删除会话', danger: true });
  });

  it('文案单一来源（防漂移：与 DOM 断言的字符串同源）', () => {
    expect(SESSION_MENU_ITEMS[0]!.label).toBe('删除会话');
  });
});

describe('menuItemById（id → 条目白名单匹配）', () => {
  it('命中已知 id：返回条目（danger 归一为布尔）', () => {
    const item = menuItemById(SESSION_MENU_ITEMS, 'delete');
    expect(item).not.toBeNull();
    expect(item).toEqual({ id: 'delete', label: '删除会话', danger: true });
  });

  it('未知 id 一律 null —— 未来新增条目不得继承破坏性 else 分支', () => {
    expect(menuItemById(SESSION_MENU_ITEMS, 'fork')).toBeNull();
    expect(menuItemById(SESSION_MENU_ITEMS, 'rename')).toBeNull();
    expect(menuItemById(SESSION_MENU_ITEMS, '')).toBeNull();
    expect(menuItemById(SESSION_MENU_ITEMS, 'bogus')).toBeNull();
  });

  it('自定义条目表同样适用（危险标记任意），空表返回 null', () => {
    const items = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', danger: true },
    ];
    expect(menuItemById(items, 'a')).toEqual({ id: 'a', label: 'A', danger: false });
    expect(menuItemById(items, 'b')).toEqual({ id: 'b', label: 'B', danger: true });
    expect(menuItemById([], 'a')).toBeNull();
  });
});

describe('menuPosition（锚点下方优先；放不下翻上方；右缘对齐 + 视图钳制）', () => {
  const vp = { width: 1000, height: 800 };

  it('下方放得下：锚下 MENU_GAP（6px）', () => {
    const pos = menuPosition(
      { left: 400, top: 100, width: 16, height: 16 },
      { width: 150, height: 120 },
      vp,
    );
    expect(pos.place).toBe('below');
    expect(pos.top).toBe(100 + 16 + MENU_GAP);
    expect(pos.left).toBe(400 + 16 - 150); // align end：右缘 = 锚右缘
  });

  it('下方放不下：翻到锚上方 MENU_GAP（且不越视口顶）', () => {
    const pos = menuPosition(
      { left: 100, top: 790, width: 16, height: 16 },
      { width: 150, height: 120 },
      vp,
    );
    expect(pos.place).toBe('above');
    expect(pos.top).toBe(790 - MENU_GAP - 120);
  });

  it('锚贴视口顶且下方放不下：上翻钳到 MENU_VIEWPORT_PAD', () => {
    const pos = menuPosition(
      { left: 100, top: 0, width: 16, height: 16 },
      { width: 150, height: 120 },
      { width: 1000, height: 100 },
    );
    expect(pos.place).toBe('above');
    expect(pos.top).toBe(MENU_VIEWPORT_PAD);
  });

  it('左缘钳制：锚很近左边 → 菜单不越出 MENU_VIEWPORT_PAD', () => {
    const pos = menuPosition(
      { left: 2, top: 100, width: 16, height: 16 },
      { width: 150, height: 120 },
      vp,
    );
    expect(pos.left).toBe(MENU_VIEWPORT_PAD);
  });

  it('右缘钳制：锚很近右边 → 菜单右缘不越视口', () => {
    const pos = menuPosition(
      { left: 982, top: 100, width: 16, height: 16 },
      { width: 150, height: 120 },
      vp,
    );
    expect(pos.left + 150).toBeLessThanOrEqual(vp.width - MENU_VIEWPORT_PAD);
  });

  it('菜单宽于视口：钳制到 pad（maxLeft 不出现负值）', () => {
    const pos = menuPosition(
      { left: 10, top: 100, width: 16, height: 16 },
      { width: 500, height: 120 },
      { width: 200, height: 600 },
    );
    expect(pos.left).toBe(MENU_VIEWPORT_PAD);
    expect(Number.isFinite(pos.left)).toBe(true);
  });
});
