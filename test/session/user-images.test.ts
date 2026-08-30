/**
 * # test/session/user-images：用户消息 images（ADR-0015）存储面
 * - 合法形状（dataURL + 正整数宽高）append/read 保真；宽高可缺省；
 * - 非法形状（外部 URL / 宽高非法）读端按现有纪律视为坏行跳过
 *   （payloadShapeError 与 content 校验同一条纪律——不做特殊豁免）。
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlFileAdapter } from '../../src/core/session/index.js';
import { cleanupTmpDirs, createTmpDir, readAll } from './support.js';

describe('user 事件 images（ADR-0015）', () => {
  let dir: string;
  let store: JsonlFileAdapter;

  beforeEach(() => {
    dir = createTmpDir();
    store = new JsonlFileAdapter({ dir });
  });

  afterEach(() => {
    cleanupTmpDirs();
  });

  it('合法 images 形状：append/read 保真（dataURL + width/height）', async () => {
    await store.create('s1');
    const images = [{ url: 'data:image/png;base64,iVBORw0KGgo=', width: 800, height: 600 }];
    await store.append('s1', {
      kind: 'user',
      payload: { content: '看图', images },
    });
    const replayed = await readAll(store, 's1');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.payload).toEqual({ content: '看图', images });
  });

  it('宽高可缺省（只有 url）：合法（估算按上限档——渲染只需 dataURL）', async () => {
    await store.create('s2');
    await store.append('s2', {
      kind: 'user',
      payload: { content: '描述', images: [{ url: 'data:image/png;base64,x' }] },
    });
    const replayed = await readAll(store, 's2');
    expect(replayed[0]!.payload).toEqual({
      content: '描述',
      images: [{ url: 'data:image/png;base64,x' }],
    });
  });

  it('非法形状读端拒绝：外部 URL / 宽高 0 → 行被跳过（与 content 校验同纪律）', async () => {
    const dir2 = createTmpDir();
    const store2 = new JsonlFileAdapter({ dir: dir2, warn: () => {} });
    await store2.create('s3');
    appendFileSync(join(dir2, 's3.jsonl'), '\n');
    appendFileSync(
      join(dir2, 's3.jsonl'),
      JSON.stringify({
        v: 1,
        seq: 1,
        ts: 123,
        kind: 'user',
        payload: { content: 'a', images: [{ url: 'https://example.com/x.png' }] },
      }) + '\n',
    );
    appendFileSync(
      join(dir2, 's3.jsonl'),
      JSON.stringify({
        v: 1,
        seq: 2,
        ts: 123,
        kind: 'user',
        payload: { content: 'b', images: [{ url: 'data:image/png;base64,x', width: 0 }] },
      }) + '\n',
    );
    const replayed = await readAll(store2, 's3');
    expect(replayed).toHaveLength(0); // 坏行一律跳过（不作弊保留）
  });
});
