/**
 * # test/shared/strings：isBlank / capitalize 纯函数（TDD 红→绿切片）
 *
 * 语义定案：
 * - isBlank：空串或全空白（空格/Tab/换行）为 true；含任一非空白字符为 false；
 * - capitalize：首字符小写 → 大写；空串原样返回；单字符原样大写。
 */
import { describe, expect, it } from 'vitest';
import { capitalize, isBlank } from '../../src/shared/strings.js';

describe('shared/strings：isBlank', () => {
  it('空串 → true', () => {
    expect(isBlank('')).toBe(true);
  });

  it('全空格 → true', () => {
    expect(isBlank('   ')).toBe(true);
  });

  it('全空白（Tab/换行混合）→ true', () => {
    expect(isBlank('\t\n \t')).toBe(true);
  });

  it('含任一非空白字符 → false', () => {
    expect(isBlank(' a')).toBe(false);
    expect(isBlank('a ')).toBe(false);
    expect(isBlank('a')).toBe(false);
  });
});

describe('shared/strings：capitalize', () => {
  it('首字符小写 → 大写', () => {
    expect(capitalize('hello world')).toBe('Hello world');
  });

  it('空串原样返回', () => {
    expect(capitalize('')).toBe('');
  });

  it('单字符小写 → 大写', () => {
    expect(capitalize('a')).toBe('A');
  });
});
