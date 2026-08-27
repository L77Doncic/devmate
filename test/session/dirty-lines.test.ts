import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonlFileAdapter } from '../../src/core/session/index.js';
import {
  cleanupTmpDirs,
  createTmpDir,
  event,
  readAll,
  toolResultPayload,
  userPayload,
  userText,
} from './support.js';

/**
 * 读入容错的完整性：事件行脏数据（非法 JSON / 合法 JSON 却非事件 / 未知 schema 版本 / seq 回退）
 * 一律跳过并告警，绝不因单行坏数据崩掉整个读取——合法事件全部保留。
 */
describe('读入容错（切片 f：脏数据行跳过 + 告警，不抛崩整个读取）', () => {
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

  it('中间行的非法 JSON（脏数据）被跳过，前后合法事件全部在', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('合法 1')));
    appendFileSync(join(dir, 's1.jsonl'), '这不是 JSON 的一行\n');
    await store.append('s1', event('user', userPayload('合法 2')));

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    expect(replayed.map((e) => userText(e))).toEqual(['合法 1', '合法 2']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('line 2');
  });

  it('合法 JSON 但结构不符（非事件对象）被跳过并告警', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('在')));
    appendFileSync(join(dir, 's1.jsonl'), '{"hello":"world"}\n');
    await store.append('s1', event('user', userPayload('也')));

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    expect(warnings).toHaveLength(1);
  });

  it('未知 schema 版本（v!=1）的行被视为脏数据跳过，同版本行照常读', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('v1 行')));
    appendFileSync(
      join(dir, 's1.jsonl'),
      '{"v":2,"seq":99,"ts":1,"kind":"user","payload":{"content":"未来版本"}}\n',
    );
    const replayed0 = await readAll(store, 's1');
    expect(replayed0.map((e) => e.seq)).toEqual([1]);
    expect(warnings).toHaveLength(1);
  });

  it('缺字段的 user 行（payload 无 content）按 kind 形状校验被拒，跳过并告警', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('真 1')));
    appendFileSync(
      join(dir, 's1.jsonl'),
      JSON.stringify({ v: 1, seq: 2, ts: 1, kind: 'user', payload: {} }) + '\n',
    );
    await store.append('s1', event('user', userPayload('真 2')));

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    expect(replayed.map((e) => userText(e))).toEqual(['真 1', '真 2']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('line 2');
  });

  it('缺字段的 tool 行（无 toolCallId）按 kind 形状校验被拒，跳过并告警', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('真 1')));
    appendFileSync(
      join(dir, 's1.jsonl'),
      JSON.stringify({ v: 1, seq: 2, ts: 1, kind: 'tool', payload: { content: '结果无归属' } }) +
        '\n',
    );
    await store.append('s1', event('tool', toolResultPayload('call_1', '真结果')));

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.kind)).toEqual(['user', 'tool']);
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('line 2');
  });

  it('assistant 行 payload.content 非 string 也被拒（与声明类型一致）', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('a')));
    appendFileSync(
      join(dir, 's1.jsonl'),
      JSON.stringify({ v: 1, seq: 2, ts: 1, kind: 'assistant', payload: { content: 42 } }) + '\n',
    );
    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('line 2');
  });

  it('seq 单调性被破坏（重复/回退）的行被跳过（幂等去重），其余照常', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('正常')));
    appendFileSync(
      join(dir, 's1.jsonl'),
      JSON.stringify({ v: 1, seq: 1, ts: 1, kind: 'user', payload: { content: '重复' } }) + '\n',
    );
    appendFileSync(
      join(dir, 's1.jsonl'),
      JSON.stringify({ v: 1, seq: 0, ts: 1, kind: 'user', payload: { content: '回退' } }) + '\n',
    );

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1]);
    expect(replayed.map((e) => userText(e))).toEqual(['正常']);
    expect(warnings.filter((m) => m.includes('line 2')).length).toBe(1);
    expect(warnings.filter((m) => m.includes('line 3')).length).toBe(1);
  });
});
