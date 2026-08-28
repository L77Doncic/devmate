/**
 * # sessions.js — 侧边栏数据纯逻辑（会话/统计/工具清单的归一化与渲染摘要）
 *
 * S12 端点契约（任务书；后端未实现时 app.js 各自容错降级，本模块只负责「形状 → 可靠值」）：
 * - GET  /api/sessions        → { sessions: [{ sessionId, title, updatedAt, messageCount,
 *                               workspaceRoot: string|null }] }（宽容：裸数组亦可；
 *                               workspaceRoot = 会话所属项目文件夹，null → 「未知项目」）
 * - GET  /api/sessions/:id    → { sessionId, title, totalCount?, truncated?, events: [...] }
 *                               events 为**协议形状**（{event,data}，同 /api/stream 帧清单，
 *                               见 sse.js 头注），服务端最多回 500 条
 * - POST /api/sessions        → { sessionId }
 * - DELETE /api/sessions/:id  → 204 | {ok:true}；409 = 会话活跃（有 run 在跑）
 * - GET  /api/stats           → { rssMb, heapMb, sessions, activeShells }
 * - GET  /api/tools           → { tools: [{ name, description, parameters }] }（裸数组亦可；
 *                               parameters = JSON Schema，供「参数摘要」）
 *
 * 版本兼容：store 事件形态（{kind,payload}）若被端点返回，toProtocolEvent 会逐类映射；
 * 协议形状原样通过。未知类型一律丢弃（与 messages.js 的防御性忽略一致）。
 *
 * 纯函数边界：无 DOM、无 fetch、无 Date.now 调用点外副作用（timeAgo 为惰性计算）。
 */
import { truncate } from './format.js';

/** 服务端回放上限（任务书：≤500）；前端防御性复切一次，防未来服务端放开。 */
export const HISTORY_EVENTS_MAX = 500;

/** 会话列表：接受 {sessions:[...]} 或裸数组；逐项校验，坏项跳过。
 *  每项带 workspaceRoot（string|null）——按项目文件夹分组的归组键
 *  （服务端 A 档契约：旧会话/无 meta → null = 「未知项目」）。 */
export function normalizeSessionList(res) {
  const raw = Array.isArray(res) ? res : res?.sessions;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const id = typeof s.sessionId === 'string' ? s.sessionId : '';
    if (!id) continue;
    out.push({
      sessionId: id,
      title: typeof s.title === 'string' && s.title.trim() ? s.title : '',
      // 时间/条数：任务书版字段（updatedAt/messageCount）与 S12 落地形状
      // （lastEventMs/createdAtMs/stepCount）双兼容，取首个可用值。
      updatedAt: toTimestamp(s.updatedAt ?? s.lastEventMs ?? s.createdAtMs),
      messageCount: toCount(s.messageCount ?? s.stepCount),
      // workspaceRoot：字符串非空才接受；缺失/非字符串/空串 → null（未知项目）
      workspaceRoot:
        typeof s.workspaceRoot === 'string' && s.workspaceRoot.trim() !== ''
          ? s.workspaceRoot
          : null,
    });
  }
  return out;
}

function toTimestamp(v) {
  if (v === null || v === undefined) return null;
  const t =
    v instanceof Date ? v.getTime() : new Date(typeof v === 'number' ? v : String(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

function toCount(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 会话列表排序：updatedAt 新的在前；无时间戳的排后（原相对序）。 */
export function sortSessionList(list) {
  return [...list].sort((a, b) => {
    const ta = a.updatedAt ?? -Infinity;
    const tb = b.updatedAt ?? -Infinity;
    return tb - ta;
  });
}

/** 列表标题（任务书：40 字符内；空标题 → 「会话 <短 id>」）。 */
export function sessionDisplayTitle(s, shortIdFn) {
  const fallback = `会话 ${typeof shortIdFn === 'function' ? shortIdFn(s.sessionId) : ''}`;
  return truncate(s.title || fallback, 40);
}

// ---------------------------------------------------------------------------
// 会话分组（侧栏 = 仅对话；按 workspaceRoot 分作者分组 —— dsh 项目树语义）
// ---------------------------------------------------------------------------

/** workspaceRoot 缺省组的组头文案（旧会话/无 workspace meta → 归入此组）。 */
export const SESSION_UNKNOWN_LABEL = '未知项目';

/**
 * workspaceRoot → 组头 label：取文件夹 basename（分隔符 / 与 \ 都认 ——
 * Windows 路径在其它列队中被序列化时为 \）。根目录（如 'C:\\'）→ 'C:\\'；
 * 空白/畸形 → SESSION_UNKNOWN_LABEL（纯函数，不抛）。
 */
export function workspaceLabel(workspaceRoot) {
  const s = String(workspaceRoot ?? '').trim();
  if (s === '') return SESSION_UNKNOWN_LABEL;
  const parts = s.split(/[\\/]+/).filter((part) => part !== '');
  if (parts.length === 0) return s; // 'C:\' 之类纯分隔符路径：原样（不冒充未知项目）
  const last = parts[parts.length - 1];
  return last !== '' ? last : s;
}

/**
 * 会话列表 → 有序分组（组序 = 输入内组首现序 —— 调用方传 sortSessionList 的
 * 新→旧列表即组按「组内最新会话」倒序；workspaceRoot null 组恒为尾组）。
 * 返回 [{ workspaceRoot: string|null, label, sessions: [...] }]；空列表 → 空数组。
 */
export function groupSessionsByWorkspace(sorted) {
  const groups = new Map();
  let unknown = null;
  for (const s of sorted) {
    const key = s.workspaceRoot ?? null;
    if (key === null) {
      if (unknown === null) {
        unknown = { workspaceRoot: null, label: SESSION_UNKNOWN_LABEL, sessions: [] };
        groups.set(null, unknown);
      }
      unknown.sessions.push(s);
      continue;
    }
    let group = groups.get(key);
    if (group === undefined) {
      group = { workspaceRoot: key, label: workspaceLabel(key), sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(s);
  }
  // Map 插入序 = 会话新→旧首现序；null 组移到末尾（「未知项目」放最后）
  const out = [...groups.values()];
  const known = out.filter((g) => g.workspaceRoot !== null);
  const tail = out.filter((g) => g.workspaceRoot === null);
  return [...known, ...tail];
}

/**
 * 会话详情：接受 {events,title,...} 或裸事件数组。
 * 返回 { title, totalCount, truncated, events }：events 恒为协议形状数组，
 * 限制 HISTORY_EVENTS_MAX 条（多出部分丢弃 + truncated=true）。
 */
export function normalizeSessionDetail(res) {
  const raw = Array.isArray(res) ? res : res?.events;
  const events = Array.isArray(raw)
    ? raw
        .map(toProtocolEvent)
        .filter((e) => e !== null)
        .slice(0, HISTORY_EVENTS_MAX)
    : [];
  const total = toCount(Array.isArray(res) ? res.length : res?.totalCount);
  const totalCount = total ?? events.length;
  let title = typeof res?.title === 'string' ? res.title : '';
  if (!title) {
    const firstUser = events.find((e) => e?.event === 'session-user');
    if (firstUser?.data?.text) title = String(firstUser.data.text).slice(0, 24);
  }
  const truncated = Boolean(res?.truncated) || totalCount > events.length;
  return { title, totalCount, truncated, events };
}

/** 存储形态（{kind,payload}）→ 协议形状（{event,data}）；无法映射的返回 null。 */
export function toProtocolEvent(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.event === 'string') {
    return typeof e.data === 'string' ? { event: e.event, data: e.data } : e;
  }
  const kind = e.kind;
  const p = e.payload ?? {};
  switch (kind) {
    case 'user':
      return { event: 'session-user', data: { text: String(p.content ?? '') } };
    case 'assistant':
      return {
        event: 'assistant-done',
        data: { content: String(p.content ?? ''), toolCalls: p.toolCalls ?? [] },
      };
    case 'tool': {
      const content = String(p.content ?? '');
      // store 的 tool 结果回注内容是 {ok,...} JSON；协议形状给 preview/content 分离
      const outcome = parseToolOutcome(content);
      return {
        event: 'tool-result',
        data: {
          id: String(p.toolCallId ?? ''),
          name: '',
          ok: outcome.ok,
          contentPreview: content.slice(0, 200),
          content,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        },
      };
    }
    case 'system':
    case 'reasoning':
      return null; // 无对应协议事件：防御性丢弃（不影响首屏/追加）
    case 'event':
      // 上下文压缩记录（core/context/project 存储形态）→ 协议 compaction 帧
      // （披露折叠记；summary 全文与可选 token 估算）。其余 event 类型仍丢弃。
      if (p?.type === 'compaction') {
        const d = typeof p.data === 'object' && p.data !== null ? p.data : {};
        const out = { summary: typeof d.summary === 'string' ? d.summary : '' };
        if (typeof d.tokensBefore === 'number') out.tokensBefore = toCount(d.tokensBefore);
        if (typeof d.tokensAfter === 'number') out.tokensAfter = toCount(d.tokensAfter);
        return { event: 'compaction', data: out };
      }
      return null;
    default:
      return null;
  }
}

function parseToolOutcome(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
      if (!parsed.ok && typeof parsed.error === 'object' && parsed.error !== null) {
        const message = parsed.error.message;
        if (typeof message === 'string') return { ok: false, error: message };
      }
      return { ok: parsed.ok };
    }
  } catch {
    // 非 JSON 结果内容：按成功文本展示
  }
  return { ok: true };
}

/** /api/stats → 可靠数值（null 表示端点缺字段；展示层自行降级为「–」）。 */
export function normalizeStats(res) {
  if (!res || typeof res !== 'object') {
    return { rssMb: null, heapMb: null, sessions: null, activeShells: null };
  }
  const num = (v) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    rssMb: num(res.rssMb),
    heapMb: num(res.heapMb),
    sessions: num(res.sessions),
    activeShells: num(res.activeShells),
  };
}

/** footer 统计行：`内存 84MB · 会话 2 · Shell 1`（缺字段用 – 占位）。 */
export function formatStatsLine(stats) {
  const s = stats ?? {};
  const mem =
    typeof s.rssMb === 'number' && Number.isFinite(s.rssMb) ? `${Math.round(s.rssMb)}MB` : '–';
  const sessions = typeof s.sessions === 'number' ? String(Math.round(s.sessions)) : '–';
  const shells = typeof s.activeShells === 'number' ? String(Math.round(s.activeShells)) : '–';
  return `内存 ${mem} · 会话 ${sessions} · Shell ${shells}`;
}

/** /api/tools → [{name, description, parameters}]（裸数组或 {tools:[...]}；坏项跳过）。 */
export function normalizeToolsList(res) {
  const raw = Array.isArray(res) ? res : res?.tools;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const name = typeof t.name === 'string' ? t.name : '';
    if (!name) continue;
    out.push({
      name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : null,
    });
  }
  return out;
}

/** 参数摘要：JSON schema properties 的键名即参数名（缺省空串）。 */
export function toolParamNames(tool) {
  const props = tool?.parameters?.properties;
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props);
}

/** /api/tools 结果的可用性分区（修复「空表歧义」：端点缺失 ≠ 合法空注册表）：
 *  fetch 未取得（端点缺失/501/网络错误）→ 'static'（回退内置静态清单 + 「暂不可用」）；
 *  成功但空表 → 'empty'（运行时合法空注册表：「暂无可用工具」，不得冒充内置清单）；
 *  非空 → 'runtime'（运行时权威清单）。 */
export function toolsListSource(ok, tools) {
  if (!ok) return 'static';
  return (tools?.length ?? 0) > 0 ? 'runtime' : 'empty';
}
