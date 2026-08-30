/**
 * # error-parse：HTTP 错误体统一解析（S1/S2 共用单一来源）
 *
 * ADR-0001 客户端与 ADR-0002 adapter 共用同一份错误解析，禁止任何一方复制实现：
 * - extractErrorBody：错误体三种形状解析（§6.1 A/B/C，含 DashScope 原生信封）；
 * - RETRYABLE_STATUS：§6.3 建议重试集合（状态码打底）；
 * - parseRetryAfter：Retry-After 三形式（§6.3，官方 SDK 同款）；
 * - classifyContextError：超限错误分类器（ADR-0016 M1——E7 自愈链的数据源；
 *   词表取自三大家实测/文档 + dsh 分类器等价物，hintMax 从 message 免费解析
 *   "valid range ... [1, N]" / "maximum context length is N" ——一次拿到供应商上限）。
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

// ---------------------------------------------------------------------------
// 超限错误分类（ADR-0016 M1：E7 自愈链 / hint 学习的数据源）
// ---------------------------------------------------------------------------

/** 超限错误两个子类（E7 链按子类行动：压缩重试 vs 输出钳制重试）。 */
export type ContextErrorKind = 'context-exceeded' | 'output-limit';

export interface ContextErrorInfo {
  kind: ContextErrorKind;
  /**
   * 从 message 免费解析的供应商上限（token；`[1, N]` 区间上界 / "maximum context
   * length is N" 的 N）；无数值 → 无键。L2「免费上限探测」的来源——0 token 计费。
   */
  hintMax?: number;
}

/**
 * 上下文超窗错误词表（B.a 三大家实测/文档 + dsh 分类器等价物）：
 * OpenAI `code:context_length_exceeded` / "maximum context length is N tokens"、
 * 泛网关 "context length exceeded"、Qwen "Range of input length"、Anthropic-ish
 * "prompt is too long"。大小写宽容；完整短语匹配（不截词——"context" 单字不算）。
 */
const CONTEXT_EXCEEDED_RE: ReadonlyArray<RegExp> = [
  /context_length_exceeded/i,
  /context length/i,
  /maximum context/i,
  /context too long/i,
  /prompt is too long/i,
  /too long for (this|the) model/i,
  /exceeds model context/i,
  /range of input length/i,
];

/**
 * 输出区间错误词表（DeepSeek 实测形状「Invalid max_tokens value, the valid range
 * of max_tokens is [1, 393216]」、Qwen "Range of max_tokens"、GLM "maximum output"）。
 * 大小写宽容；不用裸 "max_tokens"（避免与上下文超窗误命中）。
 */
const OUTPUT_LIMIT_RE: ReadonlyArray<RegExp> = [
  /valid range of max_tokens/i,
  /invalid max_tokens/i,
  /maximum output tokens/i,
  /maximum output length/i,
  /range of max_tokens/i,
];

/**
 * classifyContextError(message): 超限错误分类（纯函数，M1）。
 * 命中词表 → {kind, hintMax?}；未命中 → null（非超限错误不说谎，处理链交给既有路径）。
 * hintMax 解析（只取命中子类下可解析的区间）：先 `[1, N]`（DeepSeek/Qwen 表单——两区间
 * 并存时取大者，如输入/输出各印一份的网关），再 `maximum context length is N` /
 * `maximum output ... (is|of) N`（OpenAI 形状）；不可解析 → 无键。
 * 注意：**子类先定**（hintMax 只跟出命中子类的语义——输出区间值绝不冒充窗口）。
 */
export function classifyContextError(message: string): ContextErrorInfo | null {
  if (message === '') return null;
  let kind: ContextErrorKind | null = null;
  for (const re of CONTEXT_EXCEEDED_RE) {
    if (re.test(message)) {
      kind = 'context-exceeded';
      break;
    }
  }
  if (kind !== 'context-exceeded') {
    for (const re of OUTPUT_LIMIT_RE) {
      if (re.test(message)) {
        kind = 'output-limit';
        break;
      }
    }
  }
  if (kind === null) return null;
  const hintMax = parseHintMax(message);
  return hintMax !== undefined ? { kind, hintMax } : { kind };
}

/** 从 message 解析区间/裸上限（数字串允许千分位逗号）。 */
function parseHintMax(message: string): number | undefined {
  let best: number | undefined;
  for (const match of message.matchAll(/\[\s*1[\s,]*,\s*([0-9][0-9,]*)\s*\]/g)) {
    const n = parseInt(match[1]!.replace(/,/g, ''), 10);
    if (Number.isFinite(n) && n >= 1 && (best === undefined || n > best)) best = n;
  }
  if (best !== undefined) return best;
  const bare = message.match(
    /(?:maximum context length is|maximum output tokens? (?:is|of|should be)|valid range of max_tokens is)\s*([0-9][0-9,]*)/i,
  );
  if (bare !== null) {
    const n = parseInt(bare[1]!.replace(/,/g, ''), 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
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
