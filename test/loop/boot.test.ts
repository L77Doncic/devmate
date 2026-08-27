import { describe, expect, it, vi } from 'vitest';
import { wiredLlmAdapter } from '../../src/core/loop/index.js';
import { defaultProviderPreset } from '../../src/core/llm/index.js';
import { LlmError } from '../../src/shared/llm-types.js';
import type { ChatRequest, StreamEvent } from '../../src/shared/llm-types.js';
import type { WireRequest } from '../../src/core/llm/index.js';

/**
 * boot 接线（把 provider adapter + 重试器 + 客户端接成 LlmAdapter）：
 * 传输层错误归重试器（ADR-0006 分层），只有「未产生任何可见增量」才允许静默重试
 * （research §4.2 流式重试语义）；已见增量后的失败直接上抛（不重放、不重发）。
 */

describe('boot：wiredLlmAdapter（provider 序列化 + 传输层静默重试）', () => {
  it('可重试错误（无可见增量）→ 静默重试（Equal Jitter sleep 注入），成功后正常出流', async () => {
    const client = {
      calls: 0,
      async *chat(wire: WireRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
        void wire;
        void _signal;
        this.calls += 1;
        if (this.calls === 1) {
          yield {
            type: 'error',
            error: new LlmError({
              kind: 'http',
              status: 429,
              retryable: true,
              message: 'rate limited',
            }),
            snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
          };
          return;
        }
        yield { type: 'text', text: 'hello' };
        yield {
          type: 'end',
          snapshot: { finishReason: 'stop', usage: null, usageMissing: true, toolCalls: [] },
        };
      },
    };
    const sleep = vi.fn(async () => {});
    const llm = wiredLlmAdapter({
      provider: defaultProviderPreset(),
      client,
      policy: {
        maxAttempts: 3,
        baseDelayMs: 100,
        capMs: 10_000,
        shouldRetry: (e) => e instanceof LlmError && e.retryable,
      },
      random: () => 0,
      sleep,
    });

    const events: StreamEvent[] = [];
    for await (const ev of llm.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    expect(client.calls).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(events.map((ev) => ev.type)).toEqual(['text', 'end']);
  });

  it('不可重试错误 → 单次 error 上抛（绝不重发）', async () => {
    const client = {
      calls: 0,
      async *chat(_wire: unknown, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
        void _wire;
        void _signal;
        this.calls += 1;
        yield {
          type: 'error',
          error: new LlmError({ kind: 'http', status: 401, retryable: false, message: 'bad key' }),
          snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
        };
      },
    };
    const llm = wiredLlmAdapter({
      provider: defaultProviderPreset(),
      client,
      policy: {
        maxAttempts: 3,
        baseDelayMs: 100,
        capMs: 10_000,
        shouldRetry: (e) => e instanceof LlmError && e.retryable,
      },
      random: () => 0,
      sleep: vi.fn(async () => {}),
    });

    const events: StreamEvent[] = [];
    for await (const ev of llm.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    expect(client.calls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect(events[0]?.type === 'error' ? events[0].error.status : -1).toBe(401);
  });

  it('已产生可见增量后的失败 → 不重试、不重放：text 原样转发后 error 上抛', async () => {
    const client = {
      calls: 0,
      async *chat(_wire: unknown, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
        void _wire;
        void _signal;
        this.calls += 1;
        yield { type: 'text', text: 'half done' };
        yield {
          type: 'error',
          error: new LlmError({
            kind: 'transport',
            status: 0,
            retryable: true,
            message: 'stream died',
          }),
          snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
        };
      },
    };
    const llm = wiredLlmAdapter({
      provider: defaultProviderPreset(),
      client,
      policy: {
        maxAttempts: 3,
        baseDelayMs: 100,
        capMs: 10_000,
        shouldRetry: (e) => e instanceof LlmError && e.retryable,
      },
      random: () => 0,
      sleep: vi.fn(async () => {}),
    });

    const events: StreamEvent[] = [];
    for await (const ev of llm.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    expect(client.calls).toBe(1);
    expect(events.map((ev) => ev.type)).toEqual(['text', 'error']);
  });

  it('Retry-After 优先：shouldRetry 返回 {delayMs} 完全覆盖退避（含 cap）', async () => {
    const client = {
      calls: 0,
      async *chat(_wire: unknown, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
        void _wire;
        void _signal;
        this.calls += 1;
        if (this.calls === 1) {
          yield {
            type: 'error',
            error: new LlmError({
              kind: 'http',
              status: 429,
              retryable: true,
              message: 'wide',
              retryAfter: 50_000, // 秒 → 超 cap，应被钳到 capMs
            }),
            snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
          };
          return;
        }
        yield {
          type: 'end',
          snapshot: { finishReason: 'stop', usage: null, usageMissing: true, toolCalls: [] },
        };
      },
    };
    const sleep = vi.fn(async () => {});
    const llm = wiredLlmAdapter({
      provider: defaultProviderPreset(),
      client,
      policy: {
        maxAttempts: 2,
        baseDelayMs: 100,
        capMs: 2_000,
        // 尊重 Retry-After（毫秒）；必须显式钳 cap，未钳则 50_000_000ms
        shouldRetry: (e) =>
          e instanceof LlmError && e.retryable && e.retryAfter !== undefined
            ? { delayMs: Math.min(e.retryAfter * 1000, 2_000) }
            : false,
      },
      random: () => 0,
      sleep,
    });
    const events: StreamEvent[] = [];
    for await (const ev of llm.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    expect(client.calls).toBe(2);
    expect(sleep.mock.calls).toEqual([[2_000]]);
    expect(events.map((ev) => ev.type)).toEqual(['end']);
  });

  it('provider 序列化：ChatRequest → wire（model/messages/tools/stream）', async () => {
    const wires: WireRequest[] = [];
    const client = {
      async *chat(wire: WireRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
        void _signal;
        wires.push(wire);
        yield {
          type: 'end',
          snapshot: { finishReason: 'stop', usage: null, usageMissing: true, toolCalls: [] },
        };
      },
    };
    const llm = wiredLlmAdapter({ provider: defaultProviderPreset(), client });
    const request: ChatRequest = {
      model: 'deepseek-test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'echo', description: 'e', parameters: {} } }],
    };
    for await (const _ev of llm.chat(request)) {
      void _ev;
    }
    const body = wires[0]?.body as Record<string, unknown>;
    expect(body?.['model']).toBe('deepseek-test');
    expect(body?.['stream']).toBe(true);
    expect((body?.['messages'] as Array<Record<string, unknown>>)[0]?.['role']).toBe('user');
    const tools = body?.['tools'] as Array<{ type: string; function: { name: string } }>;
    expect(tools[0]?.function.name).toBe('echo');
  });
});
