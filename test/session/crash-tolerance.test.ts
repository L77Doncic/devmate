import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonlFileAdapter } from '../../src/core/session/index.js';
import { cleanupTmpDirs, createTmpDir, event, readAll, userPayload, userText } from './support.js';

/**
 * 崩溃一致性：任意时刻崩溃后重读，文件只留下「可用占位符修补的缺口」。
 * 本切片验证 A/B/C 三形态中的 C 形态——文件尾的半行（无 \n 结尾的截断行）。
 */
describe('崩溃一致性（切片 c：文件尾半行 → 跳过 + 告警，合法事件全部在）', () => {
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

  it('追加一半后进程崩溃（写坏尾行）：读入忽略该行并告警，合法事件全部在', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('第一条')));
    await store.append('s1', event('user', userPayload('第二条')));

    // 模拟崩溃：写入一条真实事件行的前缀（写了一半、无 \n）。
    const tornPrefix = JSON.stringify({
      v: 1,
      seq: 3,
      ts: 1730000000000,
      kind: 'user',
      payload: { content: '断在这里' },
    }).slice(0, 37);
    appendFileSync(join(dir, 's1.jsonl'), tornPrefix);

    // 模拟重启：新 store 实例读同一文件。
    const restarted = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    const replayed = await readAll(restarted, 's1');

    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    expect(replayed.map((e) => userText(e))).toEqual(['第一条', '第二条']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('s1.jsonl');
    expect(warnings[0]).toContain('line 3');
  });

  it('半行不占 seq：崩溃后继续 append，seq 从最后一条合法事件续起', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('a')));
    await store.append('s1', event('user', userPayload('b')));
    appendFileSync(join(dir, 's1.jsonl'), '{"v":1,"seq":5,"ts":1730000000000,"kind":"user","pay');

    const restarted = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    const resumed = await restarted.append('s1', event('user', userPayload('c')));
    expect(resumed.seq).toBe(3);

    const replayed = await readAll(restarted, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(replayed.map((e) => userText(e))).toEqual(['a', 'b', 'c']);
    expect(warnings).toHaveLength(1);
  });

  it('崩溃后继续 append：坏尾行被截断，文件恢复为干净行流（新事件不粘连）', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('x')));
    appendFileSync(join(dir, 's1.jsonl'), '{"v":1,"seq":99,"ts":1');
    const restarted = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    await restarted.append('s1', event('user', userPayload('y')));

    const content = readFileSync(join(dir, 's1.jsonl'), 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    const again = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    const replayed = await readAll(again, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    expect(warnings).toHaveLength(1);
  });
});
