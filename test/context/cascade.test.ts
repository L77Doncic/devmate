import { describe, expect, it } from 'vitest';

import { project } from '../../src/core/context/project.js';
import type { SummarizeRequest } from '../../src/core/context/project.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import {
  assistantEvent,
  fillerAscii,
  resetSeq,
  snapshot,
  toolEvent,
  userEvent,
} from './support.js';

/**
 * 压缩顺序固定（切片 e）：先截断 → 再裁剪 → 最后摘要；每层计数正确；
 * 只作用于投影——输入 events 永不被改动。
 * 注：本文件聚焦「顺序」断言，裁剪层统一清 clearAtLeastTokens: 1
 * （「≥8k 清出量」门槛是另一层语义，在 prune.test.ts 专门覆盖）。
 */

const WINDOW = 2000;
const CLEARANCE = 1;

/** user 5200 字符 + 5 组（第 5 组结果 12000 字符超截断阈值）。 */
function noisyEvents(): SessionEvent[] {
  resetSeq();
  const out: SessionEvent[] = [userEvent(fillerAscii(5200))];
  for (let i = 1; i <= 5; i += 1) {
    out.push(assistantEvent('', [{ id: `c${i}`, name: 'ls', arguments: '{}' }]));
    out.push(toolEvent(`c${i}`, i === 5 ? 'a'.repeat(12000) : 'z'.repeat(100) + `#${i}`));
  }
  return out;
}

describe('压缩顺序固定：截断 → 裁剪 → 摘要', () => {
  it('三层全部命中：截断 1（最新长输出）、裁剪 2（最早两组）、摘要 1', async () => {
    const events = noisyEvents();
    const before = snapshot(events);
    let captured: SummarizeRequest | undefined;
    const summarizer = (req: SummarizeRequest): string => {
      captured = req;
      return '<summary>summary-of-everything</summary>';
    };

    const projection = await project(events, {
      windowTokens: WINDOW,
      summarizer,
      clearAtLeastTokens: CLEARANCE,
    });

    expect(projection.stats.truncated.count).toBe(1);
    expect(projection.stats.pruned.count).toBe(2);
    expect(projection.stats.summary.status).toBe('summarized');

    // 顺序证据：摘要器拿到的是「已截断且已裁剪」的当前投影——
    // 最新组的超长结果被 0 层截断（advice 开头），老结果的占位符来自 1 层裁剪
    expect(captured).toBeDefined();
    const reqMessages = captured?.messages ?? [];
    expect(reqMessages).toHaveLength(11);
    const lastTool = reqMessages.at(-1);
    if (lastTool === undefined || lastTool.role !== 'tool') {
      expect.unreachable('末条应为 tool 消息（截断后的长输出）');
    }
    expect(lastTool.content.startsWith('The output of your last command was too long.\n')).toBe(
      true,
    );
    expect(lastTool.content).toContain('--- 2000 characters elided ---'); // 12000 - 5000 - 5000
    const firstTool = reqMessages[2];
    if (firstTool === undefined || firstTool.role !== 'tool') {
      expect.unreachable('首条结果应存在（index 2）');
    }
    expect(firstTool.content).toContain('removed');
    expect(firstTool.content).toContain('"ls"');

    // 输入事件流未被改动：原始 12000 字符长输出仍在事件里
    expect(snapshot(events)).toBe(before);
    const lastEvent = events.at(-1);
    if (lastEvent?.kind !== 'tool') expect.unreachable();
    expect(lastEvent.payload.content.length).toBe(12000);
  });

  it('同一输入两次投影结果确定一致（纯函数判定）', async () => {
    const events = noisyEvents();
    const summarizer = (): string => '<summary>fixed</summary>';
    const first = await project(events, {
      windowTokens: WINDOW,
      summarizer,
      clearAtLeastTokens: CLEARANCE,
    });
    const second = await project(events, {
      windowTokens: WINDOW,
      summarizer,
      clearAtLeastTokens: CLEARANCE,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('maxLevel=0：只截断，不裁剪不摘要；超长输出被处理但对话保持原样', async () => {
    const events = noisyEvents();
    const projection = await project(events, { windowTokens: WINDOW, maxLevel: 0 });
    expect(projection.stats.truncated.count).toBe(1);
    expect(projection.stats.pruned.count).toBe(0);
    expect(projection.stats.summary.status).toBe('not-triggered');
    expect(projection.messages).toHaveLength(11);
    const last = projection.messages.at(-1);
    if (last?.role !== 'tool') expect.unreachable();
    expect(last.content).toContain('--- 2000 characters elided ---');
  });

  it('maxLevel=1：截断+裁剪，摘要不触发（停在第二层，保持低成本）', async () => {
    const events = noisyEvents();
    const projection = await project(events, {
      windowTokens: WINDOW,
      maxLevel: 1,
      clearAtLeastTokens: CLEARANCE,
    });
    expect(projection.stats.truncated.count).toBe(1);
    expect(projection.stats.pruned.count).toBe(2);
    expect(projection.stats.summary.status).toBe('not-triggered');
    expect(projection.messages).toHaveLength(11);
  });
});
