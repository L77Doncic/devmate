import { describe, expect, it } from 'vitest';

import {
  InvalidSessionIdError,
  MemorySessionAdapter,
  SessionExistsError,
  SessionNotFoundError,
} from '../../src/core/session/index.js';
import {
  assistantPayload,
  event,
  expectCallsPaired,
  readAll,
  toolResultPayload,
  userPayload,
  userText,
} from './support.js';

/**
 * 内存适配器：与文件适配器同接口（SessionStore），供后续模块复用与快速测试。
 * 语义对齐：create/errors/append seq 单调/顺序回放/fork 复制/repairOrphaned 幂等。
 */
describe('MemorySessionAdapter 接口一致性', () => {
  it('append 顺序回放与 seq 分配与文件适配器一致', async () => {
    const store = new MemorySessionAdapter();
    await store.create('m1');
    await store.append('m1', event('user', userPayload('a')));
    await store.append('m1', event('user', userPayload('b')));

    const replayed = await readAll(store, 'm1');
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    expect(replayed.map((e) => userText(e))).toEqual(['a', 'b']);
    for (const e of replayed) {
      expect(e.v).toBe(1);
      expect(typeof e.ts).toBe('number');
    }
  });

  it('错误语义一致：重复 create / 未知 id / 非法 id', async () => {
    const store = new MemorySessionAdapter();
    await store.create('m1');
    await expect(store.create('m1')).rejects.toBeInstanceOf(SessionExistsError);
    await expect(store.append('nope', event('user', userPayload('x')))).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    await expect(readAll(store, 'nope')).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(store.create('../evil')).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it('repairOrphaned 语义一致：补占位、已有结果不补、幂等', async () => {
    const store = new MemorySessionAdapter();
    await store.create('m1');
    await store.append(
      'm1',
      event('assistant', assistantPayload('x', [{ id: 'c1', name: 'a', arguments: '{}' }])),
    );
    await store.append('m1', event('tool', toolResultPayload('c1', 'ok')));
    await store.append(
      'm1',
      event('assistant', assistantPayload('y', [{ id: 'c2', name: 'b', arguments: '{}' }])),
    );

    const repaired = await store.repairOrphaned('m1');
    expect(repaired).toEqual(['c2']);
    expect(await store.repairOrphaned('m1')).toEqual([]);
    expectCallsPaired(await readAll(store, 'm1'));
  });

  it('fork 复制历史，两线独立推进', async () => {
    const store = new MemorySessionAdapter();
    await store.create('m1');
    await store.append('m1', event('user', userPayload('1')));
    await store.append('m1', event('user', userPayload('2')));
    await store.fork('m1', 'm1-fork');
    await store.append('m1', event('user', userPayload('原线')));
    await store.append('m1-fork', event('user', userPayload('新线')));

    const [src, fork] = [await readAll(store, 'm1'), await readAll(store, 'm1-fork')];
    expect(src.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(fork.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(src.map((e) => userText(e))).toEqual(['1', '2', '原线']);
    expect(fork.map((e) => userText(e))).toEqual(['1', '2', '新线']);
  });

  it('读出的事件是副本：外部改写读侧对象不污染存储', async () => {
    const store = new MemorySessionAdapter();
    await store.create('m1');
    await store.append('m1', event('user', userPayload('原始')));

    const [leaked] = await readAll(store, 'm1');
    expect(leaked).toBeDefined();
    if (leaked !== undefined && leaked.kind === 'user' && 'content' in leaked.payload) {
      leaked.payload.content = '被篡改';
    }
    const again = await readAll(store, 'm1');
    expect(again.map((e) => userText(e))).toEqual(['原始']);
  });

  it('append 存储 payload 副本：事后改动输入对象不污染存储', async () => {
    const store = new MemorySessionAdapter();
    await store.create('m1');
    const input = event('user', userPayload('原始'));
    await store.append('m1', input);
    input.payload.content = '外部事后篡改';

    const replayed = await readAll(store, 'm1');
    expect(replayed.map((e) => userText(e))).toEqual(['原始']);
  });

  it('exists/append/events 与文件适配器一样做 id 校验：非法 id 抛 InvalidSessionIdError', async () => {
    const store = new MemorySessionAdapter();
    for (const bad of ['../evil', 'a/b', '..']) {
      await expect(store.exists(bad)).rejects.toBeInstanceOf(InvalidSessionIdError);
      await expect(store.append(bad, event('user', userPayload('x')))).rejects.toBeInstanceOf(
        InvalidSessionIdError,
      );
      await expect(readAll(store, bad)).rejects.toBeInstanceOf(InvalidSessionIdError);
    }
    // 合法但未创建的 id 仍是 SessionNotFoundError。
    await expect(store.append('nope', event('user', userPayload('x')))).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });
});
