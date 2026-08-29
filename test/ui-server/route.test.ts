/**
 * # test/ui-server/route：方法论路由（R2-S1）语义与提示词节 + methodFirst 设置链
 *
 * 覆盖：
 * - matchMethodologyTask 纯函数：单中 / 多中先列表优先 / 无中 null / 大小写与空格容错；
 * - createMethodologyGate 语义：参考型（reference）不进路由；disabled 技能不被 route；
 *   isLoaded/markLoaded 往返；索引未回填 → 不命中；
 * - compose 的路由节：method 型 enabled 一行 `<trigger> → <id>`（参考型/disabled 不出现）、
 *   三行规则（亮牌/先加载/收尾判据）；节内 ≤ METHODOLOGY_SECTION_TOKEN_BUDGET（超出删
 *   trigger 最长的行；确定性）；合成 ≤4096（路由节并入预算）；
 * - 服务端全链（真实 server + tmp skillsDir + methodologies.json + get 开关）：命中→拦截、
 *   POST /api/skills/:id false 后不再命中（disabled 不被 route）、methodFirst:false → 门关闭；
 * - settings：methodFirst GET 缺省 true；POST 校验（非 boolean → 400）；persist 触碰语义。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { MethodologyGate, Tool } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { MethodologyIndex } from '../../src/shared/methodology.js';
import { estimateTokens } from '../../src/core/context/index.js';
import {
  composeSystemPrompt,
  createMethodologyGate,
  matchMethodologyTask,
  METHODOLOGY_SECTION_TOKEN_BUDGET,
  methodologyRouteSection,
  splitMethodologyTriggers,
} from '../../src/ui/server/deps.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import type { SkillsIndex } from '../../src/core/tools/skill.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from './support.js';

// ---------------------------------------------------------------------------
// 路由纯函数（语义版：触发词 split / 任一命中→id；多命中先列优先；大小写与空格容错）
// ---------------------------------------------------------------------------

describe('ui/server/route：路由纯函数', () => {
  it('r1) 单中：任一触发词命中（子串）→ id；无中 → null', () => {
    const entries = [
      { id: 'tdd', triggers: ['修复 bug', '新增功能', 'test-first'] },
      { id: 'diagnosing-bugs', triggers: ['bug 定位'] },
    ];
    expect(matchMethodologyTask('帮我修复 bug 报告', entries)).toBe('tdd');
    expect(matchMethodologyTask('要求实现新增功能', entries)).toBe('tdd');
    expect(matchMethodologyTask('write a test-first loop', entries)).toBe('tdd');
    expect(matchMethodologyTask('有 bug 定位的问题', entries)).toBe('diagnosing-bugs');
    expect(matchMethodologyTask('查资料写文档', entries)).toBeNull();
    expect(matchMethodologyTask('', entries)).toBeNull();
  });

  it('r2) 多中先优先：数组顺序即优先级（先列先得；重排后结果随之翻转）', () => {
    const table = (lead: string) => [
      { id: lead, triggers: ['评审', '代码质量'] },
      { id: 'tdd', triggers: ['修复 bug'] },
    ];
    expect(matchMethodologyTask('修复 bug 之后评审一下', table('code-review'))).toBe('code-review');
    expect(matchMethodologyTask('修复 bug 之后评审一下', table('tdd'))).toBe('tdd');
    // 同一技能多触发词命中：槽位不重复命中（返回首槽）
    expect(
      matchMethodologyTask('代码质量 评审', [
        { id: 'code-review', triggers: ['评审', '代码质量'] },
      ]),
    ).toBe('code-review');
  });

  it('r3) 大小写与空白容错：case-insensitive；触发词与任务文本的连续空白忽略', () => {
    const entries = [{ id: 'tdd', triggers: ['修复 bug', 'Red-Green'] }];
    expect(matchMethodologyTask('修复  bug！', entries)).toBe('tdd'); // 双空格
    expect(matchMethodologyTask('修复bug', entries)).toBe('tdd'); // 无空格
    expect(matchMethodologyTask(' 修复 bug ', entries)).toBe('tdd'); // 牵引空白
    expect(matchMethodologyTask('do red-green anywhere', entries)).toBe('tdd');
    expect(matchMethodologyTask('RED.green', entries)).toBeNull();
    // 空白触发词（缺键/空串）不崩
    expect(matchMethodologyTask('修复 bug', [{ id: 'x', triggers: ['', '  '] }])).toBeNull();
  });

  it('r4) 触发词拆分：/ 分隔、trim、去空', () => {
    expect(splitMethodologyTriggers('修复 bug/新增功能/ test-first ')).toEqual([
      '修复 bug',
      '新增功能',
      'test-first',
    ]);
    expect(splitMethodologyTriggers('')).toEqual([]);
    expect(splitMethodologyTriggers(undefined)).toEqual([]);
    expect(splitMethodologyTriggers(' / / ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 前置门语义（createMethodologyGate + 假索引）
// ---------------------------------------------------------------------------

function indexOf(
  entries: Array<{ id: string; type: 'method' | 'reference'; trigger?: string; enabled: boolean }>,
): MethodologyIndex {
  const list = entries.map((entry) => ({
    id: entry.id,
    enabled: entry.enabled,
    methodology: {
      type: entry.type,
      ...(entry.trigger !== undefined ? { trigger: entry.trigger } : {}),
    },
  }));
  return {
    async list() {
      return list;
    },
  };
}

describe('ui/server/route：前置门语义（gate 装配路由侧）', () => {
  it('g1) 参考型不进路由：type reference 命中触发词也返回 null；index 未回填 → null', async () => {
    const gate = createMethodologyGate({
      index: () =>
        indexOf([
          { id: 'ask-matt', type: 'reference', trigger: '技能路由', enabled: true },
          { id: 'tdd', type: 'method', trigger: '修复 bug', enabled: true },
        ]),
    });
    expect(await gate.route('不知道该用哪个技能 技能路由')).toBeNull();
    expect(await gate.route('修复 bug 报告')).toBe('tdd');

    const emptyGate = createMethodologyGate({ index: () => null });
    expect(await emptyGate.route('修复 bug')).toBeNull();
  });

  it('g2) disabled 技能不被 route：enabled:false 的 method 命中触发词也返回 null；开启后恢复', async () => {
    let enabled = false;
    const index: MethodologyIndex = {
      async list() {
        return [
          {
            id: 'tdd',
            enabled,
            methodology: { type: 'method', trigger: '修复 bug' },
          },
        ];
      },
    };
    const gate = createMethodologyGate({ index: () => index });
    expect(await gate.route('修复 bug')).toBeNull();
    enabled = true;
    expect(await gate.route('修复 bug')).toBe('tdd');
  });

  it('g3) isLoaded/markLoaded 往返 + 跨会话隔离；路由故障（list 抛错）→ null', async () => {
    const loaded = new Set<string>();
    const gate: MethodologyGate = {
      async route() {
        return 'tdd';
      },
      isLoaded(sessionId, id) {
        return loaded.has(`${sessionId}:${id}`);
      },
      markLoaded(sessionId, id) {
        loaded.add(`${sessionId}:${id}`);
      },
    };
    expect(gate.isLoaded('s1', 'tdd')).toBe(false);
    gate.markLoaded('s1', 'tdd');
    expect(gate.isLoaded('s1', 'tdd')).toBe(true);
    expect(gate.isLoaded('s2', 'tdd')).toBe(false);

    const broken = createMethodologyGate({
      index: () => ({
        async list() {
          throw new Error('boom');
        },
      }),
    });
    expect(await broken.route('修复 bug')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 提示词节（composeSystemPrompt 方法论路由节 + 预算）
// ---------------------------------------------------------------------------

describe('ui/server/route：提示词路由节', () => {
  const wrapPrompt = (text: string): number =>
    estimateTokens([{ role: 'system', content: text }]).tokens;

  it('p1) 节内一行一条 method 型（enabled）：`- <trigger> → <id>`；参考型/disabled 不进；三行规则在', async () => {
    const skills: SkillsIndex = {
      async list() {
        return [
          { id: 'tdd', name: 'tdd', summary: 's', enabled: true },
          { id: 'ask-matt', name: 'ask-matt', summary: 's', enabled: true },
        ];
      },
      async content() {
        return null;
      },
      async setEnabled() {
        return false;
      },
    };
    const methodologies = () =>
      indexOf([
        { id: 'tdd', type: 'method', trigger: '修复 bug/新增功能', enabled: true },
        { id: 'ask-matt', type: 'reference', trigger: '技能路由', enabled: true },
        { id: 'to-tickets', type: 'method', trigger: '拆票', enabled: false },
      ]);
    const out = await composeSystemPrompt({
      skills: () => skills,
      methodologies,
      workflow: () => ({ subagentsEnabled: true, maxParallel: 2 }),
    });
    expect(out).toContain('## 方法论路由');
    expect(out).toContain('- 修复 bug/新增功能 → tdd');
    expect(out).not.toContain('- 技能路由 → ask-matt'); // 参考型不进路由
    expect(out).not.toContain('- 拆票 → to-tickets'); // disabled 不进路由
    // 三行规则
    expect(out).toContain('方法线：<id>');
    expect(out).toContain('首个工具调用前先 use_skill');
    expect(out).toContain('done');
    expect(out).toContain('## 可用技能');
    expect(out).toContain('## 子代理');
    expect(wrapPrompt(out)).toBeLessThanOrEqual(4096);
  });

  it('p2) 节内预算 ≤350：超预算删 trigger 最长的行（短行存活、长行先删）；确定性', async () => {
    const lines = [
      '- 短触 → keep',
      ...Array.from({ length: 40 }, (_, i) => `- ${'长触发词'.repeat(20)} ${i} → skill-${i}`),
    ];
    const section = methodologyRouteSection(lines);
    expect(section).not.toBe('');
    expect(section).toContain('- 短触 → keep'); // 短 trigger 存活
    expect((section.match(/skill-\d+/g) ?? []).length).toBeLessThan(40); // 长行被裁
    expect(wrapPrompt(section)).toBeLessThanOrEqual(METHODOLOGY_SECTION_TOKEN_BUDGET);
    expect(section).toBe(methodologyRouteSection(lines)); // 同输入必同输出
    expect(methodologyRouteSection([])).toBe('');
  });

  it('p3) 合成预算：方法论路由节并入预算链——极端清单 + 全量路由行 ≤4096、base 完整、路由节整体在场', async () => {
    const { readFile } = await import('node:fs/promises');
    const metaRaw = JSON.parse(
      await readFile(join(process.cwd(), 'assets', 'skills-meta.json'), 'utf8'),
    ) as Record<string, { type: string; trigger?: string }>;
    const entries = Object.entries(metaRaw).map(([id, meta]) => ({
      id,
      enabled: true,
      methodology: {
        type: meta.type as 'method' | 'reference',
        ...(meta.trigger !== undefined ? { trigger: meta.trigger } : {}),
      },
    }));
    const methodologies = (): MethodologyIndex => ({
      async list() {
        return entries;
      },
    });
    const long = (prefix: string, n: number): string => prefix + 'x'.repeat(n);
    const skills: SkillsIndex = {
      async list() {
        return Array.from({ length: 100 }, (_, i) => ({
          id: long(`id_${i}_`, 40),
          name: long(`Name ${i} `, 40),
          summary: long(`Summary ${i} `, 160),
          enabled: true,
        }));
      },
      async content() {
        return null;
      },
      async setEnabled() {
        return false;
      },
    };
    const out = await composeSystemPrompt({
      skills: () => skills,
      methodologies,
      workflow: () => ({ subagentsEnabled: true, maxParallel: 4 }),
    });
    expect(wrapPrompt(out)).toBeLessThanOrEqual(4096);
    expect(out).toContain('## 方法论路由'); // 路由节独立预算（≤350），不在主裁剪链上丢失
    expect(out).toContain('- 修复 bug/新增功能/行为变化/test-first/red-green/集成测试 → tdd');
  });
});

// ---------------------------------------------------------------------------
// 服务端全链（真实 server：methodologies.json × 开关 × methodFirst）
// ---------------------------------------------------------------------------

function probeTool(executions: string[]): Tool {
  return {
    name: 'probe',
    description: 'A tool that always succeeds.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      executions.push('probe');
      return { ok: true, content: 'probe:ok' };
    },
  };
}

/** 语义门装配（与 assembleDeps 同构：晚绑定索引 + 注入 runOptions.methodology）。 */
function methodDeps(options: {
  skillsDir: string;
  llm: FakeLlm;
  executions: string[];
  persistSettings?: (s: unknown) => void;
}): DevmateServerDeps {
  const idxRef: { index: MethodologyIndex | null } = { index: null };
  const gate = createMethodologyGate({ index: () => idxRef.index });
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([probeTool(options.executions)], { sessionId: 's1' }),
    llm: options.llm,
    model: 'test-model',
    skillsDir: options.skillsDir,
    attachMethodologyIndex: (index) => {
      idxRef.index = index;
    },
    runOptions: { methodology: gate },
    // 系统提示合成（与 assembleDeps 同构；路由节经晚绑定方法论索引）
    composeSystemPrompt: () =>
      composeSystemPrompt({
        skills: () => null,
        methodologies: () => idxRef.index,
        workflow: () => ({ subagentsEnabled: true, maxParallel: 2 }),
      }),
    ...(options.persistSettings !== undefined ? { persistSettings: options.persistSettings } : {}),
  };
}

async function writeSkillBundle(skillsDir: string): Promise<void> {
  await mkdir(join(skillsDir, 'tdd'), { recursive: true });
  await writeFile(
    join(skillsDir, 'tdd', 'SKILL.md'),
    '---\nname: tdd\ndescription: TDD loop.\n---\nTDD BODY',
  );
  await writeFile(
    join(skillsDir, 'methodologies.json'),
    JSON.stringify({
      tdd: { type: 'method', trigger: '修复 bug/新增功能', steps: '红先绿', done: '每片红→绿' },
      'ask-matt': { type: 'reference', trigger: '技能路由', steps: '', done: '' },
    }),
  );
}

describe('ui/server/route：服务端全链（真实 server × methodologies.json × 开关）', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];
  const clients: SseClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-route-'));
    tempDirs.push(dir);
    return dir;
  }

  it('s1) 命中→拦截（tool-result 为 methodology-first 且 probe 从未执行）；系统提示带路由节；关闭开关后放行', async () => {
    const skillsDir = await tempDir();
    await writeSkillBundle(skillsDir);
    const executions: string[] = [];
    const llm = new FakeLlm([
      { content: '直接改', toolCalls: [{ id: 'p1', name: 'probe', arguments: '{}' }] },
      { content: 'd1' },
      { content: '继续改', toolCalls: [{ id: 'p1', name: 'probe', arguments: '{}' }] },
      { content: 'd2' },
    ]);
    const { base, server } = await startServer(methodDeps({ skillsDir, llm, executions }));
    servers.push(server);

    // 首轮：命中未加载 → probe 不执行（内容 JSON = methodology-first）
    const created = (await (
      await postJson(base, '/api/chat', { text: '修复 bug 报告' })
    ).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 8, 10_000); // 拦截轮无 tool-start（工具未触达）→ 8 帧
    const resultFrame = client.frames.find((f) => f.event === 'tool-result')?.data as {
      ok: boolean;
      content: string;
      contentPreview: string;
    };
    expect(resultFrame).toBeDefined();
    // contentPreview 为截断预览（带省略号）；完整载荷在 content
    expect(JSON.parse(resultFrame.content)).toMatchObject({
      ok: false,
      error: { type: 'methodology-first', message: expect.stringContaining('use_skill(tdd)') },
    });
    expect(executions).toEqual([]); // 工具未真执行
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({
      status: 'completed',
    });
    // 系统提示：路由节一行 + 规则；参考型不进路由
    const prompt = String(llm.requests[0]!.messages[0]!.content);
    expect(prompt).toContain('## 方法论路由');
    expect(prompt).toContain('- 修复 bug/新增功能 → tdd');
    expect(prompt).not.toContain('ask-matt');
    expect(prompt).toContain('方法线：<id>');

    // 关掉技能（disabled 不被 route）→ 同任务再次 run：probe 执行
    await postJson(base, '/api/skills/tdd', { enabled: false });
    const created2 = (await (
      await postJson(base, '/api/chat', { sessionId: created.sessionId, text: '继续修复 bug' })
    ).json()) as { sessionId: string };
    expect(created2.sessionId).toBe(created.sessionId);
    await waitForFrames(client, 13, 10_000); // 第二轮 tool-result（idx12，有 tool-start）→ 执行已发生
    expect(executions).toEqual(['probe']);
  });

  it('s2) methodFirst:false → 门关闭（路由命中也直接执行）；settings 缺省 true、POST 校验与触碰持久化', async () => {
    const skillsDir = await tempDir();
    await writeSkillBundle(skillsDir);
    const executions: string[] = [];
    const llm = new FakeLlm([
      { content: '直接改', toolCalls: [{ id: 'p1', name: 'probe', arguments: '{}' }] },
      { content: 'done' },
    ]);
    const persisted: Array<Record<string, unknown>> = [];
    const depsObj = methodDeps({
      skillsDir,
      llm,
      executions,
      persistSettings: (s) => {
        persisted.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
      },
    });
    const { base, server } = await startServer(depsObj);
    servers.push(server);

    // settings：缺省 methodFirst:true
    const initial = (await (await fetch(new URL('/api/settings', base))).json()) as {
      methodFirst: boolean;
    };
    expect(initial.methodFirst).toBe(true);

    // 未触碰不带键（补丁语义）；触碰后携带
    await postJson(base, '/api/settings', { model: 'm1' });
    expect(persisted[0]).toEqual({ baseUrl: '', model: 'm1' });
    const off = await postJson(base, '/api/settings', { methodFirst: false });
    expect(off.status).toBe(200);
    expect(persisted[1]).toEqual({ baseUrl: '', model: 'm1', methodFirst: false });
    expect(((await off.json()) as { methodFirst: boolean }).methodFirst).toBe(false);

    const bad = await postJson(base, '/api/settings', { methodFirst: 'yes' });
    expect(bad.status).toBe(400);

    // methodFirst:false → startRun 删除门 → 路由命中任务也直接执行
    const created = (await (
      await postJson(base, '/api/chat', { text: '修复 bug 报告' })
    ).json()) as {
      sessionId: string;
    };
    const client = await SseClient.connect(base, created.sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    const resultFrame = client.frames.find((f) => f.event === 'tool-result')?.data as {
      ok: boolean;
      contentPreview: string;
    };
    expect(resultFrame.ok).toBe(true);
    expect(resultFrame.contentPreview).toContain('probe:ok');
    expect(executions).toEqual(['probe']);
  });
});
