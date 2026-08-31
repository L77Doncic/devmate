/**
 * # guard.js — 对话级「Token 护栏」纯逻辑（per-session）
 *
 * 语义（2026-08-31 用户定调）：
 * - 护栏判据 = 本轮 run 的累计 totalTokens（prompt+completion 之和；服务端 usage 真实值，
 *   无 usage 时本地估算）超过上限 → 下轮发送前停机；run-status 终态仍为 'cost-guard'
 *   （状态值兼容测试/UI/历史），UI 文案 = 「Token 护栏停机」（format.js RUN_STATUS_SEMANTICS）。
 * - **默认关闭**：新会话/未设置 = 不限制（= 无限 token；不再有唯一默认开启的保险丝——
 *   与 subagentsEnabled 开关族一致：关 = 不拦）。
 * - 作用域 = **会话级**：每个对话独立设置（对话所需上限不同）；localStorage 按
 *   sessionId 记忆（键前缀 `devmate.ui.guardTokens.`，与 workspaceChoicePersisted
 *   同族）；发送时经 POST /api/chat 的 `maxRunTokens`（正整数）透传——服务端校验
 *   （非法 400），缺省 = 关闭；**不入 settings / config.json**（不放设置页）。
 * - 本模块纯逻辑（可注入 storageLike 测试；零 DOM）；DOM 装配在 app.js。
 */

/** localStorage 键前缀（命名与前缀同族：devmate.ui.*）；键 = 前缀 + sessionId。 */
export const GUARD_STORAGE_PREFIX = 'devmate.ui.guardTokens.';

/** 会话护栏存储键（sessionId 空/缺失 → null：无会话即无记忆）。 */
export function guardStorageKey(sessionId) {
  const id = String(sessionId ?? '').trim();
  return id === '' ? null : `${GUARD_STORAGE_PREFIX}${id}`;
}

/**
 * 护栏上限归一（单点值域纪律，与服务端「正整数」同口径）：正整数 number 原样；
 * 其它（null/undefined/字符串/非整数/≤0/非有限）→ null = 关闭（不限制）。
 */
export function normalizeGuardValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

/**
 * 读取会话护栏（localStorage；坏值/缺失 → null = 关闭——安全默认）。
 * @param {Storage} storageLike localStorage（或可注入测试对象）
 * @param {string|null} sessionId 会话指针（null → null）
 */
export function loadGuardTokens(storageLike, sessionId) {
  const key = guardStorageKey(sessionId);
  if (key === null) return null;
  try {
    const raw = storageLike?.getItem?.(key);
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    return normalizeGuardValue(value);
  } catch {
    return null; // 隐私模式/禁用存储/坏值：按关闭（安全默认）
  }
}

/**
 * 写入/清空会话护栏：value = 正整数 → 存字符串；null → 删键（关闭）。
 * 写入异常静默（读侧按关闭兜底，不 throw）。
 */
export function saveGuardTokens(storageLike, sessionId, value) {
  const key = guardStorageKey(sessionId);
  if (key === null) return;
  const normalized = normalizeGuardValue(value);
  try {
    if (normalized === null) storageLike?.removeItem?.(key);
    else storageLike?.setItem?.(key, String(normalized));
  } catch {
    // 隐私模式/禁用存储：不 throw
  }
}

/** 数值紧凑显示（pill 标签）：<1000 原样；≥1000 → k（一位小数，去尾 0）；≥1e6 → m。 */
export function compactTokenCount(value) {
  const n = normalizeGuardValue(value);
  if (n === null) return '';
  if (n < 1000) return String(n);
  const k = Math.round(n / 100) / 10;
  if (k >= 1000) {
    // 进位溢出（如 999999 → k 档四舍五入到 1000）：按 m 档重算——不进位成 1000k
    const m = Math.round(n / 1e5) / 10;
    return `${Number.isInteger(m) ? String(m) : m.toFixed(1)}m`;
  }
  return `${Number.isInteger(k) ? String(k) : k.toFixed(1)}k`;
}

/** pill 标签：未设置 → 「护栏 关」；设置后 → 「护栏 500k」（用户定调示例形状）。 */
export function guardPillLabel(value) {
  const n = normalizeGuardValue(value);
  return n === null ? '护栏 关' : `护栏 ${compactTokenCount(n)}`;
}

/**
 * 输入框值校验（弹层保存前本地先拦；非 [0-9]+ / 非正整数 → 错误文案；
 * 空串 → ''（空 = 关闭，不报错——与「清空=关闭」语义一致））。
 */
export function guardInputError(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';
  if (!/^[0-9]+$/.test(text)) return '上限必须是正整数';
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) return '上限必须是正整数';
  return '';
}

/**
 * 弹层动态提示行（评审观察 1 处置，2026-09-01）：护栏上限 vs「当前输出上限」的关系。
 * 根因：服务端闸门 A 的请求前预判 = 累计 totalTokens + 本轮 prompt 估算 + maxTokens
 * 输出预留 > 上限 ⇒ 首轮请求前即停机（0 步，「Token 护栏停机」）——护栏上限 ≤ 输出
 * 上限时按示例（如 200000）设置会「永远停」。提示行把该关系显式讲明（预检语义
 * 诚实 + 用户可理解）。
 * @param {number|null} maxOutputTokens 当前配置的输出上限（GET /api/settings →
 * ui.settings.maxOutputTokens；服务端未加载/缺省 → null）。
 * 兜底（拿不到有效值）：方向式文案，**不编造缺省数字**——假精度会把用户引向
 * 「比假值高、比真实输出上限低」的护栏设置（恰是该症的翻版）；留「当前配置的
 * 输出上限」占位 + 说明文字。
 */
export function guardLimitHint(maxOutputTokens) {
  const n = normalizeGuardValue(maxOutputTokens);
  if (n === null) {
    return '提示：护栏上限需高于当前配置的输出上限——否则首个请求前即被预检截停。';
  }
  return `提示：护栏上限需高于当前输出上限 ${n}（否则首个请求前即被预检截停）。`;
}
