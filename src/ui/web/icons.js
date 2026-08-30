/**
 * # icons.js — 线描图标单一来源（16 视口；stroke=currentColor / fill=none / 1.5 / round）
 *
 * 背景（修「乱图标」）：侧栏组行 folder slot 与「对话」区头「添加工作区」此前的
 * 路径是**叠块填塞**（16px 下呈实心疙瘩/乱线）——用户实测视为 tofu/
 * 烂 glyph。本模块把全部侧栏/弹窗/空态图标改为**一笔画描边轮廓**（与权限
 * chip 盾形 glyph 同几何语言），d 串单一来源，装配职责在 app.js。
 *
 * 纪律：
 * - 全部 viewBox = 0 0 16 16（chevron 沿用 14 三角形同坐标、升格 16 视口）；
 * - DOM 装配只走 createElementNS（禁止 HTML 注入面字符串渲染）；
 *   iconSvgString 仅供 node 单测做字符串断言，运行时不用于任何注入面。
 *
 * 每图标 = 顺序绘制的 d 串数组（首个元素为底形）；ICONS 冻结，防运行时改串。
 */

export const ICON_NS = 'http://www.w3.org/2000/svg';
export const ICON_VIEWBOX = '0 0 16 16';
/** 统一描边宽度（与权限 glyph 同族 1.5）。 */
export const ICON_STROKE = 1.5;

/**
 * 文件夹（close 态）：圆角方形轮廓 + 左上分页斜角（dsh folder 标准形）。
 * 可视界 [0.65,15.55]×[2.95,14.25]（含 1.5 描边半宽），slot 16×20 内居。
 */
const D_FOLDER_CLOSED =
  'M2.6 3.7h4.2l1.2 1.2h5.6a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H2.6a1.2 1.2 0 0 1-1.2-1.2V4.9a1.2 1.2 0 0 1 1.2-1.2Z';

/** 文件夹（open 态）：前页翻起的「开口」形 —— 斜掠盖边 + 底部槽体。 */
const D_FOLDER_OPEN =
  'M4 9.3l1.15-2.3a1.3 1.3 0 0 1 1.2-.8h6.9a1.3 1.3 0 0 1 1.27 1.63l-1 3.8a1.3 1.3 0 0 1-1.27.97H2.9a1.3 1.3 0 0 1-1.3-1.3V3.6a1.3 1.3 0 0 1 1.3-1.3h2.3l1.35 1.1a1.3 1.3 0 0 0 1.3.53h4.35a1.3 1.3 0 0 1 1.3 1.3v.9';

/** 图标表（name → d 串数组；冻结防漂移）。 */
export const ICONS = Object.freeze({
  /** 组行 folder slot / 空态「选择工作区…」/ 目录弹窗行（关闭态）。 */
  folderClosed: Object.freeze({ d: Object.freeze([D_FOLDER_CLOSED]) }),
  /** 组行 folder slot（展开态）。 */
  folderOpen: Object.freeze({ d: Object.freeze([D_FOLDER_OPEN]) }),
  /** 「对话」区头「添加工作区」（folder + 加号；dsh IconProjectAddOutline16）。 */
  folderPlus: Object.freeze({
    d: Object.freeze([D_FOLDER_CLOSED, 'M10.05 7.9v3.2M8.45 9.5h3.2']),
  }),
  /** 组内新建 / 新建菜单「添加工作区…」（dsh IconPlusOutline16）。 */
  plus: Object.freeze({ d: Object.freeze(['M8 3.4v9.2M3.4 8h9.2']) }),
  /** 行 hover 箭头（右向；展开 90° 旋转由 CSS .arrow 处理）。 */
  chevronRight: Object.freeze({ d: Object.freeze(['M5.4 3.3l5 4.7-5 4.7Z']) }),
  /** 行 kebab（竖三点；短笔画 + round cap = 点）。 */
  kebab: Object.freeze({ d: Object.freeze(['M8 2.55v.9M8 7.55v.9M8 12.55v.9']) }),
  /** 新建菜单「勾选当前工作区」。 */
  check: Object.freeze({ d: Object.freeze(['M3.4 8.4l3.2 3.1L12.6 4.9']) }),
  /** 行菜单「删除会话」。 */
  trash: Object.freeze({
    d: Object.freeze([
      'M3 4.5h10M6.2 4.5V3.2h3.6v1.3M4.7 4.5l.35 8.1c.03.5.4.9.9.9h4.1c.5 0 .87-.4.9-.9l.35-8.1M6.7 7v3.7M9.3 7v3.7',
    ]),
  }),
  /** 目录弹窗 `..` 上级行（arrow-up + 下基线）。 */
  upDir: Object.freeze({ d: Object.freeze(['M3.2 12.8h9.6M8 3.6v6M5 6.4L8 3.4l3 3']) }),
  /** 「对话」区头搜索（dsh WorkspaceBrowser search：放大镜 + 柄；过滤会话行）。 */
  search: Object.freeze({
    d: Object.freeze([
      'M6.9 3.35a3.55 3.55 0 1 1-.01 7.1A3.55 3.55 0 0 1 6.9 3.35zM9.7 9.7l3.1 3.1',
    ]),
  }),
  /** 「对话」区头排序（dsh sort：左升右降双箭头 —— 点击轮换 时间/名称）。 */
  sort: Object.freeze({
    d: Object.freeze([
      'M5.1 12.7V3.3M5.1 6.3 3.3 8.1M5.1 6.3l1.8 1.8',
      'M10.9 3.3v9.4M10.9 9.7l-1.8-1.8M10.9 9.7l1.8-1.8',
    ]),
  }),
  /** 审查块 leading（dsh shieldCheck：盾形轮廓 + 内勾；review-block 专属）。 */
  shieldCheck: Object.freeze({
    d: Object.freeze([
      'M8 2.1l4.9 1.6v3.5c0 3.2-2 5.5-4.9 6.7-2.9-1.2-4.9-3.5-4.9-6.7V3.7L8 2.1Z',
      'M5.6 8.1l1.7 1.7 3.1-3.4',
    ]),
  }),
  /** composer 附件钮（ADR-0015：图像加号——外框圆角矩形 + 山形/山 + 中心加号；
   * 与 side/slot 图标同几何语言，16px 下不糊）。 */
  imagePlus: Object.freeze({
    d: Object.freeze([
      'M3.4 4.4a1.2 1.2 0 0 1 1.2-1.2h6.8a1.2 1.2 0 0 1 1.2 1.2v7.2a1.2 1.2 0 0 1-1.2 1.2H4.6a1.2 1.2 0 0 1-1.2-1.2V4.4Z',
      'M5.2 9.8l1.9-2.2 1.5 1.5 1.2-1.3 1.5 2',
      'M11.6 3.9v2.4M10.4 5.1h2.4',
    ]),
  }),
});

/** 图标存在性（未知名 → null；调用方防御：null 时只挂空 slots）。 */
export function iconPaths(name) {
  const spec = ICONS[name];
  return spec ? spec.d : null;
}

/** 统一 path 属性（stroke 几何语言；全部图标同族）。 */
function strokePathAttrs(path, strokeWidth) {
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', String(strokeWidth));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  return path;
}

/**
 * DOM 版图标（app.js 装配全部走此口）：createElementNS，永不入 HTML 注入面。
 * @param {string} name ICONS 键
 * @param {{size?: number, strokeWidth?: number, className?: string}} [opts]
 * @returns {SVGSVGElement|null} 未知名 → null
 */
export function iconSvg(name, { size = 16, strokeWidth = ICON_STROKE, className = '' } = {}) {
  const paths = iconPaths(name);
  if (paths === null) return null;
  const n = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : 16;
  const sw =
    Number.isFinite(Number(strokeWidth)) && Number(strokeWidth) > 0
      ? Number(strokeWidth)
      : ICON_STROKE;
  const svg = document.createElementNS(ICON_NS, 'svg');
  svg.setAttribute('viewBox', ICON_VIEWBOX);
  svg.setAttribute('width', String(n));
  svg.setAttribute('height', String(n));
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const d of paths) {
    const path = strokePathAttrs(document.createElementNS(ICON_NS, 'path'), sw);
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * 字符串版图标（node 单测专用：断言 d 串/尺寸/currentColor 完整性）。
 * 纪律：字符串版仅测试断言 —— 运行时一律 iconSvg（DOM 装配）。
 * @returns {string|null} 未知名 → null
 */
export function iconSvgString(name, { size = 16, strokeWidth = ICON_STROKE, className = '' } = {}) {
  const paths = iconPaths(name);
  if (paths === null) return null;
  const n = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : 16;
  const sw =
    Number.isFinite(Number(strokeWidth)) && Number(strokeWidth) > 0
      ? Number(strokeWidth)
      : ICON_STROKE;
  const cls = className ? ` class="${className}"` : '';
  const body = paths
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');
  return `<svg xmlns="${ICON_NS}" viewBox="${ICON_VIEWBOX}" width="${n}" height="${n}" aria-hidden="true"${cls}>${body}</svg>`;
}
