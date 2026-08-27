import { describe, expect, it } from 'vitest';
import { LlmClient, LlmError } from '../../src/core/llm/index.js';
import type { StreamEvent, WireRequest } from '../../src/core/llm/index.js';

/**
 * LlmClient 公共接口规格（接缝 S1，ADR-0001 修订：客户端为纯传输层）。
 * 只打公共 API chat(wire: WireRequest, signal?): AsyncIterable<StreamEvent>；
 * SSE 解析、分片拼接、错误映射均只能经接口观察。序列化/字段映射断言已迁至
 * provider-adapter.test.ts（序列化归 S2）——本文件只保留传输层断言：
 * URL/头/body 照单发送 + 流解析行为不变。
 * SSE chunk 样本为按 openai-compatible-api-spec.md 原文形状手写的逐字片段
 * （§4.2 chunk 骨架、§2.1 tool_calls 值、§6.1 错误体），预期值不复算。
 */

// ---------- 测试脚手架：注入假 fetch ----------

/** 假响应工厂选项：status/headers 直通；streamError 为「片数组 + 断流」专用。 */
interface FakeResponseOpts {
  status?: number;
  headers?: Record<string, string>;
  /** 设置后：最后一个文本片送达后以该错误断流（连接中断场景）。 */
  streamError?: unknown;
}

/**
 * 统一假响应工厂（合并原 sseResponse / jsonResponse / brokenStreamResponse 三个近同构入口）：
 * - 字符串体：直接 JSON/文本响应（§6.1 错误体三种形状）；
 * - 片数组：ReadableStream 逐片送达（SSE 流）；流结束自然 close，或按 streamError 断流。
 * 片数组默认带 event-stream content-type；字符串体默认不带（客户端把空 content-type
 * 视为合法流式响应）。
 */
function fakeResponse(
  body: Array<string | Uint8Array> | string,
  opts: FakeResponseOpts = {},
): Response {
  const encoder = new TextEncoder();
  // ResponseInit 的属性是 readonly：一次构造，按需携带 status/headers
  const init: ResponseInit = {
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.headers !== undefined
      ? { headers: opts.headers }
      : typeof body !== 'string'
        ? { headers: { 'content-type': 'text/event-stream' } }
        : {}),
  };
  if (typeof body === 'string') {
    return new Response(body, init);
  }
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < body.length) {
        const chunk = body[i++];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        return;
      }
      if (opts.streamError !== undefined) {
        controller.error(opts.streamError);
        return;
      }
      controller.close();
    },
  });
  return new Response(stream, init);
}

async function collectEvents(
  client: LlmClient,
  request: WireRequest,
  signal?: AbortSignal,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.chat(request, signal)) events.push(event);
  return events;
}

/** 从供应商视角手写的固定 chunk 片段（model/created/id 每 chunk 附带，§4.2）。 */
const CH = {
  roleEmpty:
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null,"logprobs":null}],"usage":null}\n',
  hello:
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null,"logprobs":null}],"usage":null}\n',
  spaceWorld:
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null,"logprobs":null}],"usage":null}\n',
  finishStop:
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}],"usage":null}\n',
  done: 'data: [DONE]\n',
} as const;

function makeClient(fetchImpl: typeof fetch, options: Partial<{ apiKey: string }> = {}): LlmClient {
  return new LlmClient({
    ...options,
    fetch: fetchImpl,
  });
}

/**
 * adapter 归一的 wire（序列化归 S2；本文件只关心传输与流解析，不再断言字段映射）。
 * baseUrl 与 body 至少像 deepseek preset 的产物——请求体由 adapter 决定。
 */
const helloWire: WireRequest = {
  baseUrl: 'https://api.deepseek.com',
  body: {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '你好' }],
    stream: true,
  },
};

// ---------- slice a：简单文本流 + [DONE] 终止 + 传输层（URL/头/body 照单发送） ----------

describe('LlmClient · a) 简单文本流', () => {
  it('LlmClient 流式返回以 [DONE] 终止：内容分片拼接，end.finishReason=stop', async () => {
    const client = makeClient(async () =>
      fakeResponse([
        `${CH.roleEmpty}\n${CH.hello}\n${CH.spaceWorld}\n${CH.finishStop}\n${CH.done}\n`,
      ]),
    );

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: '' }, // role 分片：content:"" 表示「尚未开始」（§8.A.7）
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      {
        type: 'end',
        snapshot: {
          finishReason: 'stop',
          usage: null,
          usageMissing: true, // 未见到任何 usage → 上层本地估算兜底（§4.5）
          toolCalls: [],
        },
      },
    ]);
  });

  it('传输层照单发送：URL=baseUrl+path（去尾斜杠）、POST、Bearer 头、body 与 WireRequest 完全一致', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const client = makeClient(
      async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return fakeResponse([`${CH.done}\n`]);
      },
      { apiKey: 'sk-abc' },
    );

    // extraBody（Qwen 专属）在序列化时并入 JSON 顶层——传输层唯一动 body 的地方
    const wire: WireRequest = {
      baseUrl: 'https://api.moonshot.cn/v1',
      body: {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: '你好' }],
        stream: true,
      },
      extraBody: { enable_thinking: true, thinking_budget: 4000 },
    };
    await collectEvents(client, wire);

    expect(capturedUrl).toBe('https://api.moonshot.cn/v1/chat/completions');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toMatchObject({
      authorization: 'Bearer sk-abc',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    });
    // signal 未传时不应带出
    expect(capturedInit?.signal).toBeUndefined();

    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      enable_thinking: true, // extraBody 并入顶层
      thinking_budget: 4000,
      model: 'kimi-k3',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
    });
  });

  it('baseUrl 尾斜杠剔除：/path/v4/ → /path/v4/chat/completions；无 apiKey 不带 Authorization', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const client = makeClient(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return fakeResponse([`${CH.done}\n`]);
    });

    await collectEvents(client, {
      ...helloWire,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
      body: { ...helloWire.body, model: 'glm-5.3' },
    });

    expect(capturedUrl).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(
      (capturedInit?.headers as Record<string, string> | undefined)?.authorization,
    ).toBeUndefined();
  });

  it('SSE 解析：CRLF、注释行与空行分组不产生垃圾事件（§8.A.3）', async () => {
    const crlfChunks = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null,"logprobs":null}],"usage":null}\r\n',
      '\r\n',
      ': keep-alive\r\n',
      '\r\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"B"},"finish_reason":null,"logprobs":null}],"usage":null}\r\n',
      '\r\n',
      'data: [DONE]\r\n',
      '\r\n',
    ].join('');
    const client = makeClient(async () => fakeResponse([crlfChunks]));

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
      {
        type: 'end',
        snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
      },
    ]);
  });

  it('SSE 解析：UTF-8 多字节字符跨分帧不被切断（§8.A.4）', async () => {
    const sseText =
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"北京"},"finish_reason":null,"logprobs":null}],"usage":null}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(sseText);
    // 在北京的 utf-8 分帧中间拆开（北=0xE5 0x8C 0x97）
    const beijingPrefixBytes = new TextEncoder().encode(
      sseText.slice(0, sseText.indexOf('北')),
    ).length;
    const cut = beijingPrefixBytes + 1;
    const client = makeClient(async () => fakeResponse([bytes.slice(0, cut), bytes.slice(cut)]));

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: '北京' },
      {
        type: 'end',
        snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
      },
    ]);
  });

  it('SSE 解析：data: 跨行合并成一个事件后才 JSON.parse（§8.A.1）', async () => {
    const multiLineChunks = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"multi"}\n',
      'data: ,"finish_reason":null,"logprobs":null}],"usage":null}\n',
      '\n',
      'data: [DONE]\n\n',
    ].join('');
    const client = makeClient(async () => fakeResponse([multiLineChunks]));

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: 'multi' },
      {
        type: 'end',
        snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
      },
    ]);
  });

  it('未配置 apiKey 时不发送 Authorization 头', async () => {
    let capturedInit: RequestInit | undefined;
    const client = makeClient(async (_url, init) => {
      capturedInit = init;
      return fakeResponse([`${CH.done}\n`]);
    });

    await collectEvents(client, helloWire);
    expect(capturedInit?.headers).not.toBeUndefined();
    expect((capturedInit?.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

// ---------- slice b：usage 载体（choices 为空的附加 chunk / 末内容 chunk） ----------

describe('LlmClient · b) usage 采集', () => {
  it('usage-only chunk（choices:[]）被当 usage 载体而非垃圾（§8.A.6）', async () => {
    const chunks = [
      `${CH.roleEmpty}\n`,
      `${CH.hello}\n`,
      `${CH.finishStop}\n`,
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":3}}}\n\n',
      `${CH.done}\n`,
    ].join('');
    const client = makeClient(async () => fakeResponse([chunks]));

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: 'Hello' },
      {
        type: 'end',
        snapshot: {
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 3 },
          usageMissing: false,
          toolCalls: [],
        },
      },
    ]);
  });

  it('usage 挂在最后内容 chunk（DeepSeek）也被采集，hit/miss 明细保留（§4.5）', async () => {
    const chunks = [
      `${CH.roleEmpty}\n`,
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null,"logprobs":null}],"usage":null}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}\n\n',
      `${CH.done}\n`,
    ].join('');
    const client = makeClient(async () => fakeResponse([chunks]));

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: 'Hi' },
      {
        type: 'end',
        snapshot: {
          finishReason: 'stop',
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            promptCacheHitTokens: 80,
            promptCacheMissTokens: 20,
          },
          usageMissing: false,
          toolCalls: [],
        },
      },
    ]);
  });

  it('usage 为 null 的 chunk 一律静默忽略（null 出现位置按 §4.2 原文）', async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"x"}}],"usage":null}\n\n',
      'data: {"choices":[],"usage":null}\n\n',
      `${CH.done}\n`,
    ].join('');
    const client = makeClient(async () => fakeResponse([chunks]));

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: 'x' },
      {
        type: 'end',
        snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
      },
    ]);
  });
});

// ---------- slice c：tool_calls 分片按 index 拼接 ----------

describe('LlmClient · c) tool_calls 分片拼接', () => {
  it('多 choice（n=2 同 chunk）：两个 choice 各一个 index=0 的 tool_call，按 choice 独立聚合、文本不交错（§8.A.11）', async () => {
    // 官方多 choice 形状：choices[i].index 区分流道；每个 choice 内部的 tc.index 都从 0 起。
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hello","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\""}}]},"finish_reason":null},{"index":1,"delta":{"content":"Bonjour","tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"send_email","arguments":"{\\"to\\":\\""}}]},"finish_reason":null}],"usage":null}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"北京\\"}"}}]},"finish_reason":null},{"index":1,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"bob@x.com\\"}"}}]},"finish_reason":null}],"usage":null}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"},{"index":1,"delta":{},"finish_reason":"tool_calls"}],"usage":null}\n\n',
      `${CH.done}\n`,
    ].join('');
    const client = makeClient(async () => fakeResponse([chunks]));

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'Bonjour' },
      {
        type: 'end',
        snapshot: {
          finishReason: 'tool_calls',
          usage: null,
          usageMissing: true,
          // 两个 choice 的 tc.index 都为 0，但彼此独立聚合成两条（互不合并/污染）
          toolCalls: [
            { index: 0, id: 'call_a', name: 'get_weather', arguments: '{"city":"北京"}' },
            { index: 0, id: 'call_b', name: 'send_email', arguments: '{"to":"bob@x.com"}' },
          ],
        },
      },
    ]);
  });

  it('tool_calls 分片按 index 拼接为完整参数（id/name 只在首分片）', async () => {
    // §2.1 的值逐字：call_xxx / get_weather / {"city":"北京"}；GLM 惯例首分片 content:null（§3.3）
    const chunks = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":null,"tool_calls":[{"index":0,"id":"call_xxx","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]},"finish_reason":null,"logprobs":null}],"usage":null}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"北京\\"}"}}]},"finish_reason":null,"logprobs":null}],"usage":null}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls","logprobs":null}],"usage":null}\n\n',
      `${CH.done}\n`,
    ].join('');
    const client = makeClient(async () => fakeResponse([chunks]));

    // 分片拼接隐藏在客户端内部：公共事件流不暴露 fragment（§8.B 契约），
    // 只有终态快照携带装配结果。
    expect(await collectEvents(client, helloWire)).toEqual([
      {
        type: 'end',
        snapshot: {
          finishReason: 'tool_calls',
          usage: null,
          usageMissing: true,
          toolCalls: [
            { index: 0, id: 'call_xxx', name: 'get_weather', arguments: '{"city":"北京"}' },
          ],
        },
      },
    ]);
  });

  it('多个并行 tool_calls（不同 index）互不污染（§2.2 值：call_a/call_b）', async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\""}},{"index":1,"id":"call_b","type":"function","function":{"name":"send_email","arguments":"{\\"to\\":\\""}}]},"finish_reason":null}],"usage":null}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"北京\\"}"}},{"index":1,"function":{"arguments":"bob@x.com\\",\\"body\\":\\"hi\\"}"}}]},"finish_reason":null}],"usage":null}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":null}\n\n',
      `${CH.done}\n`,
    ].join('');
    const client = makeClient(async () => fakeResponse([chunks]));

    expect(await collectEvents(client, helloWire)).toEqual([
      {
        type: 'end',
        snapshot: {
          finishReason: 'tool_calls',
          usage: null,
          usageMissing: true,
          toolCalls: [
            { index: 0, id: 'call_a', name: 'get_weather', arguments: '{"city":"北京"}' },
            {
              index: 1,
              id: 'call_b',
              name: 'send_email',
              arguments: '{"to":"bob@x.com","body":"hi"}',
            },
          ],
        },
      },
    ]);
  });

  it('id/name 重复出现采纳首个；function 缺失的容错分片不丢（§8.B.14）', async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"f","arguments":"{\\"a\\":"}}]},"finish_reason":null}],"usage":null}\n\n',
      // 后续分片 id/name 重复出现（少数实现，§8.B.14）：name 第二次为空、函数体缺失只有 id
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"arguments":"1}"}},{"index":1,"id":"call_b"}]},"finish_reason":null}],"usage":null}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":null}\n\n',
      `${CH.done}\n`,
    ].join('');
    const client = makeClient(async () => fakeResponse([chunks]));

    const events = await collectEvents(client, helloWire);
    const end = events[events.length - 1];
    expect(end).toMatchObject({
      type: 'end',
      snapshot: {
        finishReason: 'tool_calls',
        toolCalls: [
          { index: 0, id: 'call_a', name: 'f', arguments: '{"a":1}' },
          { index: 1, id: 'call_b', name: '', arguments: '' },
        ],
      },
    });
  });

  it('tc.index 缺失视为 0（§4.3 原文容错）', async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_x","type":"function","function":{"name":"g","arguments":"{}"}}]},"finish_reason":null}],"usage":null}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":null}\n\n',
      `${CH.done}\n`,
    ].join('');
    const client = makeClient(async () => fakeResponse([chunks]));

    expect(await collectEvents(client, helloWire)).toEqual([
      {
        type: 'end',
        snapshot: {
          finishReason: 'tool_calls',
          usage: null,
          usageMissing: true,
          toolCalls: [{ index: 0, id: 'call_x', name: 'g', arguments: '{}' }],
        },
      },
    ]);
  });
});

// ---------- slice d：统一错误映射（429/5xx/4xx、Retry-After、错误体三形状） ----------

const emptySnapshot = { finishReason: null, usage: null, usageMissing: true, toolCalls: [] };

describe('LlmClient · d) 错误映射', () => {
  it('429 + Retry-After 秒值 → 可重试、提取秒数、错误体 message/code（§6.1 形状 A）', async () => {
    const client = makeClient(async () =>
      fakeResponse(
        '{ "error": { "message": "Rate limit reached", "type": "rate_limit_error", "param": null, "code": "rate_limit_exceeded" } }',
        { status: 429, headers: { 'retry-after': '5' } },
      ),
    );

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({
      type: 'error',
      error: {
        kind: 'http',
        status: 429,
        retryable: true,
        retryAfter: 5,
        code: 'rate_limit_exceeded',
        message: 'Rate limit reached',
      },
      snapshot: emptySnapshot,
    });
    expect((event as { type: 'error'; error: LlmError }).error).toBeInstanceOf(LlmError);
  });

  it('500 → 可重试、无 Retry-After', async () => {
    const client = makeClient(async () =>
      fakeResponse(
        '{ "error": { "message": "The server had an error", "type": "server_error" } }',
        { status: 500 },
      ),
    );

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({
      type: 'error',
      error: {
        kind: 'http',
        status: 500,
        retryable: true,
        message: 'The server had an error',
        code: 'server_error',
      },
      snapshot: emptySnapshot,
    });
    expect(
      (event as { type: 'error'; error: { retryAfter?: number } }).error.retryAfter,
    ).toBeUndefined();
  });

  it('400（code 为 null）→ 不可重试，code 取 type（§6.1 形状 A）', async () => {
    const client = makeClient(async () =>
      fakeResponse(
        '{ "error": { "message": "Invalid parameters", "type": "invalid_request_error", "param": "temperature", "code": null } }',
        { status: 400 },
      ),
    );

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({
      type: 'error',
      error: {
        kind: 'http',
        status: 400,
        retryable: false,
        message: 'Invalid parameters',
        code: 'invalid_request_error',
      },
      snapshot: emptySnapshot,
    });
  });

  it('401 GLM 字符串型业务码 → code 逐字保留（§6.1 形状 B）', async () => {
    const client = makeClient(async () =>
      fakeResponse(
        '{ "error": { "code": "1001", "message": "Header 中未收到 Authentication 参数，无法进行身份验证" } }',
        { status: 401 },
      ),
    );

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({
      type: 'error',
      error: {
        kind: 'http',
        status: 401,
        retryable: false,
        message: 'Header 中未收到 Authentication 参数，无法进行身份验证',
        code: '1001',
      },
      snapshot: emptySnapshot,
    });
  });

  it('504 非 JSON 错误体（HTML，Kimi 网关）→ 原始摘录 + 可重试（§6.1 形状 C）', async () => {
    const client = makeClient(async () =>
      fakeResponse('<html><body>504 Gateway Timeout</body></html>', { status: 504 }),
    );

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({
      type: 'error',
      error: {
        kind: 'http',
        status: 504,
        retryable: true,
      },
      snapshot: emptySnapshot,
    });
    const error = (event as { type: 'error'; error: { message: string; bodySnippet?: string } })
      .error;
    expect(error.message).toContain('504 Gateway Timeout');
    expect(error.bodySnippet).toContain('504 Gateway Timeout');
  });

  it('Retry-After 超过上限（86400 秒）→ 不照单全收，交默认退避（§6.3 上限）', async () => {
    const client = makeClient(async () =>
      fakeResponse('{}', { status: 429, headers: { 'retry-after': '86400' } }),
    );

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({ type: 'error', error: { status: 429, retryable: true } });
    expect(
      (event as { type: 'error'; error: { retryAfter?: number } }).error.retryAfter,
    ).toBeUndefined();
  });

  it('retry-after-ms（毫秒）→ 换算为秒（§6.3 官方 SDK 三形式①）', async () => {
    const client = makeClient(async () =>
      fakeResponse('{}', { status: 429, headers: { 'retry-after-ms': '1500' } }),
    );

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({
      type: 'error',
      error: { status: 429, retryable: true, retryAfter: 1.5 },
    });
  });

  it('retry-after 为 HTTP-date → 换算剩余秒；不可解析的头不用（§6.3 三形式②③）', async () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    const clientA = makeClient(async () =>
      fakeResponse('{}', { status: 429, headers: { 'retry-after': date } }),
    );
    const [a] = await collectEvents(clientA, helloWire);
    expect(a).toMatchObject({ type: 'error', error: { retryable: true } });
    const retryAfter = (a as { type: 'error'; error: { retryAfter?: number } }).error.retryAfter;
    expect(retryAfter).toBeDefined();
    expect(retryAfter as number).toBeGreaterThan(0);
    expect(retryAfter as number).toBeLessThanOrEqual(60);

    const clientB = makeClient(async () =>
      fakeResponse('{}', { status: 429, headers: { 'retry-after': 'not-a-date' } }),
    );
    const [b] = await collectEvents(clientB, helloWire);
    expect(b).toMatchObject({ type: 'error', error: { retryable: true } });
    expect(
      (b as { type: 'error'; error: { retryAfter?: number } }).error.retryAfter,
    ).toBeUndefined();
  });

  it.each([408, 425, 502, 503])('%d → 归入可重试集合（§6.3）', async (status) => {
    const client = makeClient(async () => fakeResponse('{}', { status }));

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({
      type: 'error',
      error: { kind: 'http', status, retryable: true },
      snapshot: emptySnapshot,
    });
  });

  it('200 但 content-type 非 event-stream（HTML 混入 SSE 通道）→ 按错误处理（§8.A.9）', async () => {
    const client = makeClient(async () =>
      fakeResponse('<html>bad gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({
      type: 'error',
      error: { kind: 'http', status: 200, retryable: true },
      snapshot: emptySnapshot,
    });
    expect((event as { type: 'error'; error: { message: string } }).error.message).toContain(
      'bad gateway',
    );
  });

  it('SSE 通道出现非 JSON 数据事件 → 协议错误事件（不误判为流结束）', async () => {
    const client = makeClient(async () => fakeResponse(['data: not-json\n\ndata: [DONE]\n\n']));

    const [event] = await collectEvents(client, helloWire);
    expect(event).toMatchObject({
      type: 'error',
      error: { kind: 'protocol', status: 0, retryable: true },
      snapshot: emptySnapshot,
    });
  });

  it('尾帧坏 JSON 且无空行收尾（EOF 触发 flush）→ 恰一个 protocol 错误，不叠加 EOF 错误', async () => {
    const client = makeClient(async () =>
      fakeResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}],"usage":null}\n\n',
        'data: not-json\n', // 末事件正文坏、又无空行 → 要靠 EOF 尾 flush 才 dispatch
      ]),
    );

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: 'A' },
      {
        type: 'error',
        error: expect.objectContaining({ kind: 'protocol', status: 0, retryable: true }),
        snapshot: emptySnapshot,
      },
    ]);
  });
});

// ---------- slice e：流中断（连接断开 / EOF 缺 [DONE] / 中止信号） ----------

describe('LlmClient · e) 流中断', () => {
  it('消费者提前 break 离开 for-await → reader.cancel() 释放连接（不留悬挂读）', async () => {
    const encoder = new TextEncoder();
    let cancelCalls = 0;
    let pulled = false;
    // 流永不 close：read() 不会 done，服务器侧保持连接——正是「客户端 break 后仍挂读」的场景
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}],"usage":null}\n\ndata: [DONE]\n\n',
            ),
          );
        }
      },
      cancel() {
        cancelCalls++;
      },
    });
    const client = makeClient(
      async () =>
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );

    for await (const event of client.chat(helloWire)) {
      expect(event).toMatchObject({ type: 'text', text: 'A' });
      break;
    }

    expect(cancelCalls).toBe(1);
  });

  it('连接断开：已派发 delta 保留可读，随后是 transport 错误事件', async () => {
    const chunks = [`${CH.roleEmpty}\n\n`, `${CH.hello}\n\n`];
    const client = makeClient(async () =>
      fakeResponse(chunks, { streamError: new TypeError('network reset') }),
    );

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: 'Hello' },
      {
        type: 'error',
        error: expect.objectContaining({
          kind: 'transport',
          status: 0,
          retryable: true,
        }),
        snapshot: {
          finishReason: null,
          usage: null,
          usageMissing: true, // §8.A.8：断流拿不到 usage chunk → 缺标记
          toolCalls: [],
        },
      },
    ]);
  });

  it('EOF 未见 [DONE]：部分 tool_call 保留在错误快照中，usage 缺失', async () => {
    // 流正常读完（close）但整个流里没有 [DONE] —— 按「连接断开」对待
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_xxx","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}],"usage":null}\n\n',
    ];
    const client = makeClient(async () => fakeResponse(chunks));

    expect(await collectEvents(client, helloWire)).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({ kind: 'transport', retryable: true }),
        snapshot: {
          finishReason: null,
          usage: null,
          usageMissing: true,
          toolCalls: [{ index: 0, id: 'call_xxx', name: 'get_weather', arguments: '{"city":' }],
        },
      },
    ]);
  });

  it('reader.read() 中途抛 AbortError：已发 delta 保留，中止错误不可重试', async () => {
    const client = makeClient(async () =>
      fakeResponse([`${CH.roleEmpty}\n\n`, `${CH.hello}\n\n`], {
        streamError: new DOMException('This operation was aborted', 'AbortError'),
      }),
    );

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: 'Hello' },
      {
        type: 'error',
        error: expect.objectContaining({ kind: 'abort', status: 0, retryable: false }),
        snapshot: { finishReason: null, usage: null, usageMissing: true, toolCalls: [] },
      },
    ]);
  });

  it('signal 传给 fetch；AbortError 映射为不可重试的 abort 错误', async () => {
    let capturedSignal: AbortSignal | undefined;
    const client = makeClient(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    const controller = new AbortController();
    const [event] = await collectEvents(client, helloWire, controller.signal);

    expect(capturedSignal).toEqual(controller.signal);
    expect(event).toMatchObject({
      type: 'error',
      error: { kind: 'abort', status: 0, retryable: false },
      snapshot: emptySnapshot,
    });
  });
});

// ---------- slice f：reasoning_content（独立字段保留；回传策略归 S2，不在此层） ----------

describe('LlmClient · f) reasoning_content', () => {
  it('delta.reasoning_content 以独立事件按序保留，与 content 互不混杂', async () => {
    // DeepSeek 思考模式形状（§1.6/§3.3）：先 reasoning 分片、后正文
    const chunks = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":"先"},"finish_reason":null,"logprobs":null}],"usage":null}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"reasoning_content":"仔细"},"finish_reason":null,"logprobs":null}],"usage":null}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1720000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"答案"},"finish_reason":null,"logprobs":null}],"usage":null}\n\n',
      `${CH.finishStop}\n`,
      `${CH.done}\n`,
    ].join('');
    const client = makeClient(async () => fakeResponse([chunks]));

    expect(await collectEvents(client, helloWire)).toEqual([
      { type: 'reasoning', text: '先' },
      { type: 'reasoning', text: '仔细' },
      { type: 'text', text: '答案' },
      {
        type: 'end',
        snapshot: { finishReason: 'stop', usage: null, usageMissing: true, toolCalls: [] },
      },
    ]);
  });

  // reasoning_content 的回传序列化属 S2 策略（§3.3）——已在 provider-adapter.test.ts
  // 的 keep/remove/never-send 三档断言覆盖（迁移项）；本层只保留 delta 事件发布。
});
