/**
 * # retry：传输层错误重试器（接缝 S6）
 *
 * 职责边界（ADR-0006）：只处理传输层错误（限流、服务端错误、流式中断）的
 * 自动重试；轮次层错误归错误回注，不由本模块触碰。本模块是纯调度模块：
 * 输入是注入的异步函数 fn 与错误分级策略，输出成功值或最终错误，
 * 不做任何 HTTP。
 *
 * 契约要点：
 * - attempt 从 1 开始计数（与退避公式 2^(attempt-1) 对齐）。
 * - 默认退避（Equal Jitter，选型依据见 research §4.2）：
 *     delay(attempt) = min(capMs, baseDelayMs × 2^(attempt-1)) × (0.5 + random()/2)
 * - shouldRetry 返回 { delayMs } 时完全覆盖默认退避（含抖动与 cap；Retry-After
 *   由适配层提取后经此契约传入），该路径不消耗随机源。
 * - 失败尝试耗尽 / 判定不可重试：抛出最后一次错误；原错误对象被标上
 *   不可枚举属性 attempts（实际失败次数），错误身份与序列化形状不变。
 *   若错误对象不可扩展（frozen/sealed，第三方库错误体常见），属性
 *   定义失败则降级到模块级 WeakMap 旁挂——统一经 attemptCountOf(error) 读取。
 * - random 为抖动随机源（默认 Math.random）、sleep 为可注入调度器（默认
 *   setTimeout）——测试注入确定性序列。
 */

/** shouldRetry 的返回契约：true 走默认退避；false 立即抛出；{ delayMs } 完全覆盖退避（Retry-After 契约） */
export type RetryDecision = boolean | { delayMs: number };

export interface RetryPolicy {
  /** 总尝试次数上限（含首次尝试），最小为 1 */
  maxAttempts: number;
  /** 退避基数：第 1 次重试前的基准等待（毫秒） */
  baseDelayMs: number;
  /** 退避上限（毫秒），到达后不再增长 */
  capMs: number;
  /** 错误分级：返回 true 按默认退避重试；false 立即抛出；{ delayMs } 覆盖退避 */
  shouldRetry(error: unknown, attempt: number): RetryDecision;
}

export interface RetryOptions {
  /** 抖动随机源，期望返回 [0,1]；默认 Math.random */
  random?: () => number;
  /** 重试前等待的调度器；默认 setTimeout-based sleep */
  sleep?: (ms: number) => Promise<void>;
}

export async function retry<T>(
  fn: () => Promise<T> | T,
  policy: RetryPolicy,
  options: RetryOptions = {},
): Promise<T> {
  const { random = Math.random, sleep = defaultSleep } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // 配额耗尽视同不可重试（末次失败不再咨询 shouldRetry）；
      // 与 shouldRetry 返回 false 共享同一抛错短路径。
      const decision = attempt < policy.maxAttempts ? policy.shouldRetry(error, attempt) : false;
      if (decision === false) {
        throw withAttempts(error, attempt);
      }
      const delayMs =
        typeof decision === 'object' ? decision.delayMs : equalJitterDelay(attempt, policy, random);
      await sleep(delayMs);
    }
  }
}

/** Equal Jitter：min(cap, base × 2^(attempt-1)) × (0.5 + random()/2) */
function equalJitterDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const cappedBase = Math.min(policy.capMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return cappedBase * (0.5 + random() / 2);
}

/**
 * 旁挂计数：错误对象不可扩展（frozen/sealed）导致 defineProperty 失败时的
 * 退路；这类对象不长任何新属性，错误身份天然原样。
 */
const attemptsByError = new WeakMap<object, number>();

/**
 * 把失败次数以不可枚举属性附加到错误对象（错误身份与序列化形状不变）；
 * defineProperty 失败（不可扩展对象）时降级到 WeakMap 旁挂，绝不抛错掩埋原错误。
 */
function withAttempts(error: unknown, attempts: number): unknown {
  if (typeof error === 'object' && error !== null) {
    try {
      Object.defineProperty(error, 'attempts', {
        value: attempts,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch {
      attemptsByError.set(error, attempts);
    }
  }
  return error;
}

/**
 * 读取错误被本模块标注的实际失败次数：WeakMap 优先，其次读错误自身
 * 不可枚举属性；该错误未经过 retry 抛出或不是对象时返回 undefined。
 */
export function attemptCountOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const fromMap = attemptsByError.get(error);
  if (fromMap !== undefined) {
    return fromMap;
  }
  const fromProperty = (error as { attempts?: unknown }).attempts;
  return typeof fromProperty === 'number' ? fromProperty : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
