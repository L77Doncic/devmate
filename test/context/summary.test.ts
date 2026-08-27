import { describe, expect, it } from 'vitest';

import { project } from '../../src/core/context/project.js';
import type { SummarizeRequest } from '../../src/core/context/project.js';
import { SUMMARY_SECTION_HEADERS } from '../../src/core/context/summary.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import { ev, fillerAscii, resetSeq, snapshot, toolRound, userEvent } from './support.js';

/**
 * 触顶期摘要（切片 d）：五段式结构、禁止工具调用、只产请求/内容（写入由 loop 负责）。
 * 阈值手算：windowTokens=2000 → compactTrigger=1440；user 5200 字符 = 1300 token；
 * 每组 39（assistant 3 + 结果 36，逐项与 prune.test.ts 手算一致）× 5 = 195；
 * 11 条消息结构开销 = 3×11+3 = 36 ⇒ est0 = 1300+195+36 = 1531；
 * 裁剪 2 组结果后（占位符 138 字符 ≈ 76 token/条）est1 = 1531 − 2×36 + 2×76 = 1611 > 1440 → 触发摘要。
 * 断言裁剪证据（占位符形态）的用例清 clearAtLeastTokens: 1（「≥8k 清出量」门槛另测，prune.test.ts）。
 */

const WINDOW = 2000;
const CLEARANCE = 1;

function bigEvents(): SessionEvent[] {
  resetSeq();
  return [userEvent(fillerAscii(5200)), ...toolRound(5)];
}

/** 固定 fake 摘要器：记录请求并返回带 <summary> 包裹的内容（50 字符 'a'）。 */
function fakeSummarizer(log: SummarizeRequest[] = []) {
  const inner = 'a'.repeat(50);
  const fn = (req: SummarizeRequest): string => {
    log.push(req);
    return `<summary>${inner}</summary>`;
  };
  return { fn, log, inner };
}

describe('摘要：触顶触发与投影替换', () => {
  it('est1 > compactTrigger → 触发摘要，全部对话被摘要消息替换，内容去 <summary> 标签', async () => {
    const { fn, log, inner } = fakeSummarizer();
    const events = bigEvents();
    const before = snapshot(events);

    const projection = await project(events, {
      windowTokens: WINDOW,
      summarizer: fn,
      clearAtLeastTokens: CLEARANCE,
    });

    expect(projection.stats.summary.status).toBe('summarized');
    expect(projection.stats.summary.triggered).toBe(true);
    expect(projection.stats.summary.content).toBe(inner);
    expect(projection.stats.summary.prompt).toBeDefined();
    expect(projection.stats.summary.tokensBefore).not.toBeUndefined();
    expect(projection.stats.summary.tokensBefore!).toBeGreaterThan(1440);
    // 摘要后回到稳定小体积：单条系统消息 = 13(内容) + 3+3(结构) = 19 token
    expect(projection.stats.summary.tokensAfter).toBe(19);
    expect(projection.messages).toHaveLength(1);
    expect(projection.messages[0]).toEqual({ role: 'system', content: inner });
    expect(projection.stats.estimatedTokens).toBe(19);

    // 摘要器拿到「截断+裁剪之后」的当前投影（11 条，最老结果已是占位符）
    expect(log).toHaveLength(1);
    const req = log[0];
    expect(req?.messages).toHaveLength(11);
    expect(req?.messages[2]).toEqual({
      role: 'tool',
      toolCallId: 'c1',
      content: expect.stringContaining('removed'),
    });

    // 事件流不被改动
    expect(snapshot(events)).toBe(before);
    // 输入未被改写：原结果仍完整
    if (events[4]?.kind !== 'tool') expect.unreachable();
  });

  it('提示词逐字包含五段标题与禁止工具指令', async () => {
    const { fn, log } = fakeSummarizer();
    await project(bigEvents(), {
      windowTokens: WINDOW,
      summarizer: fn,
      clearAtLeastTokens: CLEARANCE,
    });
    const prompt = log[0]?.prompt ?? '';
    expect(prompt).toContain('Task Overview');
    expect(prompt).toContain('Current State');
    expect(prompt).toContain('Important Discoveries');
    expect(prompt).toContain('Next Steps');
    expect(prompt).toContain('Context to Preserve');
    expect(prompt).toContain('Do NOT call any tools.');
  });

  it('五段标题与提示词由单一来源派生：逐条按「序号. 标题:」出现且恰好五段（防漂移）', async () => {
    const { fn, log } = fakeSummarizer();
    await project(bigEvents(), {
      windowTokens: WINDOW,
      summarizer: fn,
      clearAtLeastTokens: CLEARANCE,
    });
    const prompt = log[0]?.prompt ?? '';
    SUMMARY_SECTION_HEADERS.forEach((header, i) => {
      expect(prompt).toContain(`${i + 1}. ${header}:`);
    });
    const numberedLines = prompt.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(numberedLines).toHaveLength(SUMMARY_SECTION_HEADERS.length);
    expect(numberedLines).toHaveLength(5);
  });

  it('systemPrefix 稳定前缀段不被触碰并置于摘要之前', async () => {
    const { fn, inner } = fakeSummarizer();
    const prefix = 'System prefix: keep me.'; // 24 字符 → 6 token
    const projection = await project(bigEvents(), {
      windowTokens: WINDOW,
      summarizer: fn,
      systemPrefix: prefix,
      clearAtLeastTokens: CLEARANCE,
    });
    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[0]).toEqual({ role: 'system', content: prefix });
    expect(projection.messages[1]).toEqual({ role: 'system', content: inner });
    // 前缀分段取整：ceil(6/4)+1+ceil(6/4)+1+1+ceil(4/4)+1+ceil(2/4)+1 = 11；
    // 摘要 13；结构 2×3+3 = 9 → 33
    expect(projection.stats.summary.tokensAfter).toBe(33);
  });

  it('未注入摘要器：只产请求（prompt），不产内容，消息停在裁剪后形态', async () => {
    const events = bigEvents();
    const projection = await project(events, {
      windowTokens: WINDOW,
      clearAtLeastTokens: CLEARANCE,
    });
    expect(projection.stats.summary.status).toBe('no-summarizer');
    expect(projection.stats.summary.prompt).toBeDefined();
    expect(projection.stats.summary.content).toBeUndefined();
    expect(projection.stats.summary.tokensBefore).toBeDefined();
    expect(projection.messages).toHaveLength(11); // 裁剪后、尚未摘要
  });

  it('forceLevel=2 即使估算未触顶也摘要（超限报错 → 压缩 → 重试 的显式升级链）', async () => {
    resetSeq();
    const events: SessionEvent[] = [userEvent('hi'), ...toolRound(1)];
    const { fn } = fakeSummarizer();
    const projection = await project(events, {
      windowTokens: WINDOW,
      summarizer: fn,
      forceLevel: 2,
    });
    expect(projection.stats.summary.status).toBe('summarized');
  });
});

describe('forceLevel × maxLevel 不对称（force 穿透：力 2 摘要必执行）', () => {
  it('maxLevel=1 + forceLevel=2：摘要仍执行（不被 maxLevel < 2 挡）', async () => {
    const { fn } = fakeSummarizer();
    const projection = await project(bigEvents(), {
      windowTokens: WINDOW,
      summarizer: fn,
      maxLevel: 1,
      forceLevel: 2,
    });
    expect(projection.stats.summary.status).toBe('summarized');
    expect(projection.messages).toHaveLength(1);
  });

  it('maxLevel=0 + forceLevel=2：force 穿透——裁剪(force≥1)与摘要(force=2)均执行', async () => {
    const { fn } = fakeSummarizer();
    const projection = await project(bigEvents(), {
      windowTokens: WINDOW,
      summarizer: fn,
      maxLevel: 0,
      forceLevel: 2,
    });
    expect(projection.stats.pruned.count).toBe(2); // force≥1：裁剪必执行（不再过清出门槛）
    expect(projection.stats.summary.status).toBe('summarized');
    expect(projection.messages).toHaveLength(1);
  });
});

describe('摘要事件回放：按事件流重建投影', () => {
  it('压缩记录事件作为投影前缀；其后事件序接续，旧事件不再参与', async () => {
    const { fn, inner } = fakeSummarizer();
    const events = bigEvents();
    const first = await project(events, {
      windowTokens: WINDOW,
      summarizer: fn,
      clearAtLeastTokens: CLEARANCE,
    });
    resetSeq();
    const summaryEvent = ev('event', {
      type: 'compaction',
      data: { summary: first.stats.summary.content ?? '' },
    });
    const after = userEvent('继续');

    // 仅摘要 + 后续事件
    const events2 = [...events, summaryEvent, after];
    const projection = await project(events2, { windowTokens: WINDOW });
    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[0]).toEqual({ role: 'system', content: inner });
    expect(projection.messages[1]).toEqual({ role: 'user', content: '继续' });
    // 旧工具/结果已进摘要，不再触发裁剪与摘要统计
    expect(projection.stats.pruned.count).toBe(0);
    expect(projection.stats.summary.status).toBe('not-triggered');
  });

  it('无后续事件时投影 = 稳定前缀 + 摘要消息', async () => {
    const { fn, inner } = fakeSummarizer();
    const events = bigEvents();
    const first = await project(events, {
      windowTokens: WINDOW,
      summarizer: fn,
      clearAtLeastTokens: CLEARANCE,
    });
    resetSeq();
    const summaryEvent = ev('event', {
      type: 'compaction',
      data: { summary: first.stats.summary.content ?? '' },
    });
    const projection = await project([...events, summaryEvent], {
      windowTokens: WINDOW,
      systemPrefix: 'Rules: maintain context.',
    });
    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[0]?.role).toBe('system');
    expect(projection.messages[1]).toEqual({ role: 'system', content: inner });
  });
});

describe('摘要提示词携带完整当前投影', () => {
  it('对话内容出现在摘要指令中（以 role/文本 呈现）', async () => {
    const { fn, log } = fakeSummarizer();
    await project(bigEvents(), {
      windowTokens: WINDOW,
      summarizer: fn,
      clearAtLeastTokens: CLEARANCE,
    });
    const req = log[0];
    const rendered = JSON.stringify(req?.messages);
    expect(rendered).toContain('user');
    expect(rendered).toContain('assistant');
    expect(rendered).toContain('removed'); // 裁剪后的占位符形态在摘要输入中
  });
});
