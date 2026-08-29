/**
 * # test/ui-server/skills：Skills 资产索引 + 运行时开关（波 B：端点契约 A1）
 *
 * GET /api/skills → {skills:[{id,name,summary,enabled,origin}]}：数据源 = deps.skillsDir 下的
 * <id>/SKILL.md frontmatter（name；description 首行 → summary；缺失降级：name=id、summary=''）；
 * origin 缺省 'bundled'（用户技能安装的合并视图见 skills-install.test.ts；本文件只测 bundled）；
 * 目录不存在/空目录 → 空列表；只含 SKILL.md 的目录进索引。索引缓存（打包资产静态不变）。
 * POST /api/skills/:id {enabled} → 运行时开关（全量开关表经 saveSkillsConfig 持久化到
 * ~/.devmate/config.json 的 skills 节；无则仅内存）；未知 id → 404；enabled 非 boolean → 400；
 * 全文（SKILL.md 内容）绝不下发。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, startServer } from './support.js';

async function baseDeps(extra: Partial<DevmateServerDeps> = {}): Promise<DevmateServerDeps> {
  // 用户技能目录注入空 tmp（缺省 ~/.devmate/skills 不入测试域——只测 bundled 视图）
  const userDir = await tempDir();
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    userSkillsDir: userDir,
    ...extra,
  };
}

const servers: DevmateServer[] = [];
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'devmate-skills-'));
  tempDirs.push(dir);
  return dir;
}

describe('ui/server：/api/skills', () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function writeSkill(
    skillsDir: string,
    id: string,
    content: string,
    extraFiles: Record<string, string> = {},
  ): Promise<void> {
    const dir = join(skillsDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), content);
    for (const [name, text] of Object.entries(extraFiles)) {
      await writeFile(join(dir, name), text);
    }
  }

  function skill(dir: string, id: string, frontmatter: string, body: string): Promise<void> {
    return writeSkill(dir, id, `${frontmatter}${body}`);
  }

  it('k1) 目录不存在/空目录 → {skills:[]}；全量响应不带 SKILL.md 全文', async () => {
    const missing = join(await tempDir(), 'no-such-dir');
    const { base, server } = await startServer(await baseDeps({ skillsDir: missing }));
    servers.push(server);

    const res = await fetch(new URL('/api/skills', base));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: unknown[] };
    expect(body.skills).toEqual([]);

    const empty = join(await tempDir(), 'empty');
    await mkdir(empty, { recursive: true });
    const { base: base2, server: server2 } = await startServer(
      await baseDeps({ skillsDir: empty }),
    );
    servers.push(server2);
    expect(
      ((await (await fetch(new URL('/api/skills', base2))).json()) as { skills: unknown[] }).skills,
    ).toEqual([]);
  });

  it('k2) frontmatter 索引：{id,name,summary,enabled:true}；description 首行 → summary', async () => {
    const skillsDir = join(await tempDir(), 'skills');
    await mkdir(skillsDir, { recursive: true });
    await skill(
      skillsDir,
      'tdd',
      '---\nname: tdd\ndescription: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.\n---\n\n# TDD\n\ncontent…',
      '',
    );
    await skill(
      skillsDir,
      'research',
      '---\nname: research\ndescription: Investigate a question against high-trust primary sources.\n---\n\n# Research\n',
      '',
    );
    // 无 frontmatter：降级 name=id、summary=''；目录内附注文件不影响索引
    await writeSkill(skillsDir, 'no-meta', '# Just a title\n\nnotes…\n', {
      'notes.md': 'attached note',
    });
    // 无 SKILL.md 的目录/零散文件：不进索引
    await writeFile(join(skillsDir, 'stray.txt'), 'x');
    await mkdir(join(skillsDir, 'license-copy'), { recursive: true });
    await writeFile(join(skillsDir, 'license-copy', 'README.md'), 'attribution only');

    const { base, server } = await startServer(await baseDeps({ skillsDir }));
    servers.push(server);

    const res = await fetch(new URL('/api/skills', base));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('Just a title'); // 全文不下发：SKILL.md body 不在响应里
    const body = JSON.parse(text) as { skills: Array<Record<string, unknown>> };
    expect(body.skills).toEqual([
      { id: 'no-meta', name: 'no-meta', summary: '', enabled: true, origin: 'bundled' },
      {
        id: 'research',
        name: 'research',
        summary: 'Investigate a question against high-trust primary sources.',
        enabled: true,
        origin: 'bundled',
      },
      {
        id: 'tdd',
        name: 'tdd',
        summary:
          'Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.',
        enabled: true,
        origin: 'bundled',
      },
    ]);
  });

  it('k3) POST /api/skills/:id {enabled}：运行时开关生效；saveSkillsConfig 收到全量开关表', async () => {
    const skillsDir = join(await tempDir(), 'skills');
    await mkdir(skillsDir, { recursive: true });
    await skill(skillsDir, 'tdd', '---\nname: tdd\ndescription: TDD loop.\n---\n\nbody', '');
    await skill(
      skillsDir,
      'research',
      '---\nname: research\ndescription: Research.\n---\n\nbody',
      '',
    );
    const saveSkillsConfig = vi.fn();
    const { base, server } = await startServer(await baseDeps({ skillsDir, saveSkillsConfig }));
    servers.push(server);

    const off = await postJson(base, '/api/skills/tdd', { enabled: false });
    expect(off.status).toBe(200);
    expect(saveSkillsConfig).toHaveBeenCalledTimes(1);
    expect(saveSkillsConfig).toHaveBeenLastCalledWith({ tdd: false, research: true });

    const list = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string; enabled: boolean }>;
    };
    expect(list.skills).toEqual([
      { id: 'research', name: 'research', summary: 'Research.', enabled: true, origin: 'bundled' },
      { id: 'tdd', name: 'tdd', summary: 'TDD loop.', enabled: false, origin: 'bundled' },
    ]);

    const back = await postJson(base, '/api/skills/tdd', { enabled: true });
    expect(back.status).toBe(200);
    expect(saveSkillsConfig).toHaveBeenLastCalledWith({ tdd: true, research: true });
  });

  it('k5) skillsRecord 播种（socket 初值）：装 seed {tdd:false} → GET tdd.enabled=false；POST 开关后保存快照与 seed 一致', async () => {
    const skillsDir = join(await tempDir(), 'skills');
    await mkdir(skillsDir, { recursive: true });
    await skill(skillsDir, 'tdd', '---\nname: tdd\ndescription: TDD.\n---\n\n', '');
    await skill(skillsDir, 'research', '---\nname: research\ndescription: R.\n---\n\n', '');
    const saveSkillsConfig = vi.fn();
    const { base, server } = await startServer(
      await baseDeps({ skillsDir, saveSkillsConfig, skillsRecord: { tdd: false } }),
    );
    servers.push(server);

    // 播种生效：重启（新构造）后 tdd 保持禁用——持久化断环修复
    const list = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string; enabled: boolean }>;
    };
    const tdd = list.skills.find((s) => s.id === 'tdd');
    const research = list.skills.find((s) => s.id === 'research');
    expect(tdd?.enabled).toBe(false);
    expect(research?.enabled).toBe(true); // 未播种 → 缺省全开

    // POST 开关后保存仍一致（快照与 seed 交集：tdd 开 → {tdd:true, research:true}）
    const on = await postJson(base, '/api/skills/tdd', { enabled: true });
    expect(on.status).toBe(200);
    expect(saveSkillsConfig).toHaveBeenLastCalledWith({ tdd: true, research: true });
  });

  it('k4) 未知 id → 404；enabled 非 boolean → 400；缺 saveSkillsConfig → 仅内存', async () => {
    const skillsDir = join(await tempDir(), 'skills');
    await mkdir(skillsDir, { recursive: true });
    await skill(skillsDir, 'tdd', '---\nname: tdd\ndescription: TDD.\n---\n\n', '');
    const { base, server } = await startServer(
      await baseDeps({ skillsDir, saveSkillsConfig: vi.fn() }),
    );
    servers.push(server);

    const unknown = await postJson(base, '/api/skills/ghost', { enabled: false });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBeTypeOf('string');

    const bad = await postJson(base, '/api/skills/tdd', { enabled: 'yes' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBeTypeOf('string');

    const missing = await postJson(base, '/api/skills/tdd', {});
    expect(missing.status).toBe(400);

    // 无 saveSkillsConfig：开关仍生效（内存态）
    const { base: base2, server: server2 } = await startServer(await baseDeps({ skillsDir }));
    servers.push(server2);
    const mem = await postJson(base2, '/api/skills/tdd', { enabled: false });
    expect(mem.status).toBe(200);
    const list = (await (await fetch(new URL('/api/skills', base2))).json()) as {
      skills: Array<{ enabled: boolean }>;
    };
    expect(list.skills[0]!.enabled).toBe(false);
  });
});
