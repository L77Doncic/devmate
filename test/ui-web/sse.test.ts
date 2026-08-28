/**
 * sse.js 单测：行缓冲跨 chunk、注释忽略、多 data 行、JSON 错误、HTTP/abort 路径。
 */
import { describe, expect, it } from 'vitest';
import { consumeSSE, createSSEParser } from '../../src/ui/web/sse.js';

type Parsed = { event: string; data: unknown; raw: string; parseError: boolean };

describe('createSSEParser', () => {
  it('解析完整事件（event + data 单行）', () => {
    const parser = createSSEParser();
    const events: Parsed[] = parser.feed('event: assistant-delta\ndata: {"text":"你"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'assistant-delta',
      data: { text: '你' },
      raw: '{"text":"你"}',
      parseError: false,
    });
  });

  it('跨 chunk 边界保持行缓冲（多次 feed 不断句）', () => {
    const parser = createSSEParser();
    const e1: Parsed[] = parser.feed('event: assistant-delta\ndata: {"tex');
    const e2: Parsed[] = parser.feed('t":"好"}\n\n');
    expect(e1).toHaveLength(0);
    expect(e2).toHaveLength(1);
    expect(e2[0]!.data).toEqual({ text: '好' });
  });

  it('忽略注释行（: ping 等）', () => {
    const parser = createSSEParser();
    const events: Parsed[] = parser.feed(
      ': ping\n\n' + // 注释 + 空行（未带数据，不发事件）
        'event: usage\n: 心跳\ndata: {"totalTokens":1}\n\n',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('usage');
  });

  it('多 data 行按 \n 拼接（SSE 规范）', () => {
    const parser = createSSEParser();
    const events: Parsed[] = parser.feed(
      'event: run-status\ndata: {"status":"done"}\ndata: "extra"\n\n',
    );
    expect(events[0]!.raw).toBe('{"status":"done"}\n"extra"');
    expect(events[0]!.parseError).toBe(true); // 拼接后不是合法 JSON
  });

  it('CRLF 换行兼容', () => {
    const parser = createSSEParser();
    const events: Parsed[] = parser.feed('event: session-user\r\ndata: {"text":"hi"}\r\n\r\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ text: 'hi' });
  });

  it('无 data 前事件边界不产生虚假事件；缺 event 字段用 message', () => {
    const parser = createSSEParser();
    const events: Parsed[] = parser.feed('\n\ndata: {"x":1}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('message');
  });

  it('JSON 解析失败不抛异常，带 parseError 标记', () => {
    const parser = createSSEParser();
    const events: Parsed[] = parser.feed('event: assistant-done\ndata: [DONE]\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.parseError).toBe(true);
    expect(events[0]!.data).toBe('[DONE]');
  });

  it('reset 丢弃半截缓冲', () => {
    const parser = createSSEParser();
    parser.feed('event: tool-start\ndata: {"id"');
    expect(parser.hasPending()).toBe(true);
    parser.reset();
    expect(parser.hasPending()).toBe(false);
    expect(parser.feed('event: run-error\ndata: {"message":"x"}\n\n')).toHaveLength(1);
  });

  it('一段真实协议流（对话 → 工具 → 审批 → 结束）全量解析', () => {
    const stream = [
      'event: session-user\ndata: {"text":"帮我压缩项目"}\n\n',
      ': ping\n\n',
      'event: assistant-delta\ndata: {"text":"好的，我先看"}\n\n',
      'event: tool-start\ndata: {"id":"t1","name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}\n\n',
      'event: approval-request\ndata: {"toolCallId":"t1","name":"bash","arguments":"{\\"cmd\\":\\"rm -rf\\"}"}\n\n',
      'event: tool-result\ndata: {"id":"t1","name":"bash","ok":true,"contentPreview":"ok"}\n\n',
      'event: usage\ndata: {"promptTokens":10,"completionTokens":2,"totalTokens":12,"costUsd":0.001,"estimated":true}\n\n',
      'event: run-status\ndata: {"status":"done","steps":1,"durationMs":1200}\n\n',
    ].join('');
    const parser = createSSEParser();
    const events: Parsed[] = parser.feed(stream);
    expect(events.map((e) => e.event)).toEqual([
      'session-user',
      'assistant-delta',
      'tool-start',
      'approval-request',
      'tool-result',
      'usage',
      'run-status',
    ]);
    expect((events[2]!.data as { arguments: string }).arguments).toContain('ls');
  });

  it('忽略未知/未识别的字段行（event *、retry: 等规范内字段）', () => {
    const parser = createSSEParser();
    const events: Parsed[] = parser.feed('id: 5\nretry: 1000\ndata: {"a":1}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// consumeSSE（注入 fake fetch + ReadableStream）
// ---------------------------------------------------------------------------

function fakeFetch(chunks: string[], { status = 200, fail = false } = {}) {
  const sends: Array<{ url: string; opts: RequestInit }> = [];
  const fetchImpl = (async (url: string, opts: any) => {
    sends.push({ url, opts });
    if (fail) throw new Error('simulated network failure');
    const encoder = new TextEncoder();
    const enqueue = (c: string) => encoder.encode(c);
    let i = 0;
    const stream = new ReadableStream({
      start(controller) {
        // 模拟真实网络的 abort 语义：信号触发 → 底层流报 AbortError
        if (opts?.signal) {
          (opts.signal as AbortSignal).addEventListener('abort', () => {
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              /* 已关闭 */
            }
          });
        }
      },
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(enqueue(chunks[i]!));
          i += 1;
        } else {
          controller.close();
        }
      },
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Nope',
      body: stream,
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, sends };
}

describe('consumeSSE', () => {
  it('读完整流并回调每个事件（含跨 chunk 的半行）', async () => {
    const { fetchImpl, sends } = fakeFetch([
      'event: session-user\ndata: {"text":"你',
      '好"}\n\nevent: usage\ndata: {',
      '"totalTokens":3}\n\n',
    ]);
    const got: any[] = [];
    await consumeSSE({ url: '/api/stream?sessionId=abc', onEvent: (e) => got.push(e), fetchImpl });
    expect(got.map((e) => e.event)).toEqual(['session-user', 'usage']);
    expect((got[0]!.data as { text: string }).text).toBe('你好');
    expect(sends[0]!.url).toBe('/api/stream?sessionId=abc');
    expect(sends[0]!.opts.headers).toMatchObject({ accept: 'text/event-stream' });
  });

  it('注释行整流被忽略', async () => {
    const { fetchImpl } = fakeFetch([
      ': ping\n\n: ping\n\nevent: run-status\ndata: {"status":"idle"}\n\n',
    ]);
    const got: any[] = [];
    await consumeSSE({ url: '/x', onEvent: (e) => got.push(e), fetchImpl });
    expect(got).toHaveLength(1);
  });

  it('HTTP 非 200 抛错', async () => {
    const { fetchImpl } = fakeFetch([''], { status: 404 });
    await expect(consumeSSE({ url: '/api/stream', fetchImpl })).rejects.toThrow(/HTTP 404/);
  });

  it('网络失败上抛（调用方归入连接中断）', async () => {
    const { fetchImpl } = fakeFetch([], { fail: true });
    await expect(consumeSSE({ url: '/api/stream', fetchImpl })).rejects.toThrow(/network/i);
  });

  it('abort 信号传播 AbortError', async () => {
    const ctrl = new AbortController();
    const { fetchImpl } = fakeFetch(['event: u\ndata: {"a":1}\n\n']);
    const p = consumeSSE({ url: '/api/stream', fetchImpl, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
