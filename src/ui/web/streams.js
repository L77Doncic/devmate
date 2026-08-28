/**
 * # streams.js — 单流闸门（纯逻辑，node 可直接 import）
 *
 * 单流模型（见 app.js / messages.js 头注）：同一时刻只有一条 /api/stream 属于当前会话。
 * 切换会话时旧流被 abort，但 abort 是**异步**进入 finally 的 —— 若新流已先行接管
 * （旧流只是尚未收尾完毕的迟到者），旧流的 finally 不得再动新流状态。
 *
 * createStreamGate 用「引用相等」裁决收尾权：只有本流**仍是当前流**的收尾才被放行
 * （解除绑定 + 触发 onFinished，即 store.endStream()）；其余（新流已接管 / 非本流）
 * 一律静默放弃 —— 修复「endStream 无条件执行」竞态（旧流 finally 影响新流 streaming 态）。
 *
 * 纯函数边界：无 DOM、无 fetch、无 setTimeout（app.js 将其接在 ensureStream 的 finally）。
 */

/**
 * 单流收尾裁决器。
 * @param {object} [opts]
 * @param {() => void} [opts.onFinished] 当前流被 retire（收尾）后回调 —— 调用方在此做
 *                                       流态收口（如 store.endStream()）；非当前流收尾不会触发。
 * @returns {{ current: () => {sessionId: string, ctrl: AbortController} | null,
 *             isCurrent: (sessionId: string) => boolean,
 *             open: (sessionId: string, ctrl: AbortController) => {sessionId: string, ctrl: AbortController} | null,
 *             retire: (ctrl: AbortController) => boolean }}
 */
export function createStreamGate({ onFinished } = {}) {
  let current = null; // { sessionId, ctrl }

  return {
    /** 当前流句柄；无流 → null（app.js 渲染头「已连接」/关流共用）。 */
    current() {
      return current;
    },

    /** 是否已是该会话的流（ensureStream 幂等：已连且属本会话则不开第二条）。 */
    isCurrent(sessionId) {
      return current !== null && current.sessionId === sessionId;
    },

    /** 开新流：接管当前位；返回被替换的旧句柄（调用方据此 abort 旧流）。 */
    open(sessionId, ctrl) {
      const prev = current;
      current = { sessionId, ctrl };
      return prev;
    },

    /**
     * 收尾裁决（finally 专用）：本流仍为当前流 → 解除绑定并回调 onFinished，返回 true；
     * 否则（新流已接管 / 重复收尾）静默返回 false —— 旧流 finally 不清新流状态。
     */
    retire(ctrl) {
      if (current === null || current.ctrl !== ctrl) return false;
      current = null;
      onFinished?.();
      return true;
    },
  };
}
