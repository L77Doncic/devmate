import { describe, expect, it } from 'vitest';

import { CompactionDebouncer } from '../../src/core/context/debounce.js';
import { DEBOUNCE_WINDOW_MS, MAX_COMPACTION_ATTEMPTS } from '../../src/core/context/constants.js';

/**
 * 压缩防抖（切片 f）：摘要后仍超限 → 计数递增；超过上限（2 次，CONTEXT 裁决 8）发出 debounce 信号；
 * 一次干净轮次清零；窗口（5 分钟）外重新计数。
 * API 语义：record() 只记录（无返回值）；shouldTrip() 显式询问「是否熔断」，
 * 计数值一律经 attempts 读取（一名一值）。
 */
describe('CompactionDebouncer', () => {
  it('默认上限 2 次：前两次仍超限不报信号，第三次才熔断', () => {
    const d = new CompactionDebouncer();
    expect(d.attempts).toBe(0);
    d.record(1000, true);
    expect(d.shouldTrip()).toBe(false);
    expect(d.attempts).toBe(1);
    d.record(2000, true);
    expect(d.shouldTrip()).toBe(false);
    expect(d.attempts).toBe(2);
    d.record(3000, true); // 3 > 2 → 熔断
    expect(d.shouldTrip()).toBe(true);
    expect(d.attempts).toBe(3);
  });

  it('MAX_COMPACTION_ATTEMPTS 单源 = 2（与 §8B「上限 2 次」一致）', () => {
    expect(MAX_COMPACTION_ATTEMPTS).toBe(2);
  });

  it('干净轮次（摘要后已收回预算）清零计数', () => {
    const d = new CompactionDebouncer();
    d.record(1000, true);
    d.record(2000, true);
    d.record(3000, false); // 干净轮次：清零
    expect(d.shouldTrip()).toBe(false);
    expect(d.attempts).toBe(0);
    // 清零后再来一轮 → 从 1 重新计
    d.record(4000, true);
    expect(d.shouldTrip()).toBe(false);
    expect(d.attempts).toBe(1);
  });

  it('时间窗含边界：恰好 5 分钟仍在窗口内；超过才重新计数', () => {
    const d = new CompactionDebouncer();
    d.record(10_000, true); // 1
    d.record(10_000 + DEBOUNCE_WINDOW_MS, true); // 恰好 5 分钟：连续 → 2
    expect(d.attempts).toBe(2);
    d.record(10_000 + DEBOUNCE_WINDOW_MS + 1, true); // 超窗：回到 1
    expect(d.attempts).toBe(1);
    expect(d.shouldTrip()).toBe(false);
  });

  it('可配置 maxAttempts（如熔断从严时）', () => {
    const d = new CompactionDebouncer({ maxAttempts: 1 });
    d.record(1000, true);
    expect(d.shouldTrip()).toBe(false);
    d.record(2000, true);
    expect(d.shouldTrip()).toBe(true);
    expect(d.attempts).toBe(2);
  });

  it('reset() 主动清零（换任务/换会话时）', () => {
    const d = new CompactionDebouncer();
    d.record(1000, true);
    d.record(2000, true);
    d.reset();
    expect(d.attempts).toBe(0);
    expect(d.shouldTrip()).toBe(false);
    d.record(3000, true);
    expect(d.shouldTrip()).toBe(false);
  });
});
