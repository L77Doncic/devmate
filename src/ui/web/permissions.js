/**
 * # permissions.js — dsh 式权限预设（PermissionSelect chip）纯逻辑（node 可直接 import）
 *
 * 服务端契约（S12/权限预设定案，src/ui/server/index.ts）：
 * - GET/POST /api/settings 的 `permission` 字段 = 'read-only' | 'workspace-write' | 'full-access'
 *   （缺省 'workspace-write'；POST 为补丁语义）；
 * - `permissionConfirmedAt`（epoch ms）= full-access 风险确认记录（GET 无记录则不带键；
 *   服务端在后端记录、不强制——确认门由前端负责，见 shouldConfirmRisk）。
 *
 * 本模块承载三档的**用户可见单一权威源**（标签/描述/盾形图标种类，防镜像漂移）与
 * 可测裁决：档位归一、已确认判定、风险门计算。网络读写（fetch）在 settings.js，不在此处。
 */

/** 三档枚举（顺序 = menu 展示顺序；与服务端 PERMISSION_PRESETS 一致）。 */
export const PERMISSION_VALUES = Object.freeze(['read-only', 'workspace-write', 'full-access']);

/** 缺省档（服务端 DEFAULT_PERMISSION_PRESET 同值：写文件不再弹窗）。 */
export const PERMISSION_DEFAULT = 'workspace-write';

/** 中档展示标签（chip 标签与 menu 行标题共用；单一来源防漂移）。 */
export const PERMISSION_LABELS = Object.freeze({
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'full-access': '全部访问',
});

/** 各档 menu 行描述（dsh PermissionSelect：选项行=glyph+名称+描述）。 */
export const PERMISSION_DESCRIPTIONS = Object.freeze({
  'read-only': '仅允许读取与只读命令；写操作与危险命令逐一问询',
  'workspace-write': '工作区写入直接执行；危险命令（rm -rf 等）自动拒绝',
  'full-access': '命令直接执行（含删除/破坏性操作），不再问询',
});

/** 各档盾形 glyph 种类（chip 与 menu 行共用；DOM 画法在 app.js —— 本模块只裁决种类）。 */
export const PERMISSION_GLYPHS = Object.freeze({
  'read-only': 'check',
  'workspace-write': 'pencil',
  'full-access': 'alert',
});

/** 风险确认门文案（Ctrl 面板复用删除确认视觉；逐字断言见 permissions.test.ts）。 */
export const RISK_CONFIRM_TITLE = '启用全部访问';
export const RISK_CONFIRM_TEXT = '全部访问：不再问询，命令直接执行（含删除/破坏性操作）。确认？';

/**
 * 档位归一：枚举值原样返回；非法/缺失 → PERMISSION_DEFAULT（闭集，不抛）。
 * @param {unknown} value
 * @returns {'read-only'|'workspace-write'|'full-access'}
 */
export function normalizePermission(value) {
  return PERMISSION_VALUES.includes(value) ? value : PERMISSION_DEFAULT;
}

/**
 * 档位标签（非法值按缺省档标签返回 —— 展示层永不裸露未知串）。
 * @param {unknown} value
 * @returns {string}
 */
export function permissionLabel(value) {
  return PERMISSION_LABELS[normalizePermission(value)];
}

/**
 * 档位描述（同归一语义）。
 * @param {unknown} value
 * @returns {string}
 */
export function permissionDescription(value) {
  return PERMISSION_DESCRIPTIONS[normalizePermission(value)];
}

/**
 * 档位 glyph 种类（归一语义；chip 图标与 menu 行图标同源）。
 * @param {unknown} value
 * @returns {'check'|'pencil'|'alert'}
 */
export function permissionGlyph(value) {
  return PERMISSION_GLYPHS[normalizePermission(value)];
}

/**
 * permissionConfirmedAt 归一：非负整数 number → 原样；否则 null（null = 无确认记录）。
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeConfirmedAt(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * 已确认判定：GET /api/settings 返回 permissionConfirmedAt（epoch ms）→ 已确认一次过。
 * @param {unknown} confirmedAt
 * @returns {boolean}
 */
export function isPermissionConfirmed(confirmedAt) {
  return normalizeConfirmedAt(confirmedAt) !== null;
}

/**
 * 风险门计算：切换目标是 full-access 且**没有**已确认记录时需要一次性风险确认门。
 * - 已确认过（GET 返回 confirmedAt）→ 下次直接生效（不挡）；
 * - read-only / workspace-write 永远零确认（一键切换）；
 * - 调用方负责「目标 === 当前」的 no-op 提前返回（本函数不判等 —— 切换才询门）。
 * @param {unknown} value 目标档位
 * @param {unknown} confirmedAt GET /api/settings 的 permissionConfirmedAt（缺省 null）
 * @returns {boolean}
 */
export function shouldConfirmRisk(value, confirmedAt) {
  return normalizePermission(value) === 'full-access' && !isPermissionConfirmed(confirmedAt);
}
