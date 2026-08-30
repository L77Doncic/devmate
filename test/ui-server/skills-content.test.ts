/**
 * # test/ui-server/skills-content：技能注入全文（content(id) = SKILL.md + 同目录文本资产）
 *
 * 契约（src/ui/server/index.ts 的 composeSkillContent + 索引接缝 content(id)）：
 * - 技能 = 目录：SKILL.md 在前 + 同目录文本资产（白名单 *.md/.txt/.json/.yaml/.py/.js/.sh，
 *   SKILL.md 入口除外；目录递归——含 scripts/ref.md 这类子目录资产）按相对路径名序追加，
 *   每资产节头 `## <file:rel>`；SKILL.md 缺失 → null；
 * - 总载荷 ≤ SKILL_PAYLOAD_LIMIT_CHARS 原样；超出 → 排序前缀截断 + 末尾「…（资产截断）」；
 * - 二进制/未知扩展名跳过并合成一行注记「有 N 个二进制资产未注入：<names…>」；
 * - bundled 与 user 两条来源同一实现（content(id) 单源——user 命中优先于 bundled）；
 * - 单文件技能（目录仅 SKILL.md）→ 返回 SKILL.md 原样（无节头无注记——行为不变）。
 * 全部经**真 tmp 目录**（bundled/user 根均注入临时目录），不走外部网络。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SKILL_PAYLOAD_LIMIT_CHARS,
  SKILL_PAYLOAD_TRUNCATED_MARK,
  composeSkillContent,
} from '../../src/ui/server/index.js';
import type { SkillsIndex } from '../../src/core/tools/skill.js';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { FakeLlm } from '../loop/support.js';
import { startServer } from './support.js';

const servers: DevmateServer[] = [];
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'devmate-skill-content-'));
  tempDirs.push(dir);
  return dir;
}

/** 深路径写入（rel 可含 `/`——子目录递归建；技能目录=真 tmp）。 */
async function writeFileDeep(root: string, rel: string, text: string): Promise<void> {
  const target = join(root, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
}

async function baseDeps(extra: Partial<DevmateServerDeps> = {}): Promise<DevmateServerDeps> {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    ...extra,
  };
}

/** 经真索引接缝取 content（attachSkillsIndex 捕获服务端实现——bundled/user 同 API 验证面）。 */
async function capturedContent(
  extra: Partial<DevmateServerDeps>,
): Promise<{ content: (id: string) => Promise<string | null> }> {
  let index: SkillsIndex | null = null;
  const { server } = await startServer(
    await baseDeps({ attachSkillsIndex: (i) => (index = i), ...extra }),
  );
  servers.push(server);
  expect(index).not.toBeNull();
  return { content: (id) => index!.content(id) };
}

describe('ui/server：技能注入全文（SKILL.md + 文本资产）', () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('a) 真 tmp user 技能：SKILL.md + scripts/ref.md + data.json + notes.py 四节按名序；节头逐资产正确（经索引接缝）', async () => {
    const skillsDir = join(await tempDir(), 'skills'); // bundled 根（空）
    const userDir = join(await tempDir(), 'user'); // user 根
    await writeFileDeep(
      userDir,
      'demo/SKILL.md',
      '---\nname: demo\ndescription: Demo skill.\n---\n# Demo body',
    );
    await writeFileDeep(userDir, 'demo/scripts/ref.md', 'reference snippet\nline2');
    await writeFileDeep(userDir, 'demo/data.json', '{"a":1}');
    await writeFileDeep(userDir, 'demo/notes.py', 'print("hi")');

    const { content } = await capturedContent({ skillsDir, userSkillsDir: userDir });
    const full = (await content('demo'))!;
    // 节头顺序（按相对路径名序：data.json < notes.py < scripts/ref.md）
    expect(full.startsWith('---\nname: demo\ndescription: Demo skill.\n---\n# Demo body')).toBe(
      true,
    );
    const headers = [...full.matchAll(/^## <file:([^>]*)>$/gm)].map((m) => m[1]);
    expect(headers).toEqual(['data.json', 'notes.py', 'scripts/ref.md']);
    expect(full).toContain('\n## <file:data.json>\n{"a":1}');
    expect(full).toContain('\n## <file:scripts/ref.md>\nreference snippet\nline2');
    expect(full).toContain('\n## <file:notes.py>\nprint("hi")');
    // 无二进制资产 → 无注记行
    expect(full).not.toContain('未注入');
  });

  it('b) 总载荷超 20k → 排序前缀截断 + 末尾「…（资产截断）」；SKILL.md 完整保留在前；恰在界内不截', async () => {
    const skillDir = join(await tempDir(), 'big');
    await writeFileDeep(skillDir, 'SKILL.md', '---\nname: big\n---\nBIG-BODY');
    await writeFileDeep(skillDir, 'a.txt', 'B'.repeat(30_000));
    const full = (await composeSkillContent(skillDir))!;
    expect(full).toHaveLength(SKILL_PAYLOAD_LIMIT_CHARS + SKILL_PAYLOAD_TRUNCATED_MARK.length);
    expect(full.startsWith('---\nname: big\n---\nBIG-BODY')).toBe(true); // 前缀截断：正文在前不丢
    expect(full.endsWith(SKILL_PAYLOAD_TRUNCATED_MARK)).toBe(true);
    expect(full.slice(0, SKILL_PAYLOAD_LIMIT_CHARS)).not.toBe('');

    // 恰在界内（SKILL.md + 资产合计 == 20k）：原样，无标记
    const exactDir = join(await tempDir(), 'exact');
    await writeFileDeep(exactDir, 'SKILL.md', '# small\n');
    const exactPrefix = '# small\n\n\n## <file:a.txt>\n'.length; // 正文 + 首资产节头
    await writeFileDeep(exactDir, 'a.txt', 'A'.repeat(SKILL_PAYLOAD_LIMIT_CHARS - exactPrefix));
    const exact = (await composeSkillContent(exactDir))!;
    expect(exact).toHaveLength(SKILL_PAYLOAD_LIMIT_CHARS);
    expect(exact).not.toContain(SKILL_PAYLOAD_TRUNCATED_MARK);
  });

  it('c) py/json 白名单纳入；png 跳过 + 一行注记（含多资产计数与名序）', async () => {
    const skillDir = join(await tempDir(), 'mixed');
    await writeFileDeep(skillDir, 'SKILL.md', '---\nname: mixed\n---\nbody');
    await writeFileDeep(skillDir, 'build.py', 'def build(): pass\n');
    await writeFileDeep(skillDir, 'config.json', '{"x":1}');
    await writeFileDeep(skillDir, 'notes.txt', 'plain text');
    await writeFileDeep(skillDir, 'image.png', 'fake-png-bytes');
    await writeFileDeep(skillDir, 'assets/logo.gif', 'fake-gif-bytes');
    await writeFileDeep(skillDir, 'script.sh', '#!/bin/sh\necho hi\n');
    await writeFileDeep(skillDir, 'deep/exclude.pdf', 'fake');
    await writeFileDeep(skillDir, 'deep/ref.yaml', 'key: value\n');

    const full = (await composeSkillContent(skillDir))!;
    const headers = [...full.matchAll(/^## <file:([^>]*)>$/gm)].map((m) => m[1]);
    // 白名单文本资产全部纳入（相对路径名序；目录递归含 deep/；p 与 g 等二进制不入）
    expect(headers).toEqual(['build.py', 'config.json', 'deep/ref.yaml', 'notes.txt', 'script.sh']);
    expect(full).toContain('\n## <file:build.py>\ndef build(): pass\n');
    expect(full).toContain('\n## <file:config.json>\n{"x":1}');
    expect(full).toContain('\n## <file:script.sh>\n#!/bin/sh\necho hi\n');
    expect(full).toContain('\n## <file:deep/ref.yaml>\nkey: value\n');
    // png/gif/pdf 全部跳过且合成一行注记（N=3，名序）
    expect(full).not.toContain('fake-png-bytes');
    expect(full).toContain('有 3 个二进制资产未注入：assets/logo.gif, deep/exclude.pdf, image.png');
  });

  it('d) bundled 单文件技能不变：目录仅 SKILL.md（含同根其它技能的零散文件干扰）→ content 与 SKILL.md 逐字相等', async () => {
    const skillsDir = join(await tempDir(), 'skills');
    const bundledBody = '---\nname: lone\n---\n# Lone bundled body\n\nkeep-me';
    await writeFileDeep(skillsDir, 'lone/SKILL.md', bundledBody);
    // 同级零散文件/空目录（不进索引、不影响内容组装——扫描只认含 SKILL.md 的子目录）
    await writeFileDeep(skillsDir, 'stray.txt', 'stray');
    await mkdir(join(skillsDir, 'empty'), { recursive: true });

    const { content } = await capturedContent({ skillsDir });
    expect(await content('lone')).toBe(bundledBody); // 逐字相等：无节头无注记无改写
  });

  it('索引接缝 user 优先 e) user 技能带资产时读取 user 目录组装；bundled 命中间接由同实现承接', async () => {
    const skillsDir = join(await tempDir(), 'skills');
    const userDir = join(await tempDir(), 'user');
    // bundled 同名 id（单文件）与 user 同名 id（带资产）：user 覆盖
    await writeFileDeep(skillsDir, 'overlap/SKILL.md', '---\nname: overlap\n---\nBUNDLED-BODY');
    await writeFileDeep(userDir, 'overlap/SKILL.md', '---\nname: overlap\n---\nUSER-BODY');
    await writeFileDeep(userDir, 'overlap/extra.md', 'extra asset');

    const { content } = await capturedContent({ skillsDir, userSkillsDir: userDir });
    const full = (await content('overlap'))!;
    expect(full.startsWith('---\nname: overlap\n---\nUSER-BODY')).toBe(true);
    expect(full).toContain('## <file:extra.md>\nextra asset');
    expect(full).not.toContain('BUNDLED-BODY');
  });

  it('未知 id → null（与旧 content(id) 同判型——use_skill 按 not-found 收敛）', async () => {
    const skillsDir = join(await tempDir(), 'skills');
    await writeFileDeep(skillsDir, 'x/SKILL.md', '# x');
    const { content } = await capturedContent({ skillsDir });
    expect(await content('ghost')).toBeNull();
  });
});
