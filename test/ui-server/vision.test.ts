/**
 * # test/ui-server/vision：图像多模态全链（ADR-0015 · dsh 管线落地：内容寻址附件）
 *
 * 覆盖：POST /api/attachments 上传（dataURL → sha256 ref）→ /api/chat 带 refs →
 * 会话事件 payload.images slim（refs，dataURL 不进存储）⊣ session-user 回显帧（refs）
 * ⊣ 投影层经 attachmentResolver 展开为 dataURL（fake llm 收 ChatRequest 断言）
 * ⊣ 回放（GET /api/sessions/:id）同形；旧 dataURL 事件/上行向后兼容（legacy 形直通）；
 * 限额（20 图/消息 413、ref 非法 400、>20MiB 上传 413 带原因码）；ref 缺失 → 降级文本提示
 * （不 400）；DELETE /api/sessions 引用扫描联动删除（共享附件保留）。
 * 零密钥零外部网络：FakeLlm + MemorySessionAdapter + 真 AttachmentStore on tmp 目录。
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import { AttachmentStore } from '../../src/ui/server/attachments.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';
import type { TestServerHandle } from './support.js';

/** 8×8 红色三角 PNG（101 字节；sha256 = IMG_SHA）。 */
const IMAGE_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAALElEQVR4nGP4L6fxHx9m+A8CBBXgUYRQgEMRqgIsijAVoCnCrgBJEW4FUEUAbLnBIWag8SAAAAAASUVORK5CYII=';
const IMG_SHA = 'f0ffe716e4705c9f50a94c4a1c2ee180af2ad6261cd4e727f1a106787ba60d13';
const IMG_REF = `sha256/${IMG_SHA}.png`;
const DIMS = { width: 800, height: 600 };

function baseDeps(llm: FakeLlm, attachmentDir: string): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([echoTool()], { sessionId: 's1' }),
    llm,
    model: 'deepseek-v4-flash-vision-exp',
    settings: { baseUrl: 'https://api.example/v1', model: 'deepseek-v4-flash-vision-exp' },
    attachments: new AttachmentStore(attachmentDir),
  };
}

async function upload(base: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return postJson(base, '/api/attachments', {
    sessionId,
    dataUrl: IMAGE_DATAURL,
    ...DIMS,
    ...extra,
  });
}

describe('ui/server：图像多模态（ADR-0015 · 内容寻址附件管线）', () => {
  let dir: string;
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devmate-vision-'));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function boot(
    llm: FakeLlm,
    opts: { deps?: DevmateServerDeps; attachmentsDir?: string } = {},
  ): Promise<TestServerHandle> {
    const handle = await startServer(opts.deps ?? baseDeps(llm, opts.attachmentsDir ?? dir));
    servers.push(handle.server);
    return handle;
  }

  it('v1) 上传→refs 全链：事件 slim（refs）/回显 refs/投影展开 dataURL 达 LLM/回放 refs', async () => {
    const fake = new FakeLlm([
      {
        content: '图中的三角形',
        usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
      },
    ]);
    const deps = baseDeps(fake, dir);
    const { base, server } = await startServer(deps);
    servers.push(server);

    // ① POST /api/attachments：dataURL → sha256 ref（宽高回传）
    const up = await upload(base, 's-v1');
    expect(up.status).toBe(200);
    const uploaded = (await up.json()) as { ref: string; width: number; height: number };
    expect(uploaded).toEqual({ ref: IMG_REF, width: 800, height: 600 });

    // ② /api/chat 上行 refs（不再是 dataURL 大串）
    const res = await postJson(base, '/api/chat', {
      sessionId: 's-v1',
      text: '描述图片',
      images: [{ ref: IMG_REF, ...DIMS }],
    });
    expect(res.status).toBe(200);
    const client = await SseClient.connect(base, 's-v1');
    clients.push(client);
    await waitForFrames(client, 5, 10_000);

    // ③ 回显帧 slim：images = refs（协议新形状；绝不含 dataURL）
    const echo = client.frames[0]!.data as { text: string; images?: unknown[] };
    expect(echo.text).toBe('描述图片');
    expect(echo.images).toEqual([{ ref: IMG_REF, ...DIMS }]);

    // ④ fake llm 收展开后的 dataURL（attachmentResolver：读文件+dataURL 组装）——wire 仍 dataURL
    expect(fake.requests).toHaveLength(1);
    const firstUser = fake.requests[0]!.messages.find((m) => m.role === 'user');
    expect(
      (firstUser as unknown as { content: Array<Record<string, unknown>> }).content,
    ).toEqual([
      { type: 'text', text: '描述图片' },
      { type: 'image_url', image_url: { url: IMAGE_DATAURL }, ...DIMS },
    ]);

    // ⑤ 存储事件 payload.images = refs（会话文件不再膨胀——slim 落盘点）
    const events: Array<{ kind: string; payload: { content?: string; images?: unknown[] } }> = [];
    for await (const ev of deps.store.events('s-v1')) events.push(ev as never);
    expect(events.find((e) => e.kind === 'user')?.payload).toMatchObject({
      content: '描述图片',
      images: [{ ref: IMG_REF, ...DIMS }],
    });

    // ⑥ 回放（GET /api/sessions/:id）：session-user 帧 images = refs
    const replay = (await (await fetch(new URL('/api/sessions/s-v1', base))).json()) as {
      events?: Array<{ event: string; data: Record<string, unknown> }>;
    };
    expect((replay.events ?? []).find((e) => e.event === 'session-user')?.data.images).toEqual([
      { ref: IMG_REF, ...DIMS },
    ]);
  });

  it('v2) 纯图消息（text 空 + refs 非空）：200 放行；无文本无图 → 400；上传缺 sessionId → 400', async () => {
    const fake = new FakeLlm([
      { content: 'ok', usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } },
    ]);
    const { base } = await boot(fake);
    const ok = await postJson(base, '/api/chat', {
      sessionId: 's-v2',
      text: '',
      images: [{ ref: IMG_REF }],
    });
    expect(ok.status).toBe(200);
    const bad = await postJson(base, '/api/chat', { text: '   ', images: [] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('text');
    // 上传缺 sessionId → 400（单会话累计限额的记账键必须有）
    const noSid = await postJson(base, '/api/attachments', { dataUrl: IMAGE_DATAURL });
    expect(noSid.status).toBe(400);
  });

  it('v3) 限额/形状：21 张 → 413；单图 >20MiB 上传 → 413 带原因码；ref 非法/宽高非法 → 400', async () => {
    const fake = new FakeLlm([{ content: 'x' }]);
    const { base } = await boot(fake);

    // 每消息 20 图（dsh 上限）：21 → 413（count 超限先行）
    const count = await postJson(base, '/api/chat', {
      sessionId: 's-v3',
      text: 'a',
      images: Array.from({ length: 21 }, (_) => ({ ref: IMG_REF })),
    });
    expect(count.status).toBe(413);
    expect(((await count.json()) as { error: string }).error).toContain('at most 20');

    // 单图 20MiB 上限：+1 字节 → 413 attach-too-large（41 字节基准对 20MiB）
    const huge = Buffer.alloc(20 * 1024 * 1024 + 1, 0x41);
    const big = await postJson(base, '/api/attachments', {
      sessionId: 's-v3',
      dataUrl: `data:image/png;base64,${huge.toString('base64')}`,
      ...DIMS,
    });
    expect(big.status).toBe(413);
    const bigBody = (await big.json()) as { code: string };
    expect(bigBody.code).toBe('attach-too-large');

    // 形状校验
    for (const [body, name] of [
      [{ sessionId: 's-v3', text: 'a', images: [{ ref: 'sha256/abc.png' }] }, 'ref 非法'],
      [{ sessionId: 's-v3', text: 'a', images: [{ ref: IMG_REF, width: 0 }] }, '宽非法'],
      [{ sessionId: 's-v3', text: 'a', images: [{ url: 'https://example.com/x.png' }] }, '外部 URL'],
      [{ sessionId: 's-v3', text: 'a', images: [{ url: 'data:text/plain;base64,x' }] }, '非 image dataURL'],
    ] as const) {
      const res = await postJson(base, '/api/chat', body);
      expect(res.status, name).toBe(400);
    }
  });

  it('v4) 旧 dataURL 上行/事件向后兼容：url 形直通（存储/回显/LLM 三方同形）', async () => {
    const fake = new FakeLlm([
      { content: 'ok', usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } },
    ]);
    const { base } = await boot(fake);
    const res = await postJson(base, '/api/chat', {
      sessionId: 's-v4',
      text: '描述图片',
      images: [{ url: IMAGE_DATAURL, ...DIMS }],
    });
    expect(res.status).toBe(200);
    const client = await SseClient.connect(base, 's-v4');
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect((client.frames[0]!.data as { images: unknown[] }).images).toEqual([
      { url: IMAGE_DATAURL, ...DIMS },
    ]);
    const firstUser = fake.requests[0]!.messages.find((m) => m.role === 'user');
    expect(
      (firstUser as unknown as { content: Array<Record<string, unknown>> }).content,
    ).toEqual([
      { type: 'text', text: '描述图片' },
      { type: 'image_url', image_url: { url: IMAGE_DATAURL }, ...DIMS },
    ]);
  });

  it('v5) ref 缺失（附件被删）→ 降级文本提示（不 400）；LLM 只收文本', async () => {
    const fake = new FakeLlm([
      { content: 'x', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } },
    ]);
    const { base } = await boot(fake);
    const up = await upload(base, 's-v5');
    const uploaded = (await up.json()) as { ref: string };
    expect(uploaded.ref).toBe(IMG_REF);
    // 附件文件被删（模拟丢失/清理）→ 投影层 degrade 而非 400
    await rm(join(dir, `${IMG_SHA}.png`), { force: true });

    const res = await postJson(base, '/api/chat', {
      sessionId: 's-v5',
      text: '描述图片',
      images: [{ ref: IMG_REF, ...DIMS }],
    });
    expect(res.status).toBe(200);
    const client = await SseClient.connect(base, 's-v5');
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    const firstUser = fake.requests[0]!.messages.find((m) => m.role === 'user');
    // 图片全降级 → 消息回到纯文本字符串形（经典形态；文本含提示——诚实路径）
    const text = String((firstUser as unknown as { content: unknown }).content);
    expect(text).toContain('描述图片');
    expect(text).toContain('附件不存在');
    expect(text).toContain(IMG_REF);
    expect(text).not.toContain('data:image');
  });

  it('v6) 会话删除联动（引用扫描）：共享 ref 文件保留、唯一删除；manifest 清除', async () => {
    const fake = new FakeLlm([]);
    const { base } = await boot(fake);
    // 同一图片（同字节）上传给两个会话 → 全局一个文件
    for (const sid of ['s-share-a', 's-share-b']) {
      await upload(base, sid);
    }
    expect((await readdir(dir)).filter((f) => f.endsWith('.png'))).toHaveLength(1);
    // 会话必须存在于 store 才能 DELETE（MemorySessionAdapter 经 chat 创建）
    const created = await postJson(base, '/api/chat', { sessionId: 's-share-b', text: '任务' });
    expect(created.status).toBe(200);
    const clientB = await SseClient.connect(base, 's-share-b');
    clients.push(clientB);
    await waitForFrames(clientB, 5, 10_000);
    // 删 B：A 仍引用该文件 → 保留全局文件；manifest-B 清除
    const delB = await fetch(new URL('/api/sessions/s-share-b', base), { method: 'DELETE' });
    expect(delB.status).toBe(200);
    expect((await readdir(dir)).filter((f) => f.endsWith('.png'))).toHaveLength(1);
    expect((await readdir(dir)).some((f) => f.includes('s-share-b.manifest'))).toBe(false);
    // 删 A（会话不存在于 store → 404，但附件 manifest 仍在——DELETE 404 语义不变）
    const delAbsent = await fetch(new URL('/api/sessions/s-share-a', base), { method: 'DELETE' });
    expect(delAbsent.status).toBe(404);
    // 通过 chat 建 A 会话后删除 → 附件文件消亡
    await postJson(base, '/api/chat', { sessionId: 's-share-a', text: '任务' });
    const clientA = await SseClient.connect(base, 's-share-a');
    clients.push(clientA);
    await waitForFrames(clientA, 5, 10_000);
    const delA = await fetch(new URL('/api/sessions/s-share-a', base), { method: 'DELETE' });
    expect(delA.status).toBe(200);
    expect((await readdir(dir)).filter((f) => f.endsWith('.png'))).toHaveLength(0);
  });
});

