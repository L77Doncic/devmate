/**
 * # test/ui-server/static + heartbeat：静态资源（S12 g 档）与 SSE 心跳（h 档）
 *
 * g) GET / 与静态资源（staticRoot 注入；缺省 src/ui/web——S13 尚未放 index.html 时
 * 回退占位页）；只读本机 127.0.0.1。
 * h) 心跳：`: ping` 注释行按 heartbeatMs 定期下发（本测试用短超时/短间隔，不进事件流）。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { echoTool, FakeLlm } from '../loop/support.js';
import { SseClient, startServer } from './support.js';

const depsFor = (extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps => ({
  store: new MemorySessionAdapter(),
  tools: defineRegistry([echoTool()], { sessionId: 's1' }),
  llm: new FakeLlm([{ content: 'x' }]),
  model: 'test-model',
  ...extra,
});

describe('ui/server：静态资源与心跳', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('g1) GET / → 200（staticRoot/index.html 原样提供）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devmate-ui-web-'));
    tempDirs.push(root);
    await writeFile(join(root, 'index.html'), '<!doctype html><h1>devmate</h1>', 'utf8');
    await writeFile(join(root, 'app.js'), 'console.log(1)', 'utf8');

    const { base, server } = await startServer(depsFor({ staticRoot: root }));
    servers.push(server);

    const index = await fetch(new URL('/', base));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type') ?? '').toContain('text/html');
    expect(await index.text()).toContain('<h1>devmate</h1>');

    const js = await fetch(new URL('/app.js', base));
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type') ?? '').toContain('javascript');
    expect(await js.text()).toContain('console.log(1)');
  });

  it('g2) 缺省 staticRoot 时 GET / 仍 200（回退占位页；S13 之前的 MVP 行为）', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);
    const res = await fetch(new URL('/', base));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
  });

  it('g3) 越权路径（.. 逃逸）→ 4xx {error}；缺失资源 → 404 {error}', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);

    const escape = await fetch(new URL('/..%2fpackage.json', base));
    expect(escape.status).toBe(400);
    expect(((await escape.json()) as { error: string }).error).toBeTypeOf('string');

    const missing = await fetch(new URL('/nope.js', base));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBeTypeOf('string');
  });

  it('h1) 心跳：短间隔下 `: ping` 注释行定期到达且不进事件流（帧数恒 0）', async () => {
    const store = new MemorySessionAdapter();
    await store.create('hb-1');
    const { base, server } = await startServer(depsFor({ store, heartbeatMs: 25 }));
    servers.push(server);

    const client = await SseClient.connect(base, 'hb-1');
    clients.push(client);
    expect(client.frames).toHaveLength(0);
    expect(await client.next(600)).toBeNull(); // 无业务事件：心跳只是注释
    expect(client.pingCount).toBeGreaterThanOrEqual(2);
  });
});
