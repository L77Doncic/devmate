/**
 * # attachments.js 单测：附件（ADR-0015）纯逻辑——上限常量/文件预检/数量/协议形状归一/
 * ref 展开（resolveImageContent 兼容 ref 与旧 dataURL 两种形状）。
 * 浏览器 File 对象的子集（{size,type,name}）即可验证；FileReader/Image 探测与上传在
 * app.js 装配层（CDP 冒烟覆盖），本面只测纯函数。
 */
import { describe, expect, it } from 'vitest';
import {
  ATTACH_LIMITS,
  attachmentErrorFor,
  attachmentsFull,
  normalizeAttachment,
  // attachmentRefValid removed: unused
  resolveImageContent,
  imageFitSingle,
  IMAGE_TILE_DIMENSION,
  DROP_OVERLAY_TEXT,
} from '../../src/ui/web/attachments.js';

const REF = `sha256/${'a'.repeat(64)}.png`;

describe('attachments.js：上限与校验', () => {
  it('上限常量：20MiB / 20 张（dsh 三数；服务端镜像；ADR-0015）', () => {
    expect(ATTACH_LIMITS.maxImageBytes).toBe(20 * 1024 * 1024);
    expect(ATTACH_LIMITS.maxCount).toBe(20);
    expect(ATTACH_LIMITS.maxSessionBytes).toBe(200 * 1024 * 1024);
  });

  it('文件预检：类型 image/* 放行；>20MiB → too-large；非图片 → not-image', () => {
    expect(attachmentErrorFor({ size: 3, type: 'image/png', name: 'a.png' })).toBeNull();
    expect(
      attachmentErrorFor({ size: 20 * 1024 * 1024 + 1, type: 'image/png', name: 'a.png' }),
    ).toBe('too-large');
    expect(attachmentErrorFor({ size: 3, type: 'text/plain', name: 'a.txt' })).toBe('not-image');
    expect(attachmentErrorFor({ size: 3, type: '', name: 'a.txt' })).toBe('not-image');
    // type 缺失但扩展名是图片（部分系统截图工具）；扩展名非图片 → 拒绝
    expect(attachmentErrorFor({ size: 3, type: '', name: 'shot.png' })).toBeNull();
    expect(attachmentErrorFor({ size: 3, type: '', name: 'shot.jpeg' })).toBeNull();
    expect(attachmentErrorFor({ size: 3, type: '', name: 'shot.webp' })).toBeNull();
    expect(attachmentErrorFor(null)).toBe('not-image');
  });

  it('数量上限：达到 20 张后拒绝追加', () => {
    expect(attachmentsFull(19)).toBe(false);
    expect(attachmentsFull(20)).toBe(true);
  });

  it('ref 形状归一：sha256/<sha>.<ext> + 可选正整数宽高；ref 非法 → null', () => {
    const good = normalizeAttachment({ ref: REF, width: 800, height: 600 });
    expect(good).toEqual({ ref: REF, width: 800, height: 600 });
    expect(normalizeAttachment({ ref: REF, width: -1 })).toEqual({ ref: REF });
    expect(normalizeAttachment(REF)).toBeNull();
    expect(normalizeAttachment({ ref: `sha256/${'a'.repeat(63)}.png` })).toBeNull();
    expect(normalizeAttachment({ ref: 'https://example.com/x.png' })).toBeNull();
    expect(normalizeAttachment(null)).toBeNull();
    expect(normalizeAttachment(undefined)).toBeNull();
    // 整数边界：1 合法、0 非法、小数非法
    expect(normalizeAttachment({ ref: REF, width: 0, height: 1 })).toEqual({
      ref: REF,
      height: 1,
    });
    expect(normalizeAttachment({ ref: REF, height: 1.5 })).toEqual({ ref: REF });
  });

  it('旧 dataURL 形状仍归一（向后兼容读旧事件/旧客户端）：data:image/ 前缀 + 正整数宽高', () => {
    expect(normalizeAttachment({ url: 'data:image/png;base64,AA==' })).toEqual({
      url: 'data:image/png;base64,AA==',
    });
    expect(normalizeAttachment({ url: 'data:image/png;base64,x', width: 800 })).toEqual({
      url: 'data:image/png;base64,x',
      width: 800,
    });
    expect(normalizeAttachment({ url: 'https://example.com/x.png' })).toBeNull();
    expect(normalizeAttachment({ url: 'data:text/plain;base64,x' })).toBeNull();
  });
});

describe('attachments.js：resolveImageContent（事件 images → 渲染描述，ref/旧 dataURL 双形）', () => {
  it('ref 形：src = /api/attachments/<ref>（同源 raw 端点）；宽高保留', () => {
    const resolved = resolveImageContent([{ ref: REF, width: 320, height: 200 }]);
    expect(resolved).toEqual([
      { src: `/api/attachments/${REF}`, width: 320, height: 200, ref: REF },
    ]);
  });

  it('旧 dataURL 形：src = 原 dataURL（不经网络）；ref 与 url 混合输入保序', () => {
    const url = 'data:image/png;base64,AA==';
    expect(resolveImageContent([{ url, width: 8, height: 8 }])).toEqual([
      { src: url, width: 8, height: 8 },
    ]);
    const mixed = resolveImageContent([{ ref: REF }, { url, height: 9 }]);
    expect(mixed).toEqual([
      { src: `/api/attachments/${REF}`, ref: REF },
      { src: url, height: 9 },
    ]);
  });

  it('非法条目（外部 URL/非对象/缺字段/ref 破）→ 丢弃而非渲染坏图', () => {
    expect(resolveImageContent([{ url: 'https://x/y.png' }])).toEqual([]);
    expect(resolveImageContent([{ ref: 'sha256/abc.png' }])).toEqual([]);
    expect(resolveImageContent([null, 42, 'nope'])).toEqual([]);
    expect(resolveImageContent([])).toEqual([]);
    expect(resolveImageContent(undefined)).toEqual([]);
  });
});

describe('dsh 同款图像几何（imageFitSingle，移植 MessageImage.singleFit）', () => {
  it('正方形 800×800 → 240×240，object-position center，不放大超自然尺寸', () => {
    expect(imageFitSingle({ width: 1600, height: 1600 })).toEqual({
      width: 240,
      height: 240,
      objectPosition: 'center',
    });
    expect(imageFitSingle({ width: 8, height: 8 })).toEqual({
      width: 8,
      height: 8,
      objectPosition: 'center', // 不放大超过自然尺寸（scale=min(1,...)）
    });
  });

  it('宽图（natural=2）→ 240×120；natural>4 → 裁剪锚 left center', () => {
    expect(imageFitSingle({ width: 1600, height: 800 })).toEqual({
      width: 240,
      height: 120,
      objectPosition: 'center',
    });
    expect(imageFitSingle({ width: 4000, height: 500 })).toEqual({
      width: 240,
      height: 60,
      objectPosition: 'left center', // natural=8 > 4
    });
  });

  it('高图（natural=1/2）→ 120×240；natural<0.25 → 裁剪锚 center top', () => {
    expect(imageFitSingle({ width: 800, height: 1600 })).toEqual({
      width: 120,
      height: 240,
      objectPosition: 'center',
    });
    expect(imageFitSingle({ width: 500, height: 3000 })).toEqual({
      width: 60,
      height: 240,
      objectPosition: 'center top', // natural ≈ 0.1667 < 0.25 → 钳到 0.25
    });
  });

  it('尺寸未知 → 240 方框 center（dsh preview 未探明尺寸的 square crop 语义）', () => {
    expect(imageFitSingle(undefined)).toEqual({
      width: 240,
      height: 240,
      objectPosition: 'center',
    });
  });

  it('tile 常量 64（dsh ImageGallery 多图 tile）', () => {
    expect(IMAGE_TILE_DIMENSION).toBe(64);
  });

  it('拖放文案常量（DropOverlay 简化单态）', () => {
    expect(DROP_OVERLAY_TEXT).toBe('松开以添加图片');
  });
});
