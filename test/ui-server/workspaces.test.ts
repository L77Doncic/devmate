/**
 * # test/ui-server/workspaces：多工作区（dsh 语义）——注册表 / browse / 会话级根 / per-session 工具隔离
 *
 * 契约（任务书 §多工作区）：
 * - 注册表：GET /api/workspaces → {roots: string[]}（缺省 [workspaceRoot]；去重保序）；
 *   POST /api/workspaces {path} → 校验（绝对/存在/目录/realpath 归一/可读）→ 注册+持久化（无
 *   回调仅内存）→ {roots}；DELETE /api/workspaces/:encodedRoot → 移除+持久化；默认根不可删（400）；
 *   GET /api/workspaces/browse?path= → {base, dirs:[{name,path}]}（排序；深层错误 {dirs:[]}；
 *   缺省 os.homedir()；纯展示）。
 * - 会话级根：POST /api/sessions|chat 首建携带 workspaceRoot（须 ∈ 注册表，否则 400
 *   workspace-not-registered）→ 会话 meta 落该根；resume 忽略参数；缺省 deps.workspaceRoot。
 * - per-session 工具面：createSessionTools 按会话解析根（workspaceRootOf：meta 或默认根，
 *   缓存）→ createJail(canonicalRoot) + createPersistentShell(canonicalRoot) 同源；旧会话
 *   无 meta → 默认根（迁移）。
 */
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJail } from '../../src/core/jail/index.js';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { LlmAdapter, ToolRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { ChatRequest, StreamEvent } from '../../src/shared/llm-types.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { createSessionToolsFactory } from '../../src/ui/server/deps.js';
import { sessionWorkspaceOf } from '../../src/ui/server/emit.js';
import { FakeLlm } from '../loop/support.js';
import { canonicalTmpBase, shellCwdForm } from '../shell-tools/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

function depsFor(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'ok' }]),
    model: 'test-model',
    ...extra,
  };
}

/** 按「首个 user 消息（=任务文本）」路由到不同 FakeLlm：两会话并行 run 互不共享脚本序。 */
class RoutingLlm implements LlmAdapter {
  constructor(private readonly routes: Map<string, FakeLlm>) {}

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const first = request.messages.find((m) => m.role === 'user');
    const key = first !== undefined && first.role === 'user' ? first.content : '';
    const fake = this.routes.get(key);
    if (fake === undefined) {
      throw new Error(`RoutingLlm: no route for ${JSON.stringify(key)}`);
    }
    yield* fake.chat(request, signal);
  }
}

/** 从会话事件流读首条 session-workspace meta（workspaceRootOf 的测试实现；无 meta → 默认根）。 */
function metaRootReader(store: MemorySessionAdapter, defaultRoot: string) {
  const cache = new Map<string, string>();
  return async (sessionId: string): Promise<string> => {
    const cached = cache.get(sessionId);
    if (cached !== undefined) return cached;
    let root = defaultRoot;
    try {
      for await (const ev of store.events(sessionId)) {
        const ws = sessionWorkspaceOf(ev);
        if (ws !== null) {
          root = ws;
          break;
        }
      }
    } catch {
      // 会话不存在等 → 默认根（与 deps 装配同口径）
    }
    cache.set(sessionId, root);
    return root;
  };
}

// ---------------------------------------------------------------------------
// 注册表（GET/POST/DELETE /api/workspaces）
// ---------------------------------------------------------------------------

describe('ui/server：工作区注册表', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-ws-reg-'));
    tempDirs.push(dir);
    return dir;
  }

  it('r1) 缺省注册表 = [默认根]：GET {roots} 保序去重；deps 注入 workspaces → 原样读回', async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const { base, server } = await startServer(
      depsFor({ workspaceRoot: dirA, workspaces: [dirA, dirB, dirA] }),
    );
    servers.push(server);
    const body = (await (await fetch(new URL('/api/workspaces', base))).json()) as {
      roots: string[];
    };
    expect(body.roots).toEqual([dirA, dirB]); // 注入去重保序
    await server.close();

    const second = await startServer(depsFor({ workspaceRoot: dirA }));
    servers.push(second.server);
    const def = (await (await fetch(new URL('/api/workspaces', second.base))).json()) as {
      roots: string[];
    };
    expect(def.roots).toEqual([dirA]); // 欠省 [workspaceRoot]
  });

  it('r2) POST 注册：realpath 归一 + 去重保序 + 持久化回调收到全量快照；重复 POST 幂等', async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const saved: string[][] = [];
    const { base, server } = await startServer(
      depsFor({
        workspaceRoot: dirA,
        workspaces: [dirA],
        saveWorkspaces: (roots) => {
          saved.push([...roots]);
        },
      }),
    );
    servers.push(server);

    const add = await postJson(base, '/api/workspaces', { path: dirB });
    expect(add.status).toBe(200);
    const body = (await add.json()) as { roots: string[] };
    expect(body.roots).toEqual([dirA, dirB]);
    expect(saved).toEqual([[dirA, dirB]]); // 持久化回调：变更后全量快照

    // 重复注册：幂等（去重，顺序不变，不再触发回调）
    const again = await postJson(base, '/api/workspaces', { path: dirB });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { roots: string[] }).roots).toEqual([dirA, dirB]);
    expect(saved).toHaveLength(1);

    // realpath 归一：软链字面注册 → 注册表存 canonical（真实目录）
    const real = join(dirA, 'real-ws');
    const link = join(dirA, 'link-ws');
    await mkdir(real, { recursive: true });
    await symlink(real, link);
    const addLink = await postJson(base, '/api/workspaces', { path: link });
    expect(addLink.status).toBe(200);
    expect(((await addLink.json()) as { roots: string[] }).roots).toEqual([dirA, dirB, real]);
    expect(saved.at(-1)).toEqual([dirA, dirB, real]);
  });

  it('r3) POST 路径校验 400（带原因）：相对路径 / 不存在 / 是文件 / 文件下子路径（不可解）/ 缺 path', async () => {
    const dirA = await tempDir();
    const filePath = join(dirA, 'f.txt');
    await writeFile(filePath, 'x');
    const { base, server } = await startServer(depsFor({ workspaceRoot: dirA }));
    servers.push(server);

    const cases: Array<{ path?: unknown; reason?: string }> = [
      { path: 'relative/dir', reason: 'workspace path must be absolute' },
      { path: join(dirA, 'missing-dir'), reason: 'workspace path is not accessible' },
      { path: filePath, reason: 'workspace path must be a directory' },
      { path: join(filePath, 'sub'), reason: 'workspace path is not accessible' },
      { reason: 'path is required' },
    ];
    for (const c of cases) {
      const res = await postJson(
        base,
        '/api/workspaces',
        c.path !== undefined ? { path: c.path } : {},
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(c.reason!);
    }
    // 200 后注册表未变化
    const list = (await (await fetch(new URL('/api/workspaces', base))).json()) as {
      roots: string[];
    };
    expect(list.roots).toEqual([dirA]);
  });

  it('r4) DELETE：移除 + 持久化全量快照；未注册根 404；当前默认根不可删 400（字面与 canonical 双检）', async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const saved: string[][] = [];
    const { base, server } = await startServer(
      depsFor({
        workspaceRoot: dirA,
        workspaces: [dirA, dirB],
        saveWorkspaces: (roots) => {
          saved.push([...roots]);
        },
      }),
    );
    servers.push(server);

    // 默认根（字面）不可删
    const rmDefault = await fetch(new URL(`/api/workspaces/${encodeURIComponent(dirA)}`, base), {
      method: 'DELETE',
    });
    expect(rmDefault.status).toBe(400);
    expect(((await rmDefault.json()) as { error: string }).error).toContain(
      'default workspace root',
    );
    // 默认根（canonical 写法，同一目录）同样不可删
    const rmCanonical = await fetch(
      new URL(`/api/workspaces/${encodeURIComponent(await realpath(dirA))}`, base),
      { method: 'DELETE' },
    );
    expect(rmCanonical.status).toBe(400);

    // 未注册根 → 404
    const rmMissing = await fetch(
      new URL(`/api/workspaces/${encodeURIComponent('/tmp/not-registered-xyz')}`, base),
      { method: 'DELETE' },
    );
    expect(rmMissing.status).toBe(404);

    // 一个会话先指向 dirB（注册时允许）；删除注册表条目后会话必须保留（指向允许——留存）
    const sessionRes = await postJson(base, '/api/sessions', {
      workspaceRoot: dirB,
      text: 'in B',
    });
    expect(sessionRes.status).toBe(200);
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    // 正常删除：dirB 移除（保序）+ 回调快照
    const rmB = await fetch(new URL(`/api/workspaces/${encodeURIComponent(dirB)}`, base), {
      method: 'DELETE',
    });
    expect(rmB.status).toBe(200);
    expect(((await rmB.json()) as { roots: string[] }).roots).toEqual([dirA]);
    expect(saved).toEqual([[dirA]]);
    const list = (await (await fetch(new URL('/api/workspaces', base))).json()) as {
      roots: string[];
    };
    expect(list.roots).toEqual([dirA]);

    // 会话文件/详情保留（workspaceRoot 归属不因注册表删除漂移）
    const detail = (await (await fetch(new URL(`/api/sessions/${sessionId}`, base))).json()) as {
      workspaceRoot: string;
    };
    expect(detail.workspaceRoot).toBe(dirB);
  });
});

// ---------------------------------------------------------------------------
// browse（GET /api/workspaces/browse）
// ---------------------------------------------------------------------------

describe('ui/server：/api/workspaces/browse', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('b1) 缺省 base = os.homedir()；dirs 列表：仅目录、按名字节序、path = join(base, name)', async () => {
    const { base, server } = await startServer(depsFor({ workspaceRoot: homedir() }));
    servers.push(server);
    const body = (await (await fetch(new URL('/api/workspaces/browse', base))).json()) as {
      base: string;
      dirs: Array<{ name: string; path: string }>;
    };
    expect(body.base).toBe(homedir());
    expect(Array.isArray(body.dirs)).toBe(true);
    for (let i = 1; i < body.dirs.length; i += 1) {
      expect(body.dirs[i - 1]!.name < body.dirs[i]!.name).toBe(true);
    }
    for (const d of body.dirs) {
      expect(d.path).toBe(join(body.base, d.name));
      expect(d.name).not.toContain('/');
    }
  });

  it('b2) 列表排序 + 只列目录（文件不列）——临时目录子 d/../a/b/c 断言字节序', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-ws-browse-'));
    tempDirs.push(dir);
    for (const name of ['b-dir', 'A-dir', 'c-dir']) await mkdir(join(dir, name));
    await writeFile(join(dir, 'x-file.txt'), 'x');
    const { base, server } = await startServer(depsFor({ workspaceRoot: dir }));
    servers.push(server);

    const url = new URL('/api/workspaces/browse', base);
    url.searchParams.set('path', dir);
    const body = (await (await fetch(url)).json()) as {
      base: string;
      dirs: Array<{ name: string; path: string }>;
    };
    expect(body.base).toBe(dir);
    expect(body.dirs.map((d) => d.name)).toEqual(['A-dir', 'b-dir', 'c-dir']); // 字节序；文件不列
    expect(body.dirs.map((d) => d.path)).toEqual(
      ['A-dir', 'b-dir', 'c-dir'].map((n) => join(dir, n)),
    );
  });

  it('b3) 深层错误（不存在的目录）→ 200 {base, dirs: []}；file 作 path → {dirs: []}；只展示不写文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-ws-browse-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'f.txt'), 'keep');
    const { base, server } = await startServer(depsFor({ workspaceRoot: dir }));
    servers.push(server);

    const missing = new URL('/api/workspaces/browse', base);
    missing.searchParams.set('path', join(dir, 'nope'));
    const missBody = (await (await fetch(missing)).json()) as { base: string; dirs: unknown[] };
    expect(missBody.dirs).toEqual([]);

    const file = new URL('/api/workspaces/browse', base);
    file.searchParams.set('path', join(dir, 'f.txt'));
    expect(((await (await fetch(file)).json()) as { dirs: unknown[] }).dirs).toEqual([]);

    // 纯展示：browse 不产生任何写入（文件内容/再读不变）
    const after = await stat(join(dir, 'f.txt'));
    expect(after.size).toBe(4);
  });

  it('b4) 路径标准化：相对路径按 homedir 解析、`..` 折叠、返回标准化 base（纯展示，不改文件）', async () => {
    const home = homedir();
    const dir = await mkdtemp(join(tmpdir(), 'devmate-ws-browse-'));
    tempDirs.push(dir);
    const sub = join(dir, 'sub');
    await mkdir(sub);
    const { base, server } = await startServer(depsFor({ workspaceRoot: home }));
    servers.push(server);

    // 相对路径（'.' + '..' 折叠）→ base 标准化
    const rel = new URL('/api/workspaces/browse', base);
    rel.searchParams.set('path', './.');
    const relBody = (await (await fetch(rel)).json()) as { base: string };
    expect(relBody.base).toBe(home);

    const dotdot = new URL('/api/workspaces/browse', base);
    dotdot.searchParams.set('path', join(dir, 'sub', '..'));
    const ddBody = (await (await fetch(dotdot)).json()) as {
      base: string;
      dirs: Array<{ name: string }>;
    };
    expect(ddBody.base).toBe(dir); // `sub/..` 折叠回 dir
    expect(ddBody.dirs.map((d) => d.name)).toContain('sub');
  });
});

// ---------------------------------------------------------------------------
// 会话级根（POST /api/sessions | /api/chat 的 workspaceRoot 参数）
// ---------------------------------------------------------------------------

describe('ui/server：会话级根（workspaceRoot 参数）', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-ws-sess-'));
    tempDirs.push(dir);
    return dir;
  }

  async function workspaceEventsOf(
    store: MemorySessionAdapter,
    sessionId: string,
  ): Promise<string[]> {
    const roots: string[] = [];
    for await (const ev of store.events(sessionId)) {
      const ws = sessionWorkspaceOf(ev);
      if (ws !== null) roots.push(ws);
    }
    return roots;
  }

  it('s1) 首建携带注册根（workspaces=[A,B]）→ 200 + 会话 meta 落该根（详情/事件流一致）', async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(
      depsFor({ store, workspaceRoot: dirA, workspaces: [dirA, dirB] }),
    );
    servers.push(server);

    const res = await postJson(base, '/api/sessions', { workspaceRoot: dirB, text: 'in B' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(await workspaceEventsOf(store, sessionId)).toEqual([dirB]);
    const detail = (await (await fetch(new URL(`/api/sessions/${sessionId}`, base))).json()) as {
      workspaceRoot: string;
    };
    expect(detail.workspaceRoot).toBe(dirB);
  });

  it('s2) 未注册根：POST /api/sessions 与 POST /api/chat 首建均 400 workspace-not-registered', async () => {
    const dirA = await tempDir();
    const dirC = await tempDir();
    const { base, server } = await startServer(
      depsFor({ workspaceRoot: dirA, workspaces: [dirA] }),
    );
    servers.push(server);

    const viaSessions = await postJson(base, '/api/sessions', { workspaceRoot: dirC });
    expect(viaSessions.status).toBe(400);
    expect(((await viaSessions.json()) as { error: string }).error).toBe(
      'workspace-not-registered',
    );

    const viaChat = await postJson(base, '/api/chat', { text: 'x', workspaceRoot: dirC });
    expect(viaChat.status).toBe(400);
    expect(((await viaChat.json()) as { error: string }).error).toBe('workspace-not-registered');

    // 注册表未被污染
    const list = (await (await fetch(new URL('/api/workspaces', base))).json()) as {
      roots: string[];
    };
    expect(list.roots).toEqual([dirA]);
  });

  it('s3) resume 忽略参数（会话已有 meta；即使参数未注册也 200）；meta 不变', async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const dirC = await tempDir();
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(
      depsFor({ store, workspaceRoot: dirA, workspaces: [dirA, dirB] }),
    );
    servers.push(server);

    const created = (await (
      await postJson(base, '/api/chat', { text: 'first', workspaceRoot: dirB })
    ).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    await waitForFrames(client, 5, 10_000);
    client.close();

    // resume：workspaceRoot=dirB（注册）→ 忽略；meta 仍 dirB
    await postJson(base, '/api/chat', {
      sessionId: created.sessionId,
      text: 'second',
      workspaceRoot: dirB,
    });
    // resume：workspaceRoot=dirC（未注册）→ 忽略（仍 200）
    const resumeUnregistered = await postJson(base, '/api/chat', {
      sessionId: created.sessionId,
      text: 'third',
      workspaceRoot: dirC,
    });
    expect(resumeUnregistered.status).toBe(200);
    expect(await workspaceEventsOf(store, created.sessionId)).toEqual([dirB]);
  });

  it('s4) 缺省（不带参数）→ meta = deps.workspaceRoot（默认根）', async () => {
    const dirA = await tempDir();
    const store = new MemorySessionAdapter();
    const { base, server } = await startServer(depsFor({ store, workspaceRoot: dirA }));
    servers.push(server);

    const res = await postJson(base, '/api/sessions', { text: 'default root' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(await workspaceEventsOf(store, sessionId)).toEqual([dirA]);
  });
});

// ---------------------------------------------------------------------------
// per-session 工具面（factory 级：jail 与 shell 同源 per 会话）
// ---------------------------------------------------------------------------

describe('ui/server/deps：per-session 根工具面（createSessionToolsFactory + workspaceRootOf）', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(canonicalTmpBase(), 'devmate-ws-per-'));
    tempDirs.push(dir);
    return dir;
  }

  it('t1) jail per 会话：指定根会话界内读/写放行；跨界（兄弟根文件）拒绝 path-outside-workspace；未指定根会话用默认根', async () => {
    const rootA = await tempDir();
    const rootB = await tempDir();
    await writeFile(join(rootB, 'shared.txt'), 'in B');
    await writeFile(join(rootA, 'mine.txt'), 'in A');
    const store = new MemorySessionAdapter();
    // 会话事实源：s-a 落根 A、s-b 落根 B（与会话首建语义一致）；s-legacy 无 meta
    for (const [id, root] of [
      ['s-a', rootA],
      ['s-b', rootB],
    ] as const) {
      await store.create(id);
      await store.append(id, {
        kind: 'event',
        payload: { type: 'session-workspace', data: { workspaceRoot: root } },
      });
    }
    await store.create('s-legacy');
    const jailA = await createJail({ workspaceRoot: rootA });
    const factory = createSessionToolsFactory({
      workspaceRoot: rootA,
      jail: jailA,
      workspaceRootOf: metaRootReader(store, rootA),
    });

    // 会话 A：meta = rootA
    const regA: ToolRegistry = await factory.createSessionTools('s-a');
    const readOwn = await regA.execute({
      id: 'ra1',
      name: 'read_file',
      arguments: JSON.stringify({ path: join(rootA, 'mine.txt') }),
    });
    expect(readOwn.ok).toBe(true);
    expect(readOwn.content).toBe('in A');
    // 会话 A 读 B 根文件（界外：B 根未登记在 A 的 jail）→ 拒绝
    const readB = await regA.execute({
      id: 'ra2',
      name: 'read_file',
      arguments: JSON.stringify({ path: join(rootB, 'shared.txt') }),
    });
    expect(readB.ok).toBe(false);
    expect(readB.content).toContain('path-outside-workspace');
    // 会话 A 写 B 根文件（写面同拒）
    const writeB = await regA.execute({
      id: 'ra3',
      name: 'write_file',
      arguments: JSON.stringify({ path: join(rootB, 'made-by-A.txt'), content: 'x' }),
    });
    expect(writeB.ok).toBe(false);
    expect(writeB.content).toContain('path-outside-workspace');

    // 会话 B：meta = rootB → B 的 jail 以 B 为界：读自己的共享文件放行；写 A 根拒
    const regB: ToolRegistry = await factory.createSessionTools('s-b');
    const readOwnB = await regB.execute({
      id: 'rb1',
      name: 'read_file',
      arguments: JSON.stringify({ path: join(rootB, 'shared.txt') }),
    });
    expect(readOwnB.ok).toBe(true);
    const writeA = await regB.execute({
      id: 'rb2',
      name: 'write_file',
      arguments: JSON.stringify({ path: join(rootA, 'mine.txt'), content: 'x' }),
    });
    expect(writeA.ok).toBe(false);
    expect(writeA.content).toContain('path-outside-workspace');

    // 未指定（无 meta）会话 → 默认根（rootA 内可读，rootB 拒）
    const regDefault = await factory.createSessionTools('s-legacy');
    const readDefault = await regDefault.execute({
      id: 'rl1',
      name: 'read_file',
      arguments: JSON.stringify({ path: join(rootA, 'mine.txt') }),
    });
    expect(readDefault.ok).toBe(true);
    const readDefaultB = await regDefault.execute({
      id: 'rl2',
      name: 'read_file',
      arguments: JSON.stringify({ path: join(rootB, 'shared.txt') }),
    });
    expect(readDefaultB.ok).toBe(false);
    await factory.dispose();
  });

  it('t2) 缓存：workspaceRootOf 每会话只读一次 meta（缓存 per 会话）；同一会话两次 createSessionTools 同实例', async () => {
    const rootA = await tempDir();
    const rootB = await tempDir();
    await writeFile(join(rootB, 'b.txt'), 'B');
    const store = new MemorySessionAdapter();
    let reads = 0;
    const spyRootOf = async (sessionId: string): Promise<string> => {
      reads += 1;
      return metaRootReader(store, rootA)(sessionId);
    };
    const jailA = await createJail({ workspaceRoot: rootA });
    const factory = createSessionToolsFactory({
      workspaceRoot: rootA,
      jail: jailA,
      workspaceRootOf: spyRootOf,
    });

    const r1 = await factory.createSessionTools('s-c');
    const r2 = await factory.createSessionTools('s-c');
    expect(r1).toBe(r2); // 同会话恒同 registry
    expect(reads).toBe(1); // 根解析按会话缓存

    await factory.disposeSession('s-c');
    const r3 = await factory.createSessionTools('s-c');
    expect(r3).not.toBe(r1); // dispose 后重建（干净重启）
    await factory.dispose();
  });
});

// ---------------------------------------------------------------------------
// E2E：会话根贯穿（HTTP 全链：pwd 断言 + A/B 工具隔离）
// ---------------------------------------------------------------------------

describe('ui/server：多工作区 E2E（会话根贯穿全链）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });

  it('e1) per-session shell cwd = 会话根（pwd 真相断言 A 与 B 各自根，互不渗透）', async () => {
    const rootA = await mkdtemp(join(canonicalTmpBase(), 'devmate-e2e-fs-'));
    const rootB = await mkdtemp(join(canonicalTmpBase(), 'devmate-e2e-fs-'));
    tempDirs.push(rootA, rootB);
    const store = new MemorySessionAdapter();
    const jailA = await createJail({ workspaceRoot: rootA });
    const factory = createSessionToolsFactory({
      workspaceRoot: rootA,
      jail: jailA,
      workspaceRootOf: metaRootReader(store, rootA),
      shellPlatform: 'posix',
    });

    const CALL_A = {
      id: 'call-pwd-a',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'pwd' }),
    };
    const CALL_B = {
      id: 'call-pwd-b',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'pwd' }),
    };
    const routes = new Map<string, FakeLlm>([
      ['en-a', new FakeLlm([{ content: 'go', toolCalls: [CALL_A] }, { content: 'a end' }])],
      ['en-b', new FakeLlm([{ content: 'go', toolCalls: [CALL_B] }, { content: 'b end' }])],
    ]);
    const { base, server } = await startServer({
      store,
      tools: defineRegistry([], { sessionId: 'e2e-unused' }),
      llm: new RoutingLlm(routes),
      model: 'test-model',
      workspaceRoot: rootA,
      workspaces: [rootA, rootB],
      approvalPolicy: () => false,
      settings: { reviewMode: false },
      createSessionTools: factory.createSessionTools,
      dispose: () => factory.dispose(),
    });
    servers.push(server);

    const bodyA = (await (
      await postJson(base, '/api/chat', { text: 'en-a', workspaceRoot: rootA })
    ).json()) as {
      sessionId: string;
    };
    const bodyB = (await (
      await postJson(base, '/api/chat', { text: 'en-b', workspaceRoot: rootB })
    ).json()) as {
      sessionId: string;
    };
    const clientA = await SseClient.connect(base, bodyA.sessionId);
    const clientB = await SseClient.connect(base, bodyB.sessionId);
    clients.push(clientA, clientB);
    await waitForFrames(clientA, 9, 30_000);
    await waitForFrames(clientB, 9, 30_000);

    const aResult = clientA.frames.find(
      (f): f is Extract<typeof f, { event: 'tool-result' }> =>
        f.event === 'tool-result' && (f.data as { id: string }).id === 'call-pwd-a',
    );
    const bResult = clientB.frames.find(
      (f): f is Extract<typeof f, { event: 'tool-result' }> =>
        f.event === 'tool-result' && (f.data as { id: string }).id === 'call-pwd-b',
    );
    expect(aResult).toBeDefined();
    expect(bResult).toBeDefined();
    // 会话 A 的 shell cwd = A 根；B 的 = B 根（per-session 根，非固定全局根）
    expect((aResult as { data: { content: string } }).data.content).toContain(shellCwdForm(rootA));
    expect((aResult as { data: { content: string } }).data.content).not.toContain(
      shellCwdForm(rootB),
    );
    expect((bResult as { data: { content: string } }).data.content).toContain(shellCwdForm(rootB));
    expect((bResult as { data: { content: string } }).data.content).not.toContain(
      shellCwdForm(rootA),
    );
  });

  it('e2) A/B 会话工具隔离（HTTP 全链）：A 会话 fs 写 B 根文件被拒；B 会话自己写放行', async () => {
    const rootA = await mkdtemp(join(canonicalTmpBase(), 'devmate-e2e-iso-'));
    const rootB = await mkdtemp(join(canonicalTmpBase(), 'devmate-e2e-iso-'));
    tempDirs.push(rootA, rootB);
    const store = new MemorySessionAdapter();
    const jailA = await createJail({ workspaceRoot: rootA });
    const factory = createSessionToolsFactory({
      workspaceRoot: rootA,
      jail: jailA,
      workspaceRootOf: metaRootReader(store, rootA),
      shellPlatform: 'posix',
    });

    const WRITE_B = {
      id: 'call-write-b',
      name: 'write_file',
      arguments: JSON.stringify({ path: join(rootB, 'made.txt'), content: 'from B side' }),
    };
    const routes = new Map<string, FakeLlm>([
      ['try-a', new FakeLlm([{ content: 'go', toolCalls: [WRITE_B] }, { content: 'a end' }])],
      ['try-b', new FakeLlm([{ content: 'go', toolCalls: [WRITE_B] }, { content: 'b end' }])],
    ]);
    const { base, server } = await startServer({
      store,
      tools: defineRegistry([], { sessionId: 'e2e-unused' }),
      llm: new RoutingLlm(routes),
      model: 'test-model',
      workspaceRoot: rootA,
      workspaces: [rootA, rootB],
      approvalPolicy: () => false,
      settings: { reviewMode: false },
      createSessionTools: factory.createSessionTools,
      dispose: () => factory.dispose(),
    });
    servers.push(server);

    const bodyA = (await (
      await postJson(base, '/api/chat', { text: 'try-a', workspaceRoot: rootA })
    ).json()) as {
      sessionId: string;
    };
    const bodyB = (await (
      await postJson(base, '/api/chat', { text: 'try-b', workspaceRoot: rootB })
    ).json()) as {
      sessionId: string;
    };
    const clientA = await SseClient.connect(base, bodyA.sessionId);
    const clientB = await SseClient.connect(base, bodyB.sessionId);
    clients.push(clientA, clientB);
    await waitForFrames(clientA, 9, 30_000);
    await waitForFrames(clientB, 9, 30_000);

    const aResult = clientA.frames.find(
      (f): f is Extract<typeof f, { event: 'tool-result' }> =>
        f.event === 'tool-result' && (f.data as { id: string }).id === 'call-write-b',
    );
    const bResult = clientB.frames.find(
      (f): f is Extract<typeof f, { event: 'tool-result' }> =>
        f.event === 'tool-result' && (f.data as { id: string }).id === 'call-write-b',
    );
    // A 的写 B 根：jail 拒（path-outside-workspace）
    expect((aResult as { data: { ok: boolean } }).data.ok).toBe(false);
    expect(String((aResult as { data: { content: string } }).data.content)).toContain(
      'path-outside-workspace',
    );
    // B 的写 B 根：放行（文件真实落盘）
    expect((bResult as { data: { ok: boolean } }).data.ok).toBe(true);
    expect(await readFile(join(rootB, 'made.txt'), 'utf8')).toBe('from B side');
  });
});
