/**
 * streams.js 单测：单流闸门的收尾裁决 + 断流兜底恢复。
 * 钉：切会话竞态下旧流 finally 不影响新流状态（旧流被 abort 后异步 finally 晚到，
 * 新流已 open 接管 —— 旧流 retire(ctrl) 必须返回 false 且不触发 onFinished）；
 * 兜底：SSE 长活中途断开 → 拉会话回放 ingest 最新一轮终态（产品缺陷回归：
 * 「生成中」挂死不恢复 —— 只 ingest 终态帧，不 mock 转发整段回放）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../../src/ui/web/messages.js';
import { composerStatsLine, runStatusLine } from '../../src/ui/web/format.js';
import { createStreamGate, recoverTerminalAfterStreamBreak } from '../../src/ui/web/streams.js';

describe('createStreamGate（单流收尾裁决）', () => {
  it('切会话竞态：旧流 finally（retire）在新流接管后静默 —— 不触发 onFinished', () => {
    let finished = 0;
    const gate = createStreamGate({
      onFinished: () => {
        finished += 1;
      },
    });
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();

    gate.open('s1', ctrlA); // 会话 1 的流（长活）
    gate.open('s2', ctrlB); // 切换会话：新流已接管
    expect(gate.current()).toMatchObject({ sessionId: 's2', ctrl: ctrlB });

    // 流 A 的 finally 晚到：不是当前流 → 静默放弃（不清 streaming、不动新流句柄）
    expect(gate.retire(ctrlA)).toBe(false);
    expect(finished).toBe(0);
    expect(gate.current()).toMatchObject({ sessionId: 's2', ctrl: ctrlB });

    // 新流 B 自己的 finally：当前流 → 解绑 + 触发 onFinished（store.endStream）
    expect(gate.retire(ctrlB)).toBe(true);
    expect(finished).toBe(1);
    expect(gate.current()).toBeNull();
  });

  it('当前流正常收尾：解绑并恰好触发一次；重复收尾幂等（不重复 endStream）', () => {
    let finished = 0;
    const gate = createStreamGate({
      onFinished: () => {
        finished += 1;
      },
    });
    const ctrl = new AbortController();
    gate.open('s1', ctrl);
    expect(gate.retire(ctrl)).toBe(true);
    expect(finished).toBe(1);
    expect(gate.retire(ctrl)).toBe(false); // 已绑定为空：再收尾不重复触发
    expect(finished).toBe(1);
  });

  it('isCurrent：幂等判定 —— 已连且属本会话不开第二条流', () => {
    const gate = createStreamGate();
    const ctrl = new AbortController();
    gate.open('s1', ctrl);
    expect(gate.isCurrent('s1')).toBe(true);
    expect(gate.isCurrent('s2')).toBe(false);
    expect(gate.isCurrent(null as unknown as string)).toBe(false);
  });

  it('open 返回被替换的旧句柄 —— 调用方据此 abort 旧流（关旧流 broker 时序）', () => {
    const gate = createStreamGate();
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    expect(gate.open('s1', ctrlA)).toBeNull();
    const prev = gate.open('s2', ctrlB);
    expect(prev).toMatchObject({ sessionId: 's1', ctrl: ctrlA });
    expect(gate.current()).toMatchObject({ sessionId: 's2', ctrl: ctrlB });
  });
});

// ---------------------------------------------------------------------------
// recoverTerminalAfterStreamBreak（断流兜底恢复终态）
//
// 产品缺陷（用户实测）：SSE 长活流中断时 reader.read() 抛错 → app.js ensureStream 只落
// 「连接中断」系统行，runActive 保持 true —— UI 卡「生成中」。服务端终态帧（run_result
// 派生的 usage + run-status）已在 GET 回放里：兜底只 ingest 最新一轮的终态帧（沿
// store reducer 现有入口，与 restoreSession 的 dispatch 一致），绝不伪造、绝不覆盖序守卫。
// ---------------------------------------------------------------------------

const ev = (event: string, data: unknown) => ({ event, data });

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

function fakeFetchFor(payload: unknown) {
  const sends: Array<{ url: string; method?: string | undefined }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sends.push({ url, method: init?.method });
    return okJson(payload);
  }) as unknown as typeof fetch;
  return { fetchImpl, sends };
}

/** 典型断流回放：多个回合，最新一轮（最后一个非哨兵 user 之后）带 run_result 派生帧。 */
const replayWithTerminal = {
  events: [
    ev('session-user', { text: '帮我改代码' }),
    ev('assistant-done', { content: 'ok' }),
    ev('usage', { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.3, estimated: true }),
    ev('session-user', { text: '再把测试跑一遍' }),
    ev('assistant-delta', { text: '看' }),
    ev('usage', { promptTokens: 20, completionTokens: 8, totalTokens: 28, costUsd: 0.5, estimated: true }),
    ev('run-status', { status: 'completed', steps: 3, durationMs: 2500 }),
  ],
};

describe('recoverTerminalAfterStreamBreak（断流兜底恢复终态）', () => {
  it('流断 + 回放含最新一轮终态：GET 会话回放 → ingest usage + 终态 run-status → runActive 落定', async () => {
    const store = createMessageStore();
    expect(store.startStream()).toBe(true); // 发送瞬间 runActive=true；断流后终态帧未达 → 挂死态
    expect(store.snapshot().runActive).toBe(true);

    const { fetchImpl, sends } = fakeFetchFor(replayWithTerminal);
    const onDone = vi.fn();
    const ok = await recoverTerminalAfterStreamBreak({
      sessionId: 's-1',
      isStillCurrent: () => true,
      dispatch: (e) => store.dispatch(e),
      onDone,
      fetchImpl,
    });

    expect(ok).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toBe('/api/sessions/s-1'); // 复用 fetchJson（GET 回放，同 restoreSession 数据源）
    expect(sends[0]!.method).toBe('GET');
    const snap = store.snapshot();
    // 终态恢复：runActive 落 false（run-strip 转「已完成」）+ runStatus/用量刷新
    expect(snap.runActive).toBe(false);
    expect(snap.runStatus).toEqual({ status: 'completed', steps: 3, durationMs: 2500 });
    expect(runStatusLine(snap.runStatus)).toBe('已完成 · 3 步 · 2.5s');
    expect(snap.usage?.totalTokens).toBe(28); // 最新一轮（跑测试），不是上一轮 15
    expect(composerStatsLine(snap.runStatus, snap.usage)).toContain('入 20 tokens');
    expect(composerStatsLine(snap.runStatus, snap.usage)).toContain('总 28 tokens');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('断流 + 服务端仍 run（最新一轮无终态 run-status）：不伪造 —— onMissing，runActive 保持', async () => {
    const store = createMessageStore();
    store.startStream();
    const onMissing = vi.fn();
    const onDone = vi.fn();
    const { fetchImpl } = fakeFetchFor({
      events: [
        ev('session-user', { text: '跑起来' }),
        ev('usage', { promptTokens: 4, completionTokens: 2, totalTokens: 6, costUsd: 0.1, estimated: true }),
      ],
    });
    const ok = await recoverTerminalAfterStreamBreak({
      sessionId: 's-1',
      isStillCurrent: () => true,
      dispatch: (e) => store.dispatch(e),
      onDone,
      onMissing,
      fetchImpl,
    });
    expect(ok).toBe(false);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(store.snapshot().runActive).toBe(true); // 保持现状（调用方保留「连接中断」提示）
  });

  it('早期轮次有终态但最新一轮无：不可挪用旧终态（anchor 后无 run-status → onMissing）', async () => {
    const store = createMessageStore();
    store.startStream();
    const onMissing = vi.fn();
    const { fetchImpl } = fakeFetchFor({
      events: [
        ev('session-user', { text: '第一轮' }),
        ev('run-status', { status: 'completed', steps: 2, durationMs: 100 }),
        ev('session-user', { text: '第二轮（断流时仍在跑）' }),
        ev('usage', { promptTokens: 9, completionTokens: 7, totalTokens: 16, costUsd: 0.2, estimated: true }),
      ],
    });
    const ok = await recoverTerminalAfterStreamBreak({
      sessionId: 's-1',
      isStillCurrent: () => true,
      dispatch: (e) => store.dispatch(e),
      onMissing,
      fetchImpl,
    });
    expect(ok).toBe(false); // 旧轮的 completed 不得用于当前挂起 run
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(store.snapshot().runActive).toBe(true);
    expect(store.snapshot().runStatus).toBeNull();
  });

  it('isStillCurrent 守卫：进场即已接管 / 拉取期间被接管 → 静默放弃（不 GET、不 dispatch）', async () => {
    // 进场即被接管：连回放 GET 都不发
    const store = createMessageStore();
    store.startStream();
    const onDone = vi.fn();
    const fetchSpy = vi.fn(async () => okJson(replayWithTerminal));
    const r1 = await recoverTerminalAfterStreamBreak({
      sessionId: 's-1',
      isStillCurrent: () => false,
      dispatch: (e) => store.dispatch(e),
      onDone,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(r1).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 拉取期间被接管：回放 GET 挂住 → 新流接管（守卫复位）→ 回放返回 → 不 ingest
    const store2 = createMessageStore();
    store2.startStream();
    let gate = true;
    let releaseFetch = () => {};
    const gateHold = new Promise<void>((r) => {
      releaseFetch = r;
    });
    const fetchHolding = vi.fn(async () => {
      await gateHold;
      return okJson(replayWithTerminal);
    });
    const pending = recoverTerminalAfterStreamBreak({
      sessionId: 's-1',
      isStillCurrent: () => gate,
      dispatch: (e) => store2.dispatch(e),
      onDone,
      fetchImpl: fetchHolding as unknown as typeof fetch,
    });
    gate = false; // fetch 未返回前新流已接管（streamGate.current() 非空）
    releaseFetch();
    expect(await pending).toBe(false);
    expect(fetchHolding).toHaveBeenCalledTimes(1);
    expect(store2.snapshot().runActive).toBe(true);
    expect(store2.snapshot().runStatus).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('回放 GET 失败（服务端仍不可达）：best-effort 静默返回 false（保留「连接中断」提示，不伪造）', async () => {
    const store = createMessageStore();
    store.startStream();
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const onMissing = vi.fn();
    const ok = await recoverTerminalAfterStreamBreak({
      sessionId: 's-1',
      isStillCurrent: () => true,
      dispatch: (e) => store.dispatch(e),
      onMissing,
      fetchImpl,
    });
    expect(ok).toBe(false);
    expect(onMissing).not.toHaveBeenCalled(); // 拉取失败 ≠ 无终态：不打扰用户（提示仍是「连接中断」）
    expect(store.snapshot().runActive).toBe(true);
  });
});
