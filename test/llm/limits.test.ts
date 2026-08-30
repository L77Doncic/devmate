/**
 * # test/llm/limits：上限钳制（clampLimits）+ 超限错误分类器（classifyContextError）
 * + 上限表断言（S/M 档；ADR-0016）
 *
 * 蓝本 = .scratch/coding-agent/research/limits-effects-and-overflow.md（S1/S2/M1）：
 * - clampLimits 纯函数矩阵：输出 > provider.maxOutputTokens → 钳 + clampedMaxOutput；
 *   输入 > provider.contextWindowTokens → 钳 + clampedMaxInput；
 *   无据供应商（maxOutputTokens 无值 = dashscope/openai 待实测/模型各异）→ 输出不钳。
 * - classifyContextError 词表（B.a 三大家实测/文档 + dsh 分类器等价物）：
 *   context-exceeded（上下文超窗）与 output-limit（输出区间）两个子类；
 *   hintMax 从 message 解析（`[1, 393216]` → 393216——DeepSeek 实测形状；
 *   "maximum context length is N" → N——OpenAI 形状）。
 * - presets 上限表：deepseek 窗口 1M（实测过 1M）/ 输出 393216（2026-08-30 实测
 *   valid-range [1, 393216]）；kimi/glm 输出 131072（API-SPEC §5.2）；dashscope/openai 无据 → null。
 */
import { describe, expect, it } from 'vitest';
import { clampLimits } from '../../src/core/llm/clamp-limits.js';
import { classifyContextError } from '../../src/core/llm/error-parse.js';
import {
  PROVIDER_PRESETS,
  defaultProviderPreset,
  providerPresetOfBaseUrl,
} from '../../src/core/llm/presets.js';

// ---------------------------------------------------------------------------
// clampLimits（S 档；纯函数矩阵）
// ---------------------------------------------------------------------------

describe('clampLimits（S 档钳制；ADR-0016）', () => {
  it('deepseek：输出 500000 → 393216 + clampedMaxOutput；输入 2000000 → 1000000 + clampedMaxInput', () => {
    const r = clampLimits(
      { maxInputTokens: 2_000_000, maxOutputTokens: 500_000 },
      PROVIDER_PRESETS.deepseek,
    );
    expect(r).toEqual({
      maxInputTokens: 1_000_000,
      maxOutputTokens: 393_216,
      clampedMaxInput: true,
      clampedMaxOutput: true,
    });
  });

  it('边界：等于上限不钳（393216 / 1000000 原样，标记 false）', () => {
    const r = clampLimits(
      { maxInputTokens: 1_000_000, maxOutputTokens: 393_216 },
      PROVIDER_PRESETS.deepseek,
    );
    expect(r.maxOutputTokens).toBe(393_216);
    expect(r.clampedMaxOutput).toBe(false);
    expect(r.maxInputTokens).toBe(1_000_000);
    expect(r.clampedMaxInput).toBe(false);
  });

  it('低于上限不钳：输出 2048 / 输入 4096 原样', () => {
    const r = clampLimits(
      { maxInputTokens: 4096, maxOutputTokens: 2048 },
      PROVIDER_PRESETS.deepseek,
    );
    expect(r).toEqual({
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
      clampedMaxInput: false,
      clampedMaxOutput: false,
    });
  });

  it('kimi/glm：输出 500000 → 131072 + 标记', () => {
    const rk = clampLimits({ maxOutputTokens: 500_000 }, PROVIDER_PRESETS.kimi);
    expect(rk.maxOutputTokens).toBe(131_072);
    expect(rk.clampedMaxOutput).toBe(true);
    const rg = clampLimits({ maxOutputTokens: 200_000 }, PROVIDER_PRESETS.glm);
    expect(rg.maxOutputTokens).toBe(131_072);
    expect(rg.clampedMaxOutput).toBe(true);
  });

  it('无据供应商（dashscope/openai 无 maxOutputTokens）：输出不钳（原值 + 标记 false）；输入仍按窗口钳', () => {
    const rd = clampLimits(
      { maxInputTokens: 200_000, maxOutputTokens: 500_000 },
      PROVIDER_PRESETS.dashscope,
    );
    expect(rd.maxOutputTokens).toBe(500_000);
    expect(rd.clampedMaxOutput).toBe(false);
    expect(rd.maxInputTokens).toBe(128_000);
    expect(rd.clampedMaxInput).toBe(true);
    const ro = clampLimits({ maxOutputTokens: 10_000_000 }, PROVIDER_PRESETS.openai);
    expect(ro.maxOutputTokens).toBe(10_000_000);
    expect(ro.clampedMaxOutput).toBe(false);
    expect(ro.clampedMaxInput).toBe(false);
  });

  it('缺省字段：未给输入 → 不涉入（无入键、标记 false）；未给输出同理；空对象全 false', () => {
    const r = clampLimits({}, PROVIDER_PRESETS.deepseek);
    expect(r).toEqual({ clampedMaxInput: false, clampedMaxOutput: false });
    const rIn = clampLimits({ maxInputTokens: 4096 }, PROVIDER_PRESETS.deepseek);
    expect(rIn.maxOutputTokens).toBeUndefined();
    expect(rIn.clampedMaxOutput).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyContextError（M1；词表 + hintMax 解析）
// ---------------------------------------------------------------------------

describe('classifyContextError（M1 分类器；ADR-0016）', () => {
  it('context-exceeded 词表（上下文超窗类）', () => {
    for (const message of [
      "This model's maximum context length is 1024000 tokens. However, your messages resulted in 2000 tokens.",
      '{"error":{"code":"context_length_exceeded","message":"messages have too many tokens"}}',
      'some context length exceeded error',
      'maximum context window exceeded; please reduce the length of the messages',
      'context too long for this request',
      'prompt is too long',
      'too long for the model to process',
      'exceeds model context window',
      'InvalidParameter: Range of input length should be [1, 65536]',
    ]) {
      const c = classifyContextError(message);
      expect(c, message).not.toBeNull();
      expect(c!.kind).toBe('context-exceeded');
    }
  });

  it('output-limit 词表（输出区间类；DeepSeek/Qwen/GLM 实测形状）', () => {
    for (const message of [
      'Invalid max_tokens value, the valid range of max_tokens is [1, 393216]',
      'maximum output length exceeded',
      'maximum output tokens is 65536',
      'InternalError.Algo.InvalidParameter: Range of max_tokens should be [1, 65536]',
    ]) {
      const c = classifyContextError(message);
      expect(c, message).not.toBeNull();
      expect(c!.kind).toBe('output-limit');
    }
  });

  it('DeepSeek 实测形状：`[1, 393216]` 解析出 hintMax=393216', () => {
    const c = classifyContextError(
      'Invalid max_tokens value, the valid range of max_tokens is [1, 393216]',
    );
    expect(c).toEqual({ kind: 'output-limit', hintMax: 393_216 });
  });

  it('OpenAI 形状：`maximum context length is 1024000 tokens` → hintMax=1024000', () => {
    const c = classifyContextError(
      "This model's maximum context length is 1024000 tokens. However, your messages resulted in 1700 tokens. Please reduce the length of the messages.",
    );
    expect(c).toEqual({ kind: 'context-exceeded', hintMax: 1_024_000 });
  });

  it('Qwen 表单：`Range of max_tokens should be [1, 65536]` → output-limit 65536', () => {
    const c = classifyContextError(
      'InternalError.Algo.InvalidParameter: Range of max_tokens should be [1, 65536]',
    );
    expect(c).toEqual({ kind: 'output-limit', hintMax: 65_536 });
  });

  it('纯措辞命中（无数值）→ 无 hintMax；非超限错误 → null', () => {
    const c = classifyContextError('some context length error happened');
    expect(c).toEqual({ kind: 'context-exceeded' });
    for (const message of [
      'Invalid API key provided',
      'rate limit reached',
      'Internal server error',
      '',
      'valid range of peaches is [1, 5]',
      'max_tokens out of range',
      'context window is not mentioned here',
    ]) {
      expect(classifyContextError(message), message).toBeNull();
    }
  });

  it('大小写宽容（uppercase 措辞）与空串 null', () => {
    expect(classifyContextError('CONTEXT LENGTH EXCEEDED')).toEqual({ kind: 'context-exceeded' });
    expect(classifyContextError('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// providerPresetOfBaseUrl + presets 上限表
// ---------------------------------------------------------------------------

describe('providerPresetOfBaseUrl（S 档钳制用 provider 解析）', () => {
  it('逐家精确匹配（去尾斜杠）', () => {
    expect(providerPresetOfBaseUrl('https://api.deepseek.com').id).toBe('deepseek');
    expect(providerPresetOfBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1').id).toBe(
      'dashscope',
    );
    expect(providerPresetOfBaseUrl('https://open.bigmodel.cn/api/paas/v4/').id).toBe('glm');
    expect(providerPresetOfBaseUrl('https://api.moonshot.cn/v1').id).toBe('kimi');
  });
  it('未知端点/空串 → 主默认（deepseek）', () => {
    expect(providerPresetOfBaseUrl('https://unknown.example/v1').id).toBe('deepseek');
    expect(providerPresetOfBaseUrl('').id).toBe('deepseek');
    expect(defaultProviderPreset().id).toBe('deepseek');
  });
});

describe('presets 上限表（ADR-0016 断言更新）', () => {
  it('deepseek：contextWindowTokens=1_000_000（实测过 1M）；maxOutputTokens=393216（实测 valid-range）', () => {
    expect(PROVIDER_PRESETS.deepseek.contextWindowTokens).toBe(1_000_000);
    expect(PROVIDER_PRESETS.deepseek.maxOutputTokens).toBe(393_216);
  });
  it('kimi/glm：maxOutputTokens=131072；dashscope/openai 无据 → undefined（不钳）', () => {
    expect(PROVIDER_PRESETS.kimi.maxOutputTokens).toBe(131_072);
    expect(PROVIDER_PRESETS.glm.maxOutputTokens).toBe(131_072);
    expect(PROVIDER_PRESETS.dashscope.maxOutputTokens).toBeUndefined();
    expect(PROVIDER_PRESETS.openai.maxOutputTokens).toBeUndefined();
  });
  it('其余四家 contextWindowTokens 保持 128000（估算，可在设置覆盖）', () => {
    for (const id of ['dashscope', 'glm', 'kimi', 'openai'] as const) {
      expect(PROVIDER_PRESETS[id].contextWindowTokens).toBe(128_000);
    }
  });
});
