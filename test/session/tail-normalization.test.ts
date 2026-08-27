import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonlFileAdapter } from '../../src/core/session/index.js';
import { cleanupTmpDirs, createTmpDir, event, readAll, userPayload, userText } from './support.js';

/**
 * 写端尾部归一化（ADR-0004 崩溃残留处理条款）：「完整 JSON 尾行但无 \n」的尾巴状态——
 * 读端把该行判为合法事件（占用 seq），写端不得无差别按撕裂截除，而是先解析尾行：
 * 可解析为完整事件 → 补一个 '\n'（保留该事件，seq 不变）；不可解析（真正撕裂）→ 才截断。
 */
describe('写端尾部归一化（切片 g：完整 JSON 尾行无 \n → 保留并补 \n）', () => {
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

  it('可解析完整尾行（无 \n）：append 前补 \n，先前合法事件全部保留，新事件 seq 正确递增', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('第一条')));
    await store.append('s1', event('user', userPayload('第二条')));
    // 外部写入一条「完整合法事件、但缺换行」的尾行（崩溃时 write 恰好写完内容而未写 \n）。
    appendFileSync(
      join(dir, 's1.jsonl'),
      JSON.stringify({
        v: 1,
        seq: 3,
        ts: 1730000000000,
        kind: 'user',
        payload: { content: '完整尾行' },
      }),
    );

    // 模拟重启：新 store 实例继续 append。
    const restarted = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    const saved = await restarted.append('s1', event('user', userPayload('续写')));

    expect(saved.seq).toBe(4);
    const replayed = await readAll(restarted, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(replayed.map((e) => userText(e))).toEqual(['第一条', '第二条', '完整尾行', '续写']);
    // 归一化只补 \n：字节级上先前事件未被截断。清尾行被补上换行（而非删除）。
    const content = readFileSync(join(dir, 's1.jsonl'), 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    expect(content).not.toContain('\n\n'); // 补的是一个 \n，加上该行可独立解析
    expect(warnings).toHaveLength(0);
  });

  it('真正撕裂的尾行（不可解析）仍被截断——两种状态可区分', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('在')));
    appendFileSync(join(dir, 's1.jsonl'), '{"v":1,"seq":9,"ts":1,"kind":"user","pay');
    const restarted = new JsonlFileAdapter({ dir, warn: (m) => warnings.push(m) });
    const saved = await restarted.append('s1', event('user', userPayload('续')));
    expect(saved.seq).toBe(2);
    const replayed = await readAll(restarted, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    // 截断也通过告警通道可见（不是无声丢失事实）。
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('truncated');
  });
});
