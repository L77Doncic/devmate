/**
 * # menu.js — 行菜单（kebab → dsh Menu 语义）纯逻辑
 *
 * dsh 会话行的溢出菜单 = Menu 原语：items 描述表（id / label / danger / icon）、
 * onSelect 以 id 分发（未知 id 决不落入破坏性 else 分支 —— 逐 id 白名单匹配）、
 * `align="end"`（菜单右缘 = 锚钮右缘）、关闭语义（外部点击 / Escape /
 * closeOnPointerLeave）。本模块只承载**可测裁决**：条目模型、id → action 匹配、
 * 锚点定位（视图内钳制，不足则翻到锚上方）。DOM 装配与事件绑定在 app.js。
 *
 * 位置几何（与 dsh Menu.module.css / 组件同族定值）：
 * - 优先锚下 6px；下方放不下 → 锚上 6px；
 * - 右缘与 kebab 右缘对齐（align end），视图左右各留 8px；
 * - 菜单高 < 1 锚 + 视口边缘 → 钳制而非裁切（viewport 内恒可点）。
 */

/** 锚点与菜单之间的可视间距。 */
export const MENU_GAP = 6;
/** 菜单相对视口边缘的最小留白。 */
export const MENU_VIEWPORT_PAD = 8;

/**
 * 行菜单 kebab 的可访问名 / 悬停提示（会话行与组头 kebab 共用同一来源；
 * title 与 aria-label 同值 —— 组头 kebab 两种状态（默认根禁用/可用）亦恒有 title）。
 */
export const ROW_MENU_KEBAB_TITLE = '更多（删除/恢复等）';

/**
 * 会话行菜单条目表（dsh SessionNodeItem row menu 的本地实例：
 * 我们无 rename/fork/archive 语义 —— 只有删除，危险项红着）。
 * 文案单一来源：menu.js（与 extensions.js 同纪律，防漂移断言见 menu.test.ts）。
 */
export const SESSION_MENU_ITEMS = Object.freeze([
  Object.freeze({ id: 'delete', label: '删除会话', danger: true }),
]);

/**
 * id → 条目匹配（白名单）；未知 id 返回 null（调用方必须落空返回 ——
 * 未来新增条目不得继承破坏性 else）。
 * @param {readonly {id: string, label: string, danger?: boolean}[]} items
 * @param {string} id
 * @returns {{id: string, label: string, danger: boolean} | null}
 */
export function menuItemById(items, id) {
  const item = items.find((candidate) => candidate.id === id);
  return item === undefined ? null : { ...item, danger: Boolean(item.danger) };
}

/**
 * 锚点菜单定位（视口内钳制）。
 * @param {{left: number, top: number, width: number, height: number}} anchor 锚钮（kebab）rect
 * @param {{width: number, height: number}} size 菜单实测尺寸（px）
 * @param {{width: number, height: number}} viewport 可视区（含滚动条外沿的视口）
 * @returns {{left: number, top: number, place: 'below' | 'above'}}
 *          place：菜单最终位于锚点上方还是下方（调用方可据此做方向性修饰，如需）
 */
export function menuPosition(anchor, size, viewport) {
  const below =
    anchor.top + anchor.height + MENU_GAP + size.height + MENU_VIEWPORT_PAD <= viewport.height;
  const top = below
    ? anchor.top + anchor.height + MENU_GAP
    : Math.max(MENU_VIEWPORT_PAD, anchor.top - MENU_GAP - size.height);
  // align end：右缘与锚钮右缘对齐；钳到 [pad, viewport.w - pad - menuStr] 内
  let left = anchor.left + anchor.width - size.width;
  const maxLeft = Math.max(MENU_VIEWPORT_PAD, viewport.width - size.width - MENU_VIEWPORT_PAD);
  left = Math.min(maxLeft, Math.max(MENU_VIEWPORT_PAD, left));
  return { left, top, place: below ? 'below' : 'above' };
}
