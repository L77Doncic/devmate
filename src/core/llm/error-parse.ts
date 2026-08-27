/**
 * # error-parse：HTTP 错误体统一解析（S1/S2 共用单一来源）
 *
 * ADR-0001 客户端与 ADR-0002 adapter 共用同一份错误解析，禁止任何一方复制实现：
 * - extractErrorBody：错误体三种形状解析（§6.1 A/B/C，含 DashScope 原生信封）；
 * - RETRYABLE_STATUS：§6.3 建议重试集合（状态码打底）；
 * - parseRetryAfter：Retry-After 三形式（§6.3，官方 SDK 同款）。
 * 供应商业务码精修（refineRetryable）在 adapter 层于这份基础之上叠加。
 */

/** §6.3 建议重试集合：{408, 425, 429, 500, 502, 503, 504}。 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface ErrorBodyParts {
  message: string;
  /** 错误体业务码（OpenAI code/type、GLM 字符串型业务码、DashScope 原生信封 code）。 */
  code?: string;
  /** 非 JSON 错误体的原始摘录（Kimi 504 HTML 等，§8.A.9）。 */
  bodySnippet?: string;
}

const BODY_SNIPPET_LEN = 200;

/**
 * 统一 HTTP 错误体解析：按 §6.1 三种形状（A/B 有 error 对象 / C 非 JSON 原文抠摘录），
 * 另含 DashScope 原生信封 `{ status_code/request_id/code/message }`（笔记 §5）。
 */
export function extractErrorBody(raw: string): ErrorBodyParts {
  const trimmed = raw.trim();
  if (trimmed === '') return { message: '(empty response body)' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // §6.1 形状 C：body 不是 JSON（Kimi 504 HTML、网关页）
    const snippet = trimmed.slice(0, BODY_SNIPPET_LEN);
    return { message: snippet, bodySnippet: snippet };
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    const err = obj.error;
    if (typeof err === 'object' && err !== null) {
      const e = err as Record<string, unknown>;
      const message = typeof e.message === 'string' && e.message !== '' ? e.message : trimmed;
      const code = extractCode(e);
      return { message, ...(code !== undefined ? { code } : {}) };
    }
    // DashScope 原生信封：无 error 包装（笔记 §5）
    if (typeof obj.code === 'string' && typeof obj.message === 'string') {
      return { message: obj.message, code: obj.code };
    }
  }
  // 有 JSON 但无 error 键 / 非对象：按摘录兜底（§6.1 形状 C 备注）
  const snippet = trimmed.slice(0, BODY_SNIPPET_LEN);
  return { message: snippet, bodySnippet: snippet };
}

function extractCode(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.code === 'string' && obj.code !== '') return obj.code;
  if (typeof obj.code === 'number') return String(obj.code);
  if (typeof obj.type === 'string' && obj.type !== '') return obj.type;
  return undefined;
}

/** 可采信 Retry-After 上限（秒）；超过视为不可信，忽略并按默认退避（openai-python 的
 * MAX_RETRY_AFTER_DELAY 同款：300。§6.3）。 */
const MAX_RETRY_AFTER_DELAY = 300;

/** §6.3/官方 SDK 三形式：retry-after-ms（毫秒）→ retry-after（秒/浮点）→ HTTP-date。
 * 三形式共用同一上限：超限一律忽略（返回 undefined，弃用该头）。 */
export function parseRetryAfter(headers: Headers): number | undefined {
  const msRaw = headers.get('retry-after-ms');
  if (msRaw !== null) {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms > 0 && ms / 1000 <= MAX_RETRY_AFTER_DELAY) return ms / 1000;
  }
  const secRaw = headers.get('retry-after');
  if (secRaw !== null) {
    const sec = Number(secRaw);
    if (Number.isFinite(sec) && sec > 0 && sec <= MAX_RETRY_AFTER_DELAY) return sec;
    const date = Date.parse(secRaw);
    if (Number.isFinite(date) && date > 0) {
      const seconds = (date - Date.now()) / 1000;
      if (seconds > 0 && seconds <= MAX_RETRY_AFTER_DELAY) return seconds;
    }
  }
  return undefined;
}
