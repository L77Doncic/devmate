import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../src/shared/llm-types.js';
import {
  estimateTextTokens,
  estimateTokens,
  TokenEstimateCalibrator,
} from '../../src/core/context/estimator.js';

/**
 * 估算器（切片 a）：L2 分类加权启发式 + Cookbook 结构开销（A-1 体系）。
 * 全部预期值为手算：字符分类照「CJK 1/字、ASCII 连续段 ceil(len/K)、其余逐字 1」，
 * 结构开销照 §1.3 的 Cookbook 常数表字面量。
 */
describe('估算器：正文文本估算（K=4 散文 / K=3 代码）', () => {
  it('ASCII 连续段按 ceil(len/K)；空白与标点逐字计 1', () => {
    expect(estimateTextTokens('abcd', 4)).toBe(1);
    expect(estimateTextTokens('abcde', 4)).toBe(2);
    expect(estimateTextTokens('a b', 4)).toBe(3);
    expect(estimateTextTokens('x=1\n', 3)).toBe(4);
  });

  it('CJK 每字 1 token（含 CJK 标点与全角区）；之后回段重新计长', () => {
    expect(estimateTextTokens('你好', 4)).toBe(2);
    expect(estimateTextTokens('你好ab', 4)).toBe(3); // 2 + ceil(2/4)
    expect(estimateTextTokens('，。', 4)).toBe(2); // 全角标点
  });

  it('JSON/代码属 K=3：{"ok": true} 手算 8 + 标点', () => {
    expect(estimateTextTokens('{"ok": true}', 3)).toBe(9);
  });
});

describe('估算器：消息结构开销（每消息 +3、回复 priming +3；A-1）', () => {
  it('单用户消息：正文 1 + 结构 3+3 = 7', () => {
    const est = estimateTokens([{ role: 'user', content: 'hi' }]);
    expect(est.tokens).toBe(7);
    expect(est.parts.contentTokens).toBe(1);
    expect(est.parts.messageOverhead).toBe(6);
    expect(est.parts.toolsOverhead).toBe(0);
  });

  it('两条消息：正文 2 + 结构 3×2+3 = 11', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo', toolCalls: [] },
    ];
    expect(estimateTokens(messages).tokens).toBe(11);
  });

  it('assistant 工具调用 args 计入正文（K=3）：名字 1 + 参数 2 + 结构 6 = 9', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
      },
    ];
    const est = estimateTokens(messages);
    expect(est.tokens).toBe(9);
    expect(est.parts.contentTokens).toBe(3);
  });

  it('tool 角色消息按 K=3 计正文：{"ok":true} 8 字 + 结构 6 = 14', () => {
    const messages: ChatMessage[] = [{ role: 'tool', content: '{"ok":true}', toolCallId: 'c1' }];
    const est = estimateTokens(messages);
    expect(est.tokens).toBe(14);
    expect(est.parts.contentTokens).toBe(8);
  });
});

describe('估算器：工具定义结构开销（每 function +7、name/description 正文另计、每 property/key +3、enum -3 每项 +3、收尾 +12；§1.3 字面量）', () => {
  const userOnly: ChatMessage[] = [{ role: 'user', content: 'hi' }];

  it('未传 tools 时不计工具开销；传空数组算收尾 +12', () => {
    expect(estimateTokens(userOnly).parts.toolsOverhead).toBe(0);
    expect(estimateTokens(userOnly, []).parts.toolsOverhead).toBe(12);
    expect(estimateTokens(userOnly, []).tokens).toBe(19); // 1 + 6 + 12
  });

  it('一个空参数 function：12 + 7 + name(ceil(2/3)=1) = 20 → 总计 27', () => {
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'ls', parameters: { type: 'object', properties: {} } },
      },
    ];
    const est = estimateTokens(userOnly, tools);
    expect(est.tokens).toBe(27);
    expect(est.parts.toolsOverhead).toBe(20);
  });

  it('一个 string 属性：12 + 7 + 1(name) + 3(属性) + 3(键) = 26 → 总计 33', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'ls',
          parameters: { type: 'object', properties: { x: { type: 'string' } } },
        },
      },
    ];
    const est = estimateTokens(userOnly, tools);
    expect(est.parts.toolsOverhead).toBe(26);
    expect(est.tokens).toBe(33);
  });

  it('enum 属性：-3 且每枚举项 +3（base 6 → 3+2×3=9）→ 工具段 29', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'ls',
          parameters: {
            type: 'object',
            properties: { x: { type: 'string', enum: ['a', 'b'] } },
          },
        },
      },
    ];
    const est = estimateTokens(userOnly, tools);
    expect(est.parts.toolsOverhead).toBe(29); // 12+7+1+6-3+6
    expect(est.tokens).toBe(36);
  });

  it('description 计入工具开销：长描述调用面不再低估（§1.3 Cookbook 口径）', () => {
    const longDesc = 'd'.repeat(4000); // K=4 散文：ceil(4000/4) = 1000
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'ls',
          description: longDesc,
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    const est = estimateTokens(userOnly, tools);
    expect(est.parts.toolsOverhead).toBe(12 + 7 + 1 + 1000); // 1020
    expect(est.tokens).toBe(1020 + 7); // 1(hi) + 6(消息结构) + 1020
  });
});

describe('估算器：估算 ≠ 精确（标注近似，§1.1/§1.2）', () => {
  it('结果恒带 approximate: true 字面量', () => {
    const est = estimateTokens([{ role: 'user', content: 'hi' }]);
    expect(est.approximate).toBe(true);
    // 字面量类型：赋成 false 在类型上不可能。
    est.approximate satisfies true;
  });

  it('消息级 name 附加开销：ChatMessage 无 name 字段，结构开销不依赖 name（tokens_per_name 无消费者，常数已删）', () => {
    // 说明性断言：结构开销只到消息 +3、无 name 附加项（TOKENS_PER_NAME 为 speculative generality，已删除）。
    const est = estimateTokens([{ role: 'user', content: 'hi' }]);
    expect(est.parts.messageOverhead).toBe(6);
    expect(est.messageCount).toBe(1);
  });
});

describe('估算器：L0 事后校准系数（估算 × EMA 系数；ADR-0012「滑动更新校正系数」）', () => {
  it('默认系数 1：apply 原样（未校准 = 原估算）', () => {
    const c = new TokenEstimateCalibrator();
    expect(c.coefficient).toBe(1);
    expect(c.apply(12)).toBe(12);
  });

  it('update = actual/estimated ratio 的 0.5 平滑（EMA）：单次 update 后系数向 ratio 靠拢', () => {
    const c = new TokenEstimateCalibrator();
    c.update(12, 18); // ratio 1.5 → 0.5×1 + 0.5×1.5 = 1.25
    expect(c.coefficient).toBeCloseTo(1.25, 12);
    expect(c.apply(16)).toBe(20); // round(16×1.25)
  });

  it('两轮后偏差缩小：低估 18 vs 12，连续两次 update 后 |actual − est×coef| 变小', () => {
    const c = new TokenEstimateCalibrator();
    c.update(12, 18);
    c.update(12, 18);
    expect(c.coefficient).toBeCloseTo(1.375, 12); // 0.5×1.25 + 0.5×1.5
    const est = c.apply(12); // round(12×1.375) = 17
    expect(Math.abs(18 - est)).toBeLessThan(Math.abs(18 - 12)); // 偏差 1 < 6
  });

  it('damping 可配置（1 = 直接采用最新 ratio）；estimated ≤ 0 时忽略不更新', () => {
    const c = new TokenEstimateCalibrator({ damping: 1 });
    c.update(12, 18);
    expect(c.coefficient).toBeCloseTo(1.5, 12);
    c.update(0, 100);
    expect(c.coefficient).toBeCloseTo(1.5, 12);
  });
});

// ---------------------------------------------------------------------------
// 图像 token（ADR-0015）：DeepSeek 近似公式（official cap 384；<384×384 放大 / >800×800
// 缩小；512px 瓦片 × 96 token；deepseek-vision.md §2——所有预期值为公式手算）
// ---------------------------------------------------------------------------

import { estimateImageTokens, IMAGE_TOKENS_CAP } from '../../src/core/context/estimator.js';

describe('估算器：图像 token（ADR-0015 近似公式）', () => {
  it('240×240（<384×384 面积）→ 放大至 384×384 → 1 瓦片 × 96 = 96', () => {
    expect(estimateImageTokens(240, 240)).toBe(96);
  });

  it('384×384（恰在放大阈值内——面积不小于阈值则原样）→ 1 瓦片 = 96', () => {
    expect(estimateImageTokens(384, 384)).toBe(96);
  });

  it('800×800（官方缩放宽/瓦片 2×2）→ 4 瓦片 × 96 = 384 = 上限', () => {
    expect(estimateImageTokens(800, 800)).toBe(IMAGE_TOKENS_CAP);
  });

  it('2000×2000 与 5000×5000（官方同 token 示例）→ 同为 384（封顶）', () => {
    expect(estimateImageTokens(2000, 2000)).toBe(IMAGE_TOKENS_CAP);
    expect(estimateImageTokens(5000, 5000)).toBe(IMAGE_TOKENS_CAP);
  });

  it('1×1（极端小图）→ 放大计算 → ≥1 瓦片 = 96（每图下限，不因尺寸归零）', () => {
    expect(estimateImageTokens(1, 1)).toBe(96);
  });

  it('宽高缺省（未知尺寸）→ 按上限档 800×800 估 = 384（保守）', () => {
    expect(estimateImageTokens()).toBe(IMAGE_TOKENS_CAP);
    expect(estimateImageTokens(undefined, undefined)).toBe(IMAGE_TOKENS_CAP);
  });

  it('非法尺寸输入（0/负数/NAN/字符串）→ 该边回落缺省 800；全非法 → 800×800 = 384（不抛错）', () => {
    // 宽非法（回落 800）× 高 100：800×100 面积 < 384² → 放大至 384² → 1086×136 → 3 瓦片
    expect(estimateImageTokens('0' as unknown as number, 100 as unknown as number)).toBe(288);
    expect(estimateImageTokens(Number.NaN, 800)).toBe(IMAGE_TOKENS_CAP);
    expect(estimateImageTokens(0, -5)).toBe(IMAGE_TOKENS_CAP);
  });

  it('多模态消息：parts.imageTokens 独立计量；tokens = 正文 + 图像 + 结构开销', () => {
    const est = estimateTokens([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,x' },
            width: 800,
            height: 800,
          },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,y' },
            width: 240,
            height: 240,
          },
        ],
      },
    ]);
    expect(est.parts.imageTokens).toBe(384 + 96);
    expect(est.parts.contentTokens).toBe(1); // 'hi' → 1（图片不进 contentTokens）
    expect(est.parts.messageOverhead).toBe(6);
    expect(est.tokens).toBe(384 + 96 + 1 + 6);
  });

  it('纯文本消息：imageTokens 恒 0（旧路径零扰动）', () => {
    const est = estimateTokens([{ role: 'user', content: 'hi' }]);
    expect(est.parts.imageTokens).toBe(0);
    expect(est.tokens).toBe(7);
  });
});
