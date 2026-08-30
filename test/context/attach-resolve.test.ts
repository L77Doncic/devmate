/**
 * # test/context/attach-resolve：投影层 ref 展开（ADR-0015 请求时展开；零 IO——resolver 注入）
 *
 * 覆盖：ref → dataURL 展开（part 带 width/height 供估算）；ref 不存在 → 该图降级文本提示
 * （不 400）；旧 dataURL 事件直通（兼容）；展开后请求维度 ≤40MiB 校验 → 超额图降级
 * + 文本提示（诚实路径——DeepSeek 48MiB 请求体的留裕检查）。
 */
import { describe, expect, it } from 'vitest';
import type { ChatContentPart } from '../../src/shared/llm-types.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import { project, attachmentMissingNote, attachmentOversizeNote } from '../../src/core/context/index.js';

const REF_A = `sha256/${'a'.repeat(64)}.png`;
const REF_B = `sha256/${'b'.repeat(64)}.jpg`;
const DATA_A = 'data:image/png;base64,AAAA';
const DATA_B = 'data:image/jpeg;base64,BBBB';

function userEvent(seq: number, content: string, images: Array<Record<string, unknown>>): SessionEvent<'user'> {
  return {
    v: 1,
    seq,
    ts: seq,
    kind: 'user',
    payload: { content, images: images as never },
  };
}

describe('project 的 ref 展开（attachmentResolver 注入）', () => {
  it('ref → dataURL：content 块数组 text+image_url（宽高保留估算面）', async () => {
    const events = [userEvent(1, '看图', [{ ref: REF_A, width: 800, height: 600 }])];
    const projection = await project(events, {
      resolveImageRef: async (ref) => (ref === REF_A ? DATA_A : null),
    });
    expect(projection.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: DATA_A }, width: 800, height: 600 },
        ],
      },
    ]);
  });

  it('ref 不存在 → 该图降级：文本提示（含 ref）——不 400 不崩溃（纯文本消息 = 经典字符串形）', async () => {
    const events = [userEvent(1, '看图', [{ ref: REF_A, width: 800, height: 600 }])];
    const projection = await project(events, { resolveImageRef: async () => null });
    // 图片全降级 → 消息回到纯文本字符串形（经典形态；文本含提示——诚实路径）
    expect(projection.messages[0]).toEqual({
      role: 'user',
      content: `看图${attachmentMissingNote(REF_A)}`,
    });
    expect(projection.stats.degradedImages).toBe(1);
  });

  it('旧 dataURL 事件直通（resolver 未命中也不改写——向后兼容旧会话）', async () => {
    const events = [userEvent(1, '旧图', [{ url: DATA_A, width: 8, height: 8 }])];
    const projection = await project(events, { resolveImageRef: async () => null });
    expect(projection.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '旧图' },
          { type: 'image_url', image_url: { url: DATA_A }, width: 8, height: 8 },
        ],
      },
    ]);
  });

  it('展开后 40MiB 校验：两图 21MiB → 一张保留一张降级 + 提示（诚实路径）', async () => {
    const bigA = `data:image/png;base64,${'x'.repeat(21 * 1024 * 1024)}`;
    const bigB = `data:image/png;base64,${'y'.repeat(21 * 1024 * 1024)}`;
    const events = [userEvent(1, '', [{ ref: REF_A }, { ref: REF_B }])];
    const projection = await project(events, {
      resolveImageRef: async (ref) => (ref === REF_A ? bigA : ref === REF_B ? bigB : null),
    });
    const content = projection.messages[0]!.content as readonly ChatContentPart[];
    const text = content[0] as { type: string; text: string };
    expect(text.text).toBe(attachmentOversizeNote(1));
    // 保序前缀策略：第一图保留，第二图降级
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: bigA } });
    expect(content).toHaveLength(2);
    // 估算面不含被降级的第二图（tokens 随图数少——image tokens 计 1 图）
  });

  it('混合：一条消息 ref 缺失 + 旧 url 并存 → 直通保留 + 缺失降级（块数组形）', async () => {
    const events = [userEvent(1, '描述', [{ ref: REF_A }, { url: DATA_A }])];
    const projection = await project(events, { resolveImageRef: async () => null });
    const content = projection.messages[0]!.content as readonly ChatContentPart[];
    expect(content).toEqual([
      { type: 'text', text: `描述${attachmentMissingNote(REF_A)}` },
      { type: 'image_url', image_url: { url: DATA_A } },
    ]);
  });

  it('无 resolver 注入 + ref 事件 → 保守降级（绝不发坏 URL，绝不崩溃）', async () => {
    const events = [userEvent(1, 'x', [{ ref: REF_A }])];
    const projection = await project(events);
    expect(projection.messages[0]).toEqual({
      role: 'user',
      content: `x${attachmentMissingNote(REF_A)}`,
    });
    expect(projection.stats.degradedImages).toBe(1);
  });
});
