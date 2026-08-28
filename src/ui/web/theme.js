/**
 * # theme.js — 主题纯逻辑（跟随系统/浅色/深色；node 可直接 import）
 *
 * 三态模型（与 styles.css 的 [data-theme] 约定一一对应）：
 * - 'system'（缺省）：`<html>` 不设 data-theme —— 纯 CSS `prefers-color-scheme`
 *   media 决定浅/深（双态跟随 OS 且随 OS 变化实时生效，无需 JS 参与取值）。
 * - 'dark' / 'light'：`<html data-theme="…">` 强制覆盖（用户显式选择）。
 * - localStorage 键 `devdev.theme`（任务书规定）持久化；读写均需容错
 *   （隐私模式/禁用存储时静默降级为 'system'，读失败也绝不 throw）。
 *
 * 与 DOM 的接缝只有两处，均以参数注入（node 测试用同形状假件，零 jsdom）：
 * - applyTheme(doc, theme, systemDark)：写 html 属性 + 同步
 *   meta[name=theme-color]（浏览器工具栏着色）与 meta[name=color-scheme]
 *   （原生控件/滚动条取色；system 态写 'light dark' 表示双支持）。
 * - localStorage 读写经注入的 storageLike（{getItem,setItem}）。
 *
 * 安全纪律：themeColor/colorScheme 的写入值只允许本模块白名单（防注入 DOM attribute）。
 */

/** 任务书规定的持久化键（与 devmate.ui.sessionId 并存；'devdev' 拼写按任务书原文）。 */
export const THEME_KEY = 'devdev.theme';

/** 用户可选三态（顺序即设置抽屉展示顺序）。 */
export const THEME_VALUES = Object.freeze(['system', 'dark', 'light']);

/** 各生效主题的 meta 值白名单（applyTheme 唯一写入来源）。 */
export const THEME_META = Object.freeze({
  dark: Object.freeze({ colorScheme: 'dark', themeColor: '#0d1117' }),
  light: Object.freeze({ colorScheme: 'light', themeColor: '#f6f8fa' }),
});

/** 非法值归一为 'system'（三态闭集；未知存续值按缺省处理）。 */
export function normalizeTheme(value) {
  return THEME_VALUES.includes(value) ? value : 'system';
}

/**
 * 三态 + 系统偏好 → 生效主题（'dark' | 'light'）。
 * sparse：systemDark = 系统当前是否深色（Boolean；测试与浏览器 matchMedia 均用）。
 */
export function resolveTheme(systemDark, savedTheme) {
  const saved = normalizeTheme(savedTheme);
  if (saved === 'dark' || saved === 'light') return saved;
  return systemDark ? 'dark' : 'light';
}

/** 读取持久化偏好（容错：storage 缺失/读写异常一律回落 'system'）。 */
export function loadThemeKey(storage) {
  try {
    return normalizeTheme(storage?.getItem?.(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** 写入持久化偏好（容错：写入异常静默忽略——主题仍即时生效，只是不记忆）。 */
export function saveThemeKey(storage, theme) {
  const value = normalizeTheme(theme);
  try {
    storage?.setItem?.(THEME_KEY, value);
  } catch {
    // 隐私模式等：写入失败不影响本次生效
  }
  return value;
}

/**
 * 把主题写到 DOM（浏览器传 document；node 单测传同形状假件）。
 * 返回实际生效主题（供调用方展示/日志）。
 *
 * @param {object}                doc   document-like：{documentElement, querySelector?}
 * @param {string}                theme 三态（'system'|'dark'|'light'）
 * @param {boolean}               systemDark 系统当前是否深色（仅在 theme==='system' 时参与）
 */
export function applyTheme(doc, theme, systemDark = false) {
  const value = normalizeTheme(theme);
  const root = doc?.documentElement;
  if (root) {
    if (value === 'system') {
      root.removeAttribute?.('data-theme');
    } else {
      root.setAttribute?.('data-theme', value);
    }
  }
  const effective = resolveTheme(systemDark, value);
  const meta = THEME_META[effective];
  if (meta && doc?.querySelector) {
    const themeColor = doc.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute('content', meta.themeColor);
    const colorScheme = doc.querySelector('meta[name="color-scheme"]');
    colorScheme?.setAttribute('content', value === 'system' ? 'light dark' : value);
  }
  return effective;
}
