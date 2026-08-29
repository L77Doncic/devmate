/**
 * workspaces.js 单测：多工作区纯逻辑 —— 注册根归一、命名（basename/home 缩写）、
 * 注册表驱动分组树（未注册根会话归「未知项目」尾组）、目录浏览状态机
 * （stack/上下级/selected）、面包屑、折叠映射持久化、错误映射。
 * 全部为纯函数；端点形状按 S14 契约（含裸数组/端点在途的容错分支）。
 */
import { describe, expect, it } from 'vitest';
import {
  WS_DEGRADED_NOTE,
  WS_EMPTY_NOTE,
  WS_COLLAPSE_LS_KEY,
  WS_MENU_ITEMS,
  WS_UNGROUPED_LABEL,
  isAbsolutePath,
  normalizeWorkspaceRoots,
  dedupeKeepOrder,
  workspaceName,
  workspacePathMeta,
  workspaceMenuOrder,
  pickDefaultRoot,
  groupSessionsByRegisteredWorkspaces,
  workspaceOfSession,
  createBrowseState,
  normalizeBrowse,
  browseNavigate,
  browseUp,
  browseLoaded,
  browseSelect,
  browseCanCommit,
  breadcrumbSegments,
  normalizeWorkspaceCollapse,
  loadWorkspaceCollapse,
  saveWorkspaceCollapse,
  workspaceErrorInfo,
} from '../../src/ui/web/workspaces.js';
import { SESSION_UNKNOWN_LABEL } from '../../src/ui/web/sessions.js';

// ---------------------------------------------------------------------------
// 常量单一来源（防漂移：文案必须与侧栏/菜单装配一致）
// ---------------------------------------------------------------------------

describe('workspaces 常量（文案单一来源）', () => {
  it('降级/空态文案与「未知项目」共用 sessions.js 语义', () => {
    expect(WS_DEGRADED_NOTE).toContain('工作区');
    expect(WS_EMPTY_NOTE).toContain('会话');
    expect(WS_UNGROUPED_LABEL).toBe(SESSION_UNKNOWN_LABEL);
  });

  it('折叠持久化键为任务书拼写（与 theme/sidebar 同族 devmate.* 前缀）', () => {
    expect(WS_COLLAPSE_LS_KEY).toBe('devmate.ui.wsCollapsed');
  });

  it('组头菜单条目 = 单一移除项（白名单有序；与行菜单同纪律）', () => {
    expect(WS_MENU_ITEMS).toHaveLength(1);
    expect(WS_MENU_ITEMS[0]).toMatchObject({ id: 'remove', danger: true });
  });
});

// ---------------------------------------------------------------------------
// 注册根归一
// ---------------------------------------------------------------------------

describe('normalizeWorkspaceRoots / isAbsolutePath', () => {
  it('{roots:[...]} 与裸数组均接受；去重保序', () => {
    const input = ['/a', '/b', '/a', '/c'];
    expect(normalizeWorkspaceRoots({ roots: input })).toEqual(['/a', '/b', '/c']);
    expect(normalizeWorkspaceRoots(input)).toEqual(['/a', '/b', '/c']);
  });

  it('坏项（相对路径/空串/非字符串/畸形对象）丢弃；missing 与空表 → []', () => {
    expect(normalizeWorkspaceRoots({ roots: ['rel/path', '', 42, null, '/ok'] })).toEqual(['/ok']);
    expect(normalizeWorkspaceRoots({})).toEqual([]);
    expect(normalizeWorkspaceRoots(null)).toEqual([]);
    expect(normalizeWorkspaceRoots({ roots: [] })).toEqual([]);
  });

  it('isAbsolutePath：POSIX 与 Windows 盘符；相对/空/win UNC 之外不可接受', () => {
    expect(isAbsolutePath('/a/b')).toBe(true);
    expect(isAbsolutePath('C:\\x')).toBe(true);
    expect(isAbsolutePath('c:/x')).toBe(true);
    expect(isAbsolutePath('a/b')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
    expect(isAbsolutePath(null)).toBe(false);
  });

  it('dedupeKeepOrder：任意去重保序（伪注册根并用场景）', () => {
    expect(dedupeKeepOrder(['/a', '/b', '/a', '/c', 'b'])).toEqual(['/a', '/b', '/c', 'b']);
    expect(dedupeKeepOrder([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 命名
// ---------------------------------------------------------------------------

describe('workspaceName / workspacePathMeta / 菜单序 / 默认根', () => {
  it('workspaceName：末段 basename；/ 与 \\ 都认；纯分隔符路径原样返回', () => {
    expect(workspaceName('/root/work/proj-a')).toBe('proj-a');
    expect(workspaceName('/root/work/proj-a/')).toBe('proj-a');
    expect(workspaceName('C:\\work\\proj')).toBe('proj');
    expect(workspaceName('/')).toBe('/');
    expect(workspaceName('')).toBe('');
    expect(workspaceName(null)).toBe('');
  });

  it('workspacePathMeta：home 下缩写为 ~，其余原样（dsh abbreviateHomePath）', () => {
    expect(workspacePathMeta('/home/user/proj', '/home/user')).toBe('~/proj');
    expect(workspacePathMeta('/home/user', '/home/user')).toBe('~');
    expect(workspacePathMeta('/opt/other', '/home/user')).toBe('/opt/other');
    expect(workspacePathMeta('/home/user2/x', '/home/user')).toBe('/home/user2/x');
    expect(workspacePathMeta('/x', undefined)).toBe('/x');
  });

  it('workspaceMenuOrder：默认根殿后（任务书「默认根项在下」），其余保持注册序', () => {
    expect(workspaceMenuOrder(['/default', '/w2', '/w3'], '/default')).toEqual([
      '/w2',
      '/w3',
      '/default',
    ]);
    expect(workspaceMenuOrder(['/w2', '/default'], '/default')).toEqual(['/w2', '/default']);
    expect(workspaceMenuOrder(['/a', '/b'], null)).toEqual(['/a', '/b']);
    // 默认根不在表内：原序
    expect(workspaceMenuOrder(['/a', '/b'], '/zzz')).toEqual(['/a', '/b']);
  });

  it('pickDefaultRoot：注册表首项启发（服务端种子通常列首）；空表 → null', () => {
    expect(pickDefaultRoot(['/root-a', '/root-b'])).toBe('/root-a');
    expect(pickDefaultRoot([])).toBeNull();
    expect(pickDefaultRoot(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 组模型（注册表驱动）
// ---------------------------------------------------------------------------

describe('groupSessionsByRegisteredWorkspaces', () => {
  const sorted = [
    { sessionId: 'd1', title: 'D挂起', updatedAt: 400, workspaceRoot: '/default' },
    { sessionId: 'n1', title: '未知新', updatedAt: 350, workspaceRoot: null },
    { sessionId: 'a1', title: 'A新', updatedAt: 300, workspaceRoot: '/work/a' },
    { sessionId: 'gone1', title: '已移除根', updatedAt: 250, workspaceRoot: '/work/gone' },
    { sessionId: 'a2', title: 'A旧', updatedAt: null, workspaceRoot: '/work/a' },
  ];

  it('组序 = 注册序；未注册根（含 /work/gone）与 null 一律归「未知项目」尾组', () => {
    const groups = groupSessionsByRegisteredWorkspaces(sorted, ['/work/a', '/default']);
    expect(groups.map((g) => g.workspaceRoot)).toEqual(['/work/a', '/default', null]);
    expect(groups.map((g) => g.label)).toEqual(['a', 'default', SESSION_UNKNOWN_LABEL]);
    expect(groups[0]!.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([
      'a1',
      'a2',
    ]);
    expect(groups[1]!.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['d1']);
    // tail 组 = null + 已移除根会话（registered:false —— 无移除菜单）
    expect(groups[2]!.registered).toBe(false);
    expect(groups[2]!.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([
      'n1',
      'gone1',
    ]);
    // 注册组恒 registered（可移除菜单的前提）
    expect(groups[0]!.registered).toBe(true);
    expect(groups[0]!.meta).toBe('/work/a');
  });

  it('注册根无会话 → 空组头保留（dsh 空组常驻）；未知组无会话 → 省略', () => {
    const groups = groupSessionsByRegisteredWorkspaces(
      [{ sessionId: 'a1', workspaceRoot: '/work/a' }],
      ['/work/a', '/empty'],
    );
    expect(groups).toHaveLength(2);
    expect(groups[1].workspaceRoot).toBe('/empty');
    expect(groups[1].sessions).toEqual([]);
    // null 尾组不出现（没有任何未知会话）
    expect(groups.map((g) => g.workspaceRoot)).toEqual(['/work/a', '/empty']);
  });

  it('注册表不可达降级：以会话根并集作伪注册根 → 全组可见（labeled by basename）', () => {
    const pseudoRoots = dedupeKeepOrder(sorted.map((s) => s.workspaceRoot).filter(Boolean));
    const groups = groupSessionsByRegisteredWorkspaces(sorted, pseudoRoots);
    expect(groups.map((g) => g.label)).toEqual(['default', 'a', 'gone', SESSION_UNKNOWN_LABEL]);
    expect(groups.at(-1)!.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['n1']);
  });

  it('空会话/空注册表 → 空数组；不修改原数组（只读装配）', () => {
    expect(groupSessionsByRegisteredWorkspaces([], [])).toEqual([]);
    expect(groupSessionsByRegisteredWorkspaces([], ['/a'])).toEqual([
      expect.objectContaining({ workspaceRoot: '/a', sessions: [] }),
    ]);
    const list = [{ sessionId: 's1', workspaceRoot: '/w' }];
    groupSessionsByRegisteredWorkspaces(list, ['/w']);
    expect(list[0]!.sessionId).toBe('s1');
  });

  it('workspaceOfSession：注册根 ∩ 会话根；未注册/未知 → null', () => {
    const roots = ['/w1', '/w2'];
    expect(workspaceOfSession(roots, { workspaceRoot: '/w1' })).toBe('/w1');
    expect(workspaceOfSession(roots, { workspaceRoot: '/gone' })).toBeNull();
    expect(workspaceOfSession(roots, { workspaceRoot: null })).toBeNull();
    expect(workspaceOfSession(roots, null)).toBeNull();
    expect(workspaceOfSession(null, { workspaceRoot: '/w1' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 目录浏览状态机
// ---------------------------------------------------------------------------

describe('目录浏览状态机（browse）', () => {
  const home = '/home/user';

  it('createBrowseState / normalizeBrowse：shape 校验 + 字节序排序 + 去重', () => {
    expect(createBrowseState(home)).toEqual({
      stack: [],
      base: home,
      dirs: [],
      selected: null,
      browsing: false,
    });
    const res = normalizeBrowse({
      base: home,
      dirs: [
        { name: 'zeta', path: home + '/zeta' },
        { name: 'alpha', path: home + '/alpha' },
        { name: 'alpha', path: home + '/alpha' },
        { name: '', path: home + '/bad1' },
        { name: 'rel', path: 'relative' },
        null,
      ],
    });
    expect(res.base).toBe(home);
    expect(res.dirs.map((d) => d.name)).toEqual(['alpha', 'zeta']);
  });

  it('normalizeBrowse 异常形状（端点降级 {base,dirs:[]} / null）→ 可靠空表', () => {
    expect(normalizeBrowse(null)).toEqual({ base: '', dirs: [] });
    expect(normalizeBrowse({ base: 42, dirs: 'no' })).toEqual({ base: '', dirs: [] });
    expect(normalizeBrowse({ base: home, dirs: [] })).toEqual({ base: home, dirs: [] });
  });

  it('browseNavigate：压栈进级、清选择、置在途；非绝对/同级/空路径 → 原样', () => {
    const a = createBrowseState(home);
    const b = browseNavigate(a, home + '/proj');
    expect(b.base).toBe(home + '/proj');
    expect(b.stack).toEqual([home]);
    expect(b.browsing).toBe(true);
    expect(b.selected).toBeNull();
    // 回退再进级：两段栈
    const c = browseNavigate(b, home + '/proj/sub');
    expect(c.stack).toEqual([home, home + '/proj']);
    expect(browseNavigate(a, 'relative')).toBe(a);
    expect(browseNavigate(a, home)).toBe(a);
    expect(browseNavigate(a, '')).toBe(a);
  });

  it('browseUp：弹栈回上级；栈空（根 base）→ 原样（不逃逸）', () => {
    const a = createBrowseState(home);
    const b = browseNavigate(a, home + '/proj');
    const c = browseNavigate(b, home + '/proj/sub');
    const up1 = browseUp(c);
    expect(up1.base).toBe(home + '/proj');
    expect(up1.stack).toEqual([home]);
    const up2 = browseUp(up1);
    expect(up2.base).toBe(home);
    expect(up2.stack).toEqual([]);
    // 栈空 no-op：同一引用（弹窗「..」无处可回）
    const up3 = browseUp(up2);
    expect(up3).toBe(up2);
  });

  it('browseLoaded：以服务端回体 base 为准装载 dirs、解除在途', () => {
    const a = browseNavigate(createBrowseState(home), home + '/proj');
    const r = normalizeBrowse({
      base: home + '/proj',
      dirs: [{ name: 'x', path: home + '/proj/x' }],
    });
    const loaded = browseLoaded(a, r);
    expect(loaded.browsing).toBe(false);
    expect(loaded.dirs).toHaveLength(1);
    expect(loaded.base).toBe(home + '/proj');
  });

  it('browseSelect：仅接受本级 dirs 成员或 base 本身；未命中/非法清选择', () => {
    const a = browseLoaded(
      browseNavigate(createBrowseState(home), home + '/proj'),
      normalizeBrowse({
        base: home + '/proj',
        dirs: [{ name: 'sub', path: home + '/proj/sub' }],
      }),
    );
    const s1 = browseSelect(a, home + '/proj/sub');
    expect(s1.selected).toBe(home + '/proj/sub');
    expect(browseCanCommit(s1)).toBe(true);
    // base 本身（手动路径/面包屑落点）亦可选中
    expect(browseSelect(a, home + '/proj').selected).toBe(home + '/proj');
    expect(browseSelect(a, home + '/elsewhere').selected).toBeNull();
    expect(browseCanCommit(browseSelect(a, home + '/elsewhere'))).toBe(false);
    expect(browseSelect(a, null).selected).toBeNull();
  });

  it('browseCanCommit：无选择 → false（按钮 enable 裁决）', () => {
    expect(browseCanCommit(createBrowseState(home))).toBe(false);
  });

  it('breadcrumbSegments：POSIX 根单项、多段累进、Windows 盘符', () => {
    expect(breadcrumbSegments('/')).toEqual([{ name: '/', path: '/' }]);
    expect(breadcrumbSegments('/home/user/proj')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'user', path: '/home/user' },
      { name: 'proj', path: '/home/user/proj' },
    ]);
    const win = breadcrumbSegments('C:\\work\\proj');
    expect(win[0]).toEqual({ name: 'C:\\', path: 'C:\\' });
    expect(win[2]).toEqual({ name: 'proj', path: 'C:\\work\\proj' });
    expect(breadcrumbSegments('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 折叠映射持久化
// ---------------------------------------------------------------------------

describe('workspace 折叠映射（per-workspace 持久化，仅布尔服从）', () => {
  it('normalizeWorkspaceCollapse：合法 JSON 映射通过；坏 JSON/非对象/数组/非布尔忽略', () => {
    expect(normalizeWorkspaceCollapse('{"a":true,"b":false}')).toEqual({ a: true, b: false });
    expect(normalizeWorkspaceCollapse('{"a":1,"b":"yes"}')).toEqual({});
    expect(normalizeWorkspaceCollapse('{bad json')).toEqual({});
    expect(normalizeWorkspaceCollapse('[1,2]')).toEqual({});
    expect(normalizeWorkspaceCollapse('"str"')).toEqual({});
    expect(normalizeWorkspaceCollapse(null)).toEqual({});
    expect(normalizeWorkspaceCollapse(undefined)).toEqual({});
  });

  it('load/save 容错：storage 缺失/读异常 → 空映射（默认展开）；写入回显目标映射', () => {
    expect(loadWorkspaceCollapse(null)).toEqual({});
    expect(loadWorkspaceCollapse({ getItem: () => '{bad' })).toEqual({});
    const store = new Map();
    const storage = {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveWorkspaceCollapse(storage, { '/w': true });
    expect(storage.getItem(WS_COLLAPSE_LS_KEY)).toBe('{"' + '/w":true}');
    expect(loadWorkspaceCollapse(storage)).toEqual({ '/w': true });
    // 写坏后再读 → 空（损坏值不冒用）
    storage.setItem(WS_COLLAPSE_LS_KEY, 'nope');
    expect(loadWorkspaceCollapse(storage)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 错误映射（dsh folderError 形态）
// ---------------------------------------------------------------------------

describe('workspaceErrorInfo（HTTP/网络错误 → kind + 中文文案）', () => {
  const http = (status: number, error: string) => ({
    status,
    message: `HTTP ${status}：${error}`,
    data: { error },
  });

  it('网络层（端点缺失/TypeError，无 status）→ network + 容错提示', () => {
    const info = workspaceErrorInfo(new TypeError('fetch failed'));
    expect(info.kind).toBe('network');
    expect(info.text).toContain('暂不可用');
  });

  it('400 原因关键字逐一映射（默认根/未注册/绝对路径/目录/不可访问/不可读）', () => {
    expect(workspaceErrorInfo(http(400, 'cannot delete the default workspace root')).kind).toBe(
      'default-root',
    );
    expect(workspaceErrorInfo(http(400, 'workspace-not-registered')).kind).toBe('not-registered');
    expect(workspaceErrorInfo(http(400, 'workspace path must be absolute')).kind).toBe(
      'not-absolute',
    );
    expect(workspaceErrorInfo(http(400, 'workspace path must be a directory')).kind).toBe(
      'not-dir',
    );
    expect(workspaceErrorInfo(http(400, 'workspace path is not accessible: ENOENT')).kind).toBe(
      'not-accessible',
    );
    expect(workspaceErrorInfo(http(400, 'workspace directory is not readable: EACCES')).kind).toBe(
      'not-readable',
    );
    // 未知 400 原因 → invalid（带原文）
    const other = workspaceErrorInfo(http(400, 'some other reason'));
    expect(other.kind).toBe('invalid');
    expect(other.text).toContain('some other reason');
  });

  it('404 与未知 HTTP → missing/http 兜底；无 err → unknown 路径', () => {
    expect(workspaceErrorInfo(http(404, 'workspace not registered: /x')).kind).toBe('missing');
    expect(workspaceErrorInfo(http(500, 'boom')).kind).toBe('http');
    expect(workspaceErrorInfo({ status: 500, message: 'x' })).toMatchObject({ kind: 'http' });
    expect(workspaceErrorInfo(null).kind).toBe('network');
  });
});
