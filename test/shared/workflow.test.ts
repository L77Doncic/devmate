/**
 * # test/shared/workflow：maxParallel 语义单一来源（0 = 无上限 / 1-8 显式；归一 0..8）
 *
 * 语义定案（subagent 无上限）：
 * - 0 = 无上限（池不设并发限制）；1-8 显式并发数；>8 → 8；
 * - 非法归一：负 → 0、非整 → floor、>8 → 8、NaN → 缺省 2；
 * - 服务端 POST /api/workflow 严格 400 于 <0 / >8 / 非整（0 允许）——本模块只夹初值/展示文案。
 */
import { describe, expect, it } from 'vitest';
import {
  clampMaxParallel,
  DEFAULT_MAX_PARALLEL,
  MAX_MAX_PARALLEL,
  MAX_PARALLEL_UNLIMITED_LABEL,
  MIN_MAX_PARALLEL,
  maxParallelCapText,
} from '../../src/shared/workflow.js';

describe('shared/workflow：clampMaxParallel 归一 0..8', () => {
  it('undefined → 缺省 2；合法整数 0..8 原样（0 = 无上限合法值）', () => {
    expect(clampMaxParallel(undefined)).toBe(DEFAULT_MAX_PARALLEL);
    expect(clampMaxParallel(0)).toBe(0);
    expect(clampMaxParallel(1)).toBe(1);
    expect(clampMaxParallel(2)).toBe(2);
    expect(clampMaxParallel(8)).toBe(8);
  });

  it('非法归一：负 → 0、非整 → floor、>8 → 8、NaN → 缺省 2', () => {
    expect(clampMaxParallel(-1)).toBe(0);
    expect(clampMaxParallel(-3)).toBe(0);
    expect(clampMaxParallel(3.7)).toBe(3);
    expect(clampMaxParallel(2.9)).toBe(2);
    expect(clampMaxParallel(9)).toBe(8);
    expect(clampMaxParallel(99)).toBe(8);
    expect(clampMaxParallel(NaN)).toBe(DEFAULT_MAX_PARALLEL);
  });

  it('档位常量单源：MIN 0 / MAX 8（0 = 无上限语义的边界）', () => {
    expect(MIN_MAX_PARALLEL).toBe(0);
    expect(MAX_MAX_PARALLEL).toBe(8);
  });
});

describe('shared/workflow：maxParallelCapText（提示词展示文案）', () => {
  it('0 → 无上限；1-8 → 数字原样', () => {
    expect(MAX_PARALLEL_UNLIMITED_LABEL).toBe('无上限');
    expect(maxParallelCapText(0)).toBe(MAX_PARALLEL_UNLIMITED_LABEL);
    expect(maxParallelCapText(1)).toBe('1');
    expect(maxParallelCapText(2)).toBe('2');
    expect(maxParallelCapText(8)).toBe('8');
  });
});
