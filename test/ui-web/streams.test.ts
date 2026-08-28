/**
 * streams.js 单测：单流闸门的收尾裁决 ——「切会话竞态下旧流 finally 不影响新流状态」。
 * 场景：旧流被 abort 后（异步 finally 晚到），新流已 open 接管 ——
 * 旧流的 retire(ctrl) 必须返回 false 且不触发 onFinished（即不调用 store.endStream）。
 */
import { describe, expect, it } from 'vitest';
import { createStreamGate } from '../../src/ui/web/streams.js';

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
