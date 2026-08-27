import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  InvalidSessionIdError,
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
} from './support.js';

describe('JsonlFileAdapter 基本契约（切片 a：事件写入即行追加，读入顺序 = 写入顺序）', () => {
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

  it('create 后会话文件存在且为空', async () => {
    await store.create('s1');
    expect(readFileSync(join(dir, 's1.jsonl'), 'utf8')).toBe('');
    expect(await store.exists('s1')).toBe(true);
  });

  it('append 每次写一行合法 JSON，读入顺序 == 写入顺序', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('你好，DevMate')));
    const toolCall = { id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' };
    await store.append('s1', event('assistant', assistantPayload('我来看看', [toolCall])));
    await store.append('s1', event('tool', toolResultPayload('call_1', 'file contents')));

    const lines = readFileSync(join(dir, 's1.jsonl'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(replayed[0]?.payload).toEqual(userPayload('你好，DevMate'));
    expect(replayed[1]?.payload).toEqual(assistantPayload('我来看看', [toolCall]));
    expect(replayed[2]?.payload).toEqual(toolResultPayload('call_1', 'file contents'));
  });

  it('seq 从 1 严格自增，v=1，ts 为毫秒时间戳', async () => {
    await store.create('s1');
    const t0 = Date.now();
    await store.append('s1', event('user', userPayload('a')));
    await store.append('s1', event('user', userPayload('b')));
    // ts 由写端在 append 时刻分配，上界在两次 append 之后取样（避免毫秒边界竞态）。
    const t1 = Date.now();

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    for (const e of replayed) {
      expect(e.v).toBe(1);
      expect(typeof e.ts).toBe('number');
      expect(e.ts).toBeGreaterThanOrEqual(t0);
      expect(e.ts).toBeLessThanOrEqual(t1);
    }
  });

  it('append 返回落盘后的事件（含分配到的 seq 与 ts）', async () => {
    await store.create('s1');
    const saved = await store.append('s1', event('user', userPayload('hi')));
    expect(saved.kind).toBe('user');
    expect(saved.payload).toEqual(userPayload('hi'));
    expect(saved.seq).toBe(1);
    expect(saved.v).toBe(1);
    expect(typeof saved.ts).toBe('number');
  });

  it('events() 对空会话为空；对不存在的会话抛 SessionNotFoundError', async () => {
    await store.create('s1');
    expect(await readAll(store, 's1')).toEqual([]);
    await expect(store.append('missing', event('user', userPayload('x')))).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    await expect(readAll(store, 'missing')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('重复 create 抛 SessionExistsError；非法 id 抛 InvalidSessionIdError', async () => {
    await store.create('s1');
    await expect(store.create('s1')).rejects.toBeInstanceOf(SessionExistsError);
    for (const bad of ['../evil', 'a/b', '..', '.hidden', 'a b']) {
      await expect(store.create(bad)).rejects.toBeInstanceOf(InvalidSessionIdError);
    }
  });

  it('干净路径下零告警', async () => {
    await store.create('s1');
    await store.append('s1', event('user', userPayload('ok')));
    await readAll(store, 's1');
    expect(warnings).toEqual([]);
  });
});
