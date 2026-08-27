import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlFileAdapter, MemorySessionAdapter } from '../../src/core/session/index.js';
import { cleanupTmpDirs, createTmpDir, event, readAll, userPayload } from './support.js';

/**
 * EVENT_KINDS 表达力（CONTEXT「会话」词条：系统提示、推理、工具调用与结果、
 * 每一次上下文注入都逐事件追加）：user/assistant/tool/event 之外还必须有
 * system（系统提示注入）与 reasoning（推理内容）——否则会话事实源记不全。
 */
describe('EVENT_KINDS：system / reasoning 事件（切片 i）', () => {
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

  it('文件适配器：system/reasoning 事件合法读写（kind、seq、payload 保真）', async () => {
    await store.create('s1');
    await store.append('s1', event('system', { content: '项目说明注入' }));
    await store.append('s1', event('reasoning', { content: '先看历史再动手' }));
    await store.append('s1', event('user', userPayload('继续')));

    const replayed = await readAll(store, 's1');
    expect(replayed.map((e) => e.kind)).toEqual(['system', 'reasoning', 'user']);
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
    const system = replayed[0];
    if (system !== undefined && system.kind === 'system') {
      expect(system.payload.content).toBe('项目说明注入');
    } else {
      expect.unreachable('第一个事件应为 system');
    }
    const reasoning = replayed[1];
    if (reasoning !== undefined && reasoning.kind === 'reasoning') {
      expect(reasoning.payload.content).toBe('先看历史再动手');
    } else {
      expect.unreachable('第二个事件应为 reasoning');
    }
    expect(warnings).toHaveLength(0);
  });

  it('内存适配器：system/reasoning 事件同样合法读写', async () => {
    const mem = new MemorySessionAdapter();
    await mem.create('m1');
    await mem.append('m1', event('system', { content: '注入' }));
    await mem.append('m1', event('reasoning', { content: '推理' }));

    const replayed = await readAll(mem, 'm1');
    expect(replayed.map((e) => e.kind)).toEqual(['system', 'reasoning']);
    const system = replayed[0];
    if (system !== undefined && system.kind === 'system') {
      expect(system.payload.content).toBe('注入');
    }
    const reasoning = replayed[1];
    if (reasoning !== undefined && reasoning.kind === 'reasoning') {
      expect(reasoning.payload.content).toBe('推理');
    } else {
      expect.unreachable('第二个事件应为 reasoning');
    }
  });
});
