import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ICONS,
  ICON_NS,
  ICON_STROKE,
  ICON_VIEWBOX,
  iconPaths,
  iconSvgString,
} from '../../src/ui/web/icons.js';

/**
 * icons.js 单测：一笔画描边图标（16 视口 / currentColor / 1.5 / round）——
 * 「乱图标」修复的钉点：每个 d 串非空、绝对坐标（M 起笔）、参数化尺寸带
 * currentColor；DOM 版走 createElementNS（永不 innerHTML，见文件内容断言）。
 * 全部为纯函数（node 环境，无 DOM —— iconSvgString 做字符串断言）。
 */

describe('ICONS 表完整性（固定视口 + 冻结，防运行时改串）', () => {
  it('全部图标名非空冻结；每图标 ≥1 个非空 d 串且绝对起笔', () => {
    const names = Object.keys(ICONS);
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) {
      const spec = ICONS[name as keyof typeof ICONS];
      expect(Object.isFrozen(spec)).toBe(true);
      expect(spec.d.length).toBeGreaterThan(0);
      for (const d of spec.d) {
        expect(d.length).toBeGreaterThan(0);
        expect(d.startsWith('M')).toBe(true); // 绝对坐标起笔（不落相对起点）
        expect(d).toMatch(/^[0-9A-Za-z ,.-]+$/); // 纯 SVG path 字元（无脚本面）
      }
    }
    expect(Object.isFrozen(ICONS)).toBe(true);
  });

  it('每个图标在使用字集内（侧栏/组/菜单/目录浏览/空态全部入口）', () => {
    expect(iconPaths('folderClosed')).not.toBeNull();
    expect(iconPaths('folderOpen')).not.toBeNull();
    expect(iconPaths('folderPlus')).not.toBeNull();
    expect(iconPaths('plus')).not.toBeNull();
    expect(iconPaths('chevronRight')).not.toBeNull();
    expect(iconPaths('kebab')).not.toBeNull();
    expect(iconPaths('check')).not.toBeNull();
    expect(iconPaths('trash')).not.toBeNull();
    expect(iconPaths('upDir')).not.toBeNull();
    expect(iconPaths('nope')).toBeNull(); // 未知名 → null（调用方防御）
  });
});

describe('iconSvgString（node 单测用的字符串版；绝不进 innerHTML 路径）', () => {
  it('每个图标：完整 stroke 几何语言（currentColor / fill none / 1.5 / round / 16 视口）', () => {
    for (const name of Object.keys(ICONS)) {
      const svg = iconSvgString(name);
      expect(svg).not.toBeNull();
      expect(svg!).toContain(`<path d="`);
      expect(svg!).toContain('fill="none"');
      expect(svg!).toContain('stroke="currentColor"');
      expect(svg!).toContain(`stroke-width="${ICON_STROKE}"`);
      expect(svg!).toContain('stroke-linecap="round"');
      expect(svg!).toContain('stroke-linejoin="round"');
      expect(svg!).toContain(`viewBox="${ICON_VIEWBOX}"`);
      expect(svg!).toContain('aria-hidden="true"');
      expect(svg!).toContain(`width="16"`);
      expect(svg!).toContain(`height="16"`);
    }
  });

  it('参数化尺寸 / 描边宽 / 类名：size=20 与 strokeWidth 覆盖、className 透传', () => {
    const svg = iconSvgString('plus', { size: 20, strokeWidth: 2, className: 'foo' });
    expect(svg).toContain('width="20"');
    expect(svg).toContain('height="20"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain('foo');
  });

  it('多 path 图标（folderPlus = 底形 + 加号）每段独立 <path>', () => {
    const svg = iconSvgString('folderPlus');
    expect(svg!.split('<path ').length - 1).toBe(2);
  });

  it('尺寸参数防御：0/NaN/负值 → 回落 16', () => {
    const svg = iconSvgString('check', { size: 0 });
    expect(svg).toContain('width="16"');
    expect(iconSvgString('check', { size: Number.NaN })).toContain('width="16"');
    expect(iconSvgString('check', { size: -3 })).toContain('width="16"');
  });

  it('未知名 → null（调用方防御不渲染损坏图标）', () => {
    expect(iconSvgString('bogus')).toBeNull();
  });
});

describe('icons.js 纪律：无 innerHTML（字符串版仅测试用）', () => {
  it('源文件不含 innerHTML / outerHTML / insertAdjacentHTML', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../src/ui/web/icons.js'), 'utf8');
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(ICON_NS).toBe('http://www.w3.org/2000/svg');
  });
});

describe('imagePlus（ADR-0015：composer 附件钮图标）', () => {
  it('图标在表内：3 段 d 串（外框/山形/加号），绝对起笔，round cap 语言同族', () => {
    const paths = iconPaths('imagePlus');
    expect(paths).not.toBeNull();
    expect(paths!.length).toBe(3);
    for (const d of paths!) {
      expect(d.startsWith('M')).toBe(true);
    }
  });
});
