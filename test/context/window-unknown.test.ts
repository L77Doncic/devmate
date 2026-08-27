import { describe, expect, it } from 'vitest';

import { isOverBudget, project } from '../../src/core/context/project.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import { assistantEvent, fillerAscii, resetSeq, toolEvent, userEvent } from './support.js';

/**
 * 窗口未知（切片 g）：不抛错；不做阈值计算（§8A/§1.4）；
 * 截断恒可用、裁剪经 forceLevel 显式可用；摘要需窗口判定 → 不触发；
 * isOverBudget 无预算 → null（不预判，由「超限报错 → 压缩 → 重试」兜底）。
 */

function bigConversation(): SessionEvent[] {
  resetSeq();
  const out: SessionEvent[] = [userEvent(fillerAscii(5200))];
  for (let i = 1; i <= 5; i += 1) {
    out.push(assistantEvent('', [{ id: `c${i}`, name: 'ls', arguments: '{}' }]));
    out.push(toolEvent(`c${i}`, i === 5 ? 'a'.repeat(12000) : 'z'.repeat(100) + `#${i}`));
  }
  return out;
}

describe('窗口未知：不抛错、无阈值触发', () => {
  it('默认调用：截断恒执行；裁剪/摘要不受阈值触发（未知时不做阈值计算）', async () => {
    let calls = 0;
    const projection = await project(bigConversation(), {
      summarizer: () => {
        calls += 1;
        return '<summary>never</summary>';
      },
    });
    expect(projection.stats.truncated.count).toBe(1);
    expect(projection.stats.pruned.count).toBe(0);
    expect(projection.stats.summary.status).toBe('not-triggered');
    expect(calls).toBe(0);
    expect(projection.messages).toHaveLength(11);
  });

  it('forceLevel=1（超限报错后的显式升级）：裁剪可用（force 绕过清出量门槛），并附带清理警告', async () => {
    const projection = await project(bigConversation(), { forceLevel: 1 });
    expect(projection.stats.pruned.count).toBe(2);
    expect(projection.stats.pruned.status).toBe('pruned');
    expect(projection.warnings).toHaveLength(1);
    expect(projection.warnings[0]).toContain('ls');
    expect(projection.stats.summary.status).toBe('not-triggered');
  });

  it('forceLevel=2：摘要需要窗口判定 → 不触发（status=window-unknown），摘要器不被调用', async () => {
    let calls = 0;
    const projection = await project(bigConversation(), {
      forceLevel: 2,
      summarizer: () => {
        calls += 1;
        return '<summary>never</summary>';
      },
    });
    expect(calls).toBe(0);
    expect(projection.stats.summary.status).toBe('window-unknown');
    expect(projection.stats.summary.triggered).toBe(true); // 判定触发过，但被窗口未知挡住
    expect(projection.stats.summary.content).toBeUndefined();
    expect(projection.stats.pruned.count).toBe(2); // 裁剪仍执行（保守策略）
  });

  it('窗口未知 + 已知：isOverBudget 三态判定（未知 null，不做超限预判）', async () => {
    const projection = await project(bigConversation());
    expect(isOverBudget(projection, undefined)).toBeNull();
    expect(isOverBudget(projection, 1)).toBe(true);
    expect(isOverBudget(projection, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('窗口未知不抛错（重复调用稳定）', async () => {
    const p1 = await project(bigConversation(), { forceLevel: 2 });
    const p2 = await project(bigConversation(), { forceLevel: 2 });
    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
  });
});
