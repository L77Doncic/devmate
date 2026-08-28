/**
 * theme.js 单测：三态归一、resolveTheme、localStorage 读写（注入 storageLike）、
 * applyTheme DOM 写入（注入 document-like 假件，零 jsdom）。
 */
import { describe, expect, it } from 'vitest';
import {
  THEME_KEY,
  THEME_VALUES,
  normalizeTheme,
  resolveTheme,
  loadThemeKey,
  saveThemeKey,
  applyTheme,
} from '../../src/ui/web/theme.js';

// ---------------------------------------------------------------------------
// 注入假件（与浏览器接口同形状；只实现被测路径用到的方法，多余调用即抛）
// ---------------------------------------------------------------------------

function fakeStorage(init: Record<string, string | null> = {}, { throwing = false } = {}) {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(init)) {
    if (v !== null) map.set(k, v);
  }
  return {
    getItem(key: string) {
      if (throwing) throw new Error('storage denied');
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (throwing) throw new Error('storage denied');
      map.set(key, value);
    },
    // 测试断言用
    keys() {
      return [...map.keys()];
    },
    value(key: string) {
      return map.get(key) ?? null;
    },
  };
}

function fakeDoc() {
  const attrs = new Map<string, string>();
  const metas = new Map<string, string>();
  return {
    root: {
      attrs,
      setAttribute(name: string, value: string) {
        attrs.set(name, value);
      },
      removeAttribute(name: string) {
        attrs.delete(name);
      },
      getAttribute(name: string) {
        return attrs.get(name) ?? null;
      },
    },
    querySelector(selector: string) {
      if (selector === 'meta[name="theme-color"]') {
        return { setAttribute: (_n: string, v: string) => metas.set('theme-color', v) };
      }
      if (selector === 'meta[name="color-scheme"]') {
        return { setAttribute: (_n: string, v: string) => metas.set('color-scheme', v) };
      }
      return null;
    },
    metas,
  };
}

/** document-like 假件（test tsconfig 无 DOM lib，此处只按 theme.js 需要的最小形状返回）。 */
const docOf = (d: ReturnType<typeof fakeDoc>) => ({
  documentElement: d.root,
  querySelector: d.querySelector,
});

// ---------------------------------------------------------------------------

describe('THEME_VALUES / normalizeTheme', () => {
  it('三值闭集（system/dark/light）', () => {
    expect(THEME_VALUES).toEqual(['system', 'dark', 'light']);
  });
  it('合法值原样；非法/缺失一律归一为 system', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('system')).toBe('system');
    expect(normalizeTheme('blurple')).toBe('system');
    expect(normalizeTheme(undefined as unknown as string)).toBe('system');
    expect(normalizeTheme(null as unknown as string)).toBe('system');
    expect(normalizeTheme('')).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('显式选择覆盖系统（dark/light 各自生效）', () => {
    expect(resolveTheme(true, 'light')).toBe('light');
    expect(resolveTheme(false, 'light')).toBe('light');
    expect(resolveTheme(false, 'dark')).toBe('dark');
    expect(resolveTheme(true, 'dark')).toBe('dark');
  });
  it('system/缺省 → 跟随系统偏好', () => {
    expect(resolveTheme(true, 'system')).toBe('dark');
    expect(resolveTheme(false, 'system')).toBe('light');
    expect(resolveTheme(true, null)).toBe('dark');
    expect(resolveTheme(false, undefined)).toBe('light');
  });
  it('非法存续值按 system 处理', () => {
    expect(resolveTheme(true, 'horse')).toBe('dark');
    expect(resolveTheme(false, 'horse')).toBe('light');
  });
});

describe('localStorage 读写（THEME_KEY = devdev.theme）', () => {
  it('写入前归一：非法值落盘为 system（不污染存储）', () => {
    const storage = fakeStorage();
    expect(saveThemeKey(storage, 'dark')).toBe('dark');
    expect(saveThemeKey(storage, 'nonsense')).toBe('system');
    expect(storage.value(THEME_KEY)).toBe('system');
  });
  it('读缺省/非法/合法：getItem 只读不写', () => {
    expect(loadThemeKey(fakeStorage())).toBe('system');
    expect(loadThemeKey(fakeStorage({ [THEME_KEY]: 'light' }))).toBe('light');
    expect(loadThemeKey(fakeStorage({ [THEME_KEY]: 'purple' }))).toBe('system');
    // 未写入过 → getItem 返回 null → system（不会回写）
    const storage = fakeStorage();
    loadThemeKey(storage);
    expect(storage.keys()).toEqual([]);
  });
  it('存储抛错（隐私模式/禁用）时静默降级 system；写入失败不抛且值归一', () => {
    const throwing = fakeStorage({}, { throwing: true });
    expect(loadThemeKey(throwing)).toBe('system');
    expect(() => saveThemeKey(throwing, 'light')).not.toThrow();
  });
  it('storageLike 为 null/缺 getItem 时不抛', () => {
    expect(loadThemeKey(null)).toBe('system');
    expect(() => saveThemeKey(null, 'dark')).not.toThrow();
  });
});

describe('applyTheme（document-like 假件）', () => {
  it('显式主题：写 data-theme + theme-color/color-scheme 单值', () => {
    const d = fakeDoc();
    const effective = applyTheme(docOf(d), 'dark', true);
    expect(effective).toBe('dark');
    expect(d.root.getAttribute('data-theme')).toBe('dark');
    expect(d.metas.get('theme-color')).toBe('#0d1117');
    expect(d.metas.get('color-scheme')).toBe('dark');

    const d2 = fakeDoc();
    const effective2 = applyTheme(docOf(d2), 'light', false);
    expect(effective2).toBe('light');
    expect(d2.root.getAttribute('data-theme')).toBe('light');
    expect(d2.metas.get('theme-color')).toBe('#f6f8fa');
    expect(d2.metas.get('color-scheme')).toBe('light');
  });
  it('system：移除 data-theme 属性（交给 CSS media），color-scheme 写双值', () => {
    const d = fakeDoc();
    d.root.setAttribute('data-theme', 'light'); // 模拟先前显式选择
    const effective = applyTheme(docOf(d), 'system', false);
    expect(effective).toBe('light');
    expect(d.root.getAttribute('data-theme')).toBeNull();
    expect(d.metas.get('color-scheme')).toBe('light dark');
    // 系统切到深色：effective 跟随 resolveTheme
    const effective2 = applyTheme(docOf(d), 'system', true);
    expect(effective2).toBe('dark');
    expect(d.metas.get('theme-color')).toBe('#0d1117');
  });
  it('meta 缺失（旧页面无标签）也不抛', () => {
    const d = fakeDoc();
    const effective = applyTheme({ documentElement: d.root }, 'dark', false);
    expect(effective).toBe('dark');
  });
});
