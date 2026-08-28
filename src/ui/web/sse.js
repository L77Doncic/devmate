/**
 * # sse.js — SSE 流解析（纯逻辑，浏览器 / node 均可直接 import）
 *
 * DevMate 服务端事件协议（S12，本地权威定义，与本模块一一对应）：
 *   GET /api/stream?sessionId=… → text/event-stream，每行一对
 *     `event: session-user|assistant-delta|assistant-done|tool-start|tool-result|
 *              approval-request|usage|run-status|run-error`
 *     `data: <JSON>`
 *   注释行 `: ping` 必须忽略。
 * 解析规则按 SSE 规范（WHATWG EventSource）：跨 chunk 要能保持行缓冲；
 * 空行是事件边界；多个 `data:` 行按行拼接（协议只用单行 JSON，但按规范实现）。
 *
 * 约束（接缝纪律）：
 * - 模块零运行时依赖、零 DOM —— 供 node 单测直接 import。
 * - 事件在 `feed()` 同步产出，跨 chunk 边界语义由创建一次 parser 连续 feed 保证。
 * - JSON 解析失败不抛异常：产出 `{ parseError: true, data: 原始串 }`，由上层定夺
 *   （协议内所有 data 都是 JSON；失败即视为协议违例，上层记录后忽略）。
 */

/** 单条解析结果：{ event, data, raw, parseError } */
function buildEvent(eventName, dataLines) {
  const raw = dataLines.join('\n');
  let data = raw;
  let parseError = false;
  try {
    data = JSON.parse(raw);
  } catch {
    parseError = true;
  }
  return { event: eventName, data, raw, parseError };
}

/**
 * 增量 SSE 解析器。用法：
 *   const parser = createSSEParser();
 *   const ready = [];
 *   for (const chunk of chunks) ready.push(...parser.feed(chunk));
 * feed 只解析**完整行**；最后一个半行留在缓冲里等下一个 chunk（跨 chunk 安全）。
 * importScript：不支持多事件共享缓冲（显式创建/重置即可，无隐藏全局态）。
 */
export function createSSEParser() {
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];

  return {
    /**
     * @param {string} text 新到的文本 chunk（可以是任意分割点）
     * @returns {Array<{event:string, data:unknown, raw:string, parseError:boolean}>}
     */
    feed(text) {
      buffer += String(text);
      const events = [];
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break; // 不完整的行，等下一次 feed
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          // 空行 = 事件边界
          if (dataLines.length > 0) {
            events.push(buildEvent(eventName, dataLines));
          }
          eventName = 'message';
          dataLines = [];
        } else if (line.startsWith(':')) {
          // 注释行（如 `: ping`）——忽略
          continue;
        } else {
          const colon = line.indexOf(':');
          const field = colon >= 0 ? line.slice(0, colon) : line;
          let value = colon >= 0 ? line.slice(colon + 1) : '';
          if (value.startsWith(' ')) value = value.slice(1); // 规范：去掉紧跟的单个空格
          if (field === 'event') {
            eventName = value || 'message';
          } else if (field === 'data') {
            dataLines.push(value);
          }
          // id / retry：协议未使用，忽略
        }
      }
      return events;
    },

    /** 丢弃缓冲（会话切换/出错重连时用；不重置回调态）。 */
    reset() {
      buffer = '';
      eventName = 'message';
      dataLines = [];
    },

    /** 缓冲中是否还有未定界内容（诊断用）。 */
    hasPending() {
      return buffer.length > 0 || dataLines.length > 0;
    },
  };
}

/**
 * 消费一次 /api/stream（fetch + ReadableStream getReader + 行缓冲解析）。
 * 返回一个 promise：流正常结束（服务端关闭 / `done`）时 resolve；
 * HTTP 非 200、网络错误、abort 均 reject（AbortError 原样抛出，上层用 AbortController 联动「停止」）。
 * HTTP 错误上带 `status` 字段（如 404），上层用 api.isStatus 做语义判断（不用字符串匹配）。
 *
 * @param {object}    opts
 * @param {string}    opts.url     完整 URL（调用方已拼 query）
 * @param {(evt: object)=>void} [opts.onEvent] 每个解析完成的事件（含注释过滤后）
 * @param {AbortSignal} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl]  可注入（测试/离线环境）
 * @param {(res: Response)=>void} [opts.onOpen] 拿到响应头时回调（成功才调）
 */
export async function consumeSSE({ url, onEvent, onOpen, signal, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status; // 语义判断接缝（api.isStatus）：不再靠正文 contains('404')
    throw err;
  }
  onOpen?.(res);
  if (!res.body || typeof res.body.getReader !== 'function') {
    throw new Error('响应没有可读 body（不是 text/event-stream？）');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = createSSEParser();
  // 网络传输干净性说明：服务端必须正常闭环；掉线（网络错误）会让 reader.read() 抛错，
  // 由调用方归入「连接中断」处理（run-status 兜底）。
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const events = parser.feed(decoder.decode(value, { stream: true }));
    for (const ev of events) {
      if (ev.parseError) continue; // 协议违例数据，绝不进 UI 状态机
      onEvent?.(ev);
    }
  }
}
