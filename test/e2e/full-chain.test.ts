/**
 * # test/e2e/full-chain：真实链路 mock-LLM 端到端（零密钥、零外部网络）
 *
 * 全链定义：真实 assembleDeps 装配（真 jail + 真 JsonlFileAdapter on tmp 目录 +
 * 真工具面 fs 六件 + run_command 常驻 shell + use_skill + spawn_subagent）+ 真服务
 * listen(0) + 全局 fetch（与浏览器同款：上行 POST JSON / 下行 SSE 帧）。
 * LLM 一律用注入的 FakeLlm（test/loop/support.ts）——assembleDeps 的 DevmateConfig
 * 无假 LLM 接缝（真实装配内部构造 LlmClient/wiredLlmAdapter），采取「装配后覆写
 * deps.llm / deps.createLlm」的 createDevmateServer 级注入（deps-tools.test 同模式）；
 * 场景 C 的假子代理池同理（assembleDeps 无池接缝 —— createSessionToolsFactory 是
 * 公共导出的既有接缝，deps-tools.test 的「装配级 + 真实服务端构造级」双档模式）。
 *
 * 场景与覆盖矩阵：
 * A  UI 协议全链路（见 A1）：/api/chat → SSE 事件序（user 回声→delta 累计→
 *    done(0 tool)→usage{含 contextEstimateTokens}→run-status completed）→ resume
 *    第二轮同序 → GET /api/sessions（会话数/标题/stepCount/workspaceRoot）→
 *    GET /api/sessions/:id（回放与在线 done 帧逐字一致）→ GET /api/stats（sessions=1、
 *    rssMb/heapMb/memoryGuard 等内存字段在）。
 * B  工具+审批全链（B1 通过 / B2 带理由拒绝）：真实工具面 run_command（echo 类，
 *    本地 spawn）× 服务端审批簿：approval-request 到达后服务端悬停不推进（next 超时
 *    无帧）→ POST /api/approval approve → tool-result(ok:true, 真实 [out] echo) 前无
 *    更多 approval-request → 第二轮 → completed；deny+reason → tool-result ok:false
 *    + error=拒因（user-denied）→ 模型继续 → completed。
 * C  subagent 与技能：GET /api/tools 工具面含 use_skill/spawn_subagent（无 mcp 前缀）；
 *    use_skill 经真实 SKILL.md 资产加载全文（tool-result ok:true 含正文）；
 *    spawn_subagent 经注入假池回注报告（pool.spawned 收证）；技能开关
 *    POST /api/skills/alpha false → 事件流 tool-result ok:false error=skill-disabled
 *    （含 available_skills）；POST /api/workflow subagentsEnabled:false →
 *    spawn_subagent 立即拒绝（subagents-disabled，池未触网）。
 * D  全程无泄漏：POST /api/settings（apiKey）→ GET 掩码回读无原文（map 值逐字）；
 *    GET /api/stats 内存字段（rssMb/heapMb/memoryGuard）在；MCP 空配置（servers:[]、
 *    stats.mcpServers=0）；api 密钥不出现在任何响应体。
 *
 * 禁止外部网络：MCP 恒空配置（无 launcher 连接）；LLM 全假（LlmClient 从不构造
 * 真连接）；shell 只跑 echo 类命令（真实 spawn 仅限本机）。测试时长：每场景独立
 * server 实例（beforeEach 起 / afterEach close + tmp 清理），无 sleep 等待（帧驱动）。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeConfig } from '../../src/cli/config.js';
import { runWeb } from '../../src/cli/web.js';
import { createJail } from '../../src/core/jail/index.js';
import type { ToolRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { SubagentPool, SubagentResult, SubagentTask } from '../../src/core/loop/subagent.js';
import type { SkillsIndex } from '../../src/core/tools/skill.js';
import { createDevmateServer } from '../../src/ui/server/index.js';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { assembleDeps, createSessionToolsFactory } from '../../src/ui/server/deps.js';
import type { WorkflowConfig } from '../../src/shared/workflow.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from '../ui-server/support.js';
import type { TestServerHandle } from '../ui-server/support.js';

type ToolResultFrame = {
  id: string;
  name: string;
  ok: boolean;
  contentPreview: string;
  content: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// E2E-A：UI 协议全链路（真实 assembleDeps + tmp JsonlFileAdapter + 假 LLM 两轮）
// ---------------------------------------------------------------------------

describe('E2E-A：UI 协议全链路（assembleDeps + fake llm 两轮脚本）', () => {
  let dir: string;
  let sessionsDir: string;
  let deps: DevmateServerDeps;
  let handle: TestServerHandle | null = null;
  let fake: FakeLlm;
  const clients: SseClient[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devmate-e2e-a-'));
    sessionsDir = join(dir, 'sessions');
    fake = new FakeLlm([
      {
        content: '第一轮回答',
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      },
      {
        content: '第二轮回答',
        usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
      },
    ]);
    deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir,
      model: 'deepseek-v4-flash',
    });
    // assembleDeps 无假 LLM 接缝（DevmateConfig 无 llm 字段）：createDevmateServer 级
    // 注入——覆写 deps.llm 与 deps.createLlm（每次 run 重建即返回同一假适配器）。
    deps.llm = fake;
    deps.createLlm = () => fake;
    handle = await startServer(deps);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await handle?.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('A1) 两轮全链：SSE 事件序 + usage{contextEstimateTokens} + 列表/回放/统计', async () => {
    const base = handle!.base;
    const res = await postJson(base, '/api/chat', { text: '任务一' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(sessionId).toMatch(/^s-/);

    // 首轮：user 回声 → delta 累计 → done(0 tool) → usage → run-status
    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    // run 异步启动（POST 先返回）：run-status 已到即一轮 chat 已完成
    expect(fake.requests).toHaveLength(1);
    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    expect(client.frames[0]!.data).toEqual({ text: '任务一' });
    expect(client.frames[1]!.data).toEqual({ text: '第一轮回答' });
    expect(client.frames[2]!.data).toEqual({ content: '第一轮回答', toolCalls: [] });
    const usage1 = client.frames[3]!.data as Record<string, unknown>;
    expect(usage1).toMatchObject({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      estimated: false,
    });
    expect(typeof usage1.costUsd).toBe('number');
    // C 档：usage 帧带最近一次投影的上下文估算（run 全链唯一一处给出该字段）
    expect(typeof usage1.contextEstimateTokens).toBe('number');
    expect((usage1.contextEstimateTokens as number) > 0).toBe(true);
    expect(client.frames[4]!.data).toMatchObject({ status: 'completed', steps: 1 });

    // resume 第二轮（同 sessionId）：事件序逐帧一致
    const res2 = await postJson(base, '/api/chat', { sessionId, text: '任务二' });
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { sessionId: string }).sessionId).toBe(sessionId);
    await waitForFrames(client, 10, 10_000);
    expect(client.frames.slice(5).map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    expect(client.frames[5]!.data).toEqual({ text: '任务二' });
    expect(client.frames[6]!.data).toEqual({ text: '第二轮回答' });
    expect(client.frames[7]!.data).toEqual({ content: '第二轮回答', toolCalls: [] });
    expect(client.frames[9]!.data).toMatchObject({ status: 'completed', steps: 1 });
    expect(fake.requests).toHaveLength(2);
    // 假 llm 确实收到真实投影的请求（系统提示合成注入，请求侧模型=配置模型）
    expect(fake.requests[0]!.model).toBe('deepseek-v4-flash');
    expect(fake.requests[0]!.messages[0]!.role).toBe('system');
    expect(String(fake.requests[0]!.messages[0]!.content)).toContain('你是 DevMate');

    // GET /api/sessions：会话在列（标题=首条 user 前 40 字符；stepCount=assistant 数）
    const listBody = (await (await fetch(new URL('/api/sessions', base))).json()) as {
      sessions: Array<{
        sessionId: string;
        title: string;
        stepCount?: number;
        workspaceRoot?: string | null;
      }>;
    };
    expect(listBody.sessions).toHaveLength(1);
    const summary = listBody.sessions[0]!;
    expect(summary.sessionId).toBe(sessionId);
    expect(summary.title).toBe('任务一');
    expect(summary.stepCount).toBe(2);
    expect(summary.workspaceRoot).toBe(dir);

    // GET /api/sessions/:id：回放与在线流同源（done 帧逐字一致）
    const detailBody = (await (
      await fetch(new URL(`/api/sessions/${sessionId}`, base))
    ).json()) as {
      sessionId: string;
      title: string;
      workspaceRoot: string | null;
      events: Array<{ event: string; data: Record<string, unknown> }>;
    };
    expect(detailBody.sessionId).toBe(sessionId);
    expect(detailBody.title).toBe('任务一');
    expect(detailBody.workspaceRoot).toBe(dir);
    expect(detailBody.events.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-done',
      'session-user',
      'assistant-done',
    ]);
    expect(detailBody.events[0]!.data).toEqual({ text: '任务一' });
    expect(detailBody.events[1]!.data).toEqual({ content: '第一轮回答', toolCalls: [] });
    expect(detailBody.events[2]!.data).toEqual({ text: '任务二' });
    expect(detailBody.events[3]!.data).toEqual({ content: '第二轮回答', toolCalls: [] });
    // 回放一致：历史 done 帧与在线流 done 帧逐字节同值（同源映射）
    expect(detailBody.events[1]).toEqual(client.frames[2] as unknown as Record<string, unknown>);
    expect(detailBody.events[3]).toEqual(client.frames[7] as unknown as Record<string, unknown>);

    // GET /api/stats：会话数=1；内存字段在（rss/heap 单次采样 + 守卫状态）
    const stats = (await (await fetch(new URL('/api/stats', base))).json()) as Record<
      string,
      unknown
    >;
    expect(stats.sessions).toBe(1);
    expect(typeof stats.rssMb).toBe('number');
    expect((stats.rssMb as number) > 0).toBe(true);
    expect(typeof stats.heapMb).toBe('number');
    expect((stats.heapMb as number) > 0).toBe(true);
    expect(stats.memoryGuard).toMatchObject({ tripped: false, lastAt: null, reason: null });
    expect(stats.activeShells).toBe(1); // run 已建会话工具面（常驻 shell 按会话懒建）
    expect(stats.mcpServers).toBe(0); // 空 MCP 配置（无外部网络面）
    expect(stats.mcpTools).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E2E-B：工具 + 审批全链（真实 run_command echo × POST /api/approval）
// ---------------------------------------------------------------------------

describe('E2E-B：工具+审批全链（真实 run_command echo）', () => {
  let dir: string;
  let deps: DevmateServerDeps;
  let handle: TestServerHandle | null = null;
  let fake: FakeLlm;
  const clients: SseClient[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devmate-e2e-b-'));
    fake = new FakeLlm([]); // 每测试自设脚本
    deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 'sessions'),
      model: 'deepseek-v4-flash',
      // B 组聚焦审批链：关掉评审哨兵（run_command 属实质变更；哨兵路径由
      // e2e/s2-methodology 的 assembleDeps 同链抽样覆盖）
      reviewMode: false,
    });
    deps.llm = fake;
    deps.createLlm = () => fake;
    handle = await startServer(deps);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await handle?.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const ECHO_CALL = {
    id: 'call-echo-1',
    name: 'run_command',
    arguments: '{"command":"echo hello"}',
  };

  it('B1) approval-request 悬停不推进；approve → 真实 echo 执行 → tool-result ok → 第二轮 completed；回放配对', async () => {
    fake = new FakeLlm([
      {
        content: '执行命令',
        toolCalls: [ECHO_CALL],
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      },
      {
        content: '命令已执行',
        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      },
    ]);
    deps.llm = fake;
    deps.createLlm = () => fake;
    const base = handle!.base;
    const res = await postJson(base, '/api/chat', { text: '跑一个 echo' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'tool-start',
      'approval-request',
    ]);
    expect(client.frames[3]!.data).toEqual({
      id: 'call-echo-1',
      name: 'run_command',
      arguments: '{"command":"echo hello"}',
    });
    expect(client.frames[4]!.data).toMatchObject({
      toolCallId: 'call-echo-1',
      name: 'run_command',
    });

    // 未答不推进：服务端悬停在审批上（无 tool-result / 无 run-status）
    expect(await client.next(500)).toBeNull();
    expect(client.frames).toHaveLength(5);

    const approved = await postJson(base, '/api/approval', {
      sessionId,
      toolCallId: 'call-echo-1',
      approve: true,
    });
    expect(approved.status).toBe(200);

    await waitForFrames(client, 10, 15_000);
    expect(client.frames.slice(5).map((f) => f.event)).toEqual([
      'tool-result',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    // approve 后 tool-result 前无更多 approval-request / tool-start（序号断言已含：
    // 紧随其后的第一帧就是 tool-result）
    const result = client.frames[5]!.data as ToolResultFrame;
    expect(result).toMatchObject({ id: 'call-echo-1', name: 'run_command', ok: true });
    expect(result.contentPreview).toContain('[out] hello'); // 真实 spawn 的输出
    expect(result.content).toContain('--- exit code: 0 ---');
    expect(client.frames[9]!.data).toMatchObject({ status: 'completed', steps: 2 });
    // 两轮 usage 均真实记账（脚本都带 usage；累计账本 = 3+4 / 1+2）
    expect(client.frames[8]!.data).toMatchObject({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      estimated: false,
    });

    // 回放：assistant-done(1tc) + tool-start + tool-result 配对一致（真实链持久化）
    const detailBody = (await (
      await fetch(new URL(`/api/sessions/${sessionId}`, base))
    ).json()) as {
      events: Array<{ event: string; data: Record<string, unknown> }>;
    };
    expect(detailBody.events.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-done',
      'tool-start',
      'tool-result',
      'assistant-done',
    ]);
    const done = detailBody.events[1]!.data as { toolCalls: Array<{ id: string }> };
    expect(done.toolCalls).toEqual([
      { id: 'call-echo-1', name: 'run_command', arguments: '{"command":"echo hello"}' },
    ]);
    const replayed = detailBody.events[3]!.data as unknown as ToolResultFrame;
    expect(replayed).toMatchObject({ id: 'call-echo-1', name: 'run_command', ok: true });
    expect(replayed.content).toContain('[out] hello');
    // 在线 tool-result 与回放 tool-result 逐字一致（同源映射：registry 观察器/持久化映射）
    expect(detailBody.events[3]).toEqual(client.frames[5] as unknown as Record<string, unknown>);
  });

  it('B2) deny（带理由）→ tool-result 失败回执（user-denied + 拒因）→ 模型继续 → completed', async () => {
    fake = new FakeLlm([
      { content: '需要审批', toolCalls: [ECHO_CALL] },
      { content: '不动它了，直接收尾' },
    ]);
    deps.llm = fake;
    deps.createLlm = () => fake;
    const base = handle!.base;
    const res = await postJson(base, '/api/chat', { text: '跑一个 echo' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'tool-start',
      'approval-request',
    ]);

    const denied = await postJson(base, '/api/approval', {
      sessionId,
      toolCallId: 'call-echo-1',
      approve: false,
      reason: '不要执行命令',
    });
    expect(denied.status).toBe(200);

    await waitForFrames(client, 10, 15_000);
    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'tool-start',
      'approval-request',
      'tool-result',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    // 失败回执：ok:false + error=拒因（user-denied 载荷；工具未执行 → 无真实 echo 输出）
    const result = client.frames[5]!.data as ToolResultFrame;
    expect(result).toMatchObject({ id: 'call-echo-1', name: 'run_command', ok: false });
    expect(result.error).toBe('不要执行命令');
    expect(result.contentPreview).toContain('user-denied');
    expect(result.contentPreview).not.toContain('[out]'); // 工具从未执行
    // 拒因回注 → 模型继续：第二次查询随后发生 → completed
    expect(client.frames[6]!.data).toEqual({ text: '不动它了，直接收尾' });
    expect(client.frames[9]!.data).toMatchObject({ status: 'completed', steps: 2 });
  });
});

// ---------------------------------------------------------------------------
// E2E-C：subagent 与技能（真实 SKILL.md 资产 + 假池注入）
// ---------------------------------------------------------------------------

describe('E2E-C：subagent 与技能（假池经 createSessionToolsFactory 注入）', () => {
  let dir: string;
  let skillsDir: string;
  let deps: DevmateServerDeps;
  let handle: TestServerHandle | null = null;
  let fake: FakeLlm;
  let pool: SubagentPool & { spawned: string[] };
  const clients: SseClient[] = [];

  /** 假池：记录 spawn 请求；关闭档立即返回 subagents-disabled（与真池契约同形状）。 */
  function makeFakePool(config: { get: (() => WorkflowConfig) | null }): SubagentPool & {
    spawned: string[];
  } {
    const spawned: string[] = [];
    let completed = 0;
    const disabled = (): SubagentResult => ({
      ok: false,
      report: '',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      estimated: false,
      durationMs: 0,
      error: 'subagents-disabled',
    });
    return {
      spawned,
      async spawn(task: SubagentTask): Promise<SubagentResult> {
        if (config.get !== null && config.get().subagentsEnabled === false) {
          return disabled(); // 绝不触网：关闭即拒绝（真池同语义）
        }
        spawned.push(task.prompt);
        completed += 1;
        return {
          ok: true,
          report: `SUBAGENT-REPORT:${task.prompt}`,
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          costUsd: 0,
          estimated: false,
          durationMs: 1,
        };
      },
      stats: () => ({
        enabled: config.get !== null ? config.get().subagentsEnabled : true,
        maxParallel: 2,
        active: 0,
        queued: 0,
        completed,
        rejected: 0,
      }),
      dispose: () => undefined,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devmate-e2e-c-'));
    skillsDir = join(dir, 'skills');
    await mkdir(join(skillsDir, 'alpha'), { recursive: true });
    await writeFile(
      join(skillsDir, 'alpha', 'SKILL.md'),
      '---\nname: Alpha asset\ndescription: An alpha asset for tests.\n---\nALPHA BODY\nline2',
    );
    fake = new FakeLlm([]);
    const jail = await createJail({ workspaceRoot: dir });
    const indexRef: { index: SkillsIndex | null } = { index: null };
    const configRef: { get: (() => WorkflowConfig) | null } = { get: null };
    pool = makeFakePool(configRef);
    const sessionTools = createSessionToolsFactory({
      workspaceRoot: dir,
      jail,
      // use_skill 索引晚绑定：服务端构造期 attach 回填（与 assembleDeps 同构）
      skillsIndex: () => indexRef.index,
      // spawn_subagent 池单例：假池经公共接缝注入（assembleDeps 无此接缝）
      subagentPool: pool,
    });
    const store = new MemorySessionAdapter();
    deps = {
      store,
      model: 'deepseek-v4-flash',
      llm: fake,
      skillsDir,
      // C 组聚焦技能/子代理链（测试脚本固定序）：关掉评审哨兵（spawn_subagent
      // 属实质变更——哨兵注入路径由 e2e/s2-methodology 同链抽样覆盖）
      settings: { reviewMode: false },
      // C 不是审批场景：直接放行（审批链在 E2E-B 覆盖）
      approvalPolicy: () => false,
      // 与 assembleDeps 同构的懒构建 data source（GET /api/tools 首次访问才建 __fallback__ 壳）
      get tools(): ToolRegistry {
        return sessionTools.tools;
      },
      createSessionTools: sessionTools.createSessionTools,
      dispose: () => sessionTools.dispose(),
      disposeSession: (id) => sessionTools.disposeSession(id),
      disposeIdleShells: (now, active) => sessionTools.disposeIdleShells(now, active),
      activeShellCount: () => sessionTools.activeShellCount(),
      queuedSubagentCount: () => pool.stats().queued,
      attachSkillsIndex: (index) => {
        indexRef.index = index;
      },
      attachWorkflowConfig: (current) => {
        configRef.get = current;
      },
    };
    handle = await startServer(deps);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await handle?.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('C1) 工具面含 use_skill/spawn_subagent；use_skill 加载全文 ok；池收到 spawn；全链 completed', async () => {
    fake = new FakeLlm([
      {
        content: '并行要工具',
        toolCalls: [
          { id: 'call-skill-1', name: 'use_skill', arguments: '{"skill":"alpha"}' },
          { id: 'call-sub-1', name: 'spawn_subagent', arguments: '{"prompt":"独立子任务A"}' },
        ],
      },
      { content: '任务完成' },
    ]);
    deps.llm = fake;
    const base = handle!.base;

    // 工具面：9 基础工具（fs 六 + run_command + use_skill + spawn_subagent），无 mcp_* 前缀
    const toolsBody = (await (await fetch(new URL('/api/tools', base))).json()) as {
      tools: Array<{ name: string }>;
    };
    expect(toolsBody.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'glob',
        'grep',
        'run_command',
        'use_skill',
        'spawn_subagent',
      ]),
    );
    expect(toolsBody.tools.some((t) => t.name.startsWith('mcp_'))).toBe(false);

    const res = await postJson(base, '/api/chat', { text: '调查' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 11, 10_000);
    const seq = client.frames.map((f) => f.event);
    // 首轮：done(2tc) + 两个 tool-start（并行调用按声明序）；第 6/7 帧 = 两个 tool-result（并行结果序不定）
    expect(seq.slice(0, 5)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'tool-start',
      'tool-start',
    ]);
    expect(seq[5]).toBe('tool-result');
    expect(seq[6]).toBe('tool-result');
    expect(seq.slice(7)).toEqual(['assistant-delta', 'assistant-done', 'usage', 'run-status']);
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({
      status: 'completed',
      steps: 2,
    });

    // 结果按 id 收窄（并行序不定，不按帧序断言）
    const byId = new Map<string, ToolResultFrame>();
    for (const frame of client.frames) {
      if (frame.event === 'tool-result') {
        const data = frame.data as ToolResultFrame;
        byId.set(data.id, data);
      }
    }
    const skill = byId.get('call-skill-1')!;
    expect(skill).toMatchObject({ name: 'use_skill', ok: true });
    expect(skill.content).toBe(
      '---\nname: Alpha asset\ndescription: An alpha asset for tests.\n---\nALPHA BODY\nline2',
    );
    const sub = byId.get('call-sub-1')!;
    expect(sub).toMatchObject({ name: 'spawn_subagent', ok: true });
    expect(sub.content).toBe('SUBAGENT-REPORT:独立子任务A');
    expect(pool.spawned).toEqual(['独立子任务A']); // 池收证（假池零网络）
  });

  it('C2) 技能开关 false → use_skill skill-disabled 回注（事件流 tool-result ok:false）；workflow 关闭 → spawn 即拒', async () => {
    fake = new FakeLlm([
      {
        content: '加载技能',
        toolCalls: [{ id: 'call-skill-off', name: 'use_skill', arguments: '{"skill":"alpha"}' }],
      },
      { content: '收到' },
      {
        content: 'spawn',
        toolCalls: [
          { id: 'call-sub-off', name: 'spawn_subagent', arguments: '{"prompt":"子任务B"}' },
        ],
      },
      { content: '好的' },
    ]);
    deps.llm = fake;
    const base = handle!.base;

    const toggle = await postJson(base, '/api/skills/alpha', { enabled: false });
    expect(toggle.status).toBe(200);
    const skillsBody = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string; enabled: boolean }>;
    };
    expect(skillsBody.skills.find((s) => s.id === 'alpha')!.enabled).toBe(false);

    // 第一轮 run：use_skill（技能已关）→ tool-result ok:false（error=skill-disabled）
    const res1 = await postJson(base, '/api/chat', { text: '用技能' });
    expect(res1.status).toBe(200);
    const { sessionId } = (await res1.json()) as { sessionId: string };
    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 9, 10_000);
    expect(client.frames.map((f) => f.event)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'tool-start',
      'tool-result',
      'assistant-delta',
      'assistant-done',
      'usage',
      'run-status',
    ]);
    const result = client.frames[4]!.data as ToolResultFrame;
    expect(result).toMatchObject({ name: 'use_skill', ok: false });
    // 协议 error 字段 = 人类可读 message（类型只在 content 的 JSON 载荷里——emit.ts 契约）
    expect(result.error).toContain('is disabled');
    // 错误回注 content 恒为合法 JSON 且带可用技能清单（当前 enabled = 空）
    const parsed = JSON.parse(result.contentPreview) as {
      error: { type: string; available_skills: string[] };
    };
    expect(parsed.error.type).toBe('skill-disabled');
    expect(parsed.error.available_skills).toEqual([]);

    // workflow 关闭：spawn_subagent 立即拒绝（池 config 闭包经 attachWorkflowConfig 现读）
    const wf = await postJson(base, '/api/workflow', { subagentsEnabled: false });
    expect(wf.status).toBe(200);
    const res2 = await postJson(base, '/api/chat', { sessionId, text: '开子代理' });
    expect(res2.status).toBe(200);
    await waitForFrames(client, 18, 10_000);
    const second = client.frames[13]!.data as ToolResultFrame;
    expect(second).toMatchObject({ name: 'spawn_subagent', ok: false });
    expect(second.error).toContain('disabled in the workflow settings');
    const subParsed = JSON.parse(second.contentPreview) as { error: { type: string } };
    expect(subParsed.error.type).toBe('subagents-disabled');
    expect(pool.spawned).toEqual([]); // 关闭即拒：池未收到任何 spawn（零触网）

    // stats：pool 接线 → queuedSubagents 字段在（P2 视图）
    const stats = (await (await fetch(new URL('/api/stats', base))).json()) as Record<
      string,
      unknown
    >;
    expect(stats.queuedSubagents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E2E-D：全程无泄漏（api key 掩码 · stats 内存字段 · MCP 空配置）
// ---------------------------------------------------------------------------

describe('E2E-D：全程无泄漏（api key 掩码 · 内存统计字段）', () => {
  let dir: string;
  let handle: TestServerHandle | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devmate-e2e-d-'));
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 'sessions'),
      model: 'deepseek-v4-flash',
      // 初始密钥：仅进程内持有；GET /api/settings 只回掩码
      apiKey: 'sk-0123456789abcdef',
      // 空 MCP 配置：无服务器 → 无任何 launcher 连接（零外部网络面）
      mcpServers: [],
    });
    deps.llm = new FakeLlm([{ content: 'x' }]);
    handle = await startServer(deps);
  });

  afterEach(async () => {
    await handle?.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('D1) POST /api/settings 后 GET 密钥只回掩码（无原文）；stats 内存字段在；MCP 空配置', async () => {
    const base = handle!.base;

    // 初值（组装注入的密钥）已掩码
    const initial = (await (await fetch(new URL('/api/settings', base))).json()) as {
      apiKey?: string;
    };
    expect(initial.apiKey).toBe('sk-0****cdef');

    // POST 触碰到新密钥 → 响应即掩码；GET 再读仍掩码；全文无原文
    const SECRET = 'sk-SUPERSECRET-0123456789';
    const posted = await postJson(base, '/api/settings', { apiKey: SECRET });
    expect(posted.status).toBe(200);
    const postedBody = JSON.stringify(await posted.json());
    expect(postedBody).toContain('sk-S****6789');
    expect(postedBody).not.toContain(SECRET);
    expect(postedBody).not.toContain('SUPERSECRET');

    const got = (await (await fetch(new URL('/api/settings', base))).json()) as Record<
      string,
      unknown
    >;
    expect(got.apiKey).toBe('sk-S****6789');
    expect(JSON.stringify(got)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(got)).not.toContain('0123456789');

    // stats：内存字段在（单次采样 + 守卫状态）；会话 0；MCP 空配置（0 服务器 0 工具）
    const stats = (await (await fetch(new URL('/api/stats', base))).json()) as Record<
      string,
      unknown
    >;
    expect(typeof stats.rssMb).toBe('number');
    expect((stats.rssMb as number) > 0).toBe(true);
    expect(typeof stats.heapMb).toBe('number');
    expect((stats.heapMb as number) > 0).toBe(true);
    expect(stats.memoryGuard).toMatchObject({ tripped: false, lastAt: null, reason: null });
    expect(stats.sessions).toBe(0);
    expect(stats.activeShells).toBe(0);
    expect(stats.mcpServers).toBe(0);
    expect(stats.mcpTools).toBe(0);
    expect(JSON.stringify(stats)).not.toContain('SUPERSECRET');

    const mcp = (await (await fetch(new URL('/api/mcp', base))).json()) as {
      servers: unknown[];
    };
    expect(mcp.servers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E2E-F：CLI web 读回种子（settings 三键：写 → 重启同文件重读 → GET /api/settings）
// ---------------------------------------------------------------------------

describe('E2E-F：CLI web 设置读回（permission/reasoning/windowTokens）', () => {
  const closes: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closes.splice(0)) await close();
  });

  it('F1) 三键持久写盘 → runWeb 重启（同文件重读）→ GET /api/settings 反映持久值；清键 → 缺省保持', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-e2e-f-'));
    const configPath = join(dir, '.devmate', 'config.json');
    // 模拟上一进程 Write 路径（POST /api/settings → persistSettings → mergeConfig 单点合并写）
    mergeConfig(configPath, {
      baseUrl: 'https://persist.example/v1',
      model: 'deepseek-v4-flash',
      reasoning: 'high',
      permission: 'full-access',
      windowTokens: 24_000,
    });
    try {
      const start = async (): Promise<{ base: string; close: () => Promise<void> }> => {
        const printed: string[] = [];
        let signal: (() => void | Promise<void>) | undefined;
        const code = await runWeb(['--no-open'], {
          cwd: dir,
          env: {},
          configPath,
          platform: 'linux',
          isDir: (p) => existsSync(p),
          findOnPath: () => true,
          openBrowser: () => undefined,
          loadServerModule: async () => ({ assembleDeps, createDevmateServer }),
          println: (line) => {
            printed.push(line);
          },
          printErr: (line) => {
            printed.push(`ERR:${line}`);
          },
          setSignalHandler: (cb) => {
            signal = cb;
          },
        });
        expect(code).toBe(0);
        expect(signal).toBeTypeOf('function');
        const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(printed.join('\n'));
        expect(match).not.toBeNull();
        return {
          base: `http://127.0.0.1:${match![1]!}`,
          close: async () => {
            await signal!();
          },
        };
      };

      // 重启 #1：同文件（configPath）重读 → 持久三键进入 assembleDeps settings → GET 同值
      const first = await start();
      closes.push(first.close);
      const settings1 = (await (await fetch(new URL('/api/settings', first.base))).json()) as {
        reasoning: string;
        permission: string;
        window?: number;
      };
      expect(settings1).toMatchObject({
        reasoning: 'high',
        permission: 'full-access',
        window: 24_000,
      });
      await first.close();

      // 重启 #2：清键（mergeConfig undefined = 删除键）→ 缺省保持（medium/workspace-write/preset 估算）
      mergeConfig(configPath, {
        reasoning: undefined,
        permission: undefined,
        windowTokens: undefined,
      });
      const second = await start();
      closes.push(second.close);
      const settings2 = (await (await fetch(new URL('/api/settings', second.base))).json()) as {
        reasoning: string;
        permission: string;
        window: number;
      };
      expect(settings2).toMatchObject({
        reasoning: 'medium',
        permission: 'workspace-write',
        window: 64_000, // deepseek preset contextWindowTokens 估算（settings 未覆盖）
      });
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
