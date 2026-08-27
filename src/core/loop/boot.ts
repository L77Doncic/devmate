/**
 * # loop/boot：把 llm/retry/context/session 接线成主循环运行面
 *
 * 本文件是接缝 S5 的接线层：把 Provider Adapter（S2）+ 传输层重试器（S6）+
 * LlmClient（S1）组合为 loop 依赖的 LlmAdapter（统一 ChatRequest/StreamEvent 口径）。
 *
 * 重试语义（ADR-0006 分层；research §4.2「流式请求的重试语义」）：
 * - 只有「未产生任何可见增量、且无任何工具被执行」时才允许静默重试（同一 wire 重发）；
 * - 已产生可见增量后的失败 → 不重试、不重放：增量原样上抛、错误紧跟其上（降级提示）；
 * - Retry-After 优先（响应头秒值，×1000 换算毫秒并钳到 capMs 上限）；退避按注入的 RetryPolicy（Equal Jitter 默认）。
 */
import { LlmError } from '../../shared/llm-types.js';
import type { ChatRequest, StreamEvent } from '../../shared/llm-types.js';
import { buildRequest } from '../llm/index.js';
import type { ProviderPreset, WireRequest } from '../llm/index.js';
import { retry } from '../retry/index.js';
import type { RetryOptions, RetryPolicy } from '../retry/index.js';
import type { LlmAdapter } from './types.js';

export interface WiredLlmAdapterOptions {
  provider: ProviderPreset;
  /** 传输层客户端（真实为 LlmClient；测试注入假客户端）。 */
  client: {
    chat(wire: WireRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  };
  /** 重试策略；缺省 = 经验默认（research §4.2：base=500ms、cap=20s、maxAttempts=5）。 */
  policy?: RetryPolicy;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 把 provider + client + retry 接线为 loop 的 LlmAdapter。 */
export function wiredLlmAdapter(options: WiredLlmAdapterOptions): LlmAdapter {
  const { provider, client } = options;
  const capMs = options.policy?.capMs ?? 20_000;
  const defaultPolicy: RetryPolicy = {
    maxAttempts: 5,
    baseDelayMs: 500,
    capMs,
    shouldRetry(error): boolean | { delayMs: number } {
      if (!(error instanceof LlmError) || !error.retryable) return false;
      if (error.retryAfter !== undefined) {
        // Retry-After 优先（research §4.2），钳 cap（防服务端超大值）
        return { delayMs: Math.min(error.retryAfter * 1000, capMs) };
      }
      return true;
    },
  };
  const policy = options.policy ?? defaultPolicy;
  const retryOptions: RetryOptions = {};
  if (options.random !== undefined) retryOptions.random = options.random;
  if (options.sleep !== undefined) retryOptions.sleep = options.sleep;

  return {
    async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      const wire = buildRequest(request, provider);
      try {
        const opened = await retry(
          () => openUntilVisible(client, wire, signal),
          policy,
          retryOptions,
        );
        yield* opened.head;
        while (true) {
          const { done, value } = await opened.rest.next();
          if (done) return;
          yield value;
        }
      } catch (err) {
        const error =
          err instanceof LlmError
            ? err
            : new LlmError({
                kind: 'transport',
                status: 0,
                retryable: false,
                message: err instanceof Error ? err.message : String(err),
              });
        yield {
          type: 'error',
          error,
          snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
        };
        return;
      }
    },
  };
}

type OpenedStream = {
  head: StreamEvent[];
  rest: AsyncIterator<StreamEvent>;
};

/**
 * 一次传输尝试：消费到「第一条可见增量（text/reasoning）或正常终态（end）」为止。
 * 此前的传输错误（无可见增量）抛出 → retry() 按策略判定；此后（已见增量）的错误
 * 在 rest 上继续冒泡（不重试、不重放）。
 */
type ChatClient = {
  chat(wire: WireRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
};

async function openUntilVisible(
  client: ChatClient,
  wire: WireRequest,
  signal: AbortSignal | undefined,
): Promise<OpenedStream> {
  const iter = client.chat(wire, signal)[Symbol.asyncIterator]();
  const head: StreamEvent[] = [];
  while (true) {
    const { done, value } = await iter.next();
    if (done) return { head, rest: iter };
    if (value.type === 'text' || value.type === 'reasoning' || value.type === 'end') {
      head.push(value);
      return { head, rest: iter };
    }
    // error：本尝试未产生任何可见增量 → 交给重试器
    throw value.error;
  }
}
