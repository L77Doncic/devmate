/**
 * # test/ui-server/attachments：内容寻址附件存储（dsh 管线落地，ADR-0015）
 *
 * 覆盖：dataURL/纯 base64+类型兼容 → sha256 内容寻址落盘（<dir>/<sha>.<ext>、目录 0700）→
 * ref 返回（sha256/<sha>.<ext>）→ resolve/raw 双向 → 限额矩阵（20MiB/单图、20/消息
 * （/api/chat 计数面见 vision.test）、200MiB/会话累计 → 413 原因码）→ 同内容去重
 * （全局一文件 + 会话 manifest 不重复计费）→ deleteSession 引用扫描删除（共享保留）。
 * 零密钥零外部网络：真 fs on tmp 目录。
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AttachmentStore,
  ATTACH_LIMITS,
  AttachmentStoreError,
  isAttachmentRef,
  refSha,
} from '../../src/ui/server/attachments.js';

/** 8×8 红色三角 PNG 的 base64（纯手造 101 字节 PNG — 零依赖 fixture；sha256 见底部常量）。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAALElEQVR4nGP4L6fxHx9m+A8CBBXgUYRQgEMRqgIsijAVoCnCrgBJEW4FUEUAbLnBIWag8SAAAAAASUVORK5CYII=';
const PNG_DATAURL = `data:image/png;base64,${PNG_BASE64}`;

/** 确定性 dataURL（内容寻址：同字节恒同 ref——测试可比对）。 */
function makeDataUrl(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

describe('attachments.ts：内容寻址附件存储（零依赖 fs 实现）', () => {
  let dir: string;
  let store: AttachmentStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devmate-attach-'));
    store = new AttachmentStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('接收 dataURL：sha256 内容寻址落盘 <sha>.<ext>，返回 ref；同内容重收去重（一文件）', async () => {
    const img = await store.receive({ sessionId: 's-a', dataUrl: PNG_DATAURL });
    expect(isAttachmentRef(img.ref)).toBe(true);
    expect(img.ref).toBe(`sha256/${IMG_SHA}.png`);
    expect(img.width).toBeUndefined();
    // 文件存在且内容字节 = 解码后字节（climb: dataURL 解码）
    const file = await readFile(join(dir, `${IMG_SHA}.png`));
    expect(file).toEqual(Buffer.from(PNG_BASE64, 'base64'));
    // 同内容（另一会话）→ 同一 ref，文件仍一个（全局去重）
    const img2 = await store.receive({ sessionId: 's-b', dataUrl: PNG_DATAURL });
    expect(img2.ref).toBe(img.ref);
    expect(await readdir(dir)).toContain(`${IMG_SHA}.png`);
    // 会话 manifest 按 ref 去重（字节不重复计费）
    const a = await store.refsOfSession('s-a');
    expect(a.refs).toEqual([img.ref]);
    expect(a.bytes).toBe(Buffer.from(PNG_BASE64, 'base64').length);
    await store.receive({ sessionId: 's-a', dataUrl: PNG_DATAURL });
    const a2 = await store.refsOfSession('s-a');
    expect(a2.refs).toEqual([img.ref]);
    expect(a2.bytes).toBe(a.bytes);
  });

  it('兼容纯 base64+类型：{data, mediaType:image/png} 同链（data:image/jpg 归一 .jpg）', async () => {
    const a = await store.receive({ sessionId: 's-a', data: PNG_BASE64, mediaType: 'image/png' });
    expect(a.ref).toBe(`sha256/${IMG_SHA}.png`);
    const jpegBody = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const j = await store.receive({
      sessionId: 's-a',
      data: jpegBody.toString('base64'),
      mediaType: 'image/jpeg',
    });
    expect(j.ref).toBe(`sha256/${refSha(j.ref)}.jpg`);
    // 非法 mediaType → 400 系错误（attach-invalid）
    await expect(
      store.receive({ sessionId: 's-a', data: 'AA==', mediaType: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'attach-invalid', status: 400 });
  });

  it('resolve/raw：还原 dataURL（读文件+组装）；篡改/未知 ref → null', async () => {
    const img = await store.receive({ sessionId: 's-a', dataUrl: PNG_DATAURL });
    expect(await store.resolve(img.ref)).toBe(PNG_DATAURL);
    const raw = await store.raw(img.ref);
    expect(raw?.mediaType).toBe('image/png');
    expect(raw?.bytes).toEqual(Buffer.from(PNG_BASE64, 'base64'));
    // 未知 ref → null（不抛；请求侧降级路径依据）
    expect(await store.resolve('sha256/' + '0'.repeat(64) + '.png')).toBeNull();
    expect(await store.raw('sha256/' + '0'.repeat(64) + '.png')).toBeNull();
    // 篡改文件（内容与 ref 不符）→ resolve 拒绝（内容寻址自校验）
    await writeFile(join(dir, `${IMG_SHA}.png`), Buffer.from('tampered'));
    expect(await store.resolve(img.ref)).toBeNull();
  });

  it('限额矩阵：单图 >20MiB → 413 attach-too-large；会话累计 >200MiB（注入小限额）→ 413 原因码', async () => {
    const big = Buffer.alloc(ATTACH_LIMITS.maxImageBytes + 1, 0x41);
    await expect(
      store.receive({ sessionId: 's-a', dataUrl: makeDataUrl(big) }),
    ).rejects.toMatchObject({ code: 'attach-too-large', status: 413 });
    // 20MiB 整正好通过（边界）
    const exact = await store.receive({
      sessionId: 's-a',
      dataUrl: makeDataUrl(Buffer.alloc(ATTACH_LIMITS.maxImageBytes, 0x41)),
    });
    expect(isAttachmentRef(exact.ref)).toBe(true);
  });

  it('会话累计限额（注入 maxSessionBytes）：超支 → 413 attach-session-quota；不同会话独立记账', async () => {
    const small = new AttachmentStore(dir, { maxSessionBytes: 200 });
    await small.receive({ sessionId: 's-q', dataUrl: makeDataUrl(Buffer.alloc(150, 0x41)) });
    await expect(
      small.receive({ sessionId: 's-q', dataUrl: makeDataUrl(Buffer.alloc(60, 0x41)) }),
    ).rejects.toMatchObject({ code: 'attach-session-quota', status: 413 });
    // 另一会话不受之（独立累计）
    await small.receive({ sessionId: 's-r', dataUrl: makeDataUrl(Buffer.alloc(60, 0x41)) });
    const r = await small.refsOfSession('s-r');
    expect(r.bytes).toBe(60);
  });

  it('目录 0700 + 文件 0600（服务端附件文件与会话同隐私面）', async () => {
    await store.receive({ sessionId: 's-a', dataUrl: PNG_DATAURL });
    const dirMode = (await stat(dir)).mode & 0o777;
    expect(dirMode & 0o077).toBe(0);
    const fileMode = (await stat(join(dir, `${IMG_SHA}.png`))).mode & 0o777;
    expect(fileMode & 0o077).toBe(0); // 0600 或更严（000 系亦兼容）
  });

  it('deleteSession 引用扫描：共享 ref 保留、唯一删除、manifest 清除', async () => {
    const img = await store.receive({ sessionId: 's-a', dataUrl: PNG_DATAURL });
    const only = await store.receive({
      sessionId: 's-b',
      dataUrl: makeDataUrl(Buffer.from('only-in-b', 'utf8')),
    });
    // 全局文件：2 个
    expect((await readdir(dir)).filter((f) => f.endsWith('.png'))).toHaveLength(2);
    const removedB = await store.deleteSession('s-b');
    expect(removedB).toBe(1); // only-in-b 无其它会话引用 → 删除
    expect(await store.resolve(img.ref)).toBe(PNG_DATAURL); // s-a 仍引用 → 保留
    expect(await store.resolve(only.ref)).toBeNull();
    const refsA = await store.refsOfSession('s-a');
    expect(refsA.refs).toEqual([img.ref]);
    // 再删 s-a → 文件亦删（dir 无附件文件、无 manifest）
    await store.deleteSession('s-a');
    expect((await readdir(dir)).filter((f) => f.endsWith('.png'))).toHaveLength(0);
  });

  it('删除幂等：不存在会话 deleteSession → 0；空会话 refsOfSession → 空', async () => {
    expect(await store.deleteSession('s-none')).toBe(0);
    expect(await store.refsOfSession('s-none')).toEqual({ bytes: 0, refs: [] });
    // 非 413 错误类型映射供路由层（HttpError shape）
    try {
      await store.receive({ sessionId: 's-a', dataUrl: makeDataUrl(Buffer.alloc(30 * 1024 * 1024)) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentStoreError);
      expect(err).toMatchObject({ code: 'attach-too-large', status: 413 });
    }
  });

  it('ref 解析：isAttachmentRef/refSha 纯函数（非法形态拒绝）', () => {
    expect(isAttachmentRef(`sha256/${IMG_SHA}.png`)).toBe(true);
    expect(isAttachmentRef('sha256/abc.png')).toBe(false); // 非 64 hex
    expect(isAttachmentRef(`sha256/${IMG_SHA}`)).toBe(false); // 缺 ext
    expect(isAttachmentRef(`sha256/${IMG_SHA}.svg`)).toBe(false); // 非白名单 ext
    expect(isAttachmentRef('/etc/passwd')).toBe(false);
    expect(isAttachmentRef('sha256/../../evil.png')).toBe(false);
    expect(refSha(`sha256/${IMG_SHA}.png`)).toBe(IMG_SHA);
    expect(refSha('nope')).toBeNull();
  });
});

/** 8×8 红色三角 PNG 的 sha256（内容寻址 ref 的确定性值；与 101 字节 PNG 对应）。 */
const IMG_SHA = 'f0ffe716e4705c9f50a94c4a1c2ee180af2ad6261cd4e727f1a106787ba60d13';
