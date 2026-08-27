import { describe, expect, it, vi } from 'vitest';
import {
  attemptCountOf,
  retry,
  type RetryDecision,
  type RetryPolicy,
} from '../../src/core/retry/index.js';

/**
 * retry 模块规格（接缝 S6：传输层错误才归重试器；边界分层见
 * research/context-and-error-handling.md §4.1 的 E1–E8 / E9–E14 原则与
 * ADR-0006 的职责边界，Equal Jitter 公式见 §4.2，Retry-After 三形态与
 * 退避契约见 openai-compatible-api-spec.md §6.3）。
 *
 * Expected values 为独立来源：Equal Jitter 公式
 *   delay(attempt) = min(capMs, baseDelayMs × 2^(attempt-1)) × (0.5 + random()/2)
 * 的手算字面量（random≡0 → ×0.5；0.5 → ×0.75；1 → ×1.0），
 * 不采用实现式复算。
 */

function makePolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxAttempts: 3,
    baseDelayMs: 100,
    capMs: 10_000,
    shouldRetry: () => true,
    ...overrides,
  };
}

const constRandom =
  (value: number): (() => number) =>
  () =>
    value;

describe('retry：传输层错误重试器（接缝 S6）', () => {
  describe('a) 首次成功', () => {
    it('成功即返回结果：fn 恰好一次，不咨询 shouldRetry、不调用调度器', async () => {
      const fn = vi.fn(async () => 'ok');
      const shouldRetry = vi.fn(() => true);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(
        retry(fn, makePolicy({ shouldRetry }), { random: () => 0, sleep }),
      ).resolves.toBe('ok');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(shouldRetry).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('b) 可重试错误按 Equal Jitter 序列退避重试', () => {
    it('random≡0 → 每段等待 ×0.5：base=100 → 50, 100, 200（手算字面量）', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('429 rate limit'))
        .mockRejectedValueOnce(new Error('429 rate limit'))
        .mockRejectedValueOnce(new Error('429 rate limit'))
        .mockResolvedValue('done');
      const random = vi.fn(() => 0);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(retry(fn, makePolicy({ maxAttempts: 4 }), { random, sleep })).resolves.toBe(
        'done',
      );

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([50, 100, 200]);
      expect(random).toHaveBeenCalledTimes(3);
      expect(fn).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls.length).toBe(3);
    });

    it('random≡0.5 → 每段等待 ×0.75：base=100 → 75, 150（手算字面量）', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('500 server error'))
        .mockRejectedValueOnce(new Error('500 server error'))
        .mockResolvedValue('done');
      const random = vi.fn(() => 0.5);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(retry(fn, makePolicy(), { random, sleep })).resolves.toBe('done');

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([75, 150]);
      expect(random).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.length).toBe(2);
    });

    it('random≡1 → 每段等待 ×1.0：base=100 → 100, 200, 400（手算字面量）', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('503 overloaded'))
        .mockRejectedValueOnce(new Error('503 overloaded'))
        .mockRejectedValueOnce(new Error('503 overloaded'))
        .mockResolvedValue('done');
      const random = vi.fn(() => 1);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(retry(fn, makePolicy({ maxAttempts: 4 }), { random, sleep })).resolves.toBe(
        'done',
      );

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400]);
      expect(random).toHaveBeenCalledTimes(3);
      expect(fn).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls.length).toBe(3);
    });

    it('到达 capMs 封顶：base=100, cap=250, random≡1 → 100, 200, 250, 250', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('504 gateway timeout'))
        .mockRejectedValueOnce(new Error('504 gateway timeout'))
        .mockRejectedValueOnce(new Error('504 gateway timeout'))
        .mockRejectedValueOnce(new Error('504 gateway timeout'))
        .mockResolvedValue('done');
      const random = vi.fn(() => 1);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(
        retry(fn, makePolicy({ maxAttempts: 5, capMs: 250 }), {
          random,
          sleep,
        }),
      ).resolves.toBe('done');

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 250, 250]);
      expect(random).toHaveBeenCalledTimes(4);
      expect(fn).toHaveBeenCalledTimes(5);
      expect(sleep.mock.calls.length).toBe(4);
    });
  });

  describe('c) maxAttempts 耗尽', () => {
    it('抛出最后一次失败的错误（身份不变），并附 attempts=最大次数', async () => {
      const lastError = new Error('429 still rate limited');
      const fn = vi.fn().mockRejectedValue(lastError);
      const shouldRetry = vi.fn(() => true);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(
        retry(fn, makePolicy({ maxAttempts: 3, shouldRetry }), {
          random: constRandom(1),
          sleep,
        }),
      ).rejects.toBe(lastError);

      // 最后一次错误被原样抛出：身份不变、附带实际失败次数
      expect(attemptCountOf(lastError)).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
      // 最后一次失败不再咨询策略（第 1、2 次各咨询一次），期间等待两次退避
      expect(shouldRetry).toHaveBeenCalledTimes(2);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    });

    it('maxAttempts=1：首次失败即抛——不咨询 shouldRetry、不调度、附 attempts=1', async () => {
      const only = new Error('429 instant');
      const fn = vi.fn().mockRejectedValue(only);
      const shouldRetry = vi.fn(() => true);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(
        retry(fn, makePolicy({ maxAttempts: 1, shouldRetry }), {
          random: constRandom(1),
          sleep,
        }),
      ).rejects.toBe(only);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(shouldRetry).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(attemptCountOf(only)).toBe(1);
    });
  });

  describe('d) 不可重试错误', () => {
    it('立即抛出：fn 恰好一次、调度器一次没有被调用，并附 attempts=1', async () => {
      const bad = new Error('400 invalid_request_error');
      const fn = vi.fn().mockRejectedValueOnce(bad);
      const shouldRetry = vi.fn(() => false);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(
        retry(fn, makePolicy({ maxAttempts: 5, shouldRetry }), {
          random: constRandom(0),
          sleep,
        }),
      ).rejects.toBe(bad);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(shouldRetry).toHaveBeenCalledTimes(1);
      expect(shouldRetry).toHaveBeenCalledWith(bad, 1);
      expect(attemptCountOf(bad)).toBe(1);
    });

    it('不可重试判定之后任何剩余配额都不再生效（4xx 不被重发）', async () => {
      const bad = new Error('403 permission denied');
      const fn = vi.fn().mockRejectedValue(bad);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(
        retry(fn, makePolicy({ maxAttempts: 3, shouldRetry: () => false }), {
          sleep,
        }),
      ).rejects.toBe(bad);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('e) shouldRetry 返回 {delayMs}（Retry-After 契约）', () => {
    it('完全覆盖默认退避：逐字等待 delayMs，不经抖动、不消耗随机源', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('429 with retry-after'))
        .mockRejectedValueOnce(new Error('429 with retry-after'))
        .mockResolvedValue('done');
      const shouldRetry = vi
        .fn<(error: unknown, attempt: number) => RetryDecision>()
        .mockReturnValueOnce({ delayMs: 5000 })
        .mockReturnValueOnce({ delayMs: 100 });
      const random = vi.fn(() => 0);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(retry(fn, makePolicy({ shouldRetry }), { random, sleep })).resolves.toBe('done');

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 100]);
      expect(random).not.toHaveBeenCalled();
      expect(shouldRetry).toHaveBeenCalledTimes(2);
    });

    it('覆盖值大于 capMs 时不被截断（上限归适配层的 MAX_RETRY_AFTER）', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('503 retry-after: 60'))
        .mockResolvedValue('done');
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(
        retry(fn, makePolicy({ capMs: 250, shouldRetry: () => ({ delayMs: 60_000 }) }), {
          sleep,
        }),
      ).resolves.toBe('done');

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([60_000]);
    });

    it('与默认退避混用：每次重试独立判定（一次覆盖、一次默认）', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('429 after 10s'))
        .mockRejectedValueOnce(new Error('500 transient'))
        .mockResolvedValue('done');
      const shouldRetry = vi
        .fn<(error: unknown, attempt: number) => RetryDecision>()
        .mockReturnValueOnce({ delayMs: 1500 }) // attempt 1 → 覆盖
        .mockReturnValueOnce(true); // attempt 2 → 默认退避
      const random = vi.fn(() => 0.5);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(retry(fn, makePolicy({ shouldRetry }), { random, sleep })).resolves.toBe('done');

      // attempt 2 的默认退避 = min(10000, 100×2^1) × (0.5 + 0.5/2) = 200 × 0.75 = 150
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1500, 150]);
      expect(random).toHaveBeenCalledTimes(1);
    });
  });

  describe('f) 调度语义（只测行为，不见内部）', () => {
    it('每次重试前调用调度器：记录到 fn → sleep → fn 的交错序列', async () => {
      const events: string[] = [];
      let call = 0;
      const fn = vi.fn(async () => {
        call += 1;
        events.push(`fn-${call}`);
        if (call < 3) {
          throw new Error(`boom-${call}`);
        }
        return 'done';
      });
      const shouldRetry = vi.fn(() => true);
      const sleep = vi.fn(async (ms: number) => {
        events.push(`sleep-start-${ms}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        events.push(`sleep-end-${ms}`);
      });

      await retry(fn, makePolicy({ shouldRetry }), { random: constRandom(0), sleep });

      expect(events).toEqual([
        'fn-1',
        'sleep-start-50',
        'sleep-end-50',
        'fn-2',
        'sleep-start-100',
        'sleep-end-100',
        'fn-3',
      ]);
      // 两次失败各咨询一次策略（成功的那一次不咨询）
      expect(shouldRetry).toHaveBeenCalledTimes(2);
    });

    it('重试严格串行：sleep 未解决前不发起下一次 fn', async () => {
      const events: string[] = [];
      const releases: Array<() => void> = [];
      let call = 0;
      const fn = vi.fn(async () => {
        call += 1;
        events.push(`fn-${call}`);
        if (call < 3) {
          throw new Error(`boom-${call}`);
        }
        return 'done';
      });
      const sleep = vi.fn(
        (ms: number) =>
          new Promise<void>((resolve) => {
            events.push(`sleep-${ms}`);
            releases.push(() => {
              events.push(`sleep-done-${ms}`);
              resolve();
            });
          }),
      );

      const promise = retry(fn, makePolicy(), { random: constRandom(0), sleep });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fn).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['fn-1', 'sleep-50']);

      releases[0]!();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fn).toHaveBeenCalledTimes(2);
      expect(events).toEqual(['fn-1', 'sleep-50', 'sleep-done-50', 'fn-2', 'sleep-100']);

      releases[1]!();
      await expect(promise).resolves.toBe('done');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('g) attempts 标注契约（不可枚举 / 冻结退化 WeakMap）', () => {
    it('可扩展错误：attempts 不可枚举——Object.keys / for-in / JSON.stringify 均不受污染', async () => {
      const lastError = new Error('429 noisy');
      const fn = vi.fn().mockRejectedValue(lastError);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(
        retry(fn, makePolicy({ maxAttempts: 2 }), { random: constRandom(0), sleep }),
      ).rejects.toBe(lastError);

      expect(attemptCountOf(lastError)).toBe(2);
      expect((lastError as { attempts?: number }).attempts).toBe(2);
      // 属性可读但不可枚举：错误外观与序列化形状不变
      expect(Object.keys(lastError)).toEqual([]);
      const seen: string[] = [];
      for (const key in lastError) {
        seen.push(key);
      }
      expect(seen).toEqual([]);
      expect(JSON.stringify(lastError)).toBe(JSON.stringify(new Error('429 noisy')));
    });

    it('冻结错误体（第三方库常见）：不会抛 TypeError 掩埋原错误，attempts 经 attemptCountOf 的 WeakMap 路径读取', async () => {
      const frozen = Object.freeze(new Error('429 frozen'));
      const fn = vi.fn().mockRejectedValueOnce(frozen).mockRejectedValueOnce(frozen);
      const sleep = vi.fn(async (_ms: number) => {});

      await expect(
        retry(fn, makePolicy({ maxAttempts: 2 }), { random: constRandom(0), sleep }),
      ).rejects.toBe(frozen);

      expect(Object.isFrozen(frozen)).toBe(true);
      expect(attemptCountOf(frozen)).toBe(2);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
