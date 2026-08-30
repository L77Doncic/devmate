/**
 * # test/tools/skill：use_skill 工具
 *
 * 契约（src/core/tools/skill.ts）：参数 {skill: id} 或 {id: id}（S2 兼容；两者都给以 id
 * 优先；缺一不可）——schema 为 string + 运行时校验（不用 enum：可用 id 随 enabled 开关
 * 变化，枚举进 schema = 任何开关变化都要重建工具面；错误回注带 available_skills 清单
 * 收敛，与 E10 同口径）。
 * 成功 → {ok:true, content: 全文（≥8000 字符经 CONTEXT 截断面板重写：头 4000 + 尾 4000
 * + elide 标记 + 收窄建议；<8000 原样——与子代理技能注入 capSkill 同值 8k：「正文+资产」
 * 总载荷口径）}；不存在 → skill-not-found；
 * disabled → skill-disabled；索引未回填 → skill-index-unavailable；内容恒为普通结果不抛。
 */
import { describe, expect, it } from 'vitest';
import {
  SKILL_CONTENT_LIMIT_CHARS,
  createSkillTool,
  truncateSkillContent,
} from '../../src/core/tools/skill.js';
import { OUTPUT_TOO_LONG_ADVICE } from '../../src/core/context/truncate.js';
import type { SkillInfo, SkillsIndex } from '../../src/core/tools/skill.js';

const SKILLS: SkillInfo[] = [
  {
    id: 'tdd',
    name: 'Test-driven development',
    summary: 'Test-driven development. Use when the user wants to build features or fix bugs.',
    enabled: true,
  },
  {
    id: 'research',
    name: 'Research',
    summary: 'Investigate a question against high-trust primary sources.',
    enabled: false,
  },
];

function fakeIndex(
  skills: SkillInfo[] = SKILLS,
  content: Record<string, string> = { tdd: '---\nname: TDD\n---\nRed. Green. Refactor.' },
): SkillsIndex {
  return {
    async list() {
      return skills;
    },
    async content(id) {
      return content[id] ?? null;
    },
    async setEnabled(id, enabled) {
      const entry = skills.find((skill) => skill.id === id);
      if (entry === undefined) return false;
      entry.enabled = enabled;
      return true;
    },
  };
}

/** 经工具面调用（参数已过主循环校验的等价形态；空参数 JSON 不可达——校验先拦，此处只验防线）。 */
async function run(index: SkillsIndex | null, argumentsRaw: string) {
  const tool = createSkillTool({ index: () => index });
  return tool.execute(
    { id: 'c1', name: 'use_skill', arguments: argumentsRaw },
    { sessionId: 's1' },
  );
}

describe('tools/skill：use_skill', () => {
  it('成功：enabled 技能 → {ok:true, content = SKILL.md 全文}（含 frontmatter 原样；不截断——全文在阈值内）', async () => {
    const body = '---\nname: TDD\n---\nRed. Green. Refactor.';
    const r = await run(fakeIndex(), JSON.stringify({ skill: 'tdd' }));
    expect(r).toEqual({ ok: true, content: body });
  });

  it('全文超阈值：复用截断器（头 4000 + 尾 4000 + elide 标记 + 收窄建议；禁止手写头截断）', async () => {
    const long = 'x'.repeat(SKILL_CONTENT_LIMIT_CHARS + 123); // 8123
    const r = await run(fakeIndex(undefined, { tdd: long }), JSON.stringify({ skill: 'tdd' }));
    expect(r.ok).toBe(true);
    const half = SKILL_CONTENT_LIMIT_CHARS / 2; // 4000
    expect(r.content?.startsWith(OUTPUT_TOO_LONG_ADVICE)).toBe(true);
    expect(
      r.content?.slice(OUTPUT_TOO_LONG_ADVICE.length, OUTPUT_TOO_LONG_ADVICE.length + half),
    ).toBe(long.slice(0, half));
    expect(r.content).toContain('\n\n--- 123 characters elided ---\n\n');
    expect(r.content?.slice(-half)).toBe(long.slice(-half));
    // 旧手写头截断标记不再出现（截断面板逐字模板）
    expect(r.content).not.toContain('（截断）');
    // 阈值内全文不动（原样返回，无面板）
    expect(truncateSkillContent('short')).toBe('short');
    expect(truncateSkillContent('x'.repeat(SKILL_CONTENT_LIMIT_CHARS - 1))).toBe(
      'x'.repeat(SKILL_CONTENT_LIMIT_CHARS - 1),
    );
  });

  it('8k 截断契约（固定数）：正文+资产 9000 字符 → 面板头 4000 + 尾 4000 + elide 1000（与 capSkill 同值；面板不吞服务端资产节）', async () => {
    const long = 'y'.repeat(9000);
    const r = await run(fakeIndex(undefined, { tdd: long }), JSON.stringify({ skill: 'tdd' }));
    expect(r.ok).toBe(true);
    const half = 4000; // SKILL_CONTENT_LIMIT_CHARS / 2（8k 契约固定数——与常量脱钩的回归锁定）
    expect(r.content?.startsWith(OUTPUT_TOO_LONG_ADVICE)).toBe(true);
    expect(
      r.content?.slice(OUTPUT_TOO_LONG_ADVICE.length, OUTPUT_TOO_LONG_ADVICE.length + half),
    ).toBe(long.slice(0, half));
    expect(r.content).toContain('\n\n--- 1000 characters elided ---\n\n');
    expect(r.content?.slice(-half)).toBe(long.slice(-half));
    // 服务端 compose 的节头/注记是普通正文：面板重写后仍保头尾（不作二次丢弃）
    const composed = '# Body\n\n## <file:a.txt>\nasset-a\n\n有 1 个二进制资产未注入：logo.png';
    expect(truncateSkillContent(composed)).toBe(composed);
  });

  it('技能载荷含资产节（服务端 compose 下游消费）：节头与二进制注记经工具原样返回（≤8k 不截）', async () => {
    const composed =
      '---\nname: TDD\n---\nRed. Green. Refactor.\n\n## <file:scripts/ref.md>\nreference snippet\n\n## <file:data.json>\n{"a":1}';
    const r = await run(fakeIndex(undefined, { tdd: composed }), JSON.stringify({ skill: 'tdd' }));
    expect(r).toEqual({ ok: true, content: composed });
  });

  it('id 不存在 → skill-not-found：content 为合法 JSON，available_skills 只列 enabled 清单', async () => {
    const r = await run(fakeIndex(), JSON.stringify({ skill: 'nope' }));
    expect(r).toMatchObject({ ok: false, error: { type: 'skill-not-found' } });
    const payload = JSON.parse(r.content) as {
      ok: boolean;
      error: { type: string; message: string; available_skills: string[] };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.type).toBe('skill-not-found');
    expect(payload.error.message).toContain('nope');
    expect(payload.error.available_skills).toEqual(['tdd']); // research disabled → 不入清单
  });

  it('disabled 技能 → skill-disabled（message 指明开关状态；available_skills 不含它）', async () => {
    const r = await run(fakeIndex(), JSON.stringify({ skill: 'research' }));
    expect(r).toMatchObject({ ok: false, error: { type: 'skill-disabled' } });
    const payload = JSON.parse(r.content) as { error: { available_skills: string[] } };
    expect(payload.error.available_skills).toEqual(['tdd']);
  });

  it('索引未回填（wiring 缺口）→ skill-index-unavailable（不伪装成 not-found 让模型试错）', async () => {
    const r = await run(null, JSON.stringify({ skill: 'tdd' }));
    expect(r).toMatchObject({ ok: false, error: { type: 'skill-index-unavailable' } });
    expect(JSON.parse(r.content)).toMatchObject({ ok: false });
  });

  it('防线：缺参/空参/非 JSON → 普通失败结果（绝不 throw、绝不触达索引）', async () => {
    for (const bad of [JSON.stringify({}), JSON.stringify({ skill: '' }), 'not-json{{{']) {
      const r = await run(fakeIndex(undefined, {}), bad);
      expect(r.ok).toBe(false);
      expect(r.error?.type).toBe('skill-not-found');
      expect(JSON.parse(r.content).ok).toBe(false);
    }
  });

  it('schema 契约：skill/id 双参均为 string（无 enum——工具定义不含可用 id 列表）；required 置空（本 schema 子集无 oneOf——运行时收窄）', async () => {
    const tool = createSkillTool({ index: () => fakeIndex() });
    expect(tool.parameters?.properties?.skill).toMatchObject({ type: 'string' });
    expect((tool.parameters?.properties?.skill as Record<string, unknown>).enum).toBeUndefined();
    expect(tool.parameters?.properties?.id).toMatchObject({ type: 'string' });
    expect(tool.parameters?.required).toEqual([]);
  });

  it('S2 参数兼容：{id} 等价于 {skill}（成功加载）；两者都给以 id 优先', async () => {
    // {id} 形态成功
    const idForm = await run(fakeIndex(), JSON.stringify({ id: 'tdd' }));
    expect(idForm).toEqual({
      ok: true,
      content: '---\nname: TDD\n---\nRed. Green. Refactor.',
    });
    // 两者都给：id 优先（skill 写不存在 id 也不受影响——先按 id 命中）
    const both = await run(fakeIndex(), JSON.stringify({ skill: 'nope', id: 'tdd' }));
    expect(both.ok).toBe(true);
    expect((both as { content: string }).content).toContain('Red. Green. Refactor.');
    // id 存在而 skill 不存在：命中{id}（id 优先）
    const idWins = await run(fakeIndex(), JSON.stringify({ id: 'tdd', skill: 'research' }));
    expect(idWins.ok).toBe(true);
    // {id} 指向未知 → skill-not-found（与 {skill} 同判型）
    const idUnknown = await run(fakeIndex(), JSON.stringify({ id: 'nope' }));
    expect(idUnknown).toMatchObject({ ok: false, error: { type: 'skill-not-found' } });
  });
});
