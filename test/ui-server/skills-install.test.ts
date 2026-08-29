/**
 * # test/ui-server/skills-install：用户技能安装（POST /api/skills/install）+ 索引合并
 *
 * 契约（CTO 定案）：
 * - 用户技能目录 userSkillsDir（deps 注入；缺省 ~/.devmate/skills；懒建——首装时）。
 * - POST /api/skills/install {source}：本地（绝对 SKILL.md 或含 SKILL.md 的目录 → 整目录
 *   复制到 <userSkillsDir>/<id>；id = frontmatter name 的 slug 化（严格 [a-z0-9-]）；
 *   已存在 → 409 skill-exists（幂等不覆盖）；无 name → invalid-source）；
 *   URL（仅 https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path...>.md，
 *   白名单 host + 逐段校验拒绝 .. / %2e / %2f / 查询串；重定向不跟随；≤512KB 流计数；
 *   仅文本（UTF-8、无 NUL））→ 同落地 <id>；响应 {ok:true,id,origin:'user'}；
 *   错误统一 {error:{type,message}}。
 * - 索引合并：bundled 序在前 + user 追加（同名 id 用户覆盖——位置不动、descriptor 顶替）；
 *   GET /api/skills 项带 origin；开关一表覆盖两者；content(id) 优先 user；
 *   frontmatter 的 methodology 块（type:method|reference）并入方法论路由表
 *   （bundled 键序在前；同名覆盖同样顶替路由表项）。
 * - 即时生效：install 成功显式失效 + userSkillsDir mtime 签名懒重扫——同一服务进程
 *   可感知（无需重启）。
 * - use_skill 真读写 tmp 取证（attachSkillsIndex 捕获 → createSkillTool 执行）。
 * 禁止外部网络：URL 用例全部注入 mock fetch。
 */
import { mkdtemp, mkdir, rm, writeFile, readFile, stat as realStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSkillTool } from '../../src/core/tools/skill.js';
import type { SkillsIndex } from '../../src/core/tools/skill.js';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { MethodologyIndex } from '../../src/shared/methodology.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import {
  parseRawGithubUrl,
  slugifySkillName,
  SKILL_INSTALL_MAX_BYTES,
} from '../../src/ui/server/index.js';
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

/** 一次安装尝试的响应（类型化 JSON）。 */
interface InstallBody {
  ok?: boolean;
  id?: string;
  origin?: string;
  error?: { type: string; message: string };
}

describe('ui/server：用户技能安装 + 索引合并', () => {
  const servers: DevmateServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-install-'));
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

  // -----------------------------------------------------------------------
  // URL 校验矩阵（纯函数：合法 6 例 / 非法 8 例）
  // -----------------------------------------------------------------------

  it('u1) 合法 URL 6 例：owner/repo/branch/path…md（子目录/分支点划/文件名点划/大写 SKILL.md）', () => {
    const valid = [
      'https://raw.githubusercontent.com/user/repo/main/README.md',
      'https://raw.githubusercontent.com/user/repo/main/docs/guide/README.md',
      'https://raw.githubusercontent.com/user/repo/feature-branch/file.md',
      'https://raw.githubusercontent.com/user/repo/v1.2.0/file.md',
      'https://raw.githubusercontent.com/user/repo/main/SKILL.md',
      'https://raw.githubusercontent.com/user/repo/main/skill.extra.md',
    ];
    expect(valid.length).toBe(6);
    for (const url of valid) {
      const parsed = parseRawGithubUrl(url);
      expect(parsed, url).not.toBeNull();
    }
    const first = parseRawGithubUrl(valid[0]!)!;
    expect(first).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      filePath: 'README.md',
    });
    const deep = parseRawGithubUrl(valid[1]!)!;
    expect(deep.filePath).toBe('docs/guide/README.md');
  });

  it('u2) 非法 URL 8 例：非白名单 host / 路径 .. / 非 .md / 非 https / 分支注入 %2f / 查询串 / 编码点 %2e / 片段', () => {
    const invalid = [
      'https://github.com/user/repo/blob/main/README.md',
      'https://raw.githubusercontent.com/user/repo/main/../evil.md',
      'https://raw.githubusercontent.com/user/repo/main/file.txt',
      'http://raw.githubusercontent.com/user/repo/main/README.md',
      'https://raw.githubusercontent.com/user/repo/main%2fevil/README.md',
      'https://raw.githubusercontent.com/user/repo/main/README.md?raw=1',
      'https://raw.githubusercontent.com/user/repo/main/%2e%2e/README.md',
      'https://raw.githubusercontent.com/user/repo/main/README.md#section',
    ];
    expect(invalid.length).toBe(8);
    for (const url of invalid) {
      expect(parseRawGithubUrl(url), url).toBeNull();
    }
  });

  it('u3) slug 化：name → [a-z0-9-]；全符号/空 → 空串（调用方 invalid-source）', () => {
    expect(slugifySkillName('My Cool Skill!')).toBe('my-cool-skill');
    expect(slugifySkillName('  TDD  ')).toBe('tdd');
    expect(slugifySkillName('bug_修复')).toBe('bug');
    expect(slugifySkillName('....')).toBe('');
    expect(slugifySkillName('')).toBe('');
  });

  // -----------------------------------------------------------------------
  // install 端点：URL（mock fetch）
  // -----------------------------------------------------------------------

  it('i1) fetch 200 → {ok,id,origin:user}；<userSkillsDir>/<id>/SKILL.md 落地；GET /api/skills 即时反映（同进程）', async () => {
    const dir = await tempDir();
    const content =
      '---\nname: My Cool Skill\ndescription: A cool user skill.\n---\n\n# U\nUSER BODY 秘密';
    const mockFetch = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(content, { status: 200 }),
    );
    const { base } = await startServerWith({ fetch: mockFetch as unknown as typeof fetch }, dir);

    const res = await postJson(base, '/api/skills/install', {
      source: 'https://raw.githubusercontent.com/user/repo/main/SKILL.md',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstallBody;
    expect(body).toEqual({ ok: true, id: 'my-cool-skill', origin: 'user' });
    // fetch 收到原始 URL + redirect:manual（重定向不跟随）
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(calledUrl).toBe('https://raw.githubusercontent.com/user/repo/main/SKILL.md');
    expect(calledInit.redirect).toBe('manual');

    // 真读写证据
    const installed = await readFile(join(dir, 'user', 'my-cool-skill', 'SKILL.md'), 'utf8');
    expect(installed).toContain('USER BODY 秘密');

    // GET /api/skills：即时生效（无重启），全文仍不下发
    const skills = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<Record<string, unknown>>;
    };
    const mine = skills.skills.find((s) => s.id === 'my-cool-skill')!;
    expect(mine).toEqual({
      id: 'my-cool-skill',
      name: 'My Cool Skill',
      summary: 'A cool user skill.',
      enabled: true,
      origin: 'user',
    });
    const text = await (await fetch(new URL('/api/skills', base))).text();
    expect(text).not.toContain('USER BODY 秘密'); // 全文不下发
  });

  it('i2) fetch 404 → 502 fetch-failed；网络错/超时（reject）→ 502 fetch-failed', async () => {
    const dir = await tempDir();
    const { base: base404 } = await startServerWith(
      {
        fetch: (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch,
      },
      dir,
    );
    const r404 = await postJson(base404, '/api/skills/install', {
      source: 'https://raw.githubusercontent.com/user/repo/main/SKILL.md',
    });
    expect(r404.status).toBe(502);
    expect((await r404.json()) as InstallBody).toMatchObject({ error: { type: 'fetch-failed' } });

    const { base: baseDown } = await startServerWith(
      {
        fetch: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
      },
      dir,
    );
    const rDown = await postJson(baseDown, '/api/skills/install', {
      source: 'https://raw.githubusercontent.com/user/repo/main/SKILL.md',
    });
    expect(rDown.status).toBe(502);
    expect((await rDown.json()) as InstallBody).toMatchObject({ error: { type: 'fetch-failed' } });
  });

  it('i3) 流 >512KB → 413 too-large（读流计数）；NUL → 400 invalid-source；非白名单 host → 400 unsupported-host；查询串 → 400 invalid-source', async () => {
    const dir = await tempDir();
    const chunk = 'x'.repeat(300 * 1024);
    const { base: baseOver } = await startServerWith(
      {
        fetch: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(chunk));
                controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
              },
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      },
      dir,
    );
    expect(SKILL_INSTALL_MAX_BYTES).toBe(512 * 1024);
    const r = await postJson(baseOver, '/api/skills/install', {
      source: 'https://raw.githubusercontent.com/user/repo/main/SKILL.md',
    });
    expect(r.status).toBe(413);
    expect((await r.json()) as InstallBody).toMatchObject({ error: { type: 'too-large' } });

    const { base: baseNul } = await startServerWith(
      {
        fetch: (async () =>
          new Response('---\nname: x\n---\n\0null', { status: 200 })) as unknown as typeof fetch,
      },
      dir,
    );
    const rNul = await postJson(baseNul, '/api/skills/install', {
      source: 'https://raw.githubusercontent.com/user/repo/main/SKILL.md',
    });
    expect(rNul.status).toBe(400);
    expect((await rNul.json()) as InstallBody).toMatchObject({ error: { type: 'invalid-source' } });

    const { base: baseHost } = await startServerWith(
      { fetch: (async () => new Response('x')) as unknown as typeof fetch },
      dir,
    );
    const rHost = await postJson(baseHost, '/api/skills/install', {
      source: 'https://github.com/user/repo/blob/main/README.md',
    });
    expect(rHost.status).toBe(400);
    expect((await rHost.json()) as InstallBody).toMatchObject({
      error: { type: 'unsupported-host' },
    });

    const { base: baseQuery } = await startServerWith(
      { fetch: (async () => new Response('x')) as unknown as typeof fetch },
      dir,
    );
    const rQuery = await postJson(baseQuery, '/api/skills/install', {
      source: 'https://raw.githubusercontent.com/user/repo/main/README.md?raw=1',
    });
    expect(rQuery.status).toBe(400);
    expect((await rQuery.json()) as InstallBody).toMatchObject({
      error: { type: 'invalid-source' },
    });
  });

  it('i4) URL 内容无 name / 已存在同名 → 400 invalid-source / 409 skill-exists（幂等不覆盖）', async () => {
    const dir = await tempDir();
    const body = (await startServerWith(
      {
        fetch: (async () =>
          new Response('---\ndescription: no name\n---\nbody', {
            status: 200,
          })) as unknown as typeof fetch,
      },
      dir,
    )) as unknown as { base: string; server: DevmateServer };
    servers.push(body.server);
    const rNoName = await postJson(body.base, '/api/skills/install', {
      source: 'https://raw.githubusercontent.com/user/repo/main/SKILL.md',
    });
    expect(rNoName.status).toBe(400);
    expect((await rNoName.json()) as InstallBody).toMatchObject({
      error: { type: 'invalid-source' },
    });

    const okUrl = await startServerWith(
      {
        fetch: (async () =>
          new Response('---\nname: Dupe\n---\nORIG BODY', {
            status: 200,
          })) as unknown as typeof fetch,
      },
      dir,
    );
    const r1 = await postJson(okUrl.base, '/api/skills/install', {
      source: 'https://raw.githubusercontent.com/user/repo/main/SKILL.md',
    });
    expect(r1.status).toBe(200);
    expect((await r1.json()) as InstallBody).toMatchObject({ id: 'dupe' });

    const r2 = await postJson(okUrl.base, '/api/skills/install', {
      source: 'https://raw.githubusercontent.com/user/repo/main/other.md',
    });
    expect(r2.status).toBe(409);
    expect((await r2.json()) as InstallBody).toMatchObject({ error: { type: 'skill-exists' } });
    // 幂等不覆盖：首装内容保留
    expect(await readFile(join(dir, 'user', 'dupe', 'SKILL.md'), 'utf8')).toContain('ORIG BODY');
  });

  // -----------------------------------------------------------------------
  // install 端点：本地路径
  // -----------------------------------------------------------------------

  it('l1) 绝对目录（含 SKILL.md）→ ok + 整目录复制（附注文件同入）；内容/幂等语义', async () => {
    const dir = await tempDir();
    const src = join(dir, 'src-skill');
    await writeSkill(dir, 'src-skill', '---\nname: Local Skill\n---\nLOCAL BODY', '');
    await writeFile(join(src, 'notes.md'), 'attached');
    const { base } = await startServerWith({}, dir);

    const res = await postJson(base, '/api/skills/install', { source: src });
    expect(res.status).toBe(200);
    expect((await res.json()) as InstallBody).toEqual({
      ok: true,
      id: 'local-skill',
      origin: 'user',
    });
    expect(await readFile(join(dir, 'user', 'local-skill', 'SKILL.md'), 'utf8')).toContain(
      'LOCAL BODY',
    );
    expect(await readFile(join(dir, 'user', 'local-skill', 'notes.md'), 'utf8')).toBe('attached');

    const again = await postJson(base, '/api/skills/install', { source: src });
    expect(again.status).toBe(409);
    expect((await again.json()) as InstallBody).toMatchObject({ error: { type: 'skill-exists' } });
  });

  it('l2) 绝对 SKILL.md 文件 → ok（基名目录落地）；相对路径/非 SKILL.md/目录无 SKILL.md → 400 invalid-source', async () => {
    const dir = await tempDir();
    await writeSkill(dir, 'file-skill', '---\nname: File Skill\n---\nFILE BODY', '');
    const file = join(dir, 'file-skill', 'SKILL.md');
    const { base } = await startServerWith({}, dir);

    const fromFile = await postJson(base, '/api/skills/install', { source: file });
    expect(fromFile.status).toBe(200);
    expect((await fromFile.json()) as InstallBody).toMatchObject({ id: 'file-skill', ok: true });
    expect(await statOrNull(join(dir, 'user', 'file-skill', 'SKILL.md'))).not.toBeNull();

    const rel = await postJson(base, '/api/skills/install', { source: 'some/relative/dir' });
    expect(rel.status).toBe(400);
    expect((await rel.json()) as InstallBody).toMatchObject({ error: { type: 'invalid-source' } });

    const notSkill = await postJson(base, '/api/skills/install', {
      source: join(dir, 'file-skill', 'notes.md'),
    });
    expect(notSkill.status).toBe(400);
    expect((await notSkill.json()) as InstallBody).toMatchObject({
      error: { type: 'invalid-source' },
    });

    const noEntry = join(dir, 'empty-dir');
    await mkdir(noEntry, { recursive: true });
    const noSkill = await postJson(base, '/api/skills/install', { source: noEntry });
    expect(noSkill.status).toBe(400);
    expect((await noSkill.json()) as InstallBody).toMatchObject({
      error: { type: 'invalid-source' },
    });
  });

  it('l3) 防路径逃逸：name=../../evil → id 净化为 evil（落伞 userSkillsDir/evil，不越界）；name 全点 → invalid-source', async () => {
    const dir = await tempDir();
    const evilSrc = join(dir, 'evil-src');
    await writeSkill(dir, 'evil-src', '---\nname: ../../evil\n---\nEVIL BODY', '');
    const { base } = await startServerWith({}, dir);

    const res = await postJson(base, '/api/skills/install', { source: evilSrc });
    expect(res.status).toBe(200);
    expect((await res.json()) as InstallBody).toMatchObject({ id: 'evil' });
    // 真路径：userSkillsDir/evil（slug 域内）——父目录绝无 evil
    expect(await statOrNull(join(dir, 'user', 'evil', 'SKILL.md'))).not.toBeNull();
    expect(await statOrNull(join(dir, 'evil'))).toBeNull();
    expect(await statOrNull(join(dir, '..', 'evil'))).toBeNull();

    const dotSrc = join(dir, 'dot-src');
    await writeSkill(dir, 'dot-src', '---\nname: ....\n---\nDOT BODY', '');
    const rDot = await postJson(base, '/api/skills/install', { source: dotSrc });
    expect(rDot.status).toBe(400);
    expect((await rDot.json()) as InstallBody).toMatchObject({ error: { type: 'invalid-source' } });
  });

  // -----------------------------------------------------------------------
  // 索引合并 + 方法论路由表 + 开关 + 懒读
  // -----------------------------------------------------------------------

  it('m1) 索引合并：bundled（id 序）在前 + user 追加；origin 标注；同名覆盖（位置不动、descriptor 顶替）', async () => {
    const dir = await tempDir();
    // bundled：tdd + research
    await writeSkill(
      join(dir, 'bundled'),
      'tdd',
      '---\nname: tdd\ndescription: bundled tdd\n---\nBUNDLED TDD BODY',
      '',
    );
    await writeSkill(
      join(dir, 'bundled'),
      'research',
      '---\nname: research\ndescription: bundled research\n---\nR',
      '',
    );
    await writeFile(
      join(dir, 'bundled', 'methodologies.json'),
      JSON.stringify({
        tdd: { type: 'method', trigger: '修复 bug', steps: 'a|b', done: 'd' },
      }),
    );
    // user：同名 tdd（覆盖）+ 专属 ask-me（method）
    await writeSkill(
      join(dir, 'user'),
      'tdd',
      '---\nname: tdd user\ndescription: user tdd\n---\nUSER TDD BODY',
      '',
    );
    await writeSkill(
      join(dir, 'user'),
      'ask-me',
      '---\nname: Ask Me\ndescription: ask me first.\nmethodology: {"type":"method","trigger":"问我","steps":"a|b","done":"d"}\n---\nASK BODY',
      '',
    );

    const skillsIndexRef: { index: SkillsIndex | null } = { index: null };
    const methodIndexRef: { index: MethodologyIndex | null } = { index: null };
    const { base } = await startServerWith(
      {
        attachSkillsIndex: (index) => {
          skillsIndexRef.index = index;
        },
        attachMethodologyIndex: (index) => {
          methodIndexRef.index = index;
        },
      },
      dir,
    );

    const list = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{
        id: string;
        name: string;
        summary: string;
        enabled: boolean;
        origin: string;
      }>;
    };
    // bundled（id 序）在前 + pure user（id 序）追加；同名顶替位置（bundled id 序 = research,tdd）
    expect(list.skills.map((s) => s.id)).toEqual(['research', 'tdd', 'ask-me']);
    expect(list.skills[0]!).toEqual({
      id: 'research',
      name: 'research',
      summary: 'bundled research',
      enabled: true,
      origin: 'bundled',
    });
    expect(list.skills[1]).toEqual({
      id: 'tdd',
      name: 'tdd user', // 用户覆盖（descriptor 顶替、位置不动）
      summary: 'user tdd',
      enabled: true,
      origin: 'user',
    });
    expect(list.skills[2]!.origin).toBe('user');

    // 内容优先级 user > bundled（同名 tdd → 用户正文）；use_skill 真读写 tmp 取证
    const content = await skillsIndexRef.index!.content('tdd');
    expect(content).toContain('USER TDD BODY');
    const tool = createSkillTool({ index: () => skillsIndexRef.index });
    const call = await tool.execute(
      {
        id: 'c-i1',
        name: 'use_skill',
        arguments: JSON.stringify({ skill: 'ask-me' }),
      },
      { sessionId: 's1' },
    );
    expect(call).toMatchObject({ ok: true });
    expect(call.content).toContain('ASK BODY');

    // 方法论路由表：bundled 键序在前 + user 追加（未收录技能按 id 序兜底）；
    // 同名覆盖同样顶替（tdd 位置不动、trigger 换）
    const entries = await methodIndexRef.index!.list();
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(entries.map((e) => e.id)).toEqual(['tdd', 'ask-me', 'research']);
    expect(byId.get('tdd')).toEqual({
      id: 'tdd',
      methodology: { type: 'method', trigger: '修复 bug', steps: 'a|b', done: 'd' },
      enabled: true,
    });
    expect(byId.get('ask-me')).toEqual({
      id: 'ask-me',
      methodology: { type: 'method', trigger: '问我', steps: 'a|b', done: 'd' },
      enabled: true,
    });
    expect(byId.get('research')).toEqual({
      id: 'research',
      methodology: { type: 'reference' },
      enabled: true,
    });
  });

  it('m2) 开关一表覆盖两者：POST /api/skills/<userId> 关闭 → GET 反映 + list().enabled 同步 + use_skill 拒绝', async () => {
    const dir = await tempDir();
    await writeSkill(
      join(dir, 'user'),
      'solo',
      '---\nname: Solo\ndescription: solo skill.\n---\nSOLO BODY',
      '',
    );
    const skillsIndexRef: { index: SkillsIndex | null } = { index: null };
    const { base } = await startServerWith(
      {
        attachSkillsIndex: (index) => {
          skillsIndexRef.index = index;
        },
      },
      dir,
    );

    const off = await postJson(base, '/api/skills/solo', { enabled: false });
    expect(off.status).toBe(200);
    const list = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string; enabled: boolean }>;
    };
    expect(list.skills.find((s) => s.id === 'solo')!.enabled).toBe(false);
    const idxList = await skillsIndexRef.index!.list();
    expect(idxList.find((s) => s.id === 'solo')!.enabled).toBe(false);

    const tool = createSkillTool({ index: () => skillsIndexRef.index });
    const denied = await tool.execute(
      {
        id: 'c-m2',
        name: 'use_skill',
        arguments: JSON.stringify({ skill: 'solo' }),
      },
      { sessionId: 's1' },
    );
    expect(denied).toMatchObject({ ok: false, error: { type: 'skill-disabled' } });
    expect(
      (JSON.parse(denied.content) as { error: { available_skills: string[] } }).error
        .available_skills,
    ).toEqual([]);
  });

  it('m3) 懒读刷新（不动服务进程）：外部直写 user 目录 → GET 反映；install 成功亦即时生效', async () => {
    const dir = await tempDir();
    const { base } = await startServerWith({}, dir);
    const before = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string }>;
    };
    expect(before.skills).toEqual([]);

    // 外部直写（绕过 install）：userSkillsDir mtime 签名变化 → 惰性重扫
    await writeSkill(join(dir, 'user'), 'outside', '---\nname: Outside\n---\nOUTSIDE BODY', '');
    const after = (await (await fetch(new URL('/api/skills', base))).json()) as {
      skills: Array<{ id: string; origin: string }>;
    };
    expect(after.skills).toContainEqual({
      id: 'outside',
      name: 'Outside',
      summary: '',
      enabled: true,
      origin: 'user',
    });
  });
});

async function statOrNull(path: string): Promise<unknown> {
  try {
    await realStat(path);
    return true;
  } catch {
    return null;
  }
}
