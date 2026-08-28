import { describe, expect, it } from 'vitest';

import { BINARY_OUTPUT_PLACEHOLDER, truncateToolOutput } from '../../src/core/context/truncate.js';
import {
  MAX_OUTPUT_CHARS,
  TRUNCATE_HEAD_CHARS,
  TRUNCATE_TAIL_CHARS,
} from '../../src/core/context/constants.js';

/**
 * 生成期截断（切片 b）：单条工具输出 ≥10000 字符 → 头 5000 + 尾 5000
 * + 显式 elide 标记 + 收窄建议（mini-swe-agent 一手模板，报告 §2.3 逐字核实；
 * 标记串冲突的裁定见 CONTEXT.md「术语裁决记录」第 9 条——以一手模板为准）。
 * 疑似二进制/不可打印内容整体替换为 BINARY_OUTPUT_PLACEHOLDER（NUL 全量扫描 + 采样占比）。
 * 预期值：按报告模板字面量手算（advice 46+58 字符、head/tail 按切片、marker「N characters elided」）。
 */

const ADVICE =
  'The output of your last command was too long.\nPlease try a different command that produces less output.\n';
const ELIDE_TEMPLATE = '--- {n} characters elided ---';

function expectedTruncated(raw: string, elided: number): string {
  return (
    ADVICE +
    raw.slice(0, TRUNCATE_HEAD_CHARS) +
    '\n\n' +
    ELIDE_TEMPLATE.replace('{n}', String(elided)) +
    '\n\n' +
    raw.slice(-TRUNCATE_TAIL_CHARS)
  );
}

describe('截断：阈值边界与格式', () => {
  it('低于阈值（9999 字符）原样返回', () => {
    const raw = 'a'.repeat(9999);
    expect(truncateToolOutput(raw)).toBe(raw);
  });

  it('恰好等于阈值（10000 字符）按 head+tail = 全量，elided 为 0', () => {
    const raw = 'a'.repeat(MAX_OUTPUT_CHARS);
    const got = truncateToolOutput(raw);
    expect(got).toBe(expectedTruncated(raw, 0));
    expect(got).toContain('\n\n--- 0 characters elided ---\n\n');
  });

  it('12000 字符：头部/尾部保序，中间为逐字标记「--- 2000 characters elided ---」', () => {
    const raw = 'a'.repeat(12000);
    const got = truncateToolOutput(raw);
    expect(got).toBe(expectedTruncated(raw, 2000));
    // 逐字断言：advice 首行、标记格式、头尾切片各就其位
    expect(got.startsWith('The output of your last command was too long.\n')).toBe(true);
    expect(got).toContain('\n\n--- 2000 characters elided ---\n\n');
    expect(got.slice(ADVICE.length, ADVICE.length + TRUNCATE_HEAD_CHARS)).toBe(
      raw.slice(0, TRUNCATE_HEAD_CHARS),
    );
    expect(got.slice(-TRUNCATE_TAIL_CHARS)).toBe(raw.slice(-TRUNCATE_TAIL_CHARS));
    // 收窄建议逐字（两行原文 + 换行）
    expect(got.startsWith(ADVICE)).toBe(true);
  });

  it('elided = 超出阈值的字符数（15000 → 5000）', () => {
    const raw = 'b'.repeat(15000);
    const got = truncateToolOutput(raw);
    expect(got).toContain('\n\n--- 5000 characters elided ---\n\n');
  });

  it('参数化 maxChars=4000：头尾按半额 2000/2000 切片，elide/建议照旧（默认可选参数不改变既有单参调用）', () => {
    const raw = 'a'.repeat(5000);
    const got = truncateToolOutput(raw, 4000);
    expect(got).toBe(
      ADVICE +
        raw.slice(0, 2000) +
        '\n\n' +
        ELIDE_TEMPLATE.replace('{n}', '1000') +
        '\n\n' +
        raw.slice(-2000),
    );
    expect(got.startsWith(ADVICE)).toBe(true);
    expect(got).toContain('\n\n--- 1000 characters elided ---\n\n');
    expect(got.slice(ADVICE.length, ADVICE.length + 2000)).toBe(raw.slice(0, 2000));
    expect(got.slice(-2000)).toBe(raw.slice(-2000));
  });

  it('参数化 maxChars=4000：阈值内（3999）原样返回；恰 4000 按 0 elided 面板重写', () => {
    expect(truncateToolOutput('a'.repeat(3999), 4000)).toBe('a'.repeat(3999));
    expect(truncateToolOutput('b'.repeat(4000), 4000)).toBe(
      ADVICE +
        'b'.repeat(2000) +
        '\n\n' +
        ELIDE_TEMPLATE.replace('{n}', '0') +
        '\n\n' +
        'b'.repeat(2000),
    );
  });
});

describe('二进制/非文本检测（NUL 全量扫描 + 不可打印占比）', () => {
  it('含 NUL 字节 → 整体替换为占位符标记，注明内容未展示', () => {
    const raw = 'text\x00' + 'a'.repeat(200);
    const got = truncateToolOutput(raw);
    expect(got).toBe(BINARY_OUTPUT_PLACEHOLDER);
    expect(got).toContain('did not contain printable text');
  });

  it('NUL 位于采样段之后也命中（全量扫描，不受采样限制）', () => {
    const raw = 'a'.repeat(2000) + '\x00' + 'b'.repeat(100);
    expect(truncateToolOutput(raw)).toBe(BINARY_OUTPUT_PLACEHOLDER);
  });

  it('不可打印字符占比过高（控制字符为主）→ 替换为占位符', () => {
    const raw = '\x01'.repeat(500) + 'ok'.repeat(10); // 非打印 500/520 ≈ 96% > 10%
    expect(truncateToolOutput(raw)).toBe(BINARY_OUTPUT_PLACEHOLDER);
  });

  it('正常文本（含 \\t\\n\\r 与 CJK）不判二进制，原样返回', () => {
    const raw = 'hello\tworld\n你好\r\n';
    expect(truncateToolOutput(raw)).toBe(raw);
  });
});
