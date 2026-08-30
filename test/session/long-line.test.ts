import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlFileAdapter } from '../../src/core/session/index.js';
import { cleanupTmpDirs, createTmpDir, event, readAll, userPayload, userText } from './support.js';

/**
 * VT-1 回归：lastEventSeqOnDisk 的 64KB 窗口把超长事件行截断 → 误判 seq（500 冲突/
 * 重启后重复 seq 数据丢失）。修复：反向块扫描只定位行边界，候选行按真实终点全量读取。
 * 两条尺寸路径复现（暴力测试 b:1000/b:2800）：单事件行 > 64KB。
 */
describe('长事件行（>64KB 单行）尾部 seq 推导（VT-1 回归）', () => {
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

  /** 大内容长度档位（字节 > 64KB 窗口；b:1000 ≈ 65k 字符 / b:2800 ≈ 350k 字节量级）。 */
  const SIZES = [
    { label: 'b:1000 量级（~100KB 行）', chars: 100_000 },
    { label: 'b:2800 量级（~300KB 行）', chars: 310_000 },
  ];

  for (const { label, chars } of SIZES) {
    it(`${label}：大 tool 结果后同实例续写——无冲突、seq 连续、长行完整回放`, async () => {
      await store.create('s1');
      await store.append('s1', event('user', userPayload('前置')));
      const big = 'x'.repeat(chars);
      const bigSaved = await store.append('s1', event('tool', { toolCallId: 'c1', content: big }));
      expect(bigSaved.seq).toBe(2);

      // 续写：reserveNextSeq 读的文件尾 = 那条 >64KB 的 tool 事件行。
      // 旧实现：窗口内找不到 '\n' 收缩 end → 截断候选行 → 误判 next=1 < 缓存 3 → 抛冲突。
      const next = await store.append('s1', event('user', userPayload('后续')));
      expect(next.seq).toBe(3);
      expect(warnings).toHaveLength(0); // 零冲突零缓存陈旧告警

      const replayed = await readAll(store, 's1');
      expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(replayed[1]!.kind).toBe('tool');
      if (replayed[1]!.kind === 'tool') {
        expect(replayed[1]!.payload.content).toBe(big); // 长行未被截断
      }
      expect(replayed.map((e) => userText(e))).toEqual(['前置', '', '后续']);
    });

    it(`${label}：全新实例 resume——磁盘真值派生正确 seq、无冲突、无重复行`, async () => {
      await store.create('s1');
      const big = 'y'.repeat(chars);
      await store.append('s1', event('tool', { toolCallId: 'c1', content: big }));

      // 模拟服务重启（缓存清空）：重启后续写由磁盘推导（旧实现推导成错误 seq 并写出重复行）
      const fresh = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
      const resumed = await fresh.append('s1', event('user', userPayload('重启后')));
      expect(resumed.seq).toBe(2);
      expect(warnings).toHaveLength(0);

      const replayed = await readAll(fresh, 's1');
      expect(replayed.map((e) => e.seq)).toEqual([1, 2]); // 无重复 seq 行（旧实现写出 seq1 重复行被读端丢弃=数据丢失）
      expect(replayed[1]!.kind).toBe('user');
      expect(userText(replayed[1]!)).toBe('重启后');

      // 磁盘长行仍是完整单行（写入未截断），文件长度 = 长行字节 + JSON 外壳。
      const disk = readFileSync(join(dir, 's1.jsonl'), 'utf8');
      expect(disk).toContain(big);
      expect(disk.split('\n')).toHaveLength(3); // 2 行 + 尾空串
    });

    it(`${label}：长行后接坏行——从后向前跳过坏行、按长行 seq 续写`, async () => {
      await store.create('s1');
      const big = 'z'.repeat(chars);
      await store.append('s1', event('tool', { toolCallId: 'c1', content: big }));
      // 外部写入一条带 '\n' 的脏行（位于文件尾）：lastEventSeqOnDisk 须越过它找到长行
      const { appendFileSync } = await import('node:fs');
      appendFileSync(join(dir, 's1.jsonl'), 'not json at all }}}{\n');

      const fresh = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
      const resumed = await fresh.append('s1', event('user', userPayload('坏行后')));
      expect(resumed.seq).toBe(2);
      expect(warnings.filter((m) => m.includes('conflict'))).toHaveLength(0);

      const replayed = await readAll(fresh, 's1');
      expect(replayed.map((e) => e.seq)).toEqual([1, 2]); // 坏行被跳过，长行完整
      expect(replayed[0]!.kind).toBe('tool');
      if (replayed[0]!.kind === 'tool') expect(replayed[0]!.payload.content).toBe(big);
    });
  }
});
