import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlFileAdapter, SessionSeqConflictError } from '../../src/core/session/index.js';
import { cleanupTmpDirs, createTmpDir, event, readAll, userPayload, userText } from './support.js';

/**
 * seq 陈旧缓存防御（切片 h：单写者假设 + 磁盘真值优先）：
 * append 的 seq 每写前从磁盘尾部派生（lastSeqOnDisk+1）；本实例缓存降级为纯提示——
 * 与磁盘不一致时以磁盘为准（报告后继续写），绝不让缓存不一致演变为用户可见的硬错。
 * SessionSeqConflictError 仅保留给磁盘回退（本实例已写过的 seq 从磁盘消失——文件被替换/截断，
 * 病态场景）。同实例内并发 append 由 per-session 串行化保证 seq 严格递增无重复。
 */
describe('seq 陈旧缓存防御（切片 h：单写者假设 + 磁盘真值优先）', () => {
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

  it('外部实例续写（磁盘 seq=5）后，旧实例 append 不抛错：告警并以磁盘真值续 seq=6，两行均在、磁盘单调', async () => {
    // 旧实例写 seq1..4（缓存 next=5）。
    await store.create('s1');
    for (const n of ['1', '2', '3', '4']) {
      await store.append('s1', event('user', userPayload(`旧 ${n}`)));
    }

    // 外部以第二 adapter 追加一行 seq=5（模拟另一实例/resume 续写）。
    const other = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    await other.append('s1', event('user', userPayload('外部 5')));

    // 旧实例继续 append：不抛、seq=5+1=6（磁盘真值）、告警诊断含 id/cached/derived。
    const resumed = await store.append('s1', event('user', userPayload('旧实例补写')));
    expect(resumed.seq).toBe(6);

    const staleWarns = warnings.filter((m) => m.includes('seq cache stale'));
    expect(staleWarns).toHaveLength(1);
    expect(staleWarns[0]).toContain('s1');
    expect(staleWarns[0]).toContain('cached next=5');
    expect(staleWarns[0]).toContain('disk-derived next=6');

    // 两行均在（4 + 外部5 + 补写6），文件回放单调递增。
    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(replayed.map((e) => userText(e))).toEqual([
      '旧 1',
      '旧 2',
      '旧 3',
      '旧 4',
      '外部 5',
      '旧实例补写',
    ]);
  });

  it('同一实例自写自续（无外部写入）永不误报冲突', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('a')));
    await store.append('s1', event('user', userPayload('b')));
    await store.append('s1', event('user', userPayload('c')));
    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(warnings).toHaveLength(0);
  });

  it('缓存不存在（全新实例 resume）：直接以磁盘续写，零冲突零告警', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('a')));
    await store.append('s1', event('user', userPayload('b')));

    const fresh = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    const resumed = await fresh.append('s1', event('user', userPayload('c')));
    expect(resumed.seq).toBe(3);
    expect(warnings).toHaveLength(0);

    const replayed = await readAll(fresh, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('磁盘尾部存在不可解析坏行：按最后合法行续 seq，不触发冲突（坏行被写端跳过）', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('a')));
    await store.append('s1', event('user', userPayload('b')));
    // 外部写入一行脏数据（带 \n，位于文件尾）：lastEventSeqOnDisk 从后向前跳过它。
    appendFileSync(join(dir, 's1.jsonl'), 'X{ broken line}\n');

    const resumed = await store.append('s1', event('user', userPayload('c')));
    expect(resumed.seq).toBe(3);
    expect(warnings.filter((m) => m.includes('seq cache stale'))).toHaveLength(0);

    // 坏行被读端丢弃，剩下的合法行 1..3 完整回放。
    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(replayed.map((e) => userText(e))).toEqual(['a', 'b', 'c']);
  });

  it('并发 Promise.all 两个 append（同实例）：per-session 串行化，seq 严格递增无重复', async () => {
    await store.create('s1');
    const [a, b] = await Promise.all([
      store.append('s1', event('user', userPayload('并发 a'))),
      store.append('s1', event('user', userPayload('并发 b'))),
    ]);
    expect(a.seq).not.toBe(b.seq); // 无重复 seq
    expect([a.seq, b.seq].sort((x, y) => x - y)).toEqual([1, 2]);

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    expect(replayed.map((e) => userText(e))).toEqual(['并发 a', '并发 b']);
  });

  it('磁盘回退（文件被替换为更旧内容）：仍抛 SessionSeqConflictError（病态兜底，概率≈0）', async () => {
    await store.create('s1');
    for (const txt of ['r1', 'r2', 'r3']) {
      await store.append('s1', event('user', userPayload(txt)));
    }
    // 本实例缓存 next=4；外部把文件整个替换为只剩下 seq1..2 的旧版本（模拟恢复/截断/异常双写）。
    const oldLine = (seq: number, content: string): string =>
      `${JSON.stringify({ v: 1, seq, ts: 1, kind: 'user', payload: { content } })}\n`;
    writeFileSync(join(dir, 's1.jsonl'), `${oldLine(1, 'v1')}${oldLine(2, 'v2')}`);

    await expect(store.append('s1', event('user', userPayload('回退补写')))).rejects.toBeInstanceOf(
      SessionSeqConflictError,
    );
  });
});
