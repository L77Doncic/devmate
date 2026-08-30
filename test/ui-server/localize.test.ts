/**
 * # ui/server/localize：供应商报错本地化（P2-6/P2-8 —— 图片被拒/认证/网络 → 中文指引）
 * 纯函数单测：命中模式 → 中文一行；未命中 → null（零信息损失，调用方保留原文）。
 */
import { describe, expect, it } from 'vitest';
import { friendlyImageError, friendlyProviderError } from '../../src/ui/server/localize.js';

describe('friendlyImageError（图片被供应商拒收）', () => {
  it('不支持图像（走查原文 `.messages[1].image[0]: You have uploaded an unsupported image…`）→ 格式指引', () => {
    const out = friendlyImageError(
      '.messages[1].image[0]: You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif.',
    );
    expect(out).toContain('png');
    expect(out).not.toBeNull();
    expect(out).toContain('移除');
  });
  it('数量超限 → 分批指引', () => {
    const out = friendlyImageError('too many images in one message');
    expect(out).toContain('分批');
  });
  it('体积/尺寸超限 → 压缩指引', () => {
    expect(friendlyImageError('total size of images exceeds the limit')).toContain('压缩');
    expect(friendlyImageError('image too large')).toContain('压缩');
  });
  it('未命中 → null', () => {
    expect(friendlyImageError('unrelated provider message')).toBeNull();
  });
});

describe('friendlyProviderError（通用供应商/连接错误）', () => {
  it('图片被拒（组合面）→ 前缀「图片请求被拒」+ 指引', () => {
    const out = friendlyProviderError('you have uploaded an unsupported image');
    expect(out).toContain('图片请求被拒');
  });
  it('认证失败（governor 原文）→ API Key 指引（无内部词）', () => {
    const out = friendlyProviderError('Authentication Fails (governor)');
    expect(out).toContain('API Key');
    expect(out).not.toMatch(/governor/);
  });
  it('限流 → 稍等指引', () => {
    expect(friendlyProviderError('rate limit exceeded')).toContain('限流');
  });
  it('网络 → 检查网络', () => {
    expect(friendlyProviderError('fetch failed: ECONNREFUSED')).toContain('网络');
  });
  it('本地业务错误（memory-pressure 等）→ 不匹配 → null（保留原文）', () => {
    expect(friendlyProviderError('memory-pressure：服务过载')).toBeNull();
  });
  it('空串/非字符串 → null', () => {
    expect(friendlyProviderError('')).toBeNull();
  });
});
