/**
 * # context/debounce：压缩防抖计数（CONTEXT「压缩防抖」；§8 A-1 熔断口径）
 *
 * 服务端超限 → 压缩 → 重试的链若压不收敛，不能无限烧钱：摘要后仍超限一次计数 +1，
 * 超过 MAX_COMPACTION_ATTEMPTS（2 次，按裁定 8：报告 §1.4 的「重试一次」为笔误，
 * 以上限 2 次为准）即发出 debounce 熔断信号（归 ADR-0006 熔断信号清单）；
 * 一次干净轮次或超窗口（DEBOUNCE_WINDOW_MS = 5 分钟）即重新起算。
 * 计时分层：record() 只记录、不返回语义；「该不该熔断」由 shouldTrip() 显式询问——
 * 布尔返回值入名，调用方先 record 再问 shouldTrip，不再有二义性布尔。
 * 计数之名只有一个：attempts（窗口内「摘要后仍超限」的连续次数）。
 * 纯内存状态机，无 IO；时间由调用方显式传入（可测）。
 */
import { DEBOUNCE_WINDOW_MS, MAX_COMPACTION_ATTEMPTS } from './constants.js';

export interface CompactionDebouncerOptions {
  /** 摘要后仍超限的容忍次数（默认 MAX_COMPACTION_ATTEMPTS = 2；超过即熔断信号）。 */
  maxAttempts?: number;
  /** 连续窗口（毫秒，默认 DEBOUNCE_WINDOW_MS = 5 分钟）。 */
  windowMs?: number;
}

export class CompactionDebouncer {
  readonly maxAttempts: number;
  readonly windowMs: number;
  #attempts = 0;
  #windowStart = 0;

  constructor(options: CompactionDebouncerOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? MAX_COMPACTION_ATTEMPTS;
    this.windowMs = options.windowMs ?? DEBOUNCE_WINDOW_MS;
  }

  /** 窗口内「摘要后仍超限」的连续次数（唯一计数名，原名 count 与此两名一值，已统一）。 */
  get attempts(): number {
    return this.#attempts;
  }

  /**
   * 记录一次压缩后的判定结果：stillOver=false（摘要后已回到预算内）→ 清零；
   * stillOver=true → 窗口内递增（超窗重起）。只记录状态，不返回语义（查询走 shouldTrip）。
   */
  record(timestamp: number, stillOver: boolean): void {
    if (!stillOver) {
      this.reset();
      return;
    }
    if (this.#attempts === 0 || timestamp - this.#windowStart > this.windowMs) {
      this.#attempts = 1;
      this.#windowStart = timestamp;
    } else {
      this.#attempts += 1;
    }
  }

  /** 当前是否应发出熔断信号（窗口内连续计数 > maxAttempts）。 */
  shouldTrip(): boolean {
    return this.#attempts > this.maxAttempts;
  }

  /** 主动清零（换任务/会话、或一次干净 Step 后）。 */
  reset(): void {
    this.#attempts = 0;
    this.#windowStart = 0;
  }
}
