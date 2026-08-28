/**
 * # test/ui-server/deps-tools：Workflow 工具面接线（技能 + 子代理入主循环）
 *
 * 覆盖（assembleDeps 装配级 + 真实服务端构造级）：
 * - 工具面共 9 个：6 文件工具 + run_command + use_skill + spawn_subagent（fs/shell 后追加）；
 * - 技能索引晚绑定：服务端（createDevmateServer）从自身索引缓存组装 SkillsIndex 回填
 *   （attachSkillsIndex）——use_skill 经真实 SKILL.md 资产成功加载 / 开关后 skill-disabled；
 * - 系统提示合成（composeSystemPrompt）：基础提示 + 技能清单节（enabled 一行一条、
 *   需要时 use_skill 加载全文）+ 子代理节（并行上限 N）；disabled 不入清单；预算感知
 *   （超预算裁技能清单，base 永不裁）；config.systemPrompt 作基础提示延续；
 * - workflow 联动：POST /api/workflow 变更后 compose 现读 getter（子代理节出现/消失）、
 *   spawn_subagent 经池 config 闭包现读（disabled 时立即拒绝，绝不触网）。
 * 全程零真实网络：spawn 只测 disabled 路径（enabled 才可能触网——那是池单测的活）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleDeps } from '../../src/ui/server/deps.js';
import {
  composeSystemPrompt,
  DEV_BASE_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS,
} from '../../src/ui/server/deps.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import type { SkillsIndex } from '../../src/core/tools/skill.js';
import type { McpCallResult, McpClient } from '../../src/core/mcp/client.js';
import { postJson, startServer } from './support.js';

const FS_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep'];

describe('ui/server/deps-tools：技能/子代理接线', () => {
  const tempDirs: string[] = [];
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-deps-tools-'));
    tempDirs.push(dir);
    return dir;
  }

  async function writeSkill(
    skillsDir: string,
    id: string,
    name: string,
    summary: string,
    body: string,
  ): Promise<void> {
    const dir = join(skillsDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${summary}\n---\n${body}`,
    );
  }

  it('D1) 注册表 9 工具：fs 六个 + run_command + use_skill + spawn_subagent（fs/shell 后追加）', async () => {
    const dir = await tempDir();
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 's'),
      model: 'm',
    });
    const names = deps.createSessionTools!('d1')
      .list()
      .map((def) => def.name);
    expect(names).toEqual([...FS_TOOLS, 'run_command', 'use_skill', 'spawn_subagent']);
    await deps.dispose?.();
  });

  it('D5) MCP 接线（假连接固定工具面）：9 基础 + mcp 2（appended）；disabled 无；mcpToolCount 传递；连接失败 → 0 工具不炸', async () => {
    const dir = await tempDir();
    // 假连接：enabled 的 server → 固定 2 工具；失败态 connect 抛错（连接失败路径）
    const closed: number[] = [];
    const toolFor = (): McpClient => ({
      name: 'search',
      async tools() {
        return [
          {
            name: 'web_search',
            description: 'Search the internet',
            inputSchema: { type: 'object' },
          },
          { name: 'fetch_url', description: 'Fetch a URL', inputSchema: { type: 'object' } },
        ];
      },
      async call(): Promise<McpCallResult> {
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
      async close(): Promise<void> {
        closed.push(1);
      },
      isDead(): boolean {
        return false;
      },
    });
    const connect = vi.fn(async (spec: { name: string; enabled: boolean }) =>
      spec.enabled ? toolFor() : null,
    );
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 's'),
      model: 'm',
      mcpServers: [
        { name: 'search', command: 'npx', args: [], enabled: true },
        { name: 'off', command: 'x', args: [], enabled: false },
      ],
      mcpConnect: connect,
    });

    // 组装：composeRunTools 每次现装（base 9 + mcp 2；disabled 服务器不产生工具）
    const base = deps.createSessionTools!('d5');
    expect(base.list().map((d) => d.name)).toEqual([
      ...FS_TOOLS,
      'run_command',
      'use_skill',
      'spawn_subagent',
    ]);
    const merged = await deps.composeRunTools!(base, 'd5');
    expect(merged.list().map((d) => d.name)).toEqual([
      ...FS_TOOLS,
      'run_command',
      'use_skill',
      'spawn_subagent',
      'mcp_search_web_search',
      'mcp_search_fetch_url',
    ]);
    expect(connect).toHaveBeenCalledTimes(1); // 只连 enabled 的 search
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ name: 'search' }));
    expect(deps.mcpToolCount!()).toBe(2);

    // mcp 工具同表可执行（fake call 直达）
    const r = await merged.execute({
      id: 'c1',
      name: 'mcp_search_web_search',
      arguments: '{}',
    });
    expect(r).toEqual({ ok: true, content: 'ok' });

    // 服务端接线：GET /api/tools（真实服务器，经 composeRunTools 合并同表）+ stats 计数
    const { base: baseUrl, server } = await startServer(deps, 0);
    servers.push(server);
    const toolsBody = (await (await fetch(new URL('/api/tools', baseUrl))).json()) as {
      tools: Array<{ name: string }>;
    };
    expect(toolsBody.tools.map((d) => d.name)).toEqual(
      expect.arrayContaining(['mcp_search_web_search', 'mcp_search_fetch_url', 'run_command']),
    );
    expect(toolsBody.tools.some((d) => d.name.startsWith('mcp_off_'))).toBe(false);
    const stats = (await (await fetch(new URL('/api/stats', baseUrl))).json()) as Record<
      string,
      unknown
    >;
    expect(stats.mcpServers).toBe(2); // 配置数（含 disabled）
    expect(stats.mcpTools).toBe(2);

    // 连接失败路径（单独装配）：0 个 mcp 工具 + 计数 0，工具面与 stats 不炸
    const bad = await assembleDeps({
      workspaceRoot: dir,
      model: 'm',
      mcpServers: [{ name: 'dead', command: 'nope', args: [], enabled: true }],
      mcpConnect: async () => {
        throw new Error('spawn failed');
      },
    });
    const badMerged = await bad.composeRunTools!(bad.createSessionTools!('b1'), 'b1');
    expect(badMerged).toBe(bad.createSessionTools!('b1')); // 0 工具 → base 原样（不包层）
    expect(bad.mcpToolCount!()).toBe(0);

    // 关闭：launcher dispose 关闭已连客户端（进程无残留——假客户端 close 计数）
    await deps.dispose?.();
    expect(closed.length).toBe(1);
  });

  it('D2) 技能索引晚绑定（服务端缓存单源）：use_skill 成功加载全文；开关后 skill-disabled；disabled 不入系统提示清单', async () => {
    const dir = await tempDir();
    const skillsDir = join(dir, 'skills');
    await writeSkill(
      skillsDir,
      'alpha',
      'Alpha asset',
      'An alpha asset for tests.',
      'ALPHA BODY\nline2',
    );
    await writeSkill(skillsDir, 'beta', 'Beta asset', 'A beta asset for tests.', 'BETA BODY');
    const deps = await assembleDeps({ workspaceRoot: dir, skillsDir, model: 'm' });
    const { base, server } = await startServer(deps, 0);
    servers.push(server);

    const registry = deps.createSessionTools!('s-k');
    // 成功加载（索引由服务端扫描——工具未自己扫描）
    const okR = await registry.execute({
      id: 'c1',
      name: 'use_skill',
      arguments: JSON.stringify({ skill: 'alpha' }),
    });
    // 全文含 frontmatter 原样（SKILL.md 全文即工具契约，未加工）
    expect(okR).toEqual({
      ok: true,
      content:
        '---\nname: Alpha asset\ndescription: An alpha asset for tests.\n---\nALPHA BODY\nline2',
    });

    // 开关（POST /api/skills）：随后工具经同一状态现读 → skill-disabled
    await postJson(base, '/api/skills/alpha', { enabled: false });
    const offR = await registry.execute({
      id: 'c2',
      name: 'use_skill',
      arguments: JSON.stringify({ skill: 'alpha' }),
    });
    expect(offR).toMatchObject({ ok: false, error: { type: 'skill-disabled' } });
    expect(
      (JSON.parse(offR.content) as { error: { available_skills: string[] } }).error
        .available_skills,
    ).toEqual(['beta']);

    // 系统提示：含 enabled 清单（beta 一行一条 + 末尾「需要时 use_skill 加载全文」），disabled（alpha）不入
    const prompt = await deps.composeSystemPrompt!();
    expect(prompt).toContain('## 可用技能');
    expect(prompt).toContain('- Beta asset（A beta asset for tests.） [id=beta]');
    expect(prompt).toContain('需要时用 use_skill 加载全文。');
    expect(prompt).not.toContain('Alpha asset');
  });

  it('D3) workflow 联动：POST /api/workflow 变更后 compose 现读（子代理节出现/消失），spawn_subagent 经池 config 闭包现读（关闭时立即拒绝，不触网）', async () => {
    const dir = await tempDir();
    const deps = await assembleDeps({
      workspaceRoot: dir,
      model: 'm',
      workflow: { subagentsEnabled: true, maxParallel: 2 },
    });
    const { base, server } = await startServer(deps, 0);
    servers.push(server);

    // 初值 enabled：子代理节在
    expect(await deps.composeSystemPrompt!()).toContain('## 子代理');
    let prompt = await deps.composeSystemPrompt!();
    expect(prompt).toContain('并行上限 2');

    // 关闭（POST /api/workflow）：compose 节消失 + spawn 立即拒绝（disabled 检查先于任何 llm 调用）
    await postJson(base, '/api/workflow', { subagentsEnabled: false });
    prompt = await deps.composeSystemPrompt!();
    expect(prompt).not.toContain('## 子代理');
    const registry = deps.createSessionTools!('s-w');
    const spawnR = await registry.execute({
      id: 'c1',
      name: 'spawn_subagent',
      arguments: JSON.stringify({ prompt: '独立子任务' }),
    });
    expect(spawnR).toMatchObject({ ok: false, error: { type: 'subagents-disabled' } });

    // 再打开：子代理节即刻复现（getter 动态读取——每次 run 前合成即生效）
    await postJson(base, '/api/workflow', { subagentsEnabled: true });
    prompt = await deps.composeSystemPrompt!();
    expect(prompt).toContain('## 子代理');
    expect(prompt).toContain('并行上限 2');
    // 队列统计接缝（池 stats 联动）
    expect(await deps.queuedSubagentCount!()).toBe(0);
  });

  it('D4) composeSystemPrompt：base（中文起草）延续 + 预算感知（超预算裁技能清单，base 永不裁）+ config.systemPrompt 作基础', async () => {
    const skills: SkillsIndex = {
      async list() {
        return [
          { id: 'a', name: 'A', summary: 'summary a', enabled: true },
          { id: 'b', name: 'B', summary: 'summary b', enabled: false },
          { id: 'c', name: 'C', summary: 'summary c', enabled: true },
        ];
      },
      async content() {
        return null;
      },
      async setEnabled() {
        return false;
      },
    };
    const workflow = () => ({ subagentsEnabled: true, maxParallel: 3 });
    // 全量：名==id 的行不带 [id=…]
    const full = await composeSystemPrompt({ skills: () => skills, workflow });
    expect(full).toContain(DEV_BASE_SYSTEM_PROMPT.slice(0, 40));
    expect(full).toContain('- A（summary a）');
    expect(full).toContain('- C（summary c）');
    expect(full).not.toContain('summary b'); // disabled 不入清单
    expect(full).toContain('并行上限 3');

    // 预算极小：技能清单整体裁掉，base 保留（base 永不裁——安全/行为规则优先）
    const shrunk = await composeSystemPrompt({ skills: () => skills, workflow, budgetTokens: 100 });
    expect(shrunk).not.toContain('## 可用技能');
    expect(shrunk).toContain(DEV_BASE_SYSTEM_PROMPT.slice(0, 40));
    expect(DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS).toBeGreaterThan(0);

    // 子代理关闭：节消失
    const noSub = await composeSystemPrompt({
      skills: () => skills,
      workflow: () => ({ subagentsEnabled: false, maxParallel: 3 }),
    });
    expect(noSub).not.toContain('## 子代理');

    // config.systemPrompt 作为基础提示延续（assembleDeps 装配）
    const dir = await tempDir();
    const deps = await assembleDeps({
      workspaceRoot: dir,
      model: 'm',
      systemPrompt: 'CUSTOM-RULES',
    });
    const composed = await deps.composeSystemPrompt!();
    expect(composed).toContain('CUSTOM-RULES');
    expect(composed).not.toContain(DEV_BASE_SYSTEM_PROMPT.slice(0, 40));
  });
});
