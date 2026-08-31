/**
 * # test/shared/slug：slugify 纯函数（TDD 红→绿切片）
 *
 * 语义定案：
 * - slugify：URL slug 化 —— 小写；任何非字母数字连续段折叠为单个连字符；
 *   去除首尾连字符；空串 / 纯空白 / 无字母数字 → ''。
 */
import { describe, expect, it } from 'vitest';
import { slugify } from '../../src/shared/slug.js';

describe('shared/slug：slugify', () => {
  it('"Hello, World!" → "hello-world"', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('"A1 B2" → "a1-b2"', () => {
    expect(slugify('A1 B2')).toBe('a1-b2');
  });

  it('"a--b"（连续连字符）→ "a-b"', () => {
    expect(slugify('a--b')).toBe('a-b');
  });

  it('空串 → ""', () => {
    expect(slugify('')).toBe('');
  });

  it('全空白 → ""', () => {
    expect(slugify('   ')).toBe('');
  });

  it('"..."（无字母数字）→ ""', () => {
    expect(slugify('...')).toBe('');
  });
});
