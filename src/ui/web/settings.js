/**
 * # settings.js — 设置读写（get/post /api/settings）与密钥掩码（纯逻辑可注入 fetch）
 *
 * 协议（S12/C 档）：GET /api/settings → {baseUrl, model, apiKey?: string|null, reasoning?,
 * window?: number, permission?, permissionConfirmedAt?}（apiKey **掩码**，服务端永不回明文；
 * reasoning = off/low/medium/high 缺省 medium；window = 上下文窗口覆盖，未配置 → 缺省
 * 不带键 = 估算模式；permission = read-only/workspace-write/full-access 缺省
 * workspace-write —— 枚举/标签/风险门的单一权威源 = permissions.js；permissionConfirmedAt
 * = full-access 风险确认记录（epoch ms），无记录不带键）；
 * POST /api/settings {baseUrl, model, apiKey?, reasoning?, windowTokens?, permission?} →
 * 同形状（同样只回掩码；reasoning/windowTokens/permission 为补丁字段，未触碰保持现值）。
 *
 * ## 密钥纪律
 * - api_key 只允许**保存时**单向上行（用户输入 → POST）；响应到达后立即丢弃明文，
 *   仅保留掩码展示（长存状态=掩码串，不落 localStorage）。
 * - 本模块不读 localStorage；会话/UI 状态均内存态 —— 刷新后需重新输入 key（服务端已持久化，
 *   GET /api/settings 会回掩码证明存在；实际操作不需要重输）。
 *
 * ## 默认值来源
 * src/core/llm/presets.ts（S2 权威）：主默认 Preset = deepseek，
 * baseUrl https://api.deepseek.com、defaultModel deepseek-v4-flash。
 */

import { normalizePermission, normalizeConfirmedAt } from './permissions.js';

export const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
});

// ---------------------------------------------------------------------------
// 思考强度（C 档：settings.reasoning = off/low/medium/high；缺省 medium ——
// 服务端契约 GET/POST /api/settings；前端在 composer 分段 pill 组选择）与
// 上下文窗口（window = number；无值 = 模型窗口未配置（估算模式））。
// ---------------------------------------------------------------------------

/** 思考强度四档（顺序即 pill 组展示顺序；缺省 'medium'）。 */
export const REASONING_VALUES = Object.freeze(['off', 'low', 'medium', 'high']);
/** 各档中文标签（分段 pill 与 /help 共用；单一来源防漂移）。 */
export const REASONING_LABELS = Object.freeze({
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
});
/** 缺省档（服务端同值兜底：无 reasoning 字段时恒 'medium'）。 */
export const REASONING_DEFAULT = 'medium';

/** 非法/缺失值归一为 REASONING_DEFAULT（闭集；未知值按缺省处理，不抛）。 */
export function normalizeReasoning(value) {
  return REASONING_VALUES.includes(value) ? value : REASONING_DEFAULT;
}

/** 上下文窗口覆盖归一：正整数 number 原样；其它（null/非数字/非整数/≤0/字符串）→ null
 *  （null = 未配置：展示层落「—」+ 估算模式 tooltip，不冒充数值）。 */
export function normalizeWindow(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/**
 * 供应商预设（侧边栏「供应商」快捷切换；数据镜像自 src/core/llm/presets.ts ——
 * 浏览器零构建不能 import .ts，此处是**展示层只读镜像**，权威仍是 presets.ts）。
 * 新增供应商 = 两边各加一行（README-UI.md 有记录）。
 */
export const PROVIDER_PRESETS = Object.freeze([
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  {
    id: 'dashscope',
    label: 'Qwen · DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-coder-plus',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    model: 'glm-5.3',
  },
  {
    id: 'kimi',
    label: 'Kimi · Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.2',
  },
]);

/** baseUrl 归一化：去空白 + 去末尾斜杠（比较只看端点本体）。 */
export function normalizeBaseUrl(url) {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '');
}

/** 按 baseUrl 匹配预设（无匹配返回 null）；model 忽略 —— 同端点不同模型仍是该供应商。 */
export function matchProvider(baseUrl) {
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return null;
  for (const p of PROVIDER_PRESETS) {
    if (normalizeBaseUrl(p.baseUrl) === target) return p;
  }
  return null;
}

/**
 * 掩码展示（只做展示，不参与明文保存/上行）：
 * 与服务端单一实现（src/cli/config.ts 的 maskApiKey — UI 服务端经它掩码回读）
 * 同口径：≤12 字符全掩 '****'，>12 显首尾各 4 位。掩码不是密钥，可长存内存展示。
 */
export function maskApiKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return '';
  if (s.length <= 12) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function normalize(json) {
  const j = json ?? {};
  return {
    baseUrl:
      typeof j.baseUrl === 'string' && j.baseUrl.trim()
        ? j.baseUrl.trim()
        : DEFAULT_SETTINGS.baseUrl,
    model: typeof j.model === 'string' && j.model.trim() ? j.model.trim() : DEFAULT_SETTINGS.model,
    // 兼容两种字段名兜底：apiKey（协议）/ apiKeyMasked
    keyConfigured: Boolean(j.apiKey || j.apiKeyMasked),
    apiKeyMasked: maskApiKey(j.apiKey || j.apiKeyMasked || ''),
    // 工作区目录（显示字段；服务端未提供时为 null —— 设置抽屉以占位符降级展示）
    workspaceDir:
      typeof j.workspaceDir === 'string' && j.workspaceDir.trim() ? j.workspaceDir : null,
    // C 档：思考强度（缺省 medium = REASONING_DEFAULT）与上下文窗口覆盖
    // （服务端 GET 回 `window` 键；容错 accept `windowTokens` —— 双名兜底）。
    reasoning: normalizeReasoning(j.reasoning),
    windowTokens: normalizeWindow(j.window ?? j.windowTokens),
    // 权限预设（缺省 workspace-write；枚举/标签权威 = permissions.js）与风险确认记录
    // （无记录 → null —— 前端只在 full-access 且已确认时跳过风险门）
    permission: normalizePermission(j.permission),
    permissionConfirmedAt: normalizeConfirmedAt(j.permissionConfirmedAt),
  };
}

/** GET /api/settings。失败抛错（调用方决定降级表现）。 */
export async function loadSettings({ fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl('/api/settings', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalize(await res.json());
}

/**
 * POST /api/settings。apiKey 传入且非空才上行；响应掩码即返回值。
 */
export async function saveSettings(
  { baseUrl, model, apiKey },
  { fetchImpl = globalThis.fetch } = {},
) {
  const body = {
    baseUrl: String(baseUrl ?? '').trim() || DEFAULT_SETTINGS.baseUrl,
    model: String(model ?? '').trim() || DEFAULT_SETTINGS.model,
  };
  const key = String(apiKey ?? '').trim();
  if (key) body.apiKey = key;
  const res = await fetchImpl('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const saved = normalize(await res.json());
  // 返回前清零 body 中的明文（引用体仍残留再调用方不可见；此处防御）
  delete body.apiKey;
  return saved;
}

/**
 * 思考强度单独提交（composer 分段 pill 组：点击即 POST，防抖在 app.js）：
 * 只上行 {reasoning} 一个字段 —— 服务端补丁语义（未触碰字段保持现值）。
 * 返回归一化后的完整设置快照（含掩码/窗口/工作区字段）。失败抛错（调用方回滚 toast）。
 */
export async function saveReasoning(reasoning, { fetchImpl = globalThis.fetch } = {}) {
  const value = normalizeReasoning(reasoning);
  const res = await fetchImpl('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ reasoning: value }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalize(await res.json());
}

/**
 * 权限预设单独提交（PermissionSelect chip：切档即 POST，防抖在 app.js；风险确认门在
 * app.js —— full-access 且无确认记录时先过 modal 再到这里）：
 * 只上行 {permission} 一个字段（服务端补丁语义；切到 full-access 时服务端记录
 * permissionConfirmedAt —— 后端记录、不强制，前端只消费回读值）。
 * 返回归一化后的完整设置快照（含掩码/窗口/权限字段）。失败抛错（调用方回滚重读+toast）。
 */
export async function savePermission(permission, { fetchImpl = globalThis.fetch } = {}) {
  const value = normalizePermission(permission);
  const res = await fetchImpl('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ permission: value }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalize(await res.json());
}
