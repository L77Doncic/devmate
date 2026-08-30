/**
 * # test/llm/models：网关窗口探测（三源取窗 · 网关层）单元规格
 *
 * discoverWindow 契约：GET {baseUrl}/models（/v1 归一：已是 .../v1 不叠，缺则补）；
 * 匹配当前模型名（id/model/name 大小写不敏感）优先，其次第一条含窗口字段的条目；
 * 字段宽容嗅探（context_length/context_window/contextWindow/max_input/max_input_tokens/
 * max_context）；合法正整数域 ≤1_000_000；无字段 → none（协议无标准字段——诚实）；
 * 无 apiKey → 不请求；网络/4xx/5xx/超时/解析失败 → 静默 none + detail。
 * 全程 mock fetch（零外部网络）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW_TIMEOUT_MS,
  discoverWindow,
  modelsEndpointOf,
  normalizeWindow,
} from '../../src/core/llm/index.js';

/** 假 JSON 响应工厂（status 直通）。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mock fetch 记录（url + init）——断言请求形态用。 */
interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** 收集式 mock：response 工厂 per call。 */
function mockFetch(respond: (url: string, init: RequestInit | undefined) => Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    return respond(u, init);
  }) as typeof fetch;
  return { impl, calls };
}

function fakeFetchOf(body: unknown, status = 200): { impl: typeof fetch; calls: FetchCall[] } {
  return mockFetch(() => Promise.resolve(jsonResponse(body, status)));
}

/** 永不 resolve 但信号感知的 fetch（超时路径：abort 时 reject）。 */
function hangingFetch(): Promise<typeof fetch> {
  return Promise.resolve(((_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      );
    });
  }) as typeof fetch);
}

describe('normalizeWindow：正整 + 域钳 + 无效 → null', () => {
  it('合法值：number 与数字字符串均接受', () => {
    expect(normalizeWindow(128_000)).toBe(128_000);
    expect(normalizeWindow('131072')).toBe(131_072);
    expect(normalizeWindow(1)).toBe(1);
    expect(normalizeWindow(1_000_000)).toBe(1_000_000); // 域上限恰在界内
  });

  it('非法值：NaN/Infinity/0/负数/小数/非数字字符串/类型 → null', () => {
    expect(normalizeWindow(Number.NaN)).toBeNull();
    expect(normalizeWindow(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeWindow(0)).toBeNull();
    expect(normalizeWindow(-128_000)).toBeNull();
    expect(normalizeWindow(13.7)).toBeNull();
    expect(normalizeWindow('131072.5')).toBeNull();
    expect(normalizeWindow('abc')).toBeNull();
    expect(normalizeWindow('')).toBeNull();
    expect(normalizeWindow(null)).toBeNull();
    expect(normalizeWindow(undefined)).toBeNull();
    expect(normalizeWindow({})).toBeNull();
    expect(normalizeWindow(131_072n)).toBeNull();
  });

  it('超大：> 1_000_000 → null（合理域外不可信）', () => {
    expect(normalizeWindow(1_000_001)).toBeNull();
    expect(normalizeWindow(10_000_000)).toBeNull();
  });
});

describe('modelsEndpointOf：baseUrl /v1 归一', () => {
  it('已是 .../v1：不叠；尾斜杠吸收；大小写宽容', () => {
    expect(modelsEndpointOf('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models');
    expect(modelsEndpointOf('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/models');
    expect(modelsEndpointOf('https://api.moonshot.cn/v1')).toBe(
      'https://api.moonshot.cn/v1/models',
    );
    expect(modelsEndpointOf('https://x.example/V1')).toBe('https://x.example/V1/models');
  });

  it('缺 /v1：按兼容面补 /v1', () => {
    expect(modelsEndpointOf('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/models');
    expect(modelsEndpointOf('https://api.deepseek.com/')).toBe(
      'https://api.deepseek.com/v1/models',
    );
  });
});

describe('discoverWindow：模型名匹配与字段嗅探', () => {
  it('命中当前模型（id 大小写不敏感）→ 取该条目字段，source=gateway', async () => {
    const { impl, calls } = fakeFetchOf({
      data: [
        { id: 'o1', context_length: 128_000 },
        { id: 'gpt-mini', context_window: 64_000 },
      ],
    });
    const result = await discoverWindow({
      baseUrl: 'https://x.example/v1',
      apiKey: 'sk-1',
      model: 'GPT-MINI',
      fetchImpl: impl,
    });
    expect(result).toEqual({
      window: 64_000,
      source: 'gateway',
      detail: '命中模型「gpt-mini」（字段 context_window=64000）',
    });
    // 请求形态：GET {base}/models + Bearer 头
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://x.example/v1/models');
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-1');
  });

  it('name/model 键均可匹配', async () => {
    const byName = fakeFetchOf({
      models: [{ model: 'DeepSeek-R1', contextWindow: 65_536 }],
    });
    const r1 = await discoverWindow({
      baseUrl: 'https://y.example',
      apiKey: 'sk-1',
      model: 'deepseek-r1',
      fetchImpl: byName.impl,
    });
    expect(r1).toMatchObject({ window: 65_536, source: 'gateway' });
    expect(byName.calls[0]!.url).toBe('https://y.example/v1/models'); // 无 /v1 → 补

    const byNameKey = fakeFetchOf({ data: [{ name: 'Qwen-Coder', max_input_tokens: 131_072 }] });
    const r2 = await discoverWindow({
      baseUrl: 'https://z.example/v1',
      apiKey: 'sk-1',
      model: 'qwen-coder',
      fetchImpl: byNameKey.impl,
    });
    expect(r2).toMatchObject({ window: 131_072, source: 'gateway' });
  });

  it('无匹配 → 取第一条含窗口字段的条目（其次任意一条）', async () => {
    const { impl } = fakeFetchOf({
      data: [
        { id: 'a', name: 'a-model' },
        { id: 'b', context_window: 131_072, name: 'b-model' },
      ],
    });
    const result = await discoverWindow({
      baseUrl: 'https://x.example/v1',
      apiKey: 'sk-1',
      model: 'not-listed',
      fetchImpl: impl,
    });
    expect(result.window).toBe(131_072);
    expect(result.source).toBe('gateway');
    expect(result.detail).toContain('首条含窗口字段');
  });

  it('子对象字段兜底：{id, model:{context_length}}', async () => {
    const { impl } = fakeFetchOf({ data: [{ id: 'm4', model: { context_length: 33_000 } }] });
    const r = await discoverWindow({
      baseUrl: 'https://x/v1',
      apiKey: 'sk',
      model: 'm4',
      fetchImpl: impl,
    });
    expect(r).toMatchObject({ window: 33_000, source: 'gateway' });
  });

  it('字符串数值字段接受', async () => {
    const { impl } = fakeFetchOf({ data: [{ id: 'm', max_context: '200000' }] });
    const r = await discoverWindow({
      baseUrl: 'https://x/v1',
      apiKey: 'sk',
      model: 'm',
      fetchImpl: impl,
    });
    expect(r).toMatchObject({ window: 200_000, source: 'gateway' });
  });

  it('命中条目无窗口字段 → none（协议无标准字段，诚实不猜）', async () => {
    const { impl } = fakeFetchOf({ data: [{ id: 'm', description: 'no fields' }] });
    const r = await discoverWindow({
      baseUrl: 'https://x/v1',
      apiKey: 'sk',
      model: 'm',
      fetchImpl: impl,
    });
    expect(r.window).toBeNull();
    expect(r.source).toBe('none');
    expect(r.detail).toContain('无窗口字段');
  });

  it('全部条目无字段 → none + 说明协议无标准字段', async () => {
    const { impl } = fakeFetchOf({ data: [{ id: 'a' }, { id: 'b' }] });
    const r = await discoverWindow({
      baseUrl: 'https://x/v1',
      apiKey: 'sk',
      model: 'a',
      fetchImpl: impl,
    });
    expect(r.window).toBeNull();
    expect(r.detail).toContain('协议无标准字段');
  });

  it('无模型名 → 直接扫描任意含窗口字段条目', async () => {
    const { impl } = fakeFetchOf({ data: [{ id: 'only', context_window: 10_000 }] });
    const r = await discoverWindow({ baseUrl: 'https://x/v1', apiKey: 'sk', fetchImpl: impl });
    expect(r).toMatchObject({ window: 10_000, source: 'gateway' });
  });
});

describe('discoverWindow：失败静默收敛（source=none）', () => {
  it('无 apiKey → 不请求，返回 none', async () => {
    let called = false;
    const spy = (() => {
      called = true;
      return Promise.resolve(jsonResponse({ data: [] }));
    }) as unknown as typeof fetch;
    const r = await discoverWindow({ baseUrl: 'https://x/v1', apiKey: undefined, fetchImpl: spy });
    expect(called).toBe(false);
    expect(r).toMatchObject({ window: null, source: 'none' });
    expect(r.detail).toContain('apiKey');
    // 空串同样视为无 key
    const r2 = await discoverWindow({ baseUrl: 'https://x/v1', apiKey: '', fetchImpl: spy });
    expect(r2.source).toBe('none');
  });

  it('401/500 → 静默 none，detail 带状态码', async () => {
    const auth = fakeFetchOf({ error: 'bad key' }, 401);
    const r1 = await discoverWindow({
      baseUrl: 'https://x/v1',
      apiKey: 'bad',
      fetchImpl: auth.impl,
    });
    expect(r1).toMatchObject({ window: null, source: 'none' });
    expect(r1.detail).toContain('401');

    const outage = fakeFetchOf({ ok: false }, 500);
    const r2 = await discoverWindow({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      fetchImpl: outage.impl,
    });
    expect(r2.detail).toContain('500');
  });

  it('网络拒绝 → 静默 none（不 throw）', async () => {
    const spy = (() => {
      return Promise.reject(new TypeError('fetch failed'));
    }) as unknown as typeof fetch;
    const r = await discoverWindow({ baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: spy });
    expect(r).toMatchObject({ window: null, source: 'none' });
    expect(r.detail).toContain('失败');
  });

  it('3s 缺省超时（timeoutMs 注入 50ms 快测）：永不 resolve 的信号感知 mock → 超时 none', async () => {
    const hanging = await hangingFetch();
    const start = performance.now();
    const r = await discoverWindow({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      fetchImpl: hanging,
      timeoutMs: 50,
    });
    const elapsed = performance.now() - start;
    expect(r).toMatchObject({ window: null, source: 'none' });
    expect(r.detail).toContain('超时');
    expect(elapsed).toBeLessThan(2_000); // 50ms 触发，未挂住真 3s
    expect(DEFAULT_WINDOW_TIMEOUT_MS).toBe(3_000);
  });

  it('响应非 JSON / 无清单数组 → 静默 none', async () => {
    const badJson = mockFetch(async () => new Response('<html>', { status: 200 }));
    const r1 = await discoverWindow({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      fetchImpl: badJson.impl,
    });
    expect(r1).toMatchObject({ window: null, source: 'none' });
    expect(r1.detail).toContain('JSON');

    const noList = fakeFetchOf({ total: 3, items: [] });
    const r2 = await discoverWindow({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      fetchImpl: noList.impl,
    });
    expect(r2.detail).toContain('清单');
  });
});
