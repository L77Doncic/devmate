import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlFileAdapter, SessionSeqConflictError } from '../../src/core/session/index.js';
import { cleanupTmpDirs, createTmpDir, event, readAll, userPayload, userText } from './support.js';

/**
 * seq 陈旧缓存防御（ADR-0004 单写者假设）：nextSeqBySession 缓存不能静默复用——
 * 本实例续写期间若有另一实例（resume）也写入同一会话，旧实例 append 必须报错，
 * 而不是写出一条重复 seq 让读端默默丢弃（数据无声丢失）。
 */
describe('seq 陈旧缓存防御（切片 h：单写者假设 + 冲突检测）', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTmpDir();
  });

  afterEach(() => {
    cleanupTmpDirs();
  });

  it('另一实例续写后，旧实例 append 抛 SessionSeqConflictError 而非产生重复 seq', async () => {
    const oldStore = new JsonlFileAdapter({ dir });
    await oldStore.create('s1');
    await oldStore.append('s1', event('user', userPayload('旧 1')));
    await oldStore.append('s1', event('user', userPayload('旧 2')));

    // 新实例（resume）继续写入 seq=3。
    const newStore = new JsonlFileAdapter({ dir });
    const resumed = await newStore.append('s1', event('user', userPayload('新 3')));
    expect(resumed.seq).toBe(3);

    // 旧实例的缓存仍是 3——继续写就会重复 seq。防御：明确报错。
    await expect(
      oldStore.append('s1', event('user', userPayload('旧实例补写'))),
    ).rejects.toBeInstanceOf(SessionSeqConflictError);

    // 文件里没有重复 seq：读回仍是 [1,2,3]。
    const replayed = await readAll(newStore, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(replayed.map((e) => userText(e))).toEqual(['旧 1', '旧 2', '新 3']);
  });

  it('同一实例自写自续（无外部写入）永不误报冲突', async () => {
    const store = new JsonlFileAdapter({ dir });
    await store.create('s1');
    await store.append('s1', event('user', userPayload('a')));
    await store.append('s1', event('user', userPayload('b')));
    await store.append('s1', event('user', userPayload('c')));
    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
