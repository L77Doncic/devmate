/**
 * # extensions.js — 设置页扩展区纯逻辑（Skills / MCP / Subagent 工作流）
 *
 * 协议契约（前端全部宽容归一化，失败由 app.js 调用方降级）：
 * - GET  /api/skills          → { skills: [{ id, name, summary, enabled, origin }] }（裸数组亦可；
 *                               origin 'bundled'|'user'，缺省视作 bundled）
 * - POST /api/skills/:id      → 请求体 { enabled: boolean }（204 | {ok:true}）
 * - POST /api/skills/install  → 请求体 { source }（URL 或本机绝对 SKILL.md/技能目录）；
 *                               成功 200 {ok:true, id, origin:'user'}；失败错误体
 *                               {error:{type,message}}，type ∈ invalid-source（400）/
 *                               fetch-failed（502）/ too-large（413）/
 *                               unsupported-host（400）/ skill-exists（409）/
 *                               write-failed（5xx）；
 *                               错误映射 = skillInstallErrorText（kind 白名单 → 中文 +
 *                               status 阶梯兜底），installSkill 绝不 throw
 * - DELETE /api/skills/:id    → 卸载（P2-4；仅 user 源可删——bundled 服务端 404
 *                               「内置技能不可移除」；成功 200 {ok:true, id}）；
 *                               错误映射 = skillRemoveErrorText（服务端直读 + 404 阶梯），
 *                               removeSkill 绝不 throw
 * - GET  /api/mcp             → { servers: [{ name, command?, enabled }] }（裸数组亦可；
 *                               status 字段服务端若下发也宽容接受 —— 前端按 enabled 渲染徽章，
 *                               契约不依赖 status）
 * - POST /api/mcp             → 请求体 { name, command, args: string[] }
 *
 * Subagent 工作流偏好与后端 /api/workflow 同步（服务端已实现，见 src/ui/server/index.ts）：
 * - GET  /api/workflow        → { subagentsEnabled, maxParallel }（成功：回显服务端值）
 * - POST /api/workflow        → 混合字段部分提交 { subagentsEnabled? } | { maxParallel? }
 *                               （200 → 服务端全量回体；非法值/越界 → 400）
 * 失败/缺端点 → 降级 localStorage 'devmate.ui.subagents' = { enabled, parallel: 0|1|…|8 }，
 * 默认 { enabled: true, parallel: 2 }（subagent 无上限语义：0 = 无上限（按需派遣）——
 * 并行步进 0-8；负 → 0、>8 → 8、非整 → floor、非数 → 兜底 2，与 shared/workflow 的
 * clampMaxParallel 同口径；浏览器不 import TS 模块——镜像纪律见 README-UI.md），
 * 控件旁注「未同步（仅本地）」（copy 常量单一来源）。
 *
 * 纯函数边界：无 DOM；fetchImpl 与 storageLike 注入（与 api.js/theme.js 同接缝，node 可测）。
 */

import { fetchJson } from './api.js';

export const SUBAGENT_LS_KEY = 'devmate.ui.subagents';
/** 工作流端点（服务端已实现：GET 全量 / POST 混合字段部分提交，见 server/index.ts）。 */
export const WORKFLOW_API_URL = '/api/workflow';
export const SUBAGENT_DEFAULTS = Object.freeze({ enabled: true, parallel: 2 });
/** 并行数档位下界：0 = 无上限（按需派遣）——0 是合法档位，不再是「禁 0」。 */
export const SUBAGENT_PARALLEL_MIN = 0;
/** 并行数档位上界（与服务端 POST /api/workflow 校验 0-8 口径一致）。 */
export const SUBAGENT_PARALLEL_MAX = 8;
/** 0 档（无上限）的显示标签（设置-常规 subagent 卡；与提示词层「无上限」文案同源不同面）。 */
export const SUBAGENT_PARALLEL_UNLIMITED_LABEL = '无上限（按需派遣）';
/** 0 档风险说明小字（resource/成本随并行子任务数上升——预算内使用建议）。 */
export const SUBAGENT_PARALLEL_RISK_NOTE =
  '0 = 任意并发：资源与成本随任务复杂度上升，建议在预算内使用';

// ---- 用户可见文案（单一来源；纪律：零端点路径，防漂移断言见 test/ui-web） ----

/** 服务端不可达（失败/缺端点）时控件旁注：降级仅本地。 */
export const SUBAGENT_LOCAL_NOTE = '未同步（仅本地）：服务端暂不可达，本次配置暂存于本机浏览器';
/** POST /api/workflow 失败（含服务端 400）回滚重读后的提示。 */
export const SUBAGENT_SYNC_FAILED_TOAST = '同步失败，已还原';
/** Skills 清单缺失/失败（含 toggle 失败重读再失败）降级行。 */
export const SKILLS_DEGRADED_NOTE = '暂无可用技能。稍后重试或检查服务状态';
/** MCP 清单缺失/失败降级行（设置页与侧栏共用）。 */
export const MCP_DEGRADED_NOTE = '暂无可用服务器。稍后重试或检查服务状态';
/** 端点成功但注册表为空的侧栏空态行（合法空表：不冒充降级说明）。 */
export const MCP_SIDEBAR_EMPTY_NOTE = '暂无服务器，可在「设置 → MCP」添加';
/** MCP 登记态徽章（enabled → 已登记；其余 → 已停用；设置页与侧栏共用单一来源）。 */
export const MCP_BADGE_ENABLED = '已登记';
export const MCP_BADGE_DISABLED = '已停用';

/**
 * 并行数归一：0-8（0 = 无上限合法档）。与 shared/workflow 的 clampMaxParallel 同口径：
 * 非整 → floor；负 → 0（无上限）；>8 → 8；非有限（NaN/±Infinity）→ 回落 fallback（默认 2）。
 * @param {unknown} value 输入值（number|string|undefined 均可归一）
 * @param {number} [fallback] 兜底并行数（仅非有限值），默认 2
 * @returns {number} 0-8 的整数
 */
export function normalizeParallel(value, fallback = SUBAGENT_DEFAULTS.parallel) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < SUBAGENT_PARALLEL_MIN) return SUBAGENT_PARALLEL_MIN; // 负 → 0（无上限）
  return Math.min(SUBAGENT_PARALLEL_MAX, floored);
}

/**
 * 0 档显示文案（设置-常规 subagent 卡）：parallel===0 → 无上限标签；风险说明小字
 * （单一来源：app.js 经此渲染，index.html 不重复写文案）；1-8 → 空串（不显示）。
 * @param {number} parallel 归一后的并行数
 * @returns {string}
 */
export function parallelLabelText(parallel) {
  if (parallel !== SUBAGENT_PARALLEL_MIN) return '';
  return `${SUBAGENT_PARALLEL_UNLIMITED_LABEL}；${SUBAGENT_PARALLEL_RISK_NOTE}`;
}

/** Subagent 偏好归一（缺省/坏值 → 默认：开关保持上次布尔，并行数归一 0-8——0 合法保留）。 */
export function normalizeSubagentPref(raw) {
  const r = raw ?? {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : SUBAGENT_DEFAULTS.enabled,
    parallel: normalizeParallel(r.parallel),
  };
}

/** 读本地偏好（storage 缺失/JSON 坏/值域外一律回落默认 —— 绝不 throw）。 */
export function loadSubagentPref(storageLike) {
  try {
    const raw = storageLike?.getItem?.(SUBAGENT_LS_KEY);
    if (!raw) return { ...SUBAGENT_DEFAULTS };
    return normalizeSubagentPref(JSON.parse(raw));
  } catch {
    return { ...SUBAGENT_DEFAULTS };
  }
}

/** 写本地偏好（写入异常静默忽略：本次生效即可，只是不记忆）。返回归一后的值。 */
export function saveSubagentPref(storageLike, pref) {
  const value = normalizeSubagentPref(pref);
  try {
    storageLike?.setItem?.(SUBAGENT_LS_KEY, JSON.stringify(value));
  } catch {
    // 隐私模式/禁用存储：不 throw
  }
  return value;
}

/**
 * 工作流偏好的服务端形状归一：同时接受服务端 {subagentsEnabled,maxParallel} 与本地
 * {enabled,parallel}（宽容双形状）；缺省/坏值 → 默认；parallel 归一 0-8
 * （0 = 无上限原样保留；负 → 0；非有限 → 兜底 2）。
 * @returns {{enabled: boolean, parallel: number}}
 */
export function normalizeWorkflowPref(raw) {
  const r = raw ?? {};
  const enabled = r.subagentsEnabled ?? r.enabled;
  const parallel = r.maxParallel ?? r.parallel;
  return {
    enabled: typeof enabled === 'boolean' ? enabled : SUBAGENT_DEFAULTS.enabled,
    parallel: normalizeParallel(parallel),
  };
}

/**
 * 加载工作流偏好：优先 GET /api/workflow（成功 → source:'server'，回显服务端值）；
 * 失败/缺端点（404/5xx/网络异常）→ 降级 localStorage（source:'local'，默认 {true,2}）。
 * 绝不 throw —— 调用方凭 source 显示「未同步（仅本地）」旁注。
 * @param {{fetchImpl?: typeof fetch,
 *          storageLike?: {getItem?: (k: string) => string | null,
 *                        setItem?: (k: string, v: string) => void}}} [opts]
 * @returns {Promise<{source: 'server'|'local', value: {enabled: boolean, parallel: number}}>}
 */
export async function loadWorkflowPref({ fetchImpl = globalThis.fetch, storageLike } = {}) {
  let server = null;
  try {
    server = await fetchJson(WORKFLOW_API_URL, { fetchImpl });
  } catch {
    server = null; // 缺端点/失败：降级 localStorage（一次尝试，无重试风暴）
  }
  if (server !== null) {
    return { source: 'server', value: normalizeWorkflowPref(server) };
  }
  return { source: 'local', value: loadSubagentPref(storageLike) };
}

/**
 * 同步工作流偏好：POST /api/workflow 混合字段部分提交（patch 内部形状 {enabled?,parallel?}
 * → 服务端字段 {subagentsEnabled?,maxParallel?}；maxParallel 提交前归一 0-8——
 * 0 = 无上限原样上行；负 → 0；>8 → 8；非有限兜底 2）。
 * 成功 → {ok:true, value:服务端回体归一}；失败（含服务端 400）→ {ok:false, error}。绝不 throw。
 * @param {{enabled?: boolean, parallel?: number}} [patch]
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, value?: {enabled: boolean, parallel: number}, error?: unknown}>}
 */
export async function syncWorkflowPref(patch = {}, { fetchImpl = globalThis.fetch } = {}) {
  const body = {};
  if (patch.enabled !== undefined) body.subagentsEnabled = Boolean(patch.enabled);
  if (patch.parallel !== undefined) body.maxParallel = normalizeParallel(patch.parallel);
  try {
    const res = await fetchJson(WORKFLOW_API_URL, { method: 'POST', body, fetchImpl });
    return { ok: true, value: normalizeWorkflowPref(res) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 技能清单：{skills:[...]} 或裸数组；逐项校验，坏项跳过；缺省返回 []。
 * origin（'bundled'|'user'）白名单归一到 'user'|'bundled'（缺省/未知 → 'bundled'）；
 * 行内仅 origin='user' 渲染「用户」小徽章（bundled 不标注 —— 简洁裁定）。
 */
export function normalizeSkillsList(res) {
  const raw = Array.isArray(res) ? res : res?.skills;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const id = typeof s.id === 'string' ? s.id : '';
    if (!id) continue;
    out.push({
      id,
      name: typeof s.name === 'string' && s.name.trim() ? s.name : id,
      summary: typeof s.summary === 'string' ? s.summary : '',
      enabled: Boolean(s.enabled),
      origin: s.origin === 'user' ? 'user' : 'bundled',
    });
  }
  return out;
}

// ---- 技能安装（POST /api/skills/install {source}；错误 kind 白名单 → 中文文案） ----

/** 安装端点（常量单一来源；文案零端点路径已由纪律断言覆盖）。 */
export const SKILL_INSTALL_API_URL = '/api/skills/install';
/** 安装进行中按钮态。 */
export const SKILL_INSTALL_BUSY = '安装中…';
/** 来源为空（客户端先拦，服务端同样回 invalid-source）。 */
export const SKILL_INSTALL_EMPTY_SOURCE = '请先填写 URL 或本地路径';
/** 输入 placeholder 与提示（字段下小字；零端点路径）——index.html 静态同步同文案。 */
export const SKILL_INSTALL_URL_PLACEHOLDER = 'https://raw.githubusercontent.com/…/SKILL.md';
export const SKILL_INSTALL_PATH_PLACEHOLDER = '/path/to/skill-dir（含 SKILL.md）';
export const SKILL_INSTALL_HELP_URL = 'URL 支持常见公共代码托管；均要求入口文件为 SKILL.md。';
export const SKILL_INSTALL_HELP_PATH = '本地路径：指向含 SKILL.md 的技能目录。';
export const SKILL_INSTALL_NOTE_DIR =
  '技能目录即插即用：把含 SKILL.md 的目录放进 ~/.devmate/skills/<id>/，点「重新扫描」即可出现在列表。';
/** 服务端错误 kind 白名单 → 中文文案（kind 之外的 400/403/404/其余各回通用文案）。 */
export const SKILL_INSTALL_ERRORS = Object.freeze({
  'invalid-source': '来源无效：请输入可下载的 URL 或本机技能目录路径',
  'fetch-failed': '获取技能失败：无法访问或下载内容异常，请检查来源',
  'too-large': '技能文件过大，超出单技能大小上限',
  'unsupported-host': '不支持的下载来源：仅允许常见公共代码托管域名',
  'skill-exists': '技能已存在：相同标识的技能已安装，请直接使用或先移除',
  'write-failed': '写入失败：无法把技能保存到本机技能目录',
});
/** 网络层 400/403 通用文案（无 kind 时兜底）。 */
export const SKILL_INSTALL_REJECTED_TEXT = '请求被服务端拒绝（HTTP 400 或 403），请检查输入后重试';
/** 端点缺失（404 = 当前服务端版本无安装功能）。 */
export const SKILL_INSTALL_UNSUPPORTED_TEXT = '当前服务端版本不支持技能安装';
/** 其余（5xx/网络异常）通用文案。 */
export const SKILL_INSTALL_FAILED_TEXT = '安装失败，请稍后重试';

/**
 * 错误 kind 归一：服务端错误体契约 {error:{type,message}}（test/ui-server
 * skills-install）为首要形状；宽容读取 data.error.type / data.kind / error.kind /
 * data.error 字符串任一位置。仅白名单 kind 识别（未知 → null —— 走通用文案）。
 * @param {unknown} error
 * @returns {string|null}
 */
export function normalizeSkillErrorKind(error) {
  const data = error && typeof error === 'object' ? (error.data ?? {}) : {};
  const errObj = data && typeof data.error === 'object' && data.error !== null ? data.error : {};
  const raw =
    (typeof errObj.type === 'string' && errObj.type) ||
    (typeof error?.kind === 'string' && error.kind) ||
    (typeof data.kind === 'string' && data.kind) ||
    (typeof data.error === 'string' && data.error) ||
    '';
  return Object.prototype.hasOwnProperty.call(SKILL_INSTALL_ERRORS, raw) ? raw : null;
}

/**
 * 安装错误 → 中文文案。阶梯：kind 白名单 → 409 已存在（幂等拒绝）→ 413 过大 →
 * 502 获取失败（上游不可达）→ 400/403 通用 → 404 未支持 → 其余通用。
 * 绝不 throw；文案零端点路径（纪律断言见 test/ui-web）。
 * @param {unknown} error
 * @returns {string}
 */
export function skillInstallErrorText(error) {
  const kind = normalizeSkillErrorKind(error);
  if (kind !== null) return SKILL_INSTALL_ERRORS[kind];
  const status = typeof error?.status === 'number' ? error.status : null;
  if (status === 409) return SKILL_INSTALL_ERRORS['skill-exists'];
  if (status === 413) return SKILL_INSTALL_ERRORS['too-large'];
  if (status === 502) return SKILL_INSTALL_ERRORS['fetch-failed'];
  if (status === 400 || status === 403) return SKILL_INSTALL_REJECTED_TEXT;
  if (status === 404) return SKILL_INSTALL_UNSUPPORTED_TEXT;
  return SKILL_INSTALL_FAILED_TEXT;
}

/** 来源输入归一：trim；空串 = 未填写（按钮禁用 + 提交前再拦一次）。 */
export function normalizeSkillSource(text) {
  return typeof text === 'string' ? text.trim() : '';
}

// ---- 技能卸载（P2-4：DELETE /api/skills/:id；仅 user 源可删——bundled 服务端 404 直拒） ----

/** 卸载端点前缀（与 SKILL_INSTALL_API_URL 同纪律：常量单一来源，文案零端点路径）。 */
export const SKILL_DELETE_API_PREFIX = '/api/skills/';

/** 确认弹窗文案（与删除会话同规：危险色 + 「不可恢复」）。 */
export function skillRemoveConfirmText(name) {
  return `确认移除用户技能「${typeof name === 'string' && name.trim() !== '' ? name.trim() : '未知'}」？其目录将被删除，不可恢复。`;
}

/** 服务端卸载错误直读（返回 string | null；data.error 唯一权威——如「内置技能不可移除」）。 */
function skillRemoveServerMessage(error) {
  const data = error && typeof error === 'object' ? (error.data ?? {}) : {};
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof data.error === 'string' &&
    data.error !== ''
  ) {
    return data.error;
  }
  return null;
}

/**
 * 卸载错误 → 文案阶梯：服务端直读（bundled 404 「内置技能不可移除」等——单一来源）
 * → 404 未知/已移除 → 其余通用。绝不 throw；文案零端点路径。
 * @param {unknown} error
 * @returns {string}
 */
export function skillRemoveErrorText(error) {
  const server = skillRemoveServerMessage(error);
  if (server !== null) return server;
  const status = typeof error?.status === 'number' ? error.status : null;
  if (status === 404) return '技能不存在或已被移除（请重新扫描）';
  return '移除失败，请稍后重试';
}

/**
 * 卸载技能：DELETE /api/skills/:id。成功 → {ok:true, id}；失败（含 404/网络）→
 * {ok:false, error}——错误原样带 status/data（skillRemoveErrorText 的输入面）。绝不 throw。
 * @param {string} id
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, id?: string|null, error?: unknown}>}
 */
export async function removeSkill(id, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof id !== 'string' || id === '') {
    return { ok: false, error: { message: '技能标识缺失' } };
  }
  try {
    const res = await fetchJson(`${SKILL_DELETE_API_PREFIX}${encodeURIComponent(id)}`, {
      method: 'DELETE',
      fetchImpl,
    });
    const got = res && typeof res === 'object' && typeof res.id === 'string' ? res.id : null;
    return { ok: true, id: got };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 安装技能：POST /api/skills/install {source}。
 * 成功 → {ok:true, id: 服务端回体 id（res.id ?? res.skill.id；缺失 → null，调用方
 * 只 toast「已安装」）}；失败（含 400/404/网络）→ {ok:false, error}。绝不 throw。
 * @param {{source: string}} input
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, id?: string|null, error?: unknown}>}
 */
export async function installSkill({ source }, { fetchImpl = globalThis.fetch } = {}) {
  const normalized = normalizeSkillSource(source);
  if (normalized === '') {
    return { ok: false, error: { kind: 'invalid-source' } };
  }
  try {
    const res = await fetchJson(SKILL_INSTALL_API_URL, {
      method: 'POST',
      body: { source: normalized },
      fetchImpl,
    });
    const id =
      res && typeof res === 'object'
        ? typeof res.id === 'string'
          ? res.id
          : (res.skill?.id ?? null)
        : null;
    return { ok: true, id: typeof id === 'string' && id !== '' ? id : null };
  } catch (error) {
    return { ok: false, error };
  }
}

/** MCP 服务器清单：{servers:[...]} 或裸数组；坏项跳过；缺省返回 []。
 *  status 字段宽容接受（白名单，缺省/未知 → 'unused'）——前端按 enabled 态渲染徽章，
 *  契约上不依赖 status（服务端即使仍下发也不受影响）。 */
export function normalizeMcpServers(res) {
  const raw = Array.isArray(res) ? res : res?.servers;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' && s.name.trim() ? s.name : '';
    if (!name) continue;
    out.push({
      name,
      command: typeof s.command === 'string' && s.command.trim() ? s.command : null,
      status: s.status === 'configured' ? 'configured' : 'unused',
      enabled: Boolean(s.enabled),
    });
  }
  return out;
}

/** args 文本行 → 参数数组（空格/Tab/换行分隔；空串 → []）。 */
export function splitMcpArgs(text) {
  return String(text ?? '')
    .split(/\s+/)
    .filter(Boolean);
}
