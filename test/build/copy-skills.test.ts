/**
 * # test/build/copy-skills：方法论蒸馏纯函数（scripts/copy-skills.mjs）
 *
 * 蒸馏契约（R2-S1）：
 * - mergeSkillFrontmatter：每个技能 SKILL.md 的 frontmatter 合并版（原字段原样保留 +
 *   `methodology: {"type",…}` 行；body 逐字保存）；无 frontmatter → 生成首行块；
 * - 无 meta 的技能（B 线/用户未来自装）→ 缺省 {type:'reference'}——**脚本对缺失 meta 键不崩**；
 * - buildMethodologiesTable：路由器表（methodologies.json）形状——坏键/缺键 → reference 缺省。
 * 只测纯函数（构建脚本不依赖插件；插件未安装时走警告跳过路径，见脚本头注）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildMethodologiesTable,
  defaultSkillMeta,
  mergeSkillFrontmatter,
  sanitizeSkillMeta,
} from '../../scripts/copy-skills.mjs';

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
