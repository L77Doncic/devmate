/**
 * # test/tools/skill：use_skill 工具
 *
 * 契约（src/core/tools/skill.ts）：参数 {skill: id}——schema 为 string + 运行时校验
 * （不用 enum：可用 id 随 enabled 开关变化，枚举进 schema = 任何开关变化都要重建工具面；
 * 错误回注带 available_skills 清单收敛，与 E10 同口径）。
 * 成功 → {ok:true, content: 全文（≥4000 字符经 CONTEXT 截断面板重写：头 2000 + 尾 2000
 * + elide 标记 + 收窄建议；<4000 原样）}；不存在 → skill-not-found；
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

  it('全文超阈值：复用截断器（头 2000 + 尾 2000 + elide 标记 + 收窄建议；禁止手写头截断）', async () => {
    const long = 'x'.repeat(SKILL_CONTENT_LIMIT_CHARS + 123); // 4123
    const r = await run(fakeIndex(undefined, { tdd: long }), JSON.stringify({ skill: 'tdd' }));
    expect(r.ok).toBe(true);
    const half = SKILL_CONTENT_LIMIT_CHARS / 2; // 2000
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

  it('schema 契约：string + 运行时校验（无 enum——工具定义不含可用 id 列表）', async () => {
    const tool = createSkillTool({ index: () => fakeIndex() });
    expect(tool.parameters?.properties?.skill).toMatchObject({ type: 'string' });
    expect((tool.parameters?.properties?.skill as Record<string, unknown>).enum).toBeUndefined();
    expect(tool.parameters?.required).toEqual(['skill']);
  });
});
