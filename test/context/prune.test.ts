import { describe, expect, it } from 'vitest';

import { project } from '../../src/core/context/project.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import {
  assistantEvent,
  ev,
  fillerAscii,
  resetSeq,
  snapshot,
  toolEvent,
  toolRound,
  userEvent,
} from './support.js';

/**
 * 组包期裁剪（切片 c）：旧工具结果按时间序 → 占位符（保留最近 3 组；副作用型豁免）。
 * 阈值手算：windowTokens=2000 → clearTrigger=floor(2000×0.45)=900、compactTrigger=1440；
 * user 2800 字符 = ceil(2800/4)=700 token；每组 = assistant（name 'ls' → ceil(2/3)=1、
 * args '{}' 逐字 2）3 token + 结果（z×100 → ceil(100/3)=34、'#'→1、'1'→1）36 token → 39；
 * 5 组 = 195；11 条消息结构开销 = 3×11+3 = 36 ⇒ est0 = 700+195+36 = 931 > 900（触发裁剪）；
 * 裁剪 2 组结果后（占位符 138 字符 ≈ 76 token）est1 = 931 − 2×36 + 2×76 = 1011 < 1440（摘要不触发）。
 * 本文件聚焦裁剪语义，触发路径统一清 clearAtLeastTokens: 1（显式关闭「≥8k 清出量」门槛，
 * 该门槛在「清出量门槛」用例中专门测试）。
 */

const WINDOW = 2000;
const CLEARANCE = 1;

function baseEvents(userLen = 2800): SessionEvent[] {
  resetSeq();
  return [userEvent(fillerAscii(userLen)), ...toolRound(5)];
}

function contentOf(events: readonly SessionEvent[], index: number): string {
  const evt = events[index];
  if (evt === undefined || evt.kind !== 'tool') {
    throw new Error(`no tool event at ${index}`);
  }
  return evt.payload.content;
}

describe('裁剪：旧结果替换为明示移除的占位符，保留最近 3 组', () => {
  it('5 组全部可裁剪 → 保留最后 3 组，最早 2 组结果变占位符', async () => {
    const events = baseEvents();
    const before = snapshot(events);
    const projection = await project(events, {
      windowTokens: WINDOW,
      clearAtLeastTokens: CLEARANCE,
    });

    expect(projection.messages).toHaveLength(11);
    expect(projection.stats.pruned.count).toBe(2);
    expect(projection.stats.pruned.groupsKept).toBe(3);
    expect(projection.stats.pruned.excludedCount).toBe(0);
    expect(projection.stats.pruned.status).toBe('pruned');
    expect(projection.stats.summary.status).toBe('not-triggered');

    // 头两组的结果被替换，且占位符明示「曾有内容被移除」+ 工具名 + 被移除量
    const t1 = projection.messages[2];
    const t2 = projection.messages[4];
    if (t1 === undefined || t1.role !== 'tool' || t2 === undefined || t2.role !== 'tool') {
      expect.unreachable('前两个结果应为 tool 消息');
    }
    expect(t1.content).toContain('removed');
    expect(t1.content).toContain('"ls"');
    expect(t1.content).toContain('102 characters'); // 原结果 z×100 + '#1'
    expect(t2.content).toContain('"ls"');
    expect(t2.toolCallId).toBe('c2'); // 配对完好：只换内容，不动 id

    // 后三组原样保留（截断阈值之下，无任何改写）
    expect(projection.messages[6]).toEqual({
      role: 'tool',
      content: contentOf(events, 6),
      toolCallId: 'c3',
    });
    // assistant（调用请求）一个都没动
    const a3 = projection.messages[5];
    if (a3 !== undefined && a3.role === 'assistant') {
      expect(a3.toolCalls?.length).toBe(1);
      expect(a3.toolCalls?.[0]?.function.name).toBe('ls');
    } else {
      expect.unreachable('第 6 条消息应为 assistant');
    }

    // 输入事件流未被改动（只作用于投影）
    expect(snapshot(events)).toBe(before);

    // 裁剪后仍在 compactTrigger 之下 → 摘要未触发
    expect(projection.stats.estimatedTokens).toBeLessThan(1440);
  });

  it('副作用型结果（write/edit/apply_patch/git_commit）永不裁剪：组1 为 write 时其结果保留', async () => {
    const events: SessionEvent[] = [
      userEvent(fillerAscii(2800)),
      assistantEvent('', [{ id: 'c1', name: 'write', arguments: '{}' }]),
      toolEvent('c1', 'z'.repeat(100) + '#1'),
      assistantEvent('', [{ id: 'c2', name: 'ls', arguments: '{}' }]),
      toolEvent('c2', 'z'.repeat(100) + '#2'),
      assistantEvent('', [{ id: 'c3', name: 'ls', arguments: '{}' }]),
      toolEvent('c3', 'z'.repeat(100) + '#3'),
      assistantEvent('', [{ id: 'c4', name: 'ls', arguments: '{}' }]),
      toolEvent('c4', 'z'.repeat(100) + '#4'),
      assistantEvent('', [{ id: 'c5', name: 'ls', arguments: '{}' }]),
      toolEvent('c5', 'z'.repeat(100) + '#5'),
    ];
    const projection = await project(events, {
      windowTokens: WINDOW,
      clearAtLeastTokens: CLEARANCE,
    });

    // 可裁剪组为 g2..g5 → 保留最近 3 组(g3,g4,g5)，只裁 g2（g1 write 豁免）
    expect(projection.stats.pruned.count).toBe(1);
    expect(projection.stats.pruned.excludedCount).toBe(1);
    expect(projection.messages[2]).toEqual({
      role: 'tool',
      content: 'z'.repeat(100) + '#1',
      toolCallId: 'c1',
    });
    const c2 = projection.messages[4];
    if (c2?.role !== 'tool') expect.unreachable('c2 结果应为 tool 消息');
    expect(c2.content).toContain('removed');
  });

  it('自定义 excludeTools：全名单豁免 → 0 裁剪、excludedCount 计满', async () => {
    const events = baseEvents();
    const projection = await project(events, {
      windowTokens: WINDOW,
      clearAtLeastTokens: CLEARANCE,
      excludeTools: ['ls'],
    });
    expect(projection.stats.pruned.count).toBe(0);
    expect(projection.stats.pruned.excludedCount).toBe(5);
    expect(projection.messages[2]).toEqual({
      role: 'tool',
      content: contentOf(events, 2),
      toolCallId: 'c1',
    });
  });

  it('组数 ≤3 时报 keep 恒为 3、无任何裁剪', async () => {
    const events: SessionEvent[] = [userEvent(fillerAscii(3300)), ...toolRound(2)];
    const projection = await project(events, {
      windowTokens: WINDOW,
      clearAtLeastTokens: CLEARANCE,
    });
    expect(projection.stats.pruned.count).toBe(0);
    expect(projection.stats.pruned.groupsKept).toBe(3);
    expect(projection.messages).toHaveLength(5);
  });

  it('孤儿结果（调用 ID 无对应请求）保守保留、不裁剪也不计豁免', async () => {
    const events: SessionEvent[] = [
      userEvent(fillerAscii(2800)),
      assistantEvent('', [{ id: 'c1', name: 'ls', arguments: '{}' }]),
      toolEvent('c1', 'z'.repeat(100) + '#1'),
      toolEvent('orphan-x', 'never matched'),
    ];
    const projection = await project(events, { windowTokens: WINDOW });
    expect(projection.stats.pruned.count).toBe(0);
    expect(projection.stats.pruned.excludedCount).toBe(0);
    const last = projection.messages.at(-1);
    expect(last).toEqual({ role: 'tool', content: 'never matched', toolCallId: 'orphan-x' });
  });

  it('reasoning 事件不进投影（不走请求，S2 策略负责）', async () => {
    const events: SessionEvent[] = [
      userEvent(fillerAscii(2800)),
      ev('reasoning', { content: 'think quietly' }),
      ...toolRound(1),
    ];
    const projection = await project(events, { windowTokens: WINDOW });
    expect(projection.messages).toHaveLength(3); // user + assistant + tool；reasoning 不算请求消息
    expect(
      projection.messages.every(
        (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
      ),
    ).toBe(true);
  });
});

describe('清出量门槛（§2.4 第 1 层：至少清出 clearAtLeastTokens 才裁剪）', () => {
  it('触顶但将被清出量不足默认 8000 → 本层跳过：结果原样、status=insufficient-clearance', async () => {
    // 5 组 × 12000 字符输出：est0 = 250(user 1000)+5×(3+3410)+36 ≈ 17400 > clearTrigger=900；
    // 截断后单条 ≈ 3410 token（10138 字符），裁 2 组净清出量 = 2×3410 = 6820 < 8000 → 跳过
    const events: SessionEvent[] = [
      userEvent(fillerAscii(1000)),
      ...toolRound(5, { content: () => 'a'.repeat(12000) }),
    ];
    const projection = await project(events, { windowTokens: WINDOW, maxLevel: 1 });

    expect(projection.stats.pruned.count).toBe(0);
    expect(projection.stats.pruned.status).toBe('insufficient-clearance');
    expect(projection.stats.pruned.clearedTokens).toBe(2 * 3410);
    expect(projection.stats.pruned.clearedTokens!).toBeLessThan(8000);
    expect(projection.warnings).toHaveLength(0); // 未发生压缩 → 无清理警告
    // 结果仍是截断后的原样（无占位符改写）
    const first = projection.messages[2];
    if (first?.role !== 'tool') expect.unreachable('首条结果应为 tool 消息');
    expect(first.content).toContain('The output of your last command was too long.');
    expect(first.toolCallId).toBe('c1');
  });

  it('将被清出量 ≥ 8000 → 照常裁剪（清出量按被裁者估算合计）', async () => {
    // 10 组 × 12000 字符输出：保留最近 3 组，裁 7 组；清出量 = 7×3410 = 23870 ≥ 8000 → 执行
    const events: SessionEvent[] = [
      userEvent(fillerAscii(1000)),
      ...toolRound(10, { content: () => 'a'.repeat(12000) }),
    ];
    const projection = await project(events, { windowTokens: WINDOW, maxLevel: 1 });

    expect(projection.stats.pruned.count).toBe(7);
    expect(projection.stats.pruned.status).toBe('pruned');
    expect(projection.stats.pruned.clearedTokens).toBe(7 * 3410);
    const first = projection.messages[2];
    if (first?.role !== 'tool') expect.unreachable('首条结果应为 tool 消息');
    expect(first.content).toContain('removed');
    // 警告随裁剪发生时注入：指明被清理的工具名与条数、提请先落盘（§2.3 准则 2）
    expect(projection.warnings).toHaveLength(1);
    expect(projection.warnings[0]).toContain('ls');
    expect(projection.warnings[0]).toContain('7 results');
    expect(projection.warnings[0]).toContain('save');
  });

  it('可配 clearAtLeastTokens：小门槛放行、大门槛拦截同一输入', async () => {
    const events = baseEvents();
    const permissive = await project(events, {
      windowTokens: WINDOW,
      clearAtLeastTokens: 1,
      maxLevel: 1,
    });
    expect(permissive.stats.pruned.count).toBe(2);
    const strict = await project(events, {
      windowTokens: WINDOW,
      clearAtLeastTokens: 10_000,
      maxLevel: 1,
    });
    expect(strict.stats.pruned.count).toBe(0);
    expect(strict.stats.pruned.status).toBe('insufficient-clearance');
  });
});

describe('裁剪前警告（§2.3 准则 2：即将清理，如仍需请自行落盘）', () => {
  it('警告指明被清理工具名（多种工具名去重）', async () => {
    resetSeq();
    const events: SessionEvent[] = [
      userEvent(fillerAscii(1000)),
      ...toolRound(10, { content: () => 'a'.repeat(12000), name: 'grep' }),
      assistantEvent('', [{ id: 'x1', name: 'ls', arguments: '{}' }]),
      toolEvent('x1', 'z'.repeat(100) + '#x'),
    ];
    // grep×10 组 + ls×1 组 = 11 个可裁剪组；保留最近 3 组（g9,g10,g11），
    // 被裁的是 g1..g8 的 grep 结果（ls 在 keep 组内不参与替换）。
    const projection = await project(events, { windowTokens: WINDOW, maxLevel: 1 });
    expect(projection.stats.pruned.count).toBe(8);
    expect(projection.warnings).toHaveLength(1);
    expect(projection.warnings[0]).toContain('grep');
    expect(projection.warnings[0]).not.toContain('"ls"'); // 被裁目标里没有 ls（它在 keep 组内）
  });
});
