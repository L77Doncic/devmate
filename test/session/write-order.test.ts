import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlFileAdapter } from '../../src/core/session/index.js';
import type { SessionEvent } from '../../src/shared/session-types.js';
import {
  assistantPayload,
  callsOf,
  cleanupTmpDirs,
  createTmpDir,
  event,
  expectCallsPaired,
  readAll,
  toolResultPayload,
  userPayload,
} from './support.js';

/**
 * 写序不变量（T1/T2，ADR-0004 与 CONTEXT「写序不变量」）：
 * assistant 先落盘 → 工具结果落盘 → 才发下一次请求。
 * 任意时刻崩溃只留下「可用占位符修补的缺口」（B 形态 = 悬空工具调用），
 * 本切片验证：正常时序可回放；缺口可由 repairOrphaned 补齐；补后可用。
 */

/** 规格谓词①：任何 tool 结果的 seq 都晚于其请求、且早于下一次带调用的请求（T2）。 */
function expectResultsBeforeNextRequest(events: readonly SessionEvent[]): void {
  const requestedByLast: string[] = [];
  const answered: string[] = [];
  for (const ev of events) {
    const calls = callsOf(ev);
    if (calls.length > 0) {
      for (const id of requestedByLast) {
        expect(answered, `下一次请求前，调用 ${id} 的结果必须已落盘`).toContain(id);
      }
      requestedByLast.length = 0;
      answered.length = 0;
      for (const call of calls) {
        requestedByLast.push(call.id);
      }
    } else if (ev.kind === 'tool' && 'toolCallId' in ev.payload) {
      answered.push(ev.payload.toolCallId);
    }
  }
}

/** 规格谓词②：seq 严格递增（追加模型，无重写）。 */
function expectStrictlyIncreasingSeq(events: readonly SessionEvent[]): void {
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1];
    const cur = events[i];
    if (prev !== undefined && cur !== undefined) {
      expect(cur.seq).toBeGreaterThan(prev.seq);
    }
  }
}

describe('写序不变量（切片 b：assistant 落盘 → 工具结果落盘 → 才发下一次请求）', () => {
  let dir: string;
  let warnings: string[];
  let store: JsonlFileAdapter;

  beforeEach(() => {
    dir = createTmpDir();
    warnings = [];
    store = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
  });

  afterEach(() => {
    cleanupTmpDirs();
  });

  it('主循环按写序执行时，事件流严格递增且每个请求都在其调用被应答后才发下一次', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('任务来了')));
    await store.append(
      's1',
      event(
        'assistant',
        assistantPayload('先看文件', [
          { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        ]),
      ),
    );
    await store.append('s1', event('tool', toolResultPayload('c1', '内容')));
    await store.append(
      's1',
      event(
        'assistant',
        assistantPayload('再执行', [
          { id: 'c2', name: 'run_command', arguments: '{"cmd":"npm test"}' },
        ]),
      ),
    );
    await store.append('s1', event('tool', toolResultPayload('c2', 'ok')));

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expectStrictlyIncreasingSeq(replayed);
    expectCallsPaired(replayed);
    expectResultsBeforeNextRequest(replayed);
  });

  it('执行工具途中崩溃（请求在、结果缺）→ 重读是可判定的缺口 → repairOrphaned 补齐 → 补后可用', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('任务')));
    await store.append(
      's1',
      event(
        'assistant',
        assistantPayload('两个动作', [
          { id: 'c1', name: 'list_dir', arguments: '{}' },
          { id: 'c2', name: 'read_file', arguments: '{"path":"b.ts"}' },
        ]),
      ),
    );
    await store.append('s1', event('tool', toolResultPayload('c1', '目录')));
    // 崩溃：c2 的结果未落盘

    const restarted = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    const before = await readAll(restarted, 's1');
    expect(before.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(before.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool']);

    const repaired = await restarted.repairOrphaned('s1');
    expect(repaired).toEqual(['c2']);

    const after = await readAll(restarted, 's1');
    expectStrictlyIncreasingSeq(after);
    expectCallsPaired(after);
    expectResultsBeforeNextRequest(after);
    expect(after[after.length - 1]?.kind).toBe('tool');
  });

  it('补齐后继续推进：修复结果构成断言链，下一条请求可正常落盘', async () => {
    await store.create('s1');
    await store.append(
      's1',
      event(
        'assistant',
        assistantPayload('动作', [{ id: 'c1', name: 'write_file', arguments: '{}' }]),
      ),
    );
    // 崩溃
    const restarted = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    await restarted.repairOrphaned('s1');
    await restarted.append('s1', event('assistant', assistantPayload('收到未知后果，我来确认')));
    await restarted.append('s1', event('user', userPayload('请继续')));

    const replayed = await readAll(restarted, 's1');
    expect(replayed.map((e) => e.kind)).toEqual(['assistant', 'tool', 'assistant', 'user']);
    expectStrictlyIncreasingSeq(replayed);
    expectCallsPaired(replayed);
    expectResultsBeforeNextRequest(replayed);
  });
});
