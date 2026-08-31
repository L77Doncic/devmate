/**
 * # meter.js — 上下文窗口占用环（dsh ContextMeter 语义）纯逻辑（node 可直接 import）
 *
 * 场景：composer 与 stats 行之间的 28px 环形条 —— 占用量 =
 * 最近一次 usage.contextEstimateTokens / settings.window（无 window → 「—」+
 * tooltip「模型窗口未配置（估算模式）」）。权重只有三个：ratio / tier / aria，
 * 全部纯函数；环的几何（SVG dasharray）与配色属 DOM/CSS 层（app.js/style.css）。
 *
 * 空态：估算缺失（null/undefined —— 尚无 usage 数据 / 会话未启动）= 0 占用，
 * 显示 0% 灰色空环（诚实空态：未测量即未使用，不伪造数值）；tooltip 说明
 * 「尚未运行：暂无上下文估算，运行后显示实时占用」。
 *
 * 阈值：> 80% → warn（琥珀）、> 95% → danger（红）；dsh 同族阈值以
 * ContextMeter.css 与 style.css 的 token 为准（--warn / --danger 单一来源）。
 */

/** 琥珀阈值（严格大于；dsh 同族：超过 80% 才告警）。 */
export const METER_WARN_RATIO = 0.8;
/** 红色阈值（严格大于 95%，红——与 dsh 同类「接近爆窗」语义）。 */
export const METER_DANGER_RATIO = 0.95;

/** 环的半径（与 style.css .meter-track/.meter-fill r=11 同值：28px 面板直径 - 2px 描边）。 */
export const METER_RADIUS = 11;

/** 周长（2πr；供 app.js 算 strokeDashoffset —— 单一数值不可在 CSS/JS 两侧漂移）。 */
export function meterCircumference(radius = METER_RADIUS) {
  return 2 * Math.PI * radius;
}

/**
 * 占用比：contextTokens / window，夹取到 [0, 1]（超窗 → 1 = 满环）。
 * 空态：估算缺失（null/undefined —— 无 usage 数据/会话未启动）= 0（0% 空环）。
 * 数据非法（非 number、NaN、负数、非整数 window）→ null（「—」= 未知）；
 * **只认 number** —— Number(null)=0 / Number('')=0 会把「缺失」误判成「0 占用」
 * （同 messages.js numOr 的反 0 陷阱）；null/undefined 显式归零是空态语义，
 * 不是 Number() 式误判 —— 与「含消息但估算非法」的 null 保持区分。
 */
export function meterRatio(contextTokens, windowTokens) {
  if (contextTokens === null || contextTokens === undefined) return 0; // 空态：未测量 = 0 占用
  if (typeof contextTokens !== 'number' || typeof windowTokens !== 'number') return null;
  const c = contextTokens;
  const w = windowTokens;
  if (!Number.isFinite(c) || c < 0) return null;
  if (!Number.isFinite(w) || w < 1 || !Number.isInteger(w)) return null;
  return Math.min(1, c / w);
}

/**
 * 色阶：'normal'（中性）/ 'warn'（琥珀，>80%）/ 'danger'（红，>95%）/
 * 'unknown'（窗口未配置 → 「—」）。比例越界夹取后再判档。
 */
export function meterTier(ratio) {
  if (ratio === null) return 'unknown';
  const r = Math.min(1, Math.max(0, Number(ratio)));
  if (r > METER_DANGER_RATIO) return 'danger';
  if (r > METER_WARN_RATIO) return 'warn';
  return 'normal';
}

/** 环内或旁的百分比文本：有窗 → '38%'；无窗 → '—'；空态（无估算）→ '0%'（tooltip 区分见 meterTooltip）。 */
export function meterPercentText(contextTokens, windowTokens) {
  const ratio = meterRatio(contextTokens, windowTokens);
  if (ratio === null) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** 悬停 tooltip：有窗 → 数值式；无窗 → 估算模式说明；空态（无估算）→ 未运行说明（文案单一来源）。 */
export function meterTooltip(contextTokens, windowTokens, formatTokensFn) {
  if (contextTokens === null || contextTokens === undefined)
    return '尚未运行：暂无上下文估算，运行后显示实时占用';
  const ratio = meterRatio(contextTokens, windowTokens);
  if (ratio === null) return '模型窗口未配置（估算模式）';
  const fmt = typeof formatTokensFn === 'function' ? formatTokensFn : (n) => String(n);
  return `上下文占用 ${Math.round(ratio * 100)}%（${fmt(contextTokens)} / ${fmt(windowTokens)} tokens）`;
}

/** 无障碍标签（读屏）：与 tooltip 同源文案；无窗态明确「未知」。 */
export function meterAriaLabel(contextTokens, windowTokens, formatTokensFn) {
  return meterTooltip(contextTokens, windowTokens, formatTokensFn);
}
