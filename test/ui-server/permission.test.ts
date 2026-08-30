/**
 * # test/ui-server/permission：权限预设（dsh 式三档）——settings 契约 + 判定矩阵逐格 + 真实 approver 决策
 *
 * CTO 语义定案 → 全同 dsh 实测（零弹窗对照）：
 * - 预设枚举 read-only / workspace-write（缺省）/ full-access；settings 持久化（与 reasoning
 *   同机制：GET/POST /api/settings + persistSettings 快照触碰语义 + config 顶层键）；
 * - 判定矩阵：read-only = 读放行 + fs 写/编辑与 ask/deny 级命令 ask（问询兜底）；
 *   workspace-write（默认）= fs 全放行 + 命令全放行（含 ask/deny 级——dsh 实测零弹窗；
 *   无 OS 沙箱强制层，破坏性命令同执行——选档即接受风险）；
 *   full-access = 全放行（一次性风险确认由前端负责，后端记录 permissionConfirmedAt）；
 * - 审批面（approval-request）只在 read-only 档产生；deny 直拒路径已删除
 *   （permissionDeniedMessage 移除；errorType='permission-denied' 由 loop 保留兼容、不再触发）。
 *
 * 矩阵逐格先以纯函数单测全覆盖（decidePermission）；关键行经真 assembleDeps + fake llm
 * 走真工具面（真实 fs 写、真实 run_command spawn）断言 approval-request 出现与否。
 */
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type {
  DevmateServer,
  DevmateServerDeps,
  PermissionPreset,
} from '../../src/ui/server/index.js';
import { classifyPermissionCall, decidePermission } from '../../src/ui/server/index.js';
import type { ToolCall } from '../../src/shared/session-types.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import { assembleDeps } from '../../src/ui/server/deps.js';
import { FakeLlm, type FakeScript } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

const call = (name: string, arguments_ = '{}'): ToolCall => ({
  id: 'c1',
  name,
  arguments: arguments_,
});

// ---------------------------------------------------------------------------
// 一、判定矩阵逐格（纯函数；CTO 定案矩阵的每一格）
// ---------------------------------------------------------------------------

describe('ui/server：权限判定矩阵（decidePermission 逐格）', () => {
  const CELLS: Array<[PermissionPreset, string, string, 'allow' | 'ask']> = [
    // fs 读类（read_file/list_dir/glob/grep）：三档均放行
    ['read-only', 'read_file', '{}', 'allow'],
    ['workspace-write', 'read_file', '{}', 'allow'],
    ['full-access', 'read_file', '{}', 'allow'],
    ['read-only', 'list_dir', '{}', 'allow'],
    ['workspace-write', 'list_dir', '{}', 'allow'],
    ['full-access', 'list_dir', '{}', 'allow'],
    ['read-only', 'glob', '{}', 'allow'],
    ['full-access', 'glob', '{}', 'allow'],
    ['read-only', 'grep', '{}', 'allow'],
    ['full-access', 'grep', '{}', 'allow'],
    // fs 写/编辑：read-only → ask；workspace-write/full-access → 放行
    ['read-only', 'write_file', '{}', 'ask'],
    ['workspace-write', 'write_file', '{}', 'allow'],
    ['full-access', 'write_file', '{}', 'allow'],
    ['read-only', 'edit_file', '{}', 'ask'],
    ['workspace-write', 'edit_file', '{}', 'allow'],
    ['full-access', 'edit_file', '{}', 'allow'],
    // shell 只读命令：三档均放行
    ['read-only', 'run_command', '{"command":"ls"}', 'allow'],
    ['workspace-write', 'run_command', '{"command":"ls"}', 'allow'],
    ['full-access', 'run_command', '{"command":"ls"}', 'allow'],
    // shell ask 级命令（未知命令等）：read-only → ask（问询兜底）；workspace-write/full-access
    // → 放行（dsh 实测零弹窗——默认档不再弹窗）
    ['read-only', 'run_command', '{"command":"echo hi"}', 'ask'],
    ['workspace-write', 'run_command', '{"command":"echo hi"}', 'allow'],
    ['full-access', 'run_command', '{"command":"echo hi"}', 'allow'],
    // shell deny 级命令（rm -rf 等）：read-only → ask（问询兜底）；workspace-write/full-access
    // → 放行（deny 直拒路径已删除——workspace-write 下同 dsh：命令直接执行（含破坏性））
    ['read-only', 'run_command', '{"command":"rm -rf foo"}', 'ask'],
    ['workspace-write', 'run_command', '{"command":"rm -rf foo"}', 'allow'],
    ['full-access', 'run_command', '{"command":"rm -rf foo"}', 'allow'],
    // 矩阵外普通工具（use_skill/spawn_subagent/mcp 等）：三档均放行（dsh 口径：普通工具调用不弹窗）
    ['read-only', 'use_skill', '{}', 'allow'],
    ['workspace-write', 'use_skill', '{}', 'allow'],
    ['full-access', 'use_skill', '{}', 'allow'],
    ['workspace-write', 'spawn_subagent', '{}', 'allow'],
    ['full-access', 'mcp_some_call', '{}', 'allow'],
  ];

  it.each(CELLS)('%s × %s(%s) → %s', (permission, name, args, expected) => {
    expect(decidePermission(permission, call(name, args))).toBe(expected);
  });

  it('classifyPermissionCall：run_command 参数畸形/空命令 → 按未知命令 ask（不放行不明命令）', () => {
    expect(classifyPermissionCall(call('run_command', 'not json' as string))).toMatchObject({
      kind: 'shell',
      verdict: 'ask',
    });
    expect(classifyPermissionCall(call('run_command', '{"command":""}'))).toMatchObject({
      kind: 'shell',
      verdict: 'ask',
    });
    expect(classifyPermissionCall(call('echo'))).toEqual({ kind: 'tool' });
  });
});

// ---------------------------------------------------------------------------
// 二、settings 契约（permission / permissionConfirmedAt；与 reasoning 同机制）
// ---------------------------------------------------------------------------

function simpleDeps(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'ok' }]),
    model: 'test-model',
    ...extra,
  };
}

describe('ui/server：settings permission 契约', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('q1) GET 缺省 permission=workspace-write（无设置/无配置种子）；assembleDeps 配置种子生效', async () => {
    const { base, server } = await startServer(simpleDeps());
    servers.push(server);
    const before = (await (await fetch(new URL('/api/settings', base))).json()) as {
      permission: string;
      permissionConfirmedAt?: number;
    };
    expect(before.permission).toBe('workspace-write');
    expect(before.permissionConfirmedAt).toBeUndefined();

    // 真装配路径：DevmateConfig.permission 种子（缺省同为 workspace-write）
    const dir = await mkdtemp(join(tmpdir(), 'devmate-perm-'));
    tempDirs.push(dir);
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 's'),
      model: 'm',
      permission: 'read-only',
    });
    const { base: base2, server: server2 } = await startServer(deps, 0);
    servers.push(server2);
    const seeded = (await (await fetch(new URL('/api/settings', base2))).json()) as {
      permission: string;
    };
    expect(seeded.permission).toBe('read-only');
    await deps.dispose?.();
  });

  it('q2) POST 枚举校验：合法三值往返；非法值 400', async () => {
    const { base, server } = await startServer(simpleDeps());
    servers.push(server);

    for (const preset of ['read-only', 'workspace-write', 'full-access'] as const) {
      const res = await postJson(base, '/api/settings', { permission: preset });
      expect(res.status, preset).toBe(200);
      const saved = (await res.json()) as { permission: string };
      expect(saved.permission).toBe(preset);
      const after = (await (await fetch(new URL('/api/settings', base))).json()) as {
        permission: string;
      };
      expect(after.permission).toBe(preset);
    }

    for (const bad of ['admin', 'Read-Only', '', 1]) {
      const res = await postJson(base, '/api/settings', { permission: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTypeOf('string');
    }
    const badConfirmed = await postJson(base, '/api/settings', { permissionConfirmedAt: -1 });
    expect(badConfirmed.status).toBe(400);
  });

  it('q3) persistSettings 快照触碰语义：permission/permissionConfirmedAt 只在被触碰时携带', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const { base, server } = await startServer(
      simpleDeps({
        settings: { baseUrl: 'https://p.example/v1', model: 'm0' },
        persistSettings: (s: unknown) => {
          persisted.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
        },
      }),
    );
    servers.push(server);

    await postJson(base, '/api/settings', { model: 'm1' });
    expect(Object.keys(persisted[0]!).sort()).toEqual(['baseUrl', 'model']);

    await postJson(base, '/api/settings', { permission: 'read-only' });
    expect(persisted[1]).toMatchObject({
      baseUrl: 'https://p.example/v1',
      model: 'm1',
      permission: 'read-only',
    });
    expect(Object.keys(persisted[1]!).sort()).toEqual(['baseUrl', 'model', 'permission']);

    await postJson(base, '/api/settings', { permissionConfirmedAt: 1234567890 });
    expect(persisted[2]).toMatchObject({
      permissionConfirmedAt: 1234567890,
      model: 'm1',
    });
    expect(Object.keys(persisted[2]!).sort()).toEqual([
      'baseUrl',
      'model',
      'permissionConfirmedAt',
    ]);
  });

  it('q4) full-access 风险确认记录：首次切换被动记录（不覆盖已有）；显式值优先', async () => {
    const { base, server } = await startServer(simpleDeps());
    servers.push(server);

    const first = await postJson(base, '/api/settings', { permission: 'full-access' });
    expect(first.status).toBe(200);
    const saved = (await first.json()) as { permissionConfirmedAt: number };
    const t1 = saved.permissionConfirmedAt;
    expect(typeof t1).toBe('number');
    expect(t1).toBeGreaterThan(0);

    // 再次切换 full-access（已是）不覆盖已有记录
    await postJson(base, '/api/settings', { permission: 'full-access' });
    const again = (await (await fetch(new URL('/api/settings', base))).json()) as {
      permissionConfirmedAt: number;
    };
    expect(again.permissionConfirmedAt).toBe(t1);

    // 显式 permissionConfirmedAt 优先
    await postJson(base, '/api/settings', {
      permission: 'full-access',
      permissionConfirmedAt: 1234567890,
    });
    const explicit = (await (await fetch(new URL('/api/settings', base))).json()) as {
      permissionConfirmedAt: number;
    };
    expect(explicit.permissionConfirmedAt).toBe(1234567890);
  });
});

// ---------------------------------------------------------------------------
// 三、真装配 approver 决策（assembleDeps + fake llm；矩阵关键行往返）
// ---------------------------------------------------------------------------

describe('ui/server：权限矩阵真装配决策（assembleDeps + fake llm）', () => {
  const servers: DevmateServer[] = [];
  const clients: SseClient[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function startReal(
    workspaceRoot: string,
    scripts: FakeScript[],
  ): Promise<{ base: string; server: DevmateServer }> {
    const deps = await assembleDeps({
      workspaceRoot,
      sessionsDir: join(workspaceRoot, 'sessions'),
      model: 'deepseek-v4-flash',
      // 本组测试聚焦权限矩阵：关掉评审哨兵（实质变更工具会触发注入——另由
      // test/loop/review-sentinel 与 e2e/s2-methodology 覆盖）
      reviewMode: false,
    });
    const fake = new FakeLlm(scripts);
    // assembleDeps 无假 LLM 接缝：createDevmateServer 级注入（覆写 llm + createLlm）
    deps.llm = fake;
    deps.createLlm = () => fake;
    void fake;
    const { base, server } = await startServer(deps);
    return { base, server };
  }

  async function chatSession(base: string): Promise<string> {
    const res = await postJson(base, '/api/chat', { text: 'task' });
    expect(res.status).toBe(200);
    return ((await res.json()) as { sessionId: string }).sessionId;
  }

  it('m1) 默认档：write_file 放行不弹窗（真实执行 ok）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-perm-m1-'));
    tempDirs.push(dir);
    const writeCall = {
      id: 'w1',
      name: 'write_file',
      arguments: JSON.stringify({ path: join(dir, 'perm-a.txt'), content: 'hello' }),
    };
    const { base, server } = await startReal(dir, [
      { content: 'write it', toolCalls: [writeCall] },
      { content: 'done' },
    ]);
    servers.push(server);
    const sessionId = await chatSession(base);

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 9, 15_000);
    const events = client.frames.map((f) => f.event);
    expect(events).not.toContain('approval-request');
    const result = client.frames.find((f) => f.event === 'tool-result')!;
    expect(result.data).toMatchObject({ id: 'w1', name: 'write_file', ok: true });
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });

  it('m2) 默认档：deny 级命令（rm -rf demo-tmp）不弹窗且真实执行（目录确实被删）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-perm-m2-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'demo-tmp'));
    // dsh 对照：workspace-write 下 rm -rf 类执行（无命令名黑名单——沙箱只看文件效应）；
    // DevMate 无 OS 沙箱强制层，等价执行——选档即接受的风险，前端文案声明
    const denyCall = {
      id: 'r1',
      name: 'run_command',
      arguments: '{"command":"rm -rf demo-tmp"}',
    };
    const { base, server } = await startReal(dir, [
      { content: 'do it', toolCalls: [denyCall] },
      { content: '收尾，不动了' },
    ]);
    servers.push(server);
    const sessionId = await chatSession(base);

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 9, 15_000);
    const events = client.frames.map((f) => f.event);
    expect(events).not.toContain('approval-request');
    const result = client.frames.find((f) => f.event === 'tool-result')!;
    expect(result.data).toMatchObject({ id: 'r1', name: 'run_command', ok: true });
    expect((result.data as { content: string }).content).toContain('--- exit code: 0 ---');
    // 执行真：demo-tmp 已被真实删除
    await expect(access(join(dir, 'demo-tmp'))).rejects.toThrow();
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });

  it('m3) read-only 档：fs 写 → approval-request；approve 后真实执行 ok', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-perm-m3-'));
    tempDirs.push(dir);
    const writeCall = {
      id: 'w1',
      name: 'write_file',
      arguments: JSON.stringify({ path: join(dir, 'perm-b.txt'), content: 'x' }),
    };
    const { base, server } = await startReal(dir, [
      { content: 'write it', toolCalls: [writeCall] },
      { content: 'done' },
    ]);
    servers.push(server);
    expect((await postJson(base, '/api/settings', { permission: 'read-only' })).status).toBe(200);
    const sessionId = await chatSession(base);

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 15_000);
    expect(client.frames[4]!.event).toBe('approval-request');
    expect(client.frames[4]!.data).toMatchObject({ toolCallId: 'w1', name: 'write_file' });

    const approved = await postJson(base, '/api/approval', {
      sessionId,
      toolCallId: 'w1',
      approve: true,
    });
    expect(approved.status).toBe(200);
    await waitForFrames(client, 10, 15_000);
    const result = client.frames.find((f) => f.event === 'tool-result')!;
    expect(result.data).toMatchObject({ id: 'w1', name: 'write_file', ok: true });
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });

  it('m4) read-only 档：只读命令放行不弹窗（真实 ls 执行）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-perm-m4-'));
    tempDirs.push(dir);
    const lsCall = { id: 'l1', name: 'run_command', arguments: '{"command":"ls"}' };
    const { base, server } = await startReal(dir, [
      { content: 'list', toolCalls: [lsCall] },
      { content: 'done' },
    ]);
    servers.push(server);
    expect((await postJson(base, '/api/settings', { permission: 'read-only' })).status).toBe(200);
    const sessionId = await chatSession(base);

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 9, 15_000);
    const events = client.frames.map((f) => f.event);
    expect(events).not.toContain('approval-request');
    const result = client.frames.find((f) => f.event === 'tool-result')!;
    expect(result.data).toMatchObject({ id: 'l1', name: 'run_command', ok: true });
    expect((result.data as { content: string }).content).toContain('--- exit code: 0 ---');
  });

  it('m5) read-only 档：deny 级命令走 ask（问询兜底）——approve 后真实执行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-perm-m5-'));
    tempDirs.push(dir);
    const denyCall = { id: 'r1', name: 'run_command', arguments: '{"command":"rm -rf perm-gone"}' };
    const { base, server } = await startReal(dir, [
      { content: 'do it', toolCalls: [denyCall] },
      { content: 'done' },
    ]);
    servers.push(server);
    expect((await postJson(base, '/api/settings', { permission: 'read-only' })).status).toBe(200);
    const sessionId = await chatSession(base);

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 15_000);
    expect(client.frames[4]!.event).toBe('approval-request');
    expect(client.frames[4]!.data).toMatchObject({
      toolCallId: 'r1',
      name: 'run_command',
      arguments: '{"command":"rm -rf perm-gone"}',
    });

    const approved = await postJson(base, '/api/approval', {
      sessionId,
      toolCallId: 'r1',
      approve: true,
    });
    expect(approved.status).toBe(200);
    await waitForFrames(client, 10, 15_000);
    const result = client.frames.find((f) => f.event === 'tool-result')!;
    expect(result.data).toMatchObject({ id: 'r1', name: 'run_command', ok: true });
  });

  it('m6) full-access 档：ask 与 deny 级命令全放行（无 approval-request；真实执行后均 ok）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-perm-m6-'));
    tempDirs.push(dir);
    const calls = [
      { id: 'r1', name: 'run_command', arguments: '{"command":"rm -rf perm-gone"}' },
      { id: 'r2', name: 'run_command', arguments: '{"command":"echo hi"}' },
    ];
    const { base, server } = await startReal(dir, [
      { content: 'all the things', toolCalls: calls },
      { content: 'done' },
    ]);
    servers.push(server);
    expect((await postJson(base, '/api/settings', { permission: 'full-access' })).status).toBe(200);
    const sessionId = await chatSession(base);

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 11, 15_000);
    const events = client.frames.map((f) => f.event);
    expect(events).not.toContain('approval-request');
    expect(events.filter((e) => e === 'tool-result')).toHaveLength(2);
    const results = client.frames.filter((f) => f.event === 'tool-result').map((f) => f.data);
    expect(results[0]).toMatchObject({ id: 'r1', name: 'run_command', ok: true });
    expect(results[1]).toMatchObject({ id: 'r2', name: 'run_command', ok: true });
    expect((results[1] as { content: string }).content).toContain('[out] hi');
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });

  it('m7) 默认档：ask 级命令（npm view — classify 未知命令→ask）不弹窗且真实执行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-perm-m7-'));
    tempDirs.push(dir);
    // npm view：classify 未知命令 → ask 级——默认档零弹窗的直接执行代表（用户诉求「不再弹窗」）
    const npmCall = {
      id: 'n1',
      name: 'run_command',
      arguments: '{"command":"npm view lodash version"}',
    };
    const { base, server } = await startReal(dir, [
      { content: 'view it', toolCalls: [npmCall] },
      { content: 'done' },
    ]);
    servers.push(server);
    const sessionId = await chatSession(base);

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 9, 20_000);
    const events = client.frames.map((f) => f.event);
    expect(events).not.toContain('approval-request');
    const result = client.frames.find((f) => f.event === 'tool-result')!;
    expect(result.data).toMatchObject({ id: 'n1', name: 'run_command', ok: true });
    // 执行真：npm 真实输出（registry 版本号）与退出码 0
    const content = (result.data as { content: string }).content;
    expect(content).toContain('--- exit code: 0 ---');
    expect(content).toMatch(/\d+\.\d+\.\d+/);
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({ status: 'completed' });
  });
});
