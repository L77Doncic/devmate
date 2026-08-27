import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlFileAdapter } from '../../src/core/session/index.js';
import type { SessionEvent, ToolPayload } from '../../src/shared/session-types.js';
import {
  assistantPayload,
  cleanupTmpDirs,
  createTmpDir,
  event,
  readAll,
  toolResultPayload,
} from './support.js';

/**
 * 悬空工具调用（CONTEXT 词条）：请求事件在、结果缺失（崩溃或中断造成）。
 * 修复方式 = 补一条「中断占位」结果而不是丢弃或重发——把「效果未知」如实告诉模型，
 * 让它决定是否重新探测（ADR-0004；research §3.2 B 形态）。
 */

function toolEvents(events: readonly SessionEvent[]): ToolPayload[] {
  return events.filter((e) => e.kind === 'tool').map((e) => e.payload as ToolPayload);
}

describe('悬空工具调用修复（切片 e：interrupted 占位的语义与幂等性）', () => {
  let dir: string;
  let store: JsonlFileAdapter;

  beforeEach(() => {
    dir = createTmpDir();
    store = new JsonlFileAdapter({ dir });
  });

  afterEach(() => {
    cleanupTmpDirs();
  });

  it('补写的占位结果：callId 配对、interrupted=true、内容为 error.type=interrupted 且声明副作用未知', async () => {
    await store.create('s1');
    await store.append(
      's1',
      event(
        'assistant',
        assistantPayload('请求', [
          { id: 'call_x', name: 'run_command', arguments: '{"cmd":"npm run deploy"}' },
        ]),
      ),
    );

    const repaired = await store.repairOrphaned('s1');
    expect(repaired).toEqual(['call_x']);

    const replayed = await readAll(store, 's1');
    const toolPayloads = toolEvents(replayed);
    expect(toolPayloads).toHaveLength(1);
    const placeholder = toolPayloads[0];
    expect(placeholder).toBeDefined();
    if (placeholder === undefined) {
      return;
    }
    expect(placeholder.toolCallId).toBe('call_x');
    expect(placeholder.interrupted).toBe(true);
    expect(placeholder.content).toContain('"type":"interrupted"');
    const parsed = JSON.parse(placeholder.content) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(error.type).toBe('interrupted');
    expect(String(error.message)).toMatch(/effects are unknown/);
  });

  it('只想补缺：已有结果的调用不重复补，事件流零重复', async () => {
    await store.create('s1');
    await store.append(
      's1',
      event('assistant', assistantPayload('一', [{ id: 'c1', name: 'a', arguments: '{}' }])),
    );
    await store.append('s1', event('tool', toolResultPayload('c1', '正常结果')));
    await store.append(
      's1',
      event('assistant', assistantPayload('二', [{ id: 'c2', name: 'b', arguments: '{}' }])),
    );

    const repaired = await store.repairOrphaned('s1');
    expect(repaired).toEqual(['c2']);
    const replayed = await readAll(store, 's1');
    const toolPayloads = toolEvents(replayed);
    expect(toolPayloads.map((p) => p.toolCallId)).toEqual(['c1', 'c2']);
    expect(toolPayloads[0]?.interrupted).toBeUndefined();
  });

  it('幂等：再次 repairOrphaned 不再追加任何事件', async () => {
    await store.create('s1');
    await store.append(
      's1',
      event('assistant', assistantPayload('x', [{ id: 'c1', name: 'a', arguments: '{}' }])),
    );
    await store.repairOrphaned('s1');
    const second = await store.repairOrphaned('s1');
    expect(second).toEqual([]);
    expect(await readAll(store, 's1')).toHaveLength(2);
  });

  it('多个悬空调用：按首次出现顺序各补一条占位', async () => {
    await store.create('s1');
    await store.append(
      's1',
      event(
        'assistant',
        assistantPayload('并行', [
          { id: 'p1', name: 'a', arguments: '{}' },
          { id: 'p2', name: 'b', arguments: '{}' },
          { id: 'p3', name: 'c', arguments: '{}' },
        ]),
      ),
    );
    await store.append('s1', event('tool', toolResultPayload('p2', '仅有 p2 完成')));

    const repaired = await store.repairOrphaned('s1');
    expect(repaired).toEqual(['p1', 'p3']);

    const replayed = await readAll(store, 's1');
    const toolPayloads = toolEvents(replayed);
    expect(toolPayloads.map((p) => p.toolCallId)).toEqual(['p2', 'p1', 'p3']);
    const order = replayed.map((e) => e.seq);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]).toBeGreaterThan(order[i - 1] ?? 0);
    }
  });
});
