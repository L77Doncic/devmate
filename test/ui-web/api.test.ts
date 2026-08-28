/**
 * api.js 单测：fetchJson（HttpError 带 status / 空体安全 / fetchImpl 注入）、
 * isStatus（语义判断替代 message.includes 字符串匹配）、
 * backswitch（切会话旧 run best-effort 中断 —— restoreSession/newSession 共用块抽离）。
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpError, fetchJson, isStatus, backswitch } from '../../src/ui/web/api.js';

/** 测试用「极简 Response 假件」（与 settings.test.ts 同法；运行时不依赖 DOM）。 */
function asFetch(fn: unknown): typeof fetch {
  return fn as unknown as typeof fetch;
}

function okResponse(json: unknown, status = 200) {
  return { ok: true, status, json: async () => json };
}

function errResponse(status: number, json: unknown = {}) {
  return { ok: false, status, json: async () => json };
}

describe('fetchJson', () => {
  it('200 → 返回 JSON 数据（形状不变，调用方无感）', async () => {
    const res = await fetchJson('/api/sessions', {
      fetchImpl: asFetch(async () => okResponse({ sessions: [] })),
    });
    expect(res).toEqual({ sessions: [] });
  });

  it('非 2xx → 抛 HttpError：带 status 与「HTTP <code>：<error>」消息（不再是裸 Error）', async () => {
    const err = await fetchJson('/api/sessions/x', {
      method: 'DELETE',
      fetchImpl: asFetch(async () => errResponse(409, { error: 'session active' })),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).toContain('HTTP 409');
    expect((err as HttpError).message).toContain('session active');
    expect(isStatus(err, 409)).toBe(true);
    expect(isStatus(err, 404)).toBe(false);
  });

  it('404/空体安全：204 → null 不抛（DELETE 端点无回体）', async () => {
    const res = await fetchJson('/api/sessions/x', {
      method: 'DELETE',
      fetchImpl: asFetch(async () => ({
        ok: true,
        status: 204,
        json: async () => {
          throw new Error('no body');
        },
      })),
    });
    expect(res).toBeNull();
  });

  it('错误消息含「404」字样 ≠ 状态 404：isStatus 以 err.status 为权威（字符串匹配陷阱）', async () => {
    // 服务端把 500 的错误正文写成 "参考 HTTP 404 文档" —— 旧 message.includes('404') 会误判
    const err = await fetchJson('/api/x', {
      fetchImpl: asFetch(async () => errResponse(500, { error: '详见 HTTP 404 处理指南' })),
    }).catch((e: unknown) => e);
    expect(isStatus(err, 500)).toBe(true);
    expect(isStatus(err, 404)).toBe(false);
  });
});

describe('isStatus', () => {
  it('HttpError / 带 status 的普通错误（sse.js 的 HTTP 错误）都识别；非对象安全', () => {
    const plain = new Error('HTTP 404 Not Found');
    (plain as { status?: number }).status = 404;
    expect(isStatus(plain, 404)).toBe(true);
    expect(isStatus(new HttpError(404, 'x'), 404)).toBe(true);
    expect(isStatus(null, 404)).toBe(false);
    expect(isStatus('boom', 404)).toBe(false);
  });
});

describe('backswitch（restoreSession / newSession 共用）', () => {
  it('旧 run 活跃且有旧会话：POST /api/interrupt 携带 sessionId，返回 true', async () => {
    const sends: Array<{ url: string; opts: unknown }> = [];
    const spy = vi.fn(async (url: string, opts: unknown) => {
      sends.push({ url, opts });
      return okResponse({ ok: true });
    });
    const done = await backswitch('s-old', true, { fetchImpl: asFetch(spy) });
    expect(done).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toBe('/api/interrupt');
    expect((sends[0]!.opts as { body: string }).body).toContain('"sessionId":"s-old"');
  });

  it('旧 run 已结束或无旧会话：跳过（不发请求）', async () => {
    const spy = vi.fn();
    expect(await backswitch(null, true, { fetchImpl: asFetch(spy) })).toBe(false);
    expect(await backswitch('s-old', false, { fetchImpl: asFetch(spy) })).toBe(false);
    expect(await backswitch('', true, { fetchImpl: asFetch(spy) })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('中断失败（409/已结束/离线）：best-effort 静默返回 false，不抛', async () => {
    const spy = vi.fn(async () => errResponse(409, { error: 'already done' }));
    const done = await backswitch('s-old', true, { fetchImpl: asFetch(spy) });
    expect(done).toBe(false);
  });
});
