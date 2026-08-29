/**
 * # shared/methodology：方法论内化（R2-S1）的数据契约
 *
 * 元内化（Meta 精编）：18 个 mattpocock 工程技能经精编为 skills-meta.json
 * （repo 根 assets/，构建时随 copy-skills.mjs 蒸馏成 dist/assets/skills/methodologies.json
 * 与各 SKILL.md 的 frontmatter 合并块）。本模块定义消费侧类型与容错解析——
 * - 类型：method 型（有步骤与完成判据的方法论）与 reference 型（词汇/路由参考，不进路由区）；
 * - MethodologyIndex：服务端索引（meta × 运行时开关 enabled 的单一来源），deps 层构图
 *   composeSystemPrompt 的方法论路由节与 loop 前置门的 route 都从它现读；
 * - parseMethodologyMap：**任何缺键/坏值都不崩**（B 线或用户未来自装的技能无 meta →
 *   缺省 {type:'reference'}；非法值收敛为缺省）。
 */
export type MethodologyKind = 'method' | 'reference';

/** 单一技能的方法论元数据（缺省仅 {type:'reference'}——无 meta = 参考型）。 */
export interface SkillMethodology {
  type: MethodologyKind;
  /** 触发描述（中文+关键英文词；多个候选以 / 分隔——路由命中词集合）。 */
  trigger?: string;
  /** 步骤摘要（3-4 词，| 分隔）。 */
  steps?: string;
  /** 完成判据（1-2 句可检查）。 */
  done?: string;
}

/** 全量方法论表：id → 元数据（dist/assets/skills/methodologies.json 的形状）。 */
export type MethodologyMap = Record<string, SkillMethodology>;

/** 方法论索引行（id + meta + 运行时 enabled；开关变化后再 list 即反映）。 */
export interface MethodologyEntry {
  id: string;
  methodology: SkillMethodology;
  enabled: boolean;
}

/** 方法论索引接缝（与 SkillsIndex 平行；服务端缓存单源回填，deps 晚绑定引用）。 */
export interface MethodologyIndex {
  list(): Promise<readonly MethodologyEntry[]>;
}

/** 缺省类型：无 meta / 键缺失 → reference（路由器表只收录 method 型；缺省即排除）。 */
export const DEFAULT_METHODOLOGY_KIND: MethodologyKind = 'reference';

/**
 * 容错解析 methodologies.json（或任意原始对象）为 MethodologyMap：
 * - 非对象/数组/null → {}；条目非对象或 type 非 'method'|'reference' → 缺省 reference；
 * - trigger/steps/done 只收非空字符串；**绝不 throw**（脚本/装配对缺失键不崩）。
 */
export function parseMethodologyMap(raw: unknown): MethodologyMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: MethodologyMap = {};
  for (const [id, entry] of Object.entries(raw)) {
    const meta = sanitizeMethodology(entry);
    if (meta !== null) out[id] = meta;
  }
  return out;
}

/** 单条清洗：合法对象 → 正常化（坏 type 或缺 type → reference 缺省）；非法 → null 丢弃。 */
export function sanitizeMethodology(raw: unknown): SkillMethodology | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const kind =
    record.type === 'method' || record.type === 'reference'
      ? record.type
      : DEFAULT_METHODOLOGY_KIND;
  const meta: SkillMethodology = { type: kind };
  for (const key of ['trigger', 'steps', 'done'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') meta[key] = value;
  }
  return meta;
}

/**
 * SKILL.md frontmatter 的 methodology 行解析（行值为 JSON 序列化的 flow mapping，如
 * `methodology: {"type":"method","trigger":"修复 bug","steps":"a|b","done":"c"}`——
 * copy-skills.mjs 蒸馏的合并块形状）：JSON 解析 + sanitizeMethodology 全量清洗；
 * 缺失/非字符串/JSON 失败/非对象 → null（调用方收敛为「无本技能方法论」——缺省
 * reference 语义由索引层兜底，与 methodologies.json 缺键同规；绝不 throw）。
 */
export function parseSkillMethodologyValue(value: unknown): SkillMethodology | null {
  if (typeof value !== 'string' || value === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  return sanitizeMethodology(raw);
}
