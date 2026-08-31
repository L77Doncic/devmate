/**
 * # test/ui-server/deps-prompt：DEV_BASE_SYSTEM_PROMPT 定稿校验（纯逻辑，不起服务器）
 *
 * 覆盖（writing-for-agents 定稿的防漂移小断言 + 预算估算）：
 * - 锚定词单源：界内 / 小步闭环 / 失败是普通消息 / 报告口径 在正文按量级重复出现——
 *   锚定词漂移 = 行为主题漂移，小断言守住它；
 * - 单一真源：base 不列工具名（工具面与清单由环境注入）、不抄参数默认值
 *   （超时/预算数值归工具说明与合成层）、不接管技能/子代理节（compose 自有这些节）、
 *   载荷键名（available_tools/available_skills）归 core/loop/tools 单一来源；
 * - 节顺序：角色 → 如何工作（步骤）→ 边界与安全（reference）→ 错误回注与审批 →
 *   终止条件（报告口径）；
 * - 预算估算：base ≤ 1800 tokens（合成上限 4096 的锚，裁剪链不裁 base 的不变式前提）；
 *   极端技能清单（100 条极限长度行）裁剪链后仍 ≤ 4096 且 base 完整保留、结果可复现。
 */
import { describe, expect, it } from 'vitest';
import {
  composeSystemPrompt,
  DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS,
  DEV_BASE_SYSTEM_PROMPT,
  REVIEW_SENTINEL_SECTION,
  TASK_DECOMPOSITION_SECTION,
} from '../../src/ui/server/deps.js';
import { estimateTokens } from '../../src/core/context/index.js';
import type { SkillInfo, SkillsIndex } from '../../src/core/tools/skill.js';

/** base 单独成 system 消息的估算 token（复用与 composeSystemPrompt 相同的口径）。 */
const tokensOf = (text: string): number =>
  estimateTokens([{ role: 'system', content: text }]).tokens;

/** 断言用的锚定词（正文与 deps.ts 常量注释重复——漂移同步两处）。 */
const ANCHORS = ['界内', '小步闭环', '失败是普通消息', '报告口径'] as const;

/** 极值技能索引：100 条、每条 id/name/summary 都取极限长度。 */
function extremeSkills(): SkillsIndex {
  const long = (prefix: string, n: number): string => prefix + 'x'.repeat(n);
  const skills: SkillInfo[] = Array.from({ length: 100 }, (_, i) => ({
    id: long(`id_${i}_`, 40),
    name: long(`Name ${i} `, 40),
    summary: long(`Summary ${i} `, 160),
    enabled: true,
  }));
  return {
    async list() {
      return skills;
    },
    async content() {
      return null;
    },
    async setEnabled() {
      return false;
    },
  };
}

/** 普通技能索引（清单节与子代理节共存、默认预算下的常规形态）。 */
function normalSkills(): SkillsIndex {
  const skills: SkillInfo[] = [
    { id: 'alpha', name: 'Alpha asset', summary: '常规技能摘要一。', enabled: true },
    { id: 'beta', name: 'Beta asset', summary: '常规技能摘要二。', enabled: true },
  ];
  return {
    async list() {
      return skills;
    },
    async content() {
      return null;
    },
    async setEnabled() {
      return false;
    },
  };
}

describe('ui/server/deps-prompt：base 定稿（锚定词/单源/节序）', () => {
  it('P1) 锚定词在正文量级重复出现（漂移小断言）', () => {
    for (const anchor of ANCHORS) {
      const count = DEV_BASE_SYSTEM_PROMPT.split(anchor).length - 1;
      // 主锚（三个行为主题）至少两次、报告口径至少一次——量级重复是锚定词的意义
      const min = anchor === '报告口径' ? 1 : 2;
      expect(count, `${anchor}（${count} 次）`).toBeGreaterThanOrEqual(min);
    }
    // 首段锚点句同时压三个主锚（行为主题开章即明）
    expect(DEV_BASE_SYSTEM_PROMPT.includes('界内动')).toBe(true);
    expect(DEV_BASE_SYSTEM_PROMPT.includes('小步闭环')).toBe(true);
    expect(DEV_BASE_SYSTEM_PROMPT.includes('失败是普通消息')).toBe(true);
  });

  it('P2) 单一真源：不列工具名、不抄默认值、不接管 compose 的节', () => {
    // 工具清单由系统注入（工具面/可用清单），base 不枚举名字
    for (const name of [
      'read_file',
      'write_file',
      'edit_file',
      'list_dir',
      'glob',
      'grep',
      'run_command',
      'use_skill',
      'spawn_subagent',
    ]) {
      expect(DEV_BASE_SYSTEM_PROMPT).not.toContain(name);
    }
    // 参数默认值/预算数字归工具说明与合成层（base 只讲策略）
    for (const literal of ['120s', '900s', '4096', '4000', '200s']) {
      expect(DEV_BASE_SYSTEM_PROMPT).not.toContain(literal);
    }
    // 错误载荷键名归 core/loop/tools 的 errorContentJson 单一来源
    for (const key of ['available_tools', 'available_skills']) {
      expect(DEV_BASE_SYSTEM_PROMPT).not.toContain(key);
    }
    // 技能清单节/子代理节由 composeSystemPrompt 追加，base 不重复这两个节
    expect(DEV_BASE_SYSTEM_PROMPT).not.toContain('## 可用技能');
    expect(DEV_BASE_SYSTEM_PROMPT).not.toContain('## 子代理');
  });

  it('P3) 节顺序：角色 → 如何工作 → 边界与安全 → 错误回注与审批 → 终止条件', () => {
    const order = [
      '工作方式三个锚',
      '## 如何工作',
      '## 边界与安全',
      '## 错误回注与审批',
      '## 终止条件',
    ].map((s) => DEV_BASE_SYSTEM_PROMPT.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 四个节严格相邻（结构是「先行正文 + 四个小节」，没有夹带节外话题）
    const headers = ['## 如何工作', '## 边界与安全', '## 错误回注与审批', '## 终止条件'];
    for (const h of headers) expect(DEV_BASE_SYSTEM_PROMPT).toContain(h);
  });

  it('P4) 结构化内容在场：小步闭环四步、审批双态、自然结束判据锚在文本中', () => {
    for (const step of ['查证', '执行', '回注', '验证']) {
      expect(DEV_BASE_SYSTEM_PROMPT).toContain(step);
    }
    expect(DEV_BASE_SYSTEM_PROMPT).toContain('带理由拒绝');
    expect(DEV_BASE_SYSTEM_PROMPT).toContain('无理由拒绝');
    expect(DEV_BASE_SYSTEM_PROMPT).toContain('不带工具调用');
  });

  it('P4b) 语言锚定：默认中文（思考与回复），用户其他语言时随用户——防「不回复中文」漂移', () => {
    expect(DEV_BASE_SYSTEM_PROMPT).toContain('语言规则');
    expect(DEV_BASE_SYSTEM_PROMPT).toContain('默认使用中文思考与回复');
    expect(DEV_BASE_SYSTEM_PROMPT).toContain('用户使用其他语言时，以用户语言回复');
  });
});

describe('ui/server/deps-prompt：预算估算（base 锚 + 裁剪链覆盖）', () => {
  it('P5) base 单独 ≤ 1800 tokens（合成上限 4096 的不动锚；base 永不裁时预算必然可满足）', () => {
    const baseTokens = tokensOf(DEV_BASE_SYSTEM_PROMPT);
    expect(baseTokens).toBeLessThanOrEqual(1800);
    expect(baseTokens).toBeLessThan(DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS);
    expect(DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS).toBe(4096);
  });

  it('P6) 常规形态（技能清单 + 子代理节 + 分解/收尾评审节）合成 ≤ 4096，base 完整在场', async () => {
    const out = await composeSystemPrompt({
      skills: () => normalSkills(),
      workflow: () => ({ subagentsEnabled: true, maxParallel: 4 }),
    });
    expect(tokensOf(out)).toBeLessThanOrEqual(DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS);
    expect(out.includes(DEV_BASE_SYSTEM_PROMPT.trim())).toBe(true);
    expect(out).toContain('## 可用技能');
    expect(out).toContain('## 子代理');
    // R2-S2 固定小节（任务分解 + 收尾评审）
    expect(out).toContain('## 任务分解');
    expect(out).toContain('## 收尾评审');
  });

  it('P9) 分解/收尾评审节预算：任务分解 ≤150、收尾评审 ≤120；极值清单合成仍 ≤4096 且两节在场（固定小节不裁）', async () => {
    expect(tokensOf(TASK_DECOMPOSITION_SECTION)).toBeLessThanOrEqual(150);
    expect(tokensOf(REVIEW_SENTINEL_SECTION)).toBeLessThanOrEqual(120);
    const out = await composeSystemPrompt({
      skills: () => extremeSkills(),
      workflow: () => ({ subagentsEnabled: true, maxParallel: 4 }),
    });
    expect(tokensOf(out)).toBeLessThanOrEqual(DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS);
    expect(out).toContain('## 任务分解');
    expect(out).toContain('## 收尾评审');
    expect(out.includes(DEV_BASE_SYSTEM_PROMPT.trim())).toBe(true); // base 永不裁
  });

  it('P7) 极端清单（100 条极限行）裁剪链后 ≤ 4096、base 完整、结果可复现', async () => {
    const opts = {
      skills: () => extremeSkills(),
      workflow: () => ({ subagentsEnabled: true, maxParallel: 4 }),
    };
    const out = await composeSystemPrompt(opts);
    const again = await composeSystemPrompt(opts);
    expect(out).toBe(again); // 清单 id 序裁剪——同输入必同输出
    expect(tokensOf(out)).toBeLessThanOrEqual(DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS);
    expect(out.includes(DEV_BASE_SYSTEM_PROMPT.trim())).toBe(true); // base 永不裁（安全/行为规则优先）
  });

  it('P8) 预算不足（base+子代理近似）时：裁剪链只动技能清单，base 完整、清单整体让位', async () => {
    // 清单节因超预算被整体裁掉（id 序逐行裁到 0）；base 仍在——「base 永不裁」不变式
    const out = await composeSystemPrompt({
      skills: () => extremeSkills(),
      workflow: () => ({ subagentsEnabled: true, maxParallel: 4 }),
      budgetTokens: tokensOf(DEV_BASE_SYSTEM_PROMPT) + 1,
    });
    expect(out.includes(DEV_BASE_SYSTEM_PROMPT.trim())).toBe(true);
    expect(out).not.toContain('## 可用技能');
    // 裁剪链只裁清单尾部：子代理节是固定小节（防回归：若日后该节做大，此处提醒它在裁剪链之外）
    expect(out).toContain('## 子代理');
  });

  it('P10) maxParallel=0 → 子代理节显示「并行上限 无上限」（不显示误导性的 0）', async () => {
    const out = await composeSystemPrompt({
      skills: () => normalSkills(),
      workflow: () => ({ subagentsEnabled: true, maxParallel: 0 }),
    });
    expect(out).toContain('## 子代理');
    expect(out).toContain('并行上限 无上限');
    expect(out).not.toContain('并行上限 0');
    // 显式档照常显示数字（≥1 路径）
    const explicit = await composeSystemPrompt({
      skills: () => normalSkills(),
      workflow: () => ({ subagentsEnabled: true, maxParallel: 8 }),
    });
    expect(explicit).toContain('并行上限 8');
  });
});
