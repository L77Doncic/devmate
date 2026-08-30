/**
 * # test/ui-server/skills-delete：用户技能卸载（P2-4 · DELETE /api/skills/:id）
 *
 * 契约（CTO / UX 终版裁决）：
 * - DELETE /api/skills/:id——**仅 user 源**可删：删 <userSkillsDir>/<id> 整目录 +
 *   用户索引失效（同一服务进程 list/content 即时反映，无需重启）+ 开关键清理
 *   （skillsSwitches 摘除该 id 并持久化快照——saveSkillsConfig 收干净表）。
 * - bundled（打包资产）→ 404 文案「内置技能不可移除」（构建态只读语义）；
 *   未知 id → 404（与 toggle 同判型）。成功 → {ok:true, id}。
 * - 卸载后索引合并回退：同名 id 的 bundled 项重新可见（user 覆盖被删）。
 * 禁止外部网络：无需 fetch（本地目录操作）。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, startServer } from './support.js';

function baseDeps(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    ...extra,
  };
}

interface DeleteBody {
  ok?: boolean;
  id?: string;
  error?: string;
}

describe('ui/server：技能卸载（DELETE /api/skills/:id）', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-del-'));
    tempDirs.push(dir);
    return dir;
  }

  async function writeSkill(
    dir: string,
    id: string,
    frontmatter: string,
    body: string,
  ): Promise<void> {
    const d = join(dir, id);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'SKILL.md'), `${frontmatter}${body}`);
  }

  async function startServerWith(
    deps: Partial<DevmateServerDeps>,
    dir: string,
  ): Promise<{ base: string; server: DevmateServer }> {
    const { base, server } = await startServer(
      baseDeps({
        skillsDir: join(dir, 'bundled'),
        userSkillsDir: join(dir, 'user'),
        ...deps,
      }),
    );
    servers.push(server);
    return { base, server };
  }

  it('d1) 卸载用户技能：200 {ok,id}；目录删除；GET 即时不含；install 可重装（幂等复原）', async () => {
    const dir = await tempDir();
    const { base } = await startServerWith({}, dir);
    // 本地目录源：先造 SKILL.md 再经 install 端点装一个（真实目录取证）
    await writeSkill(dir, 'src-skill', '---\nname: my cool skill\n---\n\nbody', '');
    const install = await postJson(base, '/api/skills/install', {
      source: join(dir, 'src-skill'),
    });
    expect(install.status).toBe(200);
    const installed = (await install.json()) as { id: string };
    expect(installed.id).toBe('my-cool-skill');
    const skillDir = join(dir, 'user', 'my-cool-skill');
    expect(existsSync(skillDir)).toBe(true);

    const res = await fetch(new URL('/api/skills/my-cool-skill', base), { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeleteBody;
    expect(body).toEqual({ ok: true, id: 'my-cool-skill' });
    expect(existsSync(skillDir)).toBe(false); // removedir 取证

    // 索引失效：GET 即时不含（无需重启）
    const list = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string }>;
    };
    expect(list.skills.map((s) => s.id)).not.toContain('my-cool-skill');

    // 删除后目录已空 → 可重装（同 id 再装成功：幂等断言）
    const reinstall = await postJson(base, '/api/skills/install', {
      source: join(dir, 'src-skill'),
    });
    expect(reinstall.status).toBe(200);
  });

  it('d2) bundled → 404「内置技能不可移除」：打包资产不删、列表恒在', async () => {
    const dir = await tempDir();
    await writeSkill(join(dir, 'bundled'), 'tdd', '---\nname: tdd\ndescription: TDD.\n---\n\n', '');
    const { base } = await startServerWith({}, dir);

    const res = await fetch(new URL('/api/skills/tdd', base), { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as DeleteBody).error).toBe('内置技能不可移除');
    // 资产目录未被动
    expect(existsSync(join(dir, 'bundled', 'tdd', 'SKILL.md'))).toBe(true);
    const list = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string }>;
    };
    expect(list.skills.map((s) => s.id)).toContain('tdd');
  });

  it('d3) 未知 id → 404（与 toggle 同判型）', async () => {
    const dir = await tempDir();
    const { base } = await startServerWith({}, dir);
    const res = await fetch(new URL('/api/skills/ghost', base), { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as DeleteBody).error).toBeTypeOf('string');
  });

  it('d4) 开关键清理：先禁用再卸载 → saveSkillsConfig 收到不含该 id 的干净表', async () => {
    const dir = await tempDir();
    await writeSkill(join(dir, 'bundled'), 'tdd', '---\nname: tdd\ndescription: T.\n---\n', '');
    await writeSkill(join(dir, 'user'), 'my-awsome', '---\nname: my awsome\n---\n', '');
    const saveSkillsConfig = vi.fn();
    const { base } = await startServerWith({ saveSkillsConfig }, dir);

    // 禁用然后卸载（开关表先含 my-awsome，后摘除）
    await postJson(base, '/api/skills/my-awsome', { enabled: false });
    expect(saveSkillsConfig).toHaveBeenLastCalledWith({ tdd: true, 'my-awsome': false });

    const res = await fetch(new URL('/api/skills/my-awsome', base), { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(saveSkillsConfig).toHaveBeenLastCalledWith({ tdd: true }); // 不含已卸载 id

    const list = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string }>;
    };
    expect(list.skills.map((s) => s.id)).toEqual(['tdd']);
  });

  it('d5) user 覆盖 bundled 同 id：卸载 user 副本 → 列表回退（bundled 项重新可见、origin 回 bundled）', async () => {
    const dir = await tempDir();
    await writeSkill(
      join(dir, 'bundled'),
      'tdd',
      '---\nname: tdd\ndescription: bundled TDD.\n---\n',
      '',
    );
    await writeSkill(join(dir, 'user'), 'tdd', '---\nname: tdd\ndescription: user TDD.\n---\n', '');

    const { base } = await startServerWith({}, dir);
    let list = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string; origin: string; summary: string }>;
    };
    const tdd = list.skills.find((s) => s.id === 'tdd');
    expect(tdd?.origin).toBe('user'); // 覆盖视图单一（位置不动、descriptor 顶替）

    const res = await fetch(new URL('/api/skills/tdd', base), { method: 'DELETE' });
    expect(res.status).toBe(200);

    list = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string; origin: string; summary: string }>;
    };
    const after = list.skills.find((s) => s.id === 'tdd');
    expect(after?.origin).toBe('bundled');
    expect(after?.summary).toBe('bundled TDD.');
  });
});
