/**
 * meter.js 单测：上下文窗口占用环纯逻辑 —— 比例（夹取/缺窗）、色阶（>80% 琥珀、
 * >95% 红）、文本与 aria（「—」= 模型窗口未配置（估算模式））。
 */
import { describe, expect, it } from 'vitest';
import {
  METER_WARN_RATIO,
  METER_DANGER_RATIO,
  METER_RADIUS,
  meterRatio,
  meterTier,
  meterPercentText,
  meterTooltip,
  meterAriaLabel,
  meterCircumference,
} from '../../src/ui/web/meter.js';

const fmt = (n: number) => `${Math.round(n)}`;

describe('meterRatio', () => {
  it('contextTokens / windowTokens；夹取到 [0,1]（超窗 = 满环 1）', () => {
    expect(meterRatio(32_000, 64_000)).toBe(0.5);
    expect(meterRatio(64_000, 64_000)).toBe(1);
    expect(meterRatio(80_000, 64_000)).toBe(1); // 超窗 → 满环而非 >1
    expect(meterRatio(0, 64_000)).toBe(0);
  });

  it('缺窗（window null/0/负数/非整数）→ null：显示「—」+ 估算模式 tooltip', () => {
    expect(meterRatio(32_000, null)).toBeNull();
    expect(meterRatio(32_000, 0)).toBeNull();
    expect(meterRatio(32_000, -1)).toBeNull();
    expect(meterRatio(32_000, 64_000.5)).toBeNull(); // 非整数窗口（服务端校验正整，防御）
  });

  it('估算缺失/非法 → null', () => {
    expect(meterRatio(null, 64_000)).toBeNull();
    expect(meterRatio(undefined, 64_000)).toBeNull();
    expect(meterRatio(-1, 64_000)).toBeNull();
    expect(meterRatio(NaN, 64_000)).toBeNull();
  });
});

describe('meterTier（阈值：>80% 琥珀、>95% 红；值以 1 封顶）', () => {
  it('临界语义按「严格大于」', () => {
    expect(meterTier(0.8)).toBe('normal'); // 80% 整点不进琥珀
    expect(meterTier(0.81)).toBe('warn');
    expect(meterTier(0.95)).toBe('warn'); // 95% 整点不进红
    expect(meterTier(0.96)).toBe('danger');
    expect(meterTier(0.5)).toBe('normal');
    expect(meterTier(1)).toBe('danger');
  });
  it('阈值常量与需求逐值钉死（80% / 95%）', () => {
    expect(METER_WARN_RATIO).toBe(0.8);
    expect(METER_DANGER_RATIO).toBe(0.95);
  });
  it('null → unknown（缺窗档）；越界夹取判档', () => {
    expect(meterTier(null)).toBe('unknown');
    expect(meterTier(2)).toBe('danger');
    expect(meterTier(-1)).toBe('normal');
  });
});

describe('展示文本 / tooltip / aria', () => {
  it('百分比文本：四舍五入 + %；无窗 → —', () => {
    expect(meterPercentText(32_000, 64_000)).toBe('50%');
    expect(meterPercentText(1, 3)).toBe('33%'); // 0.3333→33
    expect(meterPercentText(32_000, null)).toBe('—');
  });
  it('tooltip：有窗数值式；无窗 = 「模型窗口未配置（估算模式）」', () => {
    expect(meterTooltip(32_000, 64_000, fmt)).toBe('上下文占用 50%（32000 / 64000 tokens）');
    expect(meterTooltip(32_000, null, fmt)).toBe('模型窗口未配置（估算模式）');
    expect(meterTooltip(null, 64_000, fmt)).toBe('模型窗口未配置（估算模式）');
  });
  it('aria 与 tooltip 同源（读屏 = 所见文本）', () => {
    expect(meterAriaLabel(32_000, 64_000, fmt)).toBe(meterTooltip(32_000, 64_000, fmt));
    expect(meterAriaLabel(32_000, null, fmt)).toContain('估算模式');
  });
});

describe('几何常量（与 style.css r=11 / 28px 环同值）', () => {
  it('半径 11；周长 2πr（dasharray 单值，防 JS/CSS 漂移）', () => {
    expect(METER_RADIUS).toBe(11);
    // 2π·11 ≈ 69.115（与 CSS 侧 stroke-dasharray 命名同源，见 app.js renderMeter 取值处）
    expect(meterCircumference()).toBeCloseTo(69.115, 2);
  });
});
