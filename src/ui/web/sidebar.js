/**
 * # sidebar.js — 侧边栏状态纯逻辑（dsh SidebarRoot 语义：展开 260 / rail 56）
 *
 * 折叠语义（2026-08-28 对齐 dsh AppFrame）：collapsed = **rail 56px**（不是旧版
 * 0 宽）；窄屏（<900px）遵循 dsh AppFrame 约定 —— 视图宽低于阈值即自动折叠，
 * 窄屏内的手动展开是运行时覆盖（narrowExpanded，不落盘），与持久化偏好独立。
 *
 * localStorage 键 `devdev.sidebarCollapsed`（任务书拼写，与 `devdev.theme` 同族）
 * 的读取纪律：**仅字面量 'true' 服从** —— 损坏值（'1'、'yes'、JSON 坏、undefined、
 * 旧版 '0'/'1' 记法）一律按「未折叠」处理（展开是默认安全态）。写入统一写
 * String(boolean)（'true' / 'false'），读写容错（隐私模式/禁用存储静默降级）。
 *
 * 纯函数边界：无 DOM；reading/writing 经注入的 storageLike（与 theme.js 同接缝，
 * node 可测）。
 */

/** 任务书规定的持久化键（与 devdev.theme 同族；'devdev' 拼写按任务书原文）。 */
export const SIDEBAR_LS_KEY = 'devdev.sidebarCollapsed';

/** 展开态侧栏宽度（dsh figma sidebar track；CSS --sidebar-w 与此同值）。 */
export const SIDEBAR_WIDTH = 260;
/** 折叠态 rail 宽度（dsh figma rail spec：36 控制盒 + 10px 侧 pad = 56）。 */
export const SIDEBAR_RAIL_WIDTH = 56;
/** 窄屏阈值（dsh AppFrame SIDEBAR_AUTO_COLLAPSE；CSS 同值 breakpoint 899px）。 */
export const SIDEBAR_NARROW_MAX_WIDTH = 899;

/**
 * 本地构建版本徽章（dsh SidebarRoot localBuildVersion 语义）。
 * 单一来源 = 根 package.json version（防漂移断言见 test/ui-web/sidebar.test.ts）。
 */
export const BUILD_VERSION = '0.1.3';

/**
 * 折叠状态归一：仅字面量 'true' 服从；损坏/未定义/其他一切 → 展开（默认安全态）。
 * 注：collapsed = rail 56px（不是 0 宽 —— 与 dsh rail 语义对齐）。
 */
export function normalizeSidebarCollapsed(raw) {
  return raw === 'true';
}

/**
 * 解析"当前是否折叠"：窄屏（<=899px）遵循 dsh —— 自动折叠；窄屏内的手动展开
 * 经 narrowExpanded 运行时覆盖（不落盘）；宽屏完全由持久化偏好决定。
 * @param {boolean} preference 持久化偏好（宽屏生效）
 * @param {boolean} narrow 当前是否窄屏（<900）
 * @param {boolean} narrowExpanded 窄屏内手动展开的运行时覆盖
 * @returns {boolean} 当前应折叠（rail）
 */
export function resolveSidebarCollapsed(preference, narrow, narrowExpanded) {
  if (narrow) return !narrowExpanded;
  return Boolean(preference);
}

/** 读取持久化偏好（容错：storage 缺失/读异常一律回落未折叠）。返回 boolean。 */
export function loadSidebarState(storage) {
  try {
    return normalizeSidebarCollapsed(storage?.getItem?.(SIDEBAR_LS_KEY));
  } catch {
    return false;
  }
}

/** 写入持久化偏好（容错：写入异常静默忽略——本次仍生效，只是不记忆）。
 *  统一写 String(boolean) 字面量，保证下次读取仅 'true' 服从语义成立。 */
export function saveSidebarState(storage, collapsed) {
  const value = Boolean(collapsed);
  try {
    storage?.setItem?.(SIDEBAR_LS_KEY, String(value));
  } catch {
    // 隐私模式/禁用存储：不 throw
  }
  return value;
}
