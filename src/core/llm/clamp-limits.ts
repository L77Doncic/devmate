/**
 * # clamp-limits：请求侧输入/输出上限钳制（S 档；ADR-0016）
 *
 * 纯函数、零 IO、preset 数据驱动（同一张上限表唯一来源）：
 * - 输出 > provider.maxOutputTokens（该供应商**有据**上限）→ 钳到上限 + clampedMaxOutput；
 *   无上限字段（undefined = 无据/模型各异，dashscope/openai 当前口径）→ 不钳、不打标
 *   （保留用户值直发，由「超限报错 → 钳制重试」链兜底——绝不本地猜数）。
 * - 输入 > provider.contextWindowTokens → 钳到窗口 + clampedMaxInput。
 *
 * 契约（settings POST / GET 共用）：
 * - 钳制值 = 持久化值（settings 存**钳后值**——保存的即生效值）；
 * - GET 经 clamped 键回执（与 Default 标记机制同族：触达 UI「已按 <model> 上限钳制为 N」）；
 * - 输入有值、输出有值各自独立判定（一维缺省不影响另一维）。
 */
import type { ProviderPreset } from './provider-adapter.js';

/** 钳制输入（settings POST 的 parsed 值；均为严格正整数或未设）。 */
export interface ClampLimitsInput {
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ClampLimitsResult {
  /** 钳后输入上限（未设 → 无键）。 */
  maxInputTokens?: number;
  /** 钳后输出上限（未设 → 无键）。 */
  maxOutputTokens?: number;
  /** 输入被钳制（> provider.contextWindowTokens）。 */
  clampedMaxInput: boolean;
  /** 输出被钳制（> provider.maxOutputTokens 且该供应商有据）。 */
  clampedMaxOutput: boolean;
}

export function clampLimits(input: ClampLimitsInput, provider: ProviderPreset): ClampLimitsResult {
  let maxInputTokens = input.maxInputTokens;
  const clampedMaxInput =
    maxInputTokens !== undefined && maxInputTokens > provider.contextWindowTokens;
  if (clampedMaxInput) maxInputTokens = provider.contextWindowTokens;

  let maxOutputTokens = input.maxOutputTokens;
  const cap = provider.maxOutputTokens;
  const clampedMaxOutput =
    cap !== undefined && maxOutputTokens !== undefined && maxOutputTokens > cap;
  if (clampedMaxOutput) maxOutputTokens = cap;

  return {
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    clampedMaxInput,
    clampedMaxOutput,
  };
}
