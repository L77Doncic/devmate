/**
 * # extensions.js — 设置页扩展区纯逻辑（Skills / MCP / Subagent 工作流）
 *
 * 协议契约（前端全部宽容归一化，失败由 app.js 调用方降级）：
 * - GET  /api/skills          → { skills: [{ id, name, summary, enabled }] }（裸数组亦可）
 * - POST /api/skills/:id      → 请求体 { enabled: boolean }（204 | {ok:true}）
 * - GET  /api/mcp             → { servers: [{ name, command?, enabled }] }（裸数组亦可；
 *                               status 字段服务端若下发也宽容接受 —— 前端按 enabled 渲染徽章，
 *                               契约不依赖 status）
 * - POST /api/mcp             → 请求体 { name, command, args: string[] }
 *
 * Subagent 工作流偏好与后端 /api/workflow 同步（服务端已实现，见 src/ui/server/index.ts）：
 * - GET  /api/workflow        → { subagentsEnabled, maxParallel }（成功：回显服务端值）
 * - POST /api/workflow        → 混合字段部分提交 { subagentsEnabled? } | { maxParallel? }
 *                               （200 → 服务端全量回体；非法值/越界 → 400）
 * 失败/缺端点 → 降级 localStorage 'devmate.ui.subagents' = { enabled, parallel: 1|2|3|4 }，
 * 默认 { enabled: true, parallel: 2 }（任务书：开关默认开、并行数默认 2、1-4 禁 0），
 * 控件旁注「未同步（仅本地）」（copy 常量单一来源）。
 *
 * 纯函数边界：无 DOM；fetchImpl 与 storageLike 注入（与 api.js/theme.js 同接缝，node 可测）。
 */

import { fetchJson } from './api.js';

export const SUBAGENT_LS_KEY = 'devmate.ui.subagents';
/** 工作流端点（服务端已实现：GET 全量 / POST 混合字段部分提交，见 server/index.ts）。 */
export const WORKFLOW_API_URL = '/api/workflow';
export const SUBAGENT_DEFAULTS = Object.freeze({ enabled: true, parallel: 2 });
export const SUBAGENT_PARALLEL_MIN = 1;
export const SUBAGENT_PARALLEL_MAX = 4;

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
 * 并行数归一：round 到整数后 clamp 1..4；非有限值/越界 0 一律回落 fallback（默认 2）。
 * @param {unknown} value 输入值（number|string|undefined 均可归一）
 * @param {number} [fallback] 兜底并行数，默认 2
 * @returns {number} 1-4 的整数
 */
export function normalizeParallel(value, fallback = SUBAGENT_DEFAULTS.parallel) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < SUBAGENT_PARALLEL_MIN) return fallback; // 禁 0（含负值）：退回默认
  return Math.min(SUBAGENT_PARALLEL_MAX, Math.max(SUBAGENT_PARALLEL_MIN, rounded));
}

/** Subagent 偏好归一（缺省/坏值 → 默认：开关保持上次布尔，并行数兜底 2）。 */
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
 * {enabled,parallel}（宽容双形状）；缺省/坏值 → 默认（parallel 兜底 2，禁 0）。
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
 * → 服务端字段 {subagentsEnabled?,maxParallel?}；maxParallel 提交前归一——0/负本地兜底 2）。
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

/** 技能清单：{skills:[...]} 或裸数组；逐项校验，坏项跳过；缺省返回 []。 */
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
    });
  }
  return out;
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
