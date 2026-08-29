/**
 * # tools/skill：use_skill 工具（技能懒加载；Workflow 功能点①「mattpocock 内化」）
 *
 * 语义（与 A1 端点契约对齐）：
 * - 系统提示只带技能清单（一行一条 `<name>（<summary>）`），全文由本工具按 id 懒加载
 *   ——懒加载语义即「用多少载多少」：若每个 SKILL.md 全文随清单每轮进投影，清单的
 *   预算分额全被吃掉，几十个技能会压垮系统提示。
 * - 索引接缝：SkillsIndex 依赖注入（构造闭包绑定），本工具**绝不自行扫描 skillsDir**
 *   ——扫描与开关的单一来源是服务端（ui/server/index.ts 的索引缓存 + skillsSwitches；
 *   deps.ts 装配层持有晚绑定引用，服务端启动时以自身的 SkillsIndex 实现 attach 回填）。
 *   开关变化即时生效：本工具执行期才读索引（list() 每次现读），不缓存构造期快照。
 * - schema 设计取舍（已裁定）：参数用 string + 运行时校验，**不用 enum**——可用 id
 *   列表随 enabled 开关变化，若枚举进 schema，任何开关变化都要求工具面（registry，
 *   按会话懒建）整体重建，重建成本高且与「配置变化即时生效」纠缠；运行时校验的代价
 *   是模型首调可能用错 id——错误回注带可用 id 清单（`available_skills`），与未知工具
 *   （E10「附可用名单收敛」）同口径。
 * - 结果契约：存在且 enabled → {ok:true, content: 全文（≥SKILL_CONTENT_LIMIT_CHARS
 *   经生成期截断面板重写：头 2000 + 尾 2000 + elide 标记 + 收窄建议——复用
 *   context/truncate，禁止手写头截断）}；不存在 → skill-not-found；disabled →
 *   skill-disabled；两者 content 均为合法 JSON（顶层 ok:false，
 *   error.available_skills = 当前 enabled 清单——错误与内容分离：模型能收窄后再试；
 *   载荷构造复用 loop/tools 的 errorContentJson 单一实现）。
 * - 防线：索引接缝未回填（装配/wiring 缺口，仅测试或装配故障可出现）→
 *   skill-index-unavailable——不把接线故障伪装成「技能不存在」让模型试错。
 */
import type { ToolCall } from '../../shared/session-types.js';
import { truncateToolOutput } from '../context/truncate.js';
import { errorContentJson } from '../loop/tools.js';
import type { JsonSchema, Tool, ToolResult } from '../loop/types.js';

/** 技能清单项（SkillsIndex.list() 形状；与 GET /api/skills 的 skills[] 元素同构）。 */
export interface SkillInfo {
  id: string;
  name: string;
  summary: string;
  enabled: boolean;
}

/**
 * 技能索引接缝（依赖注入；服务端从自身索引缓存组装回填——工具绝不自己扫描）。
 * 所有实现须保证：list() 反映当前开关状态；content(id) 未知 id → null。
 */
export interface SkillsIndex {
  /** 全量清单（含 enabled；开关变化后再调用即反映）。 */
  list(): Promise<readonly SkillInfo[]>;
  /** SKILL.md 全文；未知 id / 读不到 → null。 */
  content(id: string): Promise<string | null>;
  /** 开关（未知 id → false；持久化与否由实现负责）。 */
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
}

/** 技能全文注入阈值（字符；懒加载语义的正文上限——与子代理报告同阈值 4k，传入截断面板）。 */
export const SKILL_CONTENT_LIMIT_CHARS = 4000;

/** use_skill 工具构造依赖（索引接缝晚绑定：每次执行期读——开关变化即时生效）。 */
export interface SkillToolOptions {
  /** 索引接缝读取器；null = 尚未回填（装配缺口，执行期报 skill-index-unavailable）。 */
  index: () => SkillsIndex | null;
}

/**
 * use_skill 参数兼容（S2 小修）：接受 `{skill: id}`（既有形态）或 `{id: id}`（别名形态），
 * 两者都给以 id 优先；缺一不可（至少一个——两者都缺在运行时判型报错，见 executeSkill）。
 * 本 schema 子集无法表达「exactly one」（no oneOf/anyOf），故 required 置空、由运行时
 * 收窄：{} 不触发 schema required 报错而是运行时 skill-not-found（与「缺参」旧行为同判型）。
 */
const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    skill: {
      type: 'string',
      description:
        'Skill id of the SKILL.md to load (' +
        'the id is the directory name under the skills assets; available ids are listed ' +
        'in the system prompt skills section and in the available_skills field of errors). ' +
        'Either "skill" (legacy) or "id" must be given; when both are given, id wins.',
    },
    id: {
      type: 'string',
      description:
        'Skill id to load (preferred alias of "skill"; when both are given, id wins). ' +
        'Available ids are listed in the system prompt skills section and in the ' +
        'available_skills field of errors.',
    },
  },
  required: [],
};

/** 构造 use_skill 工具（参数 {skill: id}；id 不存在/disabled → 错误回注带可用清单）。 */
export function createSkillTool(options: SkillToolOptions): Tool {
  return {
    name: 'use_skill',
    description:
      'Load the full text (SKILL.md, bounded at 4000 chars) of a skill by id. ' +
      'The system prompt lists available skills (name + summary); call this tool ' +
      'when you need the full detailed instructions of one of them (lazy-load semantics).',
    parameters: SCHEMA,
    execute: (call) => executeSkill(call, options),
  };
}

async function executeSkill(call: ToolCall, options: SkillToolOptions): Promise<ToolResult> {
  // 主循环已做 schema 校验（loop/tools.ts）；此处仍是防线（与 fs.ts parseArgs 同口径）。
  // 参数兼容（S2 小修）：{skill} 或 {id} 缺一不可；两者都给以 id 优先（与 skillIdOf 同口径）。
  let skillId = '';
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const id = record.id;
      if (typeof id === 'string' && id !== '')
        skillId = id; // id 优先
      else {
        const raw = record.skill;
        if (typeof raw === 'string') skillId = raw;
      }
    }
  } catch {
    // fallthrough → 报错（与 fs.ts 一样不在此复述 JSON 错误细节）
  }
  if (skillId === '') {
    return failSkillResult(
      'skill-not-found',
      'use_skill: one of "skill" or "id" must be a non-empty string id',
      [],
    );
  }

  const index = options.index();
  if (index === null) {
    return failSkillResult(
      'skill-index-unavailable',
      'use_skill: skills index is not wired (skills subsystem unavailable)',
      [],
    );
  }

  const list = await index.list();
  const entry = list.find((skill) => skill.id === skillId);
  if (entry === undefined) {
    return failSkillResult('skill-not-found', `unknown skill "${skillId}"`, list);
  }
  if (!entry.enabled) {
    return failSkillResult(
      'skill-disabled',
      `skill "${skillId}" is disabled (enable it in the skills settings first)`,
      list,
    );
  }
  const content = await index.content(skillId);
  if (content === null) {
    // 索引有记录但全文读不到（文件缺失等）：按 not-found 收敛（可用清单照带，模型可判断）。
    return failSkillResult('skill-not-found', `skill "${skillId}" content is unavailable`, list);
  }
  return { ok: true, content: truncateSkillContent(content) };
}

/** 全文截断：复用生成期截断面板（头半额 + 尾半额 + elide 标记 + 收窄建议；与池报告同源）。 */
export function truncateSkillContent(content: string): string {
  return truncateToolOutput(content, SKILL_CONTENT_LIMIT_CHARS);
}

/**
 * 失败结果（content 恒为合法 JSON，顶层 {ok:false, error:{type,message,available_skills}}——
 * 载荷构造复用 loop/tools 的 errorContentJson 单一实现，禁止手写形状；
 * available_skills 只列当前 enabled 清单——「可用 id 清单」即技能错误回注的收敛抓手）。
 */
function failSkillResult(
  type: 'skill-not-found' | 'skill-disabled' | 'skill-index-unavailable',
  message: string,
  list: readonly SkillInfo[],
): ToolResult {
  return {
    ok: false,
    content: errorContentJson({
      type,
      message,
      available_skills: list.filter((skill) => skill.enabled).map((skill) => skill.id),
    }),
    error: { type, message },
  };
}
