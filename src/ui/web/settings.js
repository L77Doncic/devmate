/**
 * # settings.js — 设置读写（get/post /api/settings）与密钥掩码（纯逻辑可注入 fetch）
 *
 * 协议（S12/C 档 + A/B 档修正 2026-08-30）：GET /api/settings → {baseUrl, model,
 * apiKey?: string|null, reasoning?, window?, maxInputTokens, maxOutputTokens,
 * maxInputTokensDefault?, maxOutputTokensDefault?, permission?, permissionConfirmedAt?,
 * methodFirst?, reviewMode?}（apiKey **掩码**，服务端永不回明文；model **恒净化名**
 * ——UI 标记后缀 `[N]m/k` 全链剥离（存量残留 → modelAutoCorrected 供「已自动校正」提示）；
 * reasoning = off/low/medium/high 缺省 medium；window = 上下文窗口覆盖，未配置 → 缺省
 * 不带键 = 估算模式；maxInputTokens/maxOutputTokens **恒回显**（B 档必填——存量缺失回填
 * 缺省：输出 8192=DEFAULT_MAX_TOKENS、输入=供应商 preset，并挂 `*Default=true` 提示键
 * 「已用默认，请修改保存」——不静默）；permission = read-only/workspace-write/full-access
 * 缺省 workspace-write —— 枚举/标签/风险门的单一权威源 = permissions.js；
 * permissionConfirmedAt = full-access 风险确认记录（epoch ms），无记录不带键；
 * methodFirst/reviewMode = 前置门/评审哨兵开关，缺省 true）。
 * POST /api/settings {baseUrl, model, apiKey?, maxInputTokens, maxOutputTokens, reasoning?,
 * windowTokens?, permission?, methodFirst?} → 同形状；**上限对必填**（缺任一 → 服务端
 * 400 max-input-output-required；非正整数 → invalid——本地先拦）；reasoning/
 * windowTokens/permission/methodFirst 为补丁字段，未触碰保持现值。
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

// ---------------------------------------------------------------------------
// 方法论先行（R2-S1：settings.methodFirst —— 前置门开关，缺省 true）
// ---------------------------------------------------------------------------

/** 缺省值（服务端同值兜底：旧服务端 GET 无该键 / 坏值 → 缺省 true = 注入前置门）。 */
export const METHODFIRST_DEFAULT = true;

/** 开关归一：boolean 原样；缺失/坏值 → 缺省 true。 */
export function normalizeMethodFirst(value) {
  return typeof value === 'boolean' ? value : METHODFIRST_DEFAULT;
}

// ---------------------------------------------------------------------------
// 收尾评审（R2-S2：settings.reviewMode —— 评审哨兵开关，缺省 true）
// ---------------------------------------------------------------------------

/** 缺省值（服务端同值兜底：旧服务端 GET 无该键 / 坏值 → 缺省 true = 注入评审哨兵）。 */
export const REVIEWMODE_DEFAULT = true;

/** 开关归一：boolean 原样；缺失/坏值 → 缺省 true。 */
export function normalizeReviewMode(value) {
  return typeof value === 'boolean' ? value : REVIEWMODE_DEFAULT;
}

/** 上下文窗口覆盖归一：正整数 number 原样；其它（null/非数字/非整数/≤0/字符串）→ null
 *  （null = 未配置：展示层落「—」+ 估算模式 tooltip，不冒充数值）。 */
export function normalizeWindow(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/**
 * 请求侧输入/输出上限归一（A 档，同 normalizeWindow 纪律）：正整数 number 原样；
 * 其它 → null。B 档（2026-08-30 用户强制）：上限**必填**——服务端 GET 恒回显
 * （存量缺失回填缺省 + `*Default` 提示键），POST 恒要求两者；normalize 只做值域
 * 归类（null = 数据缺失/坏值），展示层经 tokenLimitError 做必填校验。
 */
export function normalizeTokenLimit(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/**
 * 输入/输出上限必填校验（B 档）；返回错误文案（`''` = 合法）。空串/非 [0-9]+ /
 * 非正整数 → 错误文案（label 用于区分「输入上限/输出上限」红字）；与服务端
 * 「严格正整数必填」同口径（服务端 400 code=invalid/max-input-output-required 兜底）。
 */
export function tokenLimitError(value, label = '输入/输出上限') {
  const raw = String(value ?? '').trim();
  if (raw === '') return `${label}必填（正整数）`;
  if (!/^[0-9]+$/.test(raw)) return `${label}必须是正整数`;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return `${label}必须是正整数`;
  return '';
}

// ---------------------------------------------------------------------------
// 模型名净化（A 档：`[N]m`/`[N]k` UI 标记后缀全链根除——2026-08-30 用户实测残留）
// ---------------------------------------------------------------------------

/** 尾部 UI 标记后缀语法（镜像 core/llm/provider-adapter.ts 的 MODEL_WINDOW_HINT_RE；
 * 大小写宽容、可多个连续、仅末尾）。权威单一来源仍是 provider-adapter.ts。 */
export const MODEL_WINDOW_HINT_RE = /\[([0-9]+(?:\.[0-9]+)?)([kKmM])\]$/;

/** 模型名净化（镜像 sanitizeProviderModel——浏览器零构建不能 import .ts，只读镜像）。 */
export function sanitizeModel(model) {
  let out = String(model ?? '');
  for (;;) {
    const next = out.replace(MODEL_WINDOW_HINT_RE, '');
    if (next === out) return out;
    out = next;
  }
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
  // 模型名净化回显（A 档）：GET 值恒净化（服务端亦净化——双保险）；
  // 残留带后缀（旧服务端/静态预览）→ 净化 + modelAutoCorrected 供「已自动校正」提示一次
  const rawModel = typeof j.model === 'string' && j.model.trim() ? j.model.trim() : '';
  return {
    baseUrl:
      typeof j.baseUrl === 'string' && j.baseUrl.trim()
        ? j.baseUrl.trim()
        : DEFAULT_SETTINGS.baseUrl,
    model: rawModel ? sanitizeModel(rawModel) : DEFAULT_SETTINGS.model,
    // 服务端 modelSanitized=true（存量尾标已在读取时剥离）为权威；旧服务端无该键 →
    // 本地正则兜底（静态预览仍能理性提示）。
    modelAutoCorrected:
      j.modelSanitized === true ||
      Boolean(rawModel && /\[[0-9]+(?:\.[0-9]+)?[kKmM]\]$/.test(rawModel)),
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
    // A/B 档：请求侧输入/输出上限——服务端 GET 恒回显（缺失回填缺省+`*Default` 键；
    // 前端据此提示「已用默认，请修改保存」——不静默）。归一失败 → null（展示层红字拦）。
    maxInputTokens: normalizeTokenLimit(j.maxInputTokens),
    maxOutputTokens: normalizeTokenLimit(j.maxOutputTokens),
    maxInputTokensDefault: j.maxInputTokensDefault === true && j.maxInputTokens !== undefined,
    maxOutputTokensDefault: j.maxOutputTokensDefault === true && j.maxOutputTokens !== undefined,
    // 权限预设（缺省 workspace-write；枚举/标签权威 = permissions.js）与风险确认记录
    // （无记录 → null —— 前端只在 full-access 且已确认时跳过风险门）
    permission: normalizePermission(j.permission),
    permissionConfirmedAt: normalizeConfirmedAt(j.permissionConfirmedAt),
    // R2-S1：方法论前置门开关（缺省 true；旧服务端无该键/坏值 → 兜底 true）
    methodFirst: normalizeMethodFirst(j.methodFirst),
    // R2-S2：收尾评审哨兵开关（缺省 true；旧服务端无该键/坏值 → 兜底 true）
    reviewMode: normalizeReviewMode(j.reviewMode),
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
 * A 档：模型名发送前再净化（sanitizeModel——服务端亦净化，双保险幂等）。
 * B 档（2026-08-30 用户强制）：maxInputTokens/maxOutputTokens **必填**——缺失/非法
 * 本地即抛错（服务端 400 code=max-input-output-required/invalid 兜底）；
 * 值归一为 Number 上行（模型输入透传字符串 → 400 由服务端兜底——本地先拦）。
 * @param {{ baseUrl: string; model: string; apiKey?: string;
 *   maxInputTokens: number | string | null | undefined;
 *   maxOutputTokens: number | string | null | undefined }} input
 * @param {{ fetchImpl?: typeof globalThis.fetch }} [opts]
 */
export async function saveSettings(
  { baseUrl, model, apiKey, maxInputTokens, maxOutputTokens },
  { fetchImpl = globalThis.fetch } = {},
) {
  const inputErr = tokenLimitError(maxInputTokens, '输入上限');
  const outputErr = tokenLimitError(maxOutputTokens, '输出上限');
  if (inputErr || outputErr) {
    throw new Error(`输入/输出上限必填（正整数）：${inputErr || outputErr}`);
  }
  const body = {
    baseUrl: String(baseUrl ?? '').trim() || DEFAULT_SETTINGS.baseUrl,
    model: sanitizeModel(String(model ?? '').trim() || DEFAULT_SETTINGS.model),
    maxInputTokens: Number(String(maxInputTokens).trim()),
    maxOutputTokens: Number(String(maxOutputTokens).trim()),
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
 * 必填上限对（B 档；单字段补丁 POST 共用）：校验并返回
 * {maxInputTokens, maxOutputTokens}（都是 Number）；缺失/非法 → 抛错
 * （与服务端 400 code=max-input-output-required/invalid 同口径，本地先拦）。
 */
function requiredTokenBody(maxInputTokens, maxOutputTokens) {
  const inputErr = tokenLimitError(maxInputTokens, '输入上限');
  const outputErr = tokenLimitError(maxOutputTokens, '输出上限');
  if (inputErr || outputErr) {
    throw new Error(`输入/输出上限必填（正整数）：${inputErr || outputErr}`);
  }
  return {
    maxInputTokens: Number(String(maxInputTokens).trim()),
    maxOutputTokens: Number(String(maxOutputTokens).trim()),
  };
}

/**
 * 思考强度单独提交（composer 分段 pill 组：点击即 POST，防抖在 app.js）：
 * 只上行 {reasoning} + 必填上限对（B 档：/api/settings POST 恒要求
 * maxInputTokens/maxOutputTokens——调用方传当前值；服务端补丁语义其余字段保持现值）。
 * 返回归一化后的完整设置快照（含掩码/窗口/工作区字段）。失败抛错（调用方回滚 toast）。
 * @param {{ maxInputTokens: number | string | null | undefined;
 *   maxOutputTokens: number | string | null | undefined;
 *   fetchImpl?: typeof globalThis.fetch }} [opts]
 */
export async function saveReasoning(reasoning, opts = {}) {
  const { maxInputTokens, maxOutputTokens, fetchImpl = globalThis.fetch } = opts;
  const value = normalizeReasoning(reasoning);
  const res = await fetchImpl('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      reasoning: value,
      ...requiredTokenBody(maxInputTokens, maxOutputTokens),
    }),
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
 * @param {{ maxInputTokens: number | string | null | undefined;
 *   maxOutputTokens: number | string | null | undefined;
 *   fetchImpl?: typeof globalThis.fetch }} [opts]
 */
export async function savePermission(permission, opts = {}) {
  const { maxInputTokens, maxOutputTokens, fetchImpl = globalThis.fetch } = opts;
  const value = normalizePermission(permission);
  const res = await fetchImpl('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      permission: value,
      ...requiredTokenBody(maxInputTokens, maxOutputTokens),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalize(await res.json());
}

/**
 * 方法论先行开关单独提交（设置页开关：change 即 POST，防抖在 app.js）：
 * 只上行 {methodFirst} 一个字段（服务端补丁语义）。值先归一（缺省 true 兜底）。
 * 返回归一化后的完整设置快照。失败抛错（调用方回滚重读 + toast）。
 * @param {{ maxInputTokens: number | string | null | undefined;
 *   maxOutputTokens: number | string | null | undefined;
 *   fetchImpl?: typeof globalThis.fetch }} [opts]
 */
export async function saveMethodFirst(methodFirst, opts = {}) {
  const { maxInputTokens, maxOutputTokens, fetchImpl = globalThis.fetch } = opts;
  const value = normalizeMethodFirst(methodFirst);
  const res = await fetchImpl('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      methodFirst: value,
      ...requiredTokenBody(maxInputTokens, maxOutputTokens),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalize(await res.json());
}

/**
 * 收尾评审开关单独提交（设置页开关：change 即 POST，防抖在 app.js）：
 * 只上行 {reviewMode} 一个字段（服务端补丁语义）。值先归一（缺省 true 兜底）。
 * 返回归一化后的完整设置快照。失败抛错（调用方回滚重读 + toast）。
 * @param {{ maxInputTokens: number | string | null | undefined;
 *   maxOutputTokens: number | string | null | undefined;
 *   fetchImpl?: typeof globalThis.fetch }} [opts]
 */
export async function saveReviewMode(reviewMode, opts = {}) {
  const { maxInputTokens, maxOutputTokens, fetchImpl = globalThis.fetch } = opts;
  const value = normalizeReviewMode(reviewMode);
  const res = await fetchImpl('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      reviewMode: value,
      ...requiredTokenBody(maxInputTokens, maxOutputTokens),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalize(await res.json());
}
