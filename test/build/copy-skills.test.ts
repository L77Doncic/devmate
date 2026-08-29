/**
 * # test/build/copy-skills：方法论蒸馏（scripts/copy-skills.mjs）——纯函数 + CLI 确定性 fixture
 *
 * 蒸馏契约（R2-S1）：
 * - mergeSkillFrontmatter：每个技能 SKILL.md 的 frontmatter 合并版（原字段原样保留 +
 *   `methodology: {"type",…}` 行；body 逐字保存）；无 frontmatter → 生成首行块；
 * - 无 meta 的技能（B 线/用户未来自装）→ 缺省 {type:'reference'}——**脚本对缺失 meta 键不崩**；
 * - buildMethodologiesTable：路由器表（methodologies.json）形状——坏键/缺键 → reference 缺省，
 *   键序 = Meta 撰写序（路由优先级），未收录技能按 id 序兜底。
 *
 * E2E（CI 真因）：脚本源目录优先级 = env DEV_MATE_SKILLS_SRC > ~/.claude 插件默认路径 > 空；
 * CI 无插件 → WARN + 空 dist + exit 0（**脚本内不存在任何 process.exit**——vitest 视其为崩溃，
 * 旧版 import 触发的 process.exit(0) 即 Ubuntu 红 / Windows 绿的根因）。
 * 本组 fixture 运行：mkdtemp 临时目录建 <root>/engineering/{tdd,custom}/SKILL.md（各自的
 * frontmatter 样例）→ spawnSync node scripts/copy-skills.mjs 注入 env → 断言 dist 合并产物；
 * 全程不依赖真实插件目录。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMethodologiesTable,
  defaultSkillMeta,
  mergeSkillFrontmatter,
  sanitizeSkillMeta,
} from '../../scripts/copy-skills.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'copy-skills.mjs');
const dst = join(repoRoot, 'dist', 'assets', 'skills');

describe('scripts/copy-skills：蒸馏纯函数', () => {
  it('d1) 合并 frontmatter：原字段保留 + methodology 行进入头块；body 逐字保存', () => {
    const original = [
      '---',
      'name: tdd',
      'description: Test-driven development. Use when…',
      'disable-model-invocation: true',
      '---',
      '',
      '# TDD',
      '',
      'content line',
    ].join('\n');
    const merged = mergeSkillFrontmatter(original, {
      type: 'method',
      trigger: '修复 bug/新增功能',
      steps: '红先绿|一次一切片',
      done: '每个切片红→绿→验证。',
    });
    const lines = merged.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('name: tdd');
    expect(lines[2]).toBe('description: Test-driven development. Use when…');
    expect(lines[3]).toBe('disable-model-invocation: true');
    const methodologyLine = lines.find((line) => line.startsWith('methodology:'));
    expect(methodologyLine).toBeDefined();
    expect(JSON.parse(methodologyLine!.slice('methodology: '.length))).toEqual({
      type: 'method',
      trigger: '修复 bug/新增功能',
      steps: '红先绿|一次一切片',
      done: '每个切片红→绿→验证。',
    });
    // 关闭 ``` 之后 body 逐字（追加行不重排正文）
    expect(merged.endsWith('# TDD\n\ncontent line')).toBe(true);
    // 只有一对头块（frontmatter 数不变）
    expect((merged.match(/^---$/gm) ?? []).length).toBe(2);
  });

  it('d2) 缺省 reference：无 meta（undefined）/坏 type → 缺省 {type:"reference"}；坏形状 → null', () => {
    expect(sanitizeSkillMeta(undefined)).toBeNull();
    expect(sanitizeSkillMeta('text')).toBeNull();
    expect(sanitizeSkillMeta([])).toBeNull();
    expect(defaultSkillMeta()).toEqual({ type: 'reference' });
    expect(sanitizeSkillMeta({ type: 'shaper' })).toEqual({ type: 'reference' });
    expect(sanitizeSkillMeta({})).toEqual({ type: 'reference' });
    // 缺键保留：trigger/steps/done 只收非空字符串
    expect(sanitizeSkillMeta({ type: 'method' })).toEqual({ type: 'method' });
    expect(sanitizeSkillMeta({ type: 'method', trigger: '', steps: '一次一切片' })).toEqual({
      type: 'method',
      steps: '一次一切片',
    });
  });

  it('d3) 无 meta 技能合并 frontmatter：生成 methodology reference 缺省；无 frontmatter 时创建块', () => {
    const withFm = mergeSkillFrontmatter(
      '---\nname: ghost\ndescription: x\n---\n\n# X\n',
      undefined,
    );
    expect(withFm).toContain('methodology: {"type":"reference"}');
    expect(withFm).toContain('name: ghost');
    expect(withFm).toContain('# X');

    // 无 frontmatter（B 线技能）：前置生成的块（body 原样跟随）
    const noFm = mergeSkillFrontmatter('# Just body\n- item\n', { type: 'method', trigger: 'x' });
    expect(noFm.startsWith('---\n')).toBe(true);
    expect(noFm).toContain('methodology: {"type":"method","trigger":"x"}');
    expect(noFm).toContain('# Just body');
  });

  it('d4) 路由器表：id → 清洗后 meta；缺失/坏键 → reference 缺省；坏 meta 图（非对象）→ {} 且不崩', () => {
    const table = buildMethodologiesTable(['tdd', 'ask-matt', 'ghost', 'broken'], {
      tdd: { type: 'method', trigger: '修复 bug', steps: '红先绿' },
      'ask-matt': { type: 'reference', trigger: '技能路由' },
      broken: { type: '???' },
    });
    expect(table).toEqual({
      tdd: { type: 'method', trigger: '修复 bug', steps: '红先绿' },
      'ask-matt': { type: 'reference', trigger: '技能路由' },
      ghost: { type: 'reference' },
      broken: { type: 'reference' },
    });

    expect(buildMethodologiesTable(['a'], null)).toEqual({ a: { type: 'reference' } });
    expect(buildMethodologiesTable([], 'not-an-object')).toEqual({});
    // 坏 meta 图含数组条目：不崩、缺省 reference
    expect(buildMethodologiesTable(['a'], { a: ['array'] })).toEqual({
      a: { type: 'reference' },
    });
  });

  it('d5) 蒸馏实况：repo 根 assets/skills-meta.json 18 项全录（14 method + 4 reference）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const meta = JSON.parse(
      readFileSync(join(process.cwd(), 'assets', 'skills-meta.json'), 'utf8'),
    ) as Record<string, unknown>;
    const ids = Object.keys(meta);
    expect(ids).toHaveLength(18);
    const table = buildMethodologiesTable(ids, meta) as Record<
      string,
      { type: 'method' | 'reference' }
    >;
    const counts = ids.reduce(
      (acc, id) => {
        const kind = table[id]!.type;
        acc[kind] = (acc[kind] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    expect(counts).toEqual({ method: 14, reference: 4 });
    // 每项 trigger/steps/done 非空（路由与判据依赖它们）
    const idsWithout = ids.filter((id) =>
      ['trigger', 'steps', 'done'].some((key) => {
        const value = meta[id] as Record<string, unknown>;
        return typeof value[key] !== 'string' || value[key] === '';
      }),
    );
    expect(idsWithout).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E2E fixture：CI 确定性——绝不依赖真实 ~/.claude 插件目录
// ---------------------------------------------------------------------------

type RunResult = { status: number | null; output: string };

/** spawnSync node scripts/copy-skills.mjs；显式移除本测试的污染 env（SRC/META）再叠加覆盖。 */
function runScript(envOverrides: Record<string, string>): RunResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'DEV_MATE_SKILLS_SRC' || key === 'DEV_MATE_SKILLS_META')
      continue;
    env[key] = value;
  }
  Object.assign(env, envOverrides);
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(res.error).toBeUndefined();
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** 临时 fixture：<root>/engineering/{tdd,custom}/SKILL.md + 附注 + LICENSE/README；<root>/home 空 HOME。 */
function makeFixture(meta: Record<string, unknown> | null = null): {
  root: string;
  src: string;
  home: string;
  metaPath: string | null;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'devmate-copy-skills-'));
  const src = join(root, 'engineering');
  const home = join(root, 'home');
  mkdirSync(join(src, 'tdd'), { recursive: true });
  mkdirSync(join(src, 'custom'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(src, 'tdd', 'SKILL.md'),
    [
      '---',
      'name: tdd',
      'description: Test-driven development. Use when…',
      'disable-model-invocation: true',
      '---',
      '',
      '# TDD',
      '',
      'tdd body line',
    ].join('\n'),
  );
  writeFileSync(
    join(src, 'custom', 'SKILL.md'),
    [
      '---',
      'name: custom',
      'description: Custom skill fixture. Use when…',
      '---',
      '',
      '# Custom',
      '',
      'custom body line',
    ].join('\n'),
  );
  writeFileSync(join(src, 'tdd', 'notes.md'), 'fixture attachment text\n');
  writeFileSync(join(root, 'LICENSE'), 'FIXTURE LICENSE LINE\n');
  writeFileSync(join(root, 'README.md'), 'FIXTURE README LINE\n');
  let metaPath: string | null = null;
  if (meta !== null) {
    metaPath = join(root, 'skills-meta.fixture.json');
    writeFileSync(metaPath, JSON.stringify(meta));
  }
  return {
    root,
    src,
    home,
    metaPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** repo 生产 meta（f1 用默认 meta 源的真实输入）。 */
const repoMeta = JSON.parse(
  readFileSync(join(repoRoot, 'assets', 'skills-meta.json'), 'utf8'),
) as Record<
  string,
  { type: 'method' | 'reference' | string; trigger?: string; steps?: string; done?: string }
>;

describe('scripts/copy-skills：CLI 确定性 fixture（不依赖真实插件目录）', () => {
  it('f1) env DEV_MATE_SKILLS_SRC 注入 → dist 整目录复制 + frontmatter 合并（含 methodology 块）+ methodologies.json 优先级序 + LICENSE/README 聚合', () => {
    const fx = makeFixture();
    try {
      const r = runScript({ HOME: fx.home, DEV_MATE_SKILLS_SRC: fx.src });
      expect(r.status).toBe(0);
      expect(r.output).toContain('skills assets copied');

      // 整目录保留：SKILL.md 与附注 md 一并复制
      expect(readFileSync(join(dst, 'tdd', 'notes.md'), 'utf8')).toBe('fixture attachment text\n');

      // tdd：原有 frontmatter 字段原样 + methodology 行（method，来自 repo assets/skills-meta.json）
      const tdd = readFileSync(join(dst, 'tdd', 'SKILL.md'), 'utf8');
      expect(tdd.split('\n').slice(0, 5)).toEqual([
        '---',
        'name: tdd',
        'description: Test-driven development. Use when…',
        'disable-model-invocation: true',
        expect.stringMatching(/^methodology: /),
      ]);
      expect(repoMeta.tdd).toBeDefined();
      expect(sanitizeSkillMeta(repoMeta.tdd)).toEqual(
        JSON.parse(tdd.match(/^methodology: (\{.*\})$/m)![1]!),
      );
      expect(JSON.parse(tdd.match(/^methodology: (\{.*\})$/m)![1]!).type).toBe('method');
      expect(tdd.endsWith('# TDD\n\ntdd body line')).toBe(true);

      // custom：repo meta 未收录 → 缺省 {type:'reference'}
      const custom = readFileSync(join(dst, 'custom', 'SKILL.md'), 'utf8');
      expect(custom).toContain('methodology: {"type":"reference"}');
      expect(custom).toContain('name: custom');
      expect(custom).toContain('# Custom');

      // methodologies.json：键序 = Meta 撰写序优于未收录 id 序（路由优先级）；内容 = 清洗后 meta
      const table = JSON.parse(readFileSync(join(dst, 'methodologies.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(Object.keys(table)).toEqual(['tdd', 'custom']);
      expect(table.tdd).toEqual(sanitizeSkillMeta(repoMeta.tdd));
      expect(table.custom).toEqual({ type: 'reference' });

      // 属性声明：LICENSE + README 聚合单文件（含来源版本行）
      const license = readFileSync(join(dst, 'LICENSE-mattpocock-skills.txt'), 'utf8');
      expect(license).toContain('FIXTURE LICENSE LINE');
      expect(license).toContain('FIXTURE README LINE');
      expect(license).toContain('版本');
    } finally {
      fx.cleanup();
    }
  });

  it('f2) 无源（HOME 空、无 env）= CI 形态：WARN 而非 process.exit；dist 为空；exit 0', () => {
    const fx = makeFixture();
    try {
      const r = runScript({ HOME: fx.home });
      expect(r.status).toBe(0);
      expect(r.output).toContain('no skills source');
      expect(r.output).toContain('DEV_MATE_SKILLS_SRC');
      // 无源 → dist/assets/skills 为空（不残留上次构建资产；server 空列表降级）
      expect(existsSync(dst)).toBe(true);
      expect(readdirSync(dst)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('f3) 坏 meta（DEV_MATE_SKILLS_META 注入）：不崩；坏 type/非对象 → reference 缺省；未收录 id 不进表', () => {
    const fx = makeFixture({
      tdd: { type: '???', trigger: 42 },
      custom: 'garbage-meta',
      ghost: { type: 'method' },
    });
    try {
      const r = runScript({
        HOME: fx.home,
        DEV_MATE_SKILLS_SRC: fx.src,
        DEV_MATE_SKILLS_META: fx.metaPath!,
      });
      expect(r.status).toBe(0);
      expect(r.output).toContain('skills assets copied');

      const tdd = readFileSync(join(dst, 'tdd', 'SKILL.md'), 'utf8');
      expect(tdd).toContain('methodology: {"type":"reference"}');
      expect(tdd).toContain('name: tdd');
      const custom = readFileSync(join(dst, 'custom', 'SKILL.md'), 'utf8');
      expect(custom).toContain('methodology: {"type":"reference"}');

      const table = JSON.parse(readFileSync(join(dst, 'methodologies.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(table).toEqual({ tdd: { type: 'reference' }, custom: { type: 'reference' } });
    } finally {
      fx.cleanup();
    }
  });

  it('f4) 源优先级：env DEV_MATE_SKILLS_SRC > 默认插件路径（HOME 伪装插件 + env 覆盖 → 只出 fixture；无 env → 走默认路径）', () => {
    const fx = makeFixture();
    try {
      // HOME 下伪装一个默认插件（版本目录 + skills/engineering/decoy-skill）
      const decoy = join(
        fx.home,
        '.claude',
        'plugins',
        'cache',
        'claude-plugins-official',
        'mattpocock-skills',
        '9.9.9',
        'skills',
        'engineering',
        'decoy-skill',
      );
      mkdirSync(decoy, { recursive: true });
      writeFileSync(
        join(decoy, 'SKILL.md'),
        '---\nname: decoy-skill\ndescription: decoy\n---\n\n# Decoy\n',
      );

      // 无 env → 默认插件路径生效（回归：默认路径仍可用）
      const noEnv = runScript({ HOME: fx.home });
      expect(noEnv.status).toBe(0);
      expect(existsSync(join(dst, 'decoy-skill', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(dst, 'tdd'))).toBe(false);

      // 设 env → 一律优先 fixture（decoy 不出现）
      const withEnv = runScript({ HOME: fx.home, DEV_MATE_SKILLS_SRC: fx.src });
      expect(withEnv.status).toBe(0);
      expect(readFileSync(join(dst, 'tdd', 'SKILL.md'), 'utf8')).toContain(
        'methodology: {"type":"method"',
      );
      expect(existsSync(join(dst, 'decoy-skill'))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});
