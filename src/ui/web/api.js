/**
 * # api.js — 同源 API 编排纯逻辑（fetchJson 封装 + 状态码语义 + 切换会话 best-effort 中断）
 *
 * 本模块固定「同源 + JSON」的调用口（fetchImpl 可注入，与 settings.js 同接缝 ——
 * 测试/离线环境用假件）；所有错误以 HttpError 携带 status 抛出，调用方用 isStatus
 * 做语义判断（替代 `message.includes('409'/'404')` 字符串匹配 —— 修复状态码陷阱：
 * 错误正文里出现"404"字样并非错误本身，而 status 才是权威语义）。
 *
 * 纯函数边界：无 DOM；只依赖注入的 fetchImpl（默认 globalThis.fetch）。
 */

/** 带 HTTP 状态码的错误（err.status 可与响应序数同级比较；data 为服务端回体，可能为 null）。 */
export class HttpError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.data = data;
  }
}

/** 同源 fetch + JSON；非 2xx 抛 HttpError（含服务端 error 字段与 status）。
 *  DELETE 204 / html 错误页等空体安全（data=null，不抛）。 */
export async function fetchJson(url, { method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null; // 204 / html 错误页等情况
  }
  if (!res.ok) {
    throw new HttpError(
      res.status,
      `HTTP ${res.status}${data?.error ? `：${data.error}` : ''}`,
      data,
    );
  }
  return data;
}

/** 语义判定：错误（HttpError 或 sse.js 的 HTTP 错误）是否携带指定状态码。 */
export function isStatus(err, status) {
  return typeof err?.status === 'number' && err.status === status;
}

/** 切会话时的旧 run 中断（restoreSession / newSession 共用，替代各写 10 行重复块）：
 *  旧 run 活跃且存在旧会话才 POST /api/interrupt；失败静默（已结束/不存在/离线，best-effort）。
 *  @returns {Promise<boolean>} true = 中断请求已发出（不保证服务端已停）；false = 跳过或失败。 */
export async function backswitch(
  previousSessionId,
  previousRunActive,
  { fetchImpl = globalThis.fetch } = {},
) {
  if (!previousRunActive || !previousSessionId) return false;
  try {
    await fetchJson('/api/interrupt', {
      method: 'POST',
      body: { sessionId: previousSessionId },
      fetchImpl,
    });
    return true;
  } catch {
    return false; // best-effort：已结束/不存在/离线一律忽略
  }
}
