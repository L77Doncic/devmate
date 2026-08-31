/**
 * # test/ui-web/assistant-paint-split：助手气泡流式绘制切分（纯逻辑，node 直接 import）
 *
 * 背景（用户报告「两行一样的字，随后一行被删除」）：paintAssistant 未定稿时按最后一个
 * 换行切稳定段（markdown 渲染）与尾段（pre-wrap 纯文本 + 光标）；旧实现在**无换行**分支
 * 漏清稳定段——稳定段保留全文、尾段又是全文 → 同一段文字被 markdown 与尾段各渲染一次
 * （正文下叠一条相同内容的流式尾行），直到换行/定稿触发重绘才消失。
 * 本测试锚定切分不变式：稳定段与尾段**永不重叠**（B1），两段合起来恒等于全文（B2）。
 */
import { describe, expect, it } from 'vitest';
import { assistantPaintSplit } from '../../src/ui/web/format.js';

describe('assistantPaintSplit（稳定段/尾段切分；防「正文与尾段同文双重渲染」）', () => {
  it('B1) 未定稿且无换行：稳定段为空、全文归尾段（旧缺陷回归锚——绝不与正文重叠）', () => {
    const text = '让我快速查看各子目录，以便准确描述。';
    const { stable, tail } = assistantPaintSplit(text, false);
    expect(stable).toBe('');
    expect(tail).toBe(text);
  });

  it('B1b) 未定稿且含换行：稳定段 = 最后一个换行之前，尾段 = 其后（不重叠、也不重复）', () => {
    const text = '第一段\n第二段。\n尾部还在写';
    const { stable, tail } = assistantPaintSplit(text, false);
    expect(stable).toBe('第一段\n第二段。');
    expect(tail).toBe('尾部还在写');
    // 尾段不以稳定段结尾为前缀（无重叠）
    expect(tail.startsWith(stable.slice(-1)) && stable.endsWith(tail)).toBe(false);
  });

  it('B2) 拼接恒等于「全文去掉换行分隔点」（覆盖：换行开头/结尾/连续换行/单行）', () => {
    // 切分点本身（最后一个换行）是行分隔符而非内容——拼接后只会丢失它，别无缺席；
    // 逐字重复（同字两次）意味着某段文本被给了两段渲染，即用例失败。
    for (const text of ['abc', 'a\nb', 'a\n', '\na', 'a\n\nb', '第一行\n\n第二行。', '']) {
      const { stable, tail } = assistantPaintSplit(text, false);
      const idx = text.lastIndexOf('\n');
      const expect1 = idx >= 0 ? text.slice(0, idx) + text.slice(idx + 1) : text;
      expect(stable + tail, `text=${JSON.stringify(text)}`).toBe(expect1);
      // 稳定段与尾段内容互不重叠（tail 非 stable 的完整复制）
      expect(tail !== stable || stable === '').toBe(true);
    }
  });

  it('B3) 定稿：全文稳定段、无尾段（替代性重绘 = 权威定稿单份渲染）', () => {
    const text = '最后一句话。';
    const { stable, tail } = assistantPaintSplit(text, true);
    expect(stable).toBe(text);
    expect(tail).toBe('');
  });

  it('B4) 空串/缺失输入：稳定段与尾段皆空（渲染层不落空节点）', () => {
    expect(assistantPaintSplit('', false)).toEqual({ stable: '', tail: '' });
    expect(assistantPaintSplit(null, false)).toEqual({ stable: '', tail: '' });
    expect(assistantPaintSplit(undefined, true)).toEqual({ stable: '', tail: '' });
  });
});
