import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  JsonlFileAdapter,
  SessionExistsError,
  SessionNotFoundError,
} from '../../src/core/session/index.js';
import {
  assistantPayload,
  cleanupTmpDirs,
  createTmpDir,
  event,
  readAll,
  toolResultPayload,
  userPayload,
  userText,
} from './support.js';

/**
 * 会话恢复 = 同一会话 ID 的既有事件流追加新事件继续运行（CONTEXT「会话恢复」）；
 * 会话分叉 = 把历史复制到新会话 ID，原会话不动（CONTEXT「会话分叉」；ADR-0004）。
 */
describe('resume / fork（切片 d）', () => {
  let dir: string;
  let store: JsonlFileAdapter;

  beforeEach(() => {
    dir = createTmpDir();
    store = new JsonlFileAdapter({ dir });
  });

  afterEach(() => {
    cleanupTmpDirs();
  });

  async function writeHistory(prefix: string): Promise<void> {
    await store.create('s1');
    await store.append('s1', event('user', userPayload(`${prefix}-1`)));
    await store.append('s1', event('user', userPayload(`${prefix}-2`)));
  }

  it('resume：重启后同 id 继续 append，seq 延续、既有历史一字不改', async () => {
    await writeHistory('会话');
    const before = readFileSync(join(dir, 's1.jsonl'), 'utf8');

    // 模拟进程重启：新 store 实例、同 dir、同 id
    const afterRestart = new JsonlFileAdapter({ dir });
    const resumed = await afterRestart.append('s1', event('user', userPayload('第 3 条')));
    expect(resumed.seq).toBe(3);

    const replayed = await readAll(afterRestart, 's1');
    expect(replayed.map((e) => userText(e))).toEqual(['会话-1', '会话-2', '第 3 条']);
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
    const after = readFileSync(join(dir, 's1.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
  });

  it('fork：历史复制到新 id（事件逐字一致），原文件一个字节不动', async () => {
    await writeHistory('fork');
    await store.append(
      's1',
      event(
        'assistant',
        assistantPayload('查查呢', [{ id: 'c1', name: 'list_dir', arguments: '{}' }]),
      ),
    );
    await store.append('s1', event('tool', toolResultPayload('c1', '列表')));
    const sourceBytes = readFileSync(join(dir, 's1.jsonl'));

    await store.fork('s1', 's1-fork');

    const forked = await readAll(store, 's1-fork');
    const original = await readAll(store, 's1');
    expect(forked).toEqual(original);
    expect(readFileSync(join(dir, 's1.jsonl'))).toEqual(sourceBytes);
    expect(readFileSync(join(dir, 's1-fork.jsonl'), 'utf8')).toBe(sourceBytes.toString('utf8'));
  });

  it('fork 后可独立推进：两边追加互不影响', async () => {
    await writeHistory('split');
    await store.fork('s1', 's1-fork');

    await store.append('s1', event('user', userPayload('原线继续')));
    await store.append('s1-fork', event('user', userPayload('新线继续')));

    const [oline, forked] = [await readAll(store, 's1'), await readAll(store, 's1-fork')];
    expect(oline.map((e) => userText(e))).toEqual(['split-1', 'split-2', '原线继续']);
    expect(forked.map((e) => userText(e))).toEqual(['split-1', 'split-2', '新线继续']);
    // 新线的 seq 从复制来的历史之后继续，两边互不串号
    expect(oline.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(forked.map((e) => e.seq)).toEqual([1, 2, 3]);
    await store.append('s1-fork', event('user', userPayload('新线又一条')));
    const forked2 = await readAll(store, 's1-fork');
    expect(forked2.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('fork 的边界：源不存在抛 SessionNotFoundError；目标已存在抛 SessionExistsError', async () => {
    await writeHistory('edge');
    await store.fork('s1', 's1-fork');
    await expect(store.fork('nope', 'x')).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(store.fork('s1', 's1-fork')).rejects.toBeInstanceOf(SessionExistsError);
  });
});
