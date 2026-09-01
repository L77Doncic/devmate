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
 * recoverTerminalAfterStreamBreak：断流兜底（SSE 长活中途断开 → run 终态帧不再经流送达，
 * UI 卡「生成中」）——拉取会话回放（与 restoreSession 同数据源），只 ingest 最新一轮的
 * 最后一条 usage 与终态 run-status（store reducer 同入口，不经 replayGuard —— 本路径
 * 不接流、无覆盖序问题；被新流接管即静默放弃）。
 *
 * 纯函数边界：无 DOM、无定时器；网络只经注入 fetchImpl（默认 globalThis.fetch，同
 * api.js / sse.js 纪律；app.js 将其接在 ensureStream 的 finally 收尾裁决之后）。
 */
import { fetchJson } from './api.js';
import { normalizeSessionDetail } from './sessions.js';
import { TERMINAL_STATUSES } from './format.js';

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

/**
 * 断流兜底（产品缺陷修复：SSE 长活中途断开时 UI 卡「生成中」不恢复终态）——长活流
 * 异常收流/断流后，run 的终态帧可能已在服务端落盘（run_result 持久化，GET 回放派生
 * usage + run-status 帧）但不再经本流送达 → runActive 挂死。本函数拉取会话回放，沿
 * store reducer 的既有入口（与 restoreSession 逐帧 dispatch 一致）恢复终态：
 * runActive 由终态 run-status 自动落 false、run-strip 转「已完成」、统计行/上下文环
 * 由 usage 刷新。**不伪造**终态（三条真值守卫，任一不满足 → false）：
 * - sessionId 非空；
 * - isStillCurrent()：本流收尾裁决后仍无新流接管（streamGate 引用相等语义 —— 被新流
 *   接管时终态由新流回放提供，绝不重复恢复）；
 * - 回放中最新一轮（最后一个非哨兵 session-user 之后）确实存在终态 run-status ——
 *   服务端仍 run / 终态未落盘 → onMissing（调用方补提示），保持现状。
 * 纯函数边界：无 DOM / 无定时器；网络经注入 fetchImpl（测试/离线环境用假件）。
 *
 * @param {object} opts
 * @param {string} opts.sessionId 本流会话 id
 * @param {() => boolean} opts.isStillCurrent 本流收尾后仍无新流接管（fetch 期间被接管 → false）
 * @param {(ev: {event: string, data: unknown}) => void} opts.dispatch store.dispatch（reducer 同入口）
 * @param {() => void} [opts.onDone]    恢复成功（终态帧已 ingest）；调用方做 UI 收口
 * @param {() => void} [opts.onMissing] 回放可达但无终态（服务端仍 run）；调用方补提示
 * @param {typeof fetch} [opts.fetchImpl] 注入（同 api.js / sse.js 接缝）
 * @returns {Promise<boolean>} true = 已 ingest 终态帧（调用方做 UI 收口）
 */
export async function recoverTerminalAfterStreamBreak({
  sessionId,
  isStillCurrent,
  dispatch,
  onDone,
  onMissing,
  fetchImpl,
}) {
  if (!sessionId || !isStillCurrent()) return false;
  let events = [];
  try {
    const detail = normalizeSessionDetail(
      await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { fetchImpl }),
    );
    events = detail?.events ?? [];
  } catch {
    return false; // 回放拉取失败（服务端仍不可达 / 会话已清）：保持「连接中断」提示，不伪造
  }
  if (!isStillCurrent()) return false; // 拉取期间被新流接管：终态由新流回放提供

  // 最新一轮锚定：最后一个非哨兵 session-user（评审哨兵 system:true 不作回合锚）
  // 之后的 usage / run-status 帧属于断流那一轮；更早轮次的终态绝不可滥用
  // （误导当前 run 已结束 —— 伪造）。
  let anchor = -1;
  let usage = null;
  let status = null;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (ev?.event === 'session-user' && ev?.data?.system !== true) {
      anchor = i;
    } else if (ev?.event === 'usage') {
      usage = { ev, i };
    } else if (ev?.event === 'run-status') {
      status = { ev, i };
    }
  }
  const terminal =
    status !== null && status.i > anchor && TERMINAL_STATUSES.includes(status.ev?.data?.status)
      ? status.ev
      : null;
  if (terminal === null) {
    onMissing?.();
    return false;
  }
  if (usage !== null && usage.i > anchor) dispatch(usage.ev); // 与流内同序：usage 先于 run-status
  dispatch(terminal);
  onDone?.();
  return true;
}
