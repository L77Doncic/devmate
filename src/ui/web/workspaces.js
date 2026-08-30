/**
 * # workspaces.js — 多工作区纯逻辑（dsh WorkspaceBrowser / WorkspacePickFlow 语义）
 *
 * S14 端点契约（服务端 src/ui/server 已提供；本模块只做「形状 → 可靠值」与裁决）：
 * - GET    /api/workspaces           → { roots: string[] }（缺省 = 启动目录；裸数组亦可）
 * - POST   /api/workspaces {path}    → { roots }（校验绝对目录 → 登记；错误 400 带原因：
 *                                       not accessible / must be a directory / not readable）
 * - DELETE /api/workspaces/:encodedRoot → { roots }（默认根不可删 → 400
 *                                       'cannot delete the default workspace root'）
 * - GET    /api/workspaces/browse?path= → { base, dirs: [{name,path}] }（缺省 homedir，
 *                                       仅目录、字节序排序、纯展示；深层错误 → 空目录列表）
 * - POST   /api/sessions {workspaceRoot?} → { sessionId }（workspaceRoot ∈ 注册表，
 *                                       未注册 → 400 'workspace-not-registered'）
 *
 * 组模型（dsh 语义：注册表驱动分组树）：workspace 组**只来源于注册根**；会话的
 * workspaceRoot 不在注册表 → 归入尾组「未知项目」（dsh UNGROUPED 桶）。前台
 * 需要展示但注册表不可达时的降级：以会话自身 workspaceRoot 并集作伪注册根。
 *
 * 纯函数边界：无 DOM、无 fetch、无定时器；storage 读写经注入的 storageLike
 * （与 theme.js/sidebar.js 同接缝，node 可测）。
 */
import { SESSION_UNKNOWN_LABEL } from './sessions.js';

// ---------------------------------------------------------------------------
// 常量（文案单一来源：本文件；防漂移断言见 test/ui-web/workspaces.test.ts）
// ---------------------------------------------------------------------------

/** 端点缺失/网络失败时的侧栏降级说明（与 sessions 降级说明同族）。 */
export const WS_DEGRADED_NOTE = '工作区列表暂不可用。添加/移除功能可能受限。';

/** 侧栏空态（dsh empty.none 语义：pad 16/12、13px、tertiary）。 */
export const WS_EMPTY_NOTE = '暂无会话：点「新建」或「添加工作区」开始。';

/** 搜索过滤到零结果的空态（与「无会话」区分：不冒充空表）。 */
export const WS_SEARCH_NO_MATCH = '无匹配会话';

/** 目录选择弹窗标题（dsh ui-directory-picker-browse 形态）。 */
export const WS_PICKER_TITLE = '选择工作区目录';

/** 手动路径输入 placeholder。 */
export const WS_PICKER_MANUAL_PLACEHOLDER = '或输入绝对路径，回车校验';

/** 选择按钮文案。 */
export const WS_PICKER_COMMIT_LABEL = '选择此文件夹';

/** 错误对话框标题（dsh folderError.title 形态）。 */
export const WS_ERROR_TITLE = '添加工作区失败';

/** 「未知项目」组头（未注册根会话；复用 sessions.js 单一来源）。 */
export const WS_UNGROUPED_LABEL = SESSION_UNKNOWN_LABEL;

/** 组折叠持久化键（per-workspace；JSON 映射 root→bool，损坏一律回落展开）。 */
export const WS_COLLAPSE_LS_KEY = 'devmate.ui.wsCollapsed';

/** 工作区组头 kebab 菜单条目（dsh ProjectRowItem row menu 本地实例：仅移除；
 *  危险项红着 —— 与 SESSION_MENU_ITEMS 同纪律，白名单匹配见 app.js）。 */
export const WS_MENU_ITEMS = Object.freeze([
  Object.freeze({ id: 'remove', label: '移除工作区', danger: true }),
]);

// ---------------------------------------------------------------------------
// 归一：注册根列表
// ---------------------------------------------------------------------------

/** 绝对路径判定（POSIX 以 / 开头；Windows 盘符兼容——服务端按 POSIX 校验，前端宽容）。 */
export function isAbsolutePath(path) {
  const s = String(path ?? '');
  return s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s);
}

/**
 * GET /api/workspaces → 注册根列表：接受 {roots:[...]} 或裸数组；逐项
 * 校验（非空字符串且绝对路径），去重保序（dsh/服务端 dedupeKeepOrder 同语义）。
 * 非法返回 []（调用方据此容错降级）。
 */
export function normalizeWorkspaceRoots(res) {
  const raw = Array.isArray(res) ? res : res?.roots;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (typeof r !== 'string' || r.trim() === '' || !isAbsolutePath(r.trim())) continue;
    const key = r.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 去重保序（任意数组 → 去重后保持首现序；服务端 dedupeKeepOrder 同语义，纯本地）。
 * 用于：注册表不可达时以会话根并集作伪注册根。
 */
export function dedupeKeepOrder(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 命名（dsh util-workspace-path：friendly basename + POSIX home 缩写 meta）
// ---------------------------------------------------------------------------

/** 工作区友好显示名：取路径最后一个非空段（/ 与 \ 都认）。
 *  纯分隔符路径（'/'、'C:\'）→ 原样返回（不冒充空名）。 */
export function workspaceName(root) {
  const s = String(root ?? '').trim();
  if (s === '') return '';
  const parts = s.split(/[\\/]+/).filter((part) => part !== '');
  if (parts.length === 0) return s;
  return parts[parts.length - 1];
}

/** 工作区路径 meta（dsh abbreviateHomePath：home 下 → '~' 缩写；其余原样）。 */
export function workspacePathMeta(root, home) {
  const s = String(root ?? '');
  const h = home ? String(home).replace(/[\\/]+$/, '') : '';
  if (h !== '' && (s === h || s.startsWith(h + '/'))) {
    return '~' + s.slice(h.length);
  }
  return s;
}

/**
 * 菜单顺序（dsh WorkspacePickFlow 惯例 + 任务书「默认根项在下」）：
 * 非默认根（注册序）在前，默认根殿后；不识别默认根时原序返回。
 */
export function workspaceMenuOrder(roots, defaultRoot) {
  if (!defaultRoot) return [...roots];
  const rest = roots.filter((r) => r !== defaultRoot);
  return [...rest, ...(roots.includes(defaultRoot) ? [defaultRoot] : [])];
}

/** 默认根识别（客户端无服务端权威字段：注册表初值通常列首 —— 服务端
 *  dedupeKeepOrder([workspaceRoot,...]) 或 config.workspaces 全局。roots[0] 启发 +
 *  DELETE 400 'cannot delete the default workspace root' 回授校正（见 app.js）。 */
export function pickDefaultRoot(roots) {
  const list = Array.isArray(roots) ? roots : [];
  return list.length > 0 ? list[0] : null;
}

// ---------------------------------------------------------------------------
// 会话行 搜索过滤 / 排序轮换（dsh WorkspaceBrowser 区头 search/sort 的纯逻辑；
// 只做「列表 → 列表」，DOM 装配与 open 态在 app.js —— 纯函数可单测）
// ---------------------------------------------------------------------------

/** 排序模式（点击轮换序）：recent = 最近（updatedAt 新→旧，缺省）/ name = 标题。 */
export const WS_SORT_MODES = Object.freeze(['recent', 'name']);

/** 轮换裁决（dsh sort 图标点击）：recent → name → recent（未知值按 recent 起轮）。 */
export function nextWsSortMode(current) {
  return current === 'name' ? 'recent' : 'name';
}

/**
 * 会话列表按模式排序（输入不修改；返回新数组）：
 * - recent：updatedAt 新→旧，无时间戳排后（原相对序，与 sessions.js sortSessionList 同语义）；
 * - name：标题升序（localeCompare，无标题排前）；同标题比 updatedAt 新→旧（稳定）；
 * - 未知模式按 recent 兜底（闭集：不抛、不裸露未知串，渲染层永不落到空排序）。
 */
export function sortWorkspaceSessions(list, mode) {
  const arr = Array.isArray(list) ? [...list] : [];
  if (mode === 'name') {
    return arr.sort((a, b) => {
      const cmp = String(a?.title ?? '').localeCompare(String(b?.title ?? ''), 'zh');
      if (cmp !== 0) return cmp;
      return (b?.updatedAt ?? -Infinity) - (a?.updatedAt ?? -Infinity);
    });
  }
  return arr.sort((a, b) => {
    return (b?.updatedAt ?? -Infinity) - (a?.updatedAt ?? -Infinity);
  });
}

/**
 * 会话行过滤（纯客户端）：query 空白 → 原列表副本（无查询 = 不过滤）；
 * 命中 = 标题或 sessionId 包含 query（大小写不敏感）。空查询/空列表均防御。
 */
export function filterSessionList(list, query) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  const src = Array.isArray(list) ? list : [];
  if (q === '') return [...src];
  return src.filter((s) => {
    const hay = `${String(s?.title ?? '')} ${String(s?.sessionId ?? '')}`.toLowerCase();
    return hay.includes(q);
  });
}

// ---------------------------------------------------------------------------
// 组模型：注册表 → per-group sessions 树
// ---------------------------------------------------------------------------

/**
 * 会话列表 → 工作区分组树（dsh 语义）：
 * - 组序 = 传入 roots 序（调用方传注册序；菜单序由 workspaceMenuOrder 另管）；
 * - 每个注册根一组 { workspaceRoot, label, meta, registered:true, sessions }；
 * - workspaceRoot 不在注册表（含 null/未注册根）→ 恒为尾组「未知项目」
 *   （registered:false，无 kebab —— 不可移除未注册「组」）；
 * - 未知组无会话 → 省略（空注册根组保留：组头常驻，空组体）。
 * 输入为已排序列表（调用方 sortWorkspaceSessions —— 时间或名称模式），组内序随输入。
 */
export function groupSessionsByRegisteredWorkspaces(sorted, roots) {
  const rootList = Array.isArray(roots) ? roots : [];
  const groups = new Map();
  for (const root of rootList) {
    groups.set(root, {
      workspaceRoot: root,
      label: workspaceName(root),
      meta: root,
      registered: true,
      sessions: [],
    });
  }
  const ungrouped = {
    workspaceRoot: null,
    label: WS_UNGROUPED_LABEL,
    meta: '',
    registered: false,
    sessions: [],
  };
  for (const s of sorted) {
    const root = s?.workspaceRoot ?? null;
    const group = root !== null && groups.has(root) ? groups.get(root) : ungrouped;
    group.sessions.push(s);
  }
  const out = [...groups.values()];
  if (ungrouped.sessions.length > 0) out.push(ungrouped);
  return out;
}

/** 当前会话所属工作区根（注册表 ∩ 会话 workspaceRoot；null = 未知/未注册）。 */
export function workspaceOfSession(roots, session) {
  if (!session?.workspaceRoot) return null;
  return Array.isArray(roots) && roots.includes(session.workspaceRoot)
    ? session.workspaceRoot
    : null;
}

// ---------------------------------------------------------------------------
// 目录浏览状态机（ui-directory-picker-browse）
// ---------------------------------------------------------------------------

/**
 * 浏览态：stack = 上级 base 栈（browseUp 弹出）；base = 当前目录；
 * dirs = 当前目录子目录 [{name,path}]；selected = 待注册目录路径（null = 未选）；
 * browsing = 一次进级/回退的拉取在途（调用方以此置 loading 态）。
 */
export function createBrowseState(base = '') {
  return { stack: [], base: String(base ?? ''), dirs: [], selected: null, browsing: false };
}

/** GET /api/workspaces/browse → 可靠形状 {base, dirs}：逐项校验（name/path 字符串，
 *  绝对路径方可），去重保序，按 name 字节序排序（服务端同序；本地兜底一遍）。 */
export function normalizeBrowse(res) {
  const base = typeof res?.base === 'string' ? res.base : '';
  const raw = Array.isArray(res?.dirs) ? res.dirs : [];
  const seen = new Set();
  const dirs = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const name = typeof d.name === 'string' ? d.name : '';
    const path = typeof d.path === 'string' ? d.path : '';
    if (!name || !path || !isAbsolutePath(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    dirs.push({ name, path });
  }
  dirs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { base, dirs };
}

/** 进入子目录：当前 base 压栈、目标为 base、清选择、置浏览在途。 */
export function browseNavigate(state, path) {
  const p = String(path ?? '');
  if (!p || !isAbsolutePath(p) || p === state.base) return state;
  return {
    ...state,
    stack: [...state.stack, state.base],
    base: p,
    dirs: [],
    selected: null,
    browsing: true,
  };
}

/** 回退上级（`..` 行 / 面包屑）：栈空（已在根 base）→ 原样返回（不逃逸）。 */
export function browseUp(state) {
  if (state.stack.length === 0) return state;
  const next = state.stack[state.stack.length - 1];
  return {
    ...state,
    stack: state.stack.slice(0, -1),
    base: next,
    dirs: [],
    selected: null,
    browsing: true,
  };
}

/** 拉取完成：装载归一结果（base 以服务端回体为准 —— normalize 后的权威），在途解除。 */
export function browseLoaded(state, normalized) {
  return {
    ...state,
    base:
      typeof normalized?.base === 'string' && normalized.base !== '' ? normalized.base : state.base,
    dirs: Array.isArray(normalized?.dirs) ? normalized.dirs : [],
    browsing: false,
  };
}

/** 选中当前级目录（行点击）：path 必须在本级 dirs 内；未命中/空 → 清选择。
 *  额外允许 path === base（手动路径/面包屑落点 —— 「在此级选中即注册」）。 */
export function browseSelect(state, path) {
  const p = String(path ?? '');
  if (p === '' || !isAbsolutePath(p)) return { ...state, selected: null };
  if (p !== state.base && !state.dirs.some((d) => d.path === p))
    return { ...state, selected: null };
  return { ...state, selected: p };
}

/** 提交可用性：「选择此文件夹」按钮 enable 裁决（只在当前级选中或落在 base）。 */
export function browseCanCommit(state) {
  return state.selected !== null && state.selected !== '';
}

/** 面包屑段（路径条可点分段）：[{name, path}]；POSIX '/' 单项；每段点击 → buybrowse到该段。
 *  例：/home/u/p → [{'/', '/'}, {'home','/home'}, {'u','/home/u'}, {'p','/home/u/p'}]。 */
export function breadcrumbSegments(base) {
  const s = String(base ?? '');
  if (s === '') return [];
  // Windows 盘符根：'C:\' → 单项根
  const drive = /^([a-zA-Z]:)[\\/]/.exec(s);
  if (drive) {
    const rest = s.slice(drive[0].length);
    const parts = rest.split(/[\\/]+/).filter((p) => p !== '');
    const segments = [{ name: drive[1] + '\\', path: drive[1] + '\\' }];
    let acc = drive[1] + '\\';
    for (const part of parts) {
      acc = acc + part + '\\';
      segments.push({ name: part, path: acc.slice(0, -1) });
    }
    return segments;
  }
  const parts = s.split('/').filter((p) => p !== '');
  if (parts.length === 0) return [{ name: '/', path: '/' }];
  const segments = [{ name: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc = acc + '/' + part;
    segments.push({ name: part, path: acc });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// 校验与持久化（per-workspace 折叠）
// ---------------------------------------------------------------------------

/**
 * 折叠映射归一：localStorage JSON → { [root]: boolean }。坏 JSON/非对象/非
 * 布尔值一律忽略（默认展开 —— dsh groupExpansion 默认全展开语义）。
 */
export function normalizeWorkspaceCollapse(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** 读取折叠映射（容错：storage 缺失/读异常一律空映射 → 展开）。 */
export function loadWorkspaceCollapse(storage) {
  try {
    return normalizeWorkspaceCollapse(storage?.getItem?.(WS_COLLAPSE_LS_KEY));
  } catch {
    return {};
  }
}

/** 写入折叠映射（容错：写入异常静默忽略）。返回目标映射。 */
export function saveWorkspaceCollapse(storage, collapsed) {
  const map = { ...(collapsed ?? {}) };
  try {
    storage?.setItem?.(WS_COLLAPSE_LS_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式/禁用存储：不 throw
  }
  return map;
}

// ---------------------------------------------------------------------------
// 已选工作区持久化（P1-2：保存设置/刷新/重启不回「先选工作区」锁定态 —— 有已选
// 工作区即解锁；写读均容错，与 fold 映射同纪律）。
// ---------------------------------------------------------------------------

/** 持久键（命名与前缀同族：devmate.ui.workspaceChoicePersisted；布尔位）。 */
const WS_CHOICE_KEY = 'devmate.ui.workspaceChoicePersisted';

/**
 * 读取「已选过工作区」位：仅字面量 '1' 为真（坏值/缺失 → false = 仍锁态；
 * 防旧记法/损坏值误解锁）。读取异常 → false（锁态是安全默认）。
 */
export function loadWorkspaceChoice(storage) {
  try {
    return storage?.getItem?.(WS_CHOICE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 写入/清空「已选工作区」位：chosen=true → 置 '1'；false → 删键。
 * 写入异常静默（锁态回退由下次读取决定，不 throw）。
 */
export function saveWorkspaceChoice(storage, chosen) {
  try {
    if (chosen) storage?.setItem?.(WS_CHOICE_KEY, '1');
    else storage?.removeItem?.(WS_CHOICE_KEY);
  } catch {
    // 隐私模式/禁用存储：不 throw
  }
}

// ---------------------------------------------------------------------------
// 错误映射（dsh folderError 形态：kind → 中文文案）
// ---------------------------------------------------------------------------

/**
 * 错误分类（err 语义 = api.js HttpError/TypeError）：kind 用于分支裁决
 * （如 default-root 回授 → 把该根标记禁用），text 用于对话框/toast 文案。
 * 识别顺序：HTTP 400 原因关键字 → 404 → 网络（TypeError/无 status）→ 未知。
 */
export function workspaceErrorInfo(err) {
  const status = typeof err?.status === 'number' ? err.status : null;
  const rawMessage =
    (err?.data && typeof err.data === 'object' && typeof err.data.error === 'string'
      ? err.data.error
      : '') ||
    (typeof err?.message === 'string' ? err.message : '') ||
    '';
  if (status === null) {
    // 端点缺失/网络层：TypeError: fetch failed 或空 message
    return { kind: 'network', text: '工作区服务暂不可用，请检查服务状态后重试。' };
  }
  if (status === 400) {
    if (rawMessage.includes('cannot delete the default workspace root')) {
      return { kind: 'default-root', text: '默认工作区不可移除。' };
    }
    if (rawMessage.includes('workspace-not-registered')) {
      return { kind: 'not-registered', text: '工作区未注册，请刷新后再试。' };
    }
    if (rawMessage.includes('must be absolute')) {
      return { kind: 'not-absolute', text: '路径无效：必须是绝对目录路径。' };
    }
    if (rawMessage.includes('must be a directory')) {
      return { kind: 'not-dir', text: '路径无效：目标不是目录。' };
    }
    if (rawMessage.includes('not accessible')) {
      return { kind: 'not-accessible', text: '路径不可访问（不存在或没有权限）。' };
    }
    if (rawMessage.includes('not readable')) {
      return { kind: 'not-readable', text: '目录不可读：没有读取权限。' };
    }
    return { kind: 'invalid', text: `添加失败：${rawMessage}` };
  }
  if (status === 404) {
    return { kind: 'missing', text: '工作区未注册，可能已被移除。' };
  }
  return { kind: 'http', text: `操作失败（HTTP ${status}）${rawMessage ? `：${rawMessage}` : ''}` };
}

/** 侧栏降级提示（注册表不可达时 + 新建菜单的降级行文案）。 */
export function wsMenuDegradedNote() {
  return '工作区列表暂不可用：新建会话将使用默认工作区。';
}
