/**
 * # test/shared/camelize：camelize 纯函数（TDD 红→绿切片）
 *
 * 语义定案：
 * - camelize：camelCase 化 —— 按非字母数字连续段切分；第一段全小写，
 *   后续段首字母大写、其余小写；空串 / 纯空白 / 无字母数字 → ''。
 */
import { describe, expect, it } from 'vitest';
import { camelize } from '../../src/shared/camelize.js';

describe('shared/camelize：camelize', () => {
  it('"hello world" → "helloWorld"', () => {
    expect(camelize('hello world')).toBe('helloWorld');
  });

  it('"Hello, World!"（标点 + 大写）→ "helloWorld"', () => {
    expect(camelize('Hello, World!')).toBe('helloWorld');
  });

  it('"A1 B2"（含数字）→ "a1B2"', () => {
    expect(camelize('A1 B2')).toBe('a1B2');
  });

  it('"a--b"（连续分隔符）→ "aB"', () => {
    expect(camelize('a--b')).toBe('aB');
  });

  it('"foo_bar-baz"（混合分隔符）→ "fooBarBaz"', () => {
    expect(camelize('foo_bar-baz')).toBe('fooBarBaz');
  });

  it('空串 → ""', () => {
    expect(camelize('')).toBe('');
  });

  it('全空白 "   " → ""', () => {
    expect(camelize('   ')).toBe('');
  });

  it('"..."（无字母数字）→ ""', () => {
    expect(camelize('...')).toBe('');
  });
});
