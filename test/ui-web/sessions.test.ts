/**
 * sessions.js 单测：会话列表/详情归一化、排序、标题 40 字符、统计行、工具清单。
 * 全部为纯函数；端点形状按 S12 任务书契约（含裸数组/存储形态兼容分支）。
 */
import { describe, expect, it } from 'vitest';
import {
  HISTORY_EVENTS_MAX,
  normalizeSessionList,
  sortSessionList,
  sessionDisplayTitle,
  normalizeSessionDetail,
  toProtocolEvent,
  normalizeStats,
  formatStatsLine,
  normalizeToolsList,
  toolParamNames,
  toolsListSource,
  SESSION_UNKNOWN_LABEL,
  workspaceLabel,
  groupSessionsByWorkspace,
} from '../../src/ui/web/sessions.js';

const shortId = (id: unknown) => String(id ?? '').slice(0, 6);

describe('normalizeSessionList', () => {
  it('{sessions:[...]} 与裸数组均接受；坏项/缺 id 项丢弃', () => {
    const input = [
      { sessionId: 's-aaa', title: 'A', updatedAt: 1700000000000, messageCount: 3 },
      { title: '无 id 项' },
      null,
      { sessionId: 's-bbb', title: '', updatedAt: 'bad-ts', messageCount: 'x' },
    ];
    const fromObj = normalizeSessionList({ sessions: input });
    const fromArr = normalizeSessionList(input);
    expect(fromArr).toHaveLength(2);
    expect(fromObj).toEqual(fromArr);
    expect(fromArr[0]).toEqual({
      sessionId: 's-aaa',
      title: 'A',
      updatedAt: 1700000000000,
      messageCount: 3,
      workspaceRoot: null,
    });
    // 坏 updatedAt/messageCount → null（展示层落 –）
    expect(fromArr[1]).toEqual({
      sessionId: 's-bbb',
      title: '',
      updatedAt: null,
      messageCount: null,
      workspaceRoot: null,
    });
  });

  it('workspaceRoot：字符串非空原样接受（/ 与 \\ 均可）；缺失/空串/非字符串 → null', () => {
    const list = normalizeSessionList({
      sessions: [
        { sessionId: 's-1', workspaceRoot: '/work/devmate', title: 'a' },
        { sessionId: 's-2', workspaceRoot: 'C:\\Work', title: 'b' },
        { sessionId: 's-3', workspaceRoot: '', title: '空' },
        { sessionId: 's-4', workspaceRoot: '   ', title: '空白' },
        { sessionId: 's-5', workspaceRoot: 42, title: '数字' },
        { sessionId: 's-6', title: '无字段' },
      ],
    });
    expect(list[0]!.workspaceRoot).toBe('/work/devmate');
    expect(list[1]!.workspaceRoot).toBe('C:\\Work');
    expect(list[2]!.workspaceRoot).toBeNull();
    expect(list[3]!.workspaceRoot).toBeNull();
    expect(list[4]!.workspaceRoot).toBeNull();
    expect(list[5]!.workspaceRoot).toBeNull();
  });

  it('非列表形状返回空数组（端点缺失/形状不符不抛）', () => {
    expect(normalizeSessionList(null)).toEqual([]);
    expect(normalizeSessionList({})).toEqual([]);
    expect(normalizeSessionList({ sessions: 'nope' })).toEqual([]);
  });

  it('Date 对象 updatedAt 与数字串均接受', () => {
    const list = normalizeSessionList({
      sessions: [{ sessionId: 's-1', updatedAt: new Date(123) }],
    });
    expect(list[0]!.updatedAt).toBe(123);
  });

  it('S12 落地形状（lastEventMs/createdAtMs/stepCount）双兼容', () => {
    const list = normalizeSessionList({
      sessions: [
        { sessionId: 's-x', title: 'T', createdAtMs: 100, lastEventMs: 200, stepCount: 7 },
        // 无 lastEventMs 时回落 createdAtMs
        { sessionId: 's-y', title: '', createdAtMs: 50 },
      ],
    });
    expect(list[0]).toMatchObject({ updatedAt: 200, messageCount: 7 });
    expect(list[1]).toMatchObject({ updatedAt: 50, messageCount: null });
  });
});

describe('sortSessionList', () => {
  it('updatedAt 新的在前；无时间戳的排后（保留相对序）', () => {
    const sorted = sortSessionList([
      { sessionId: 'old', updatedAt: 10 },
      { sessionId: 'none', updatedAt: null },
      { sessionId: 'new', updatedAt: 99 },
      { sessionId: 'none2', updatedAt: null },
    ]);
    expect(sorted.map((s) => s.sessionId)).toEqual(['new', 'old', 'none', 'none2']);
  });
  it('不修改原数组', () => {
    const list = [
      { sessionId: 'a', updatedAt: 1 },
      { sessionId: 'b', updatedAt: 2 },
    ];
    sortSessionList(list);
    expect(list.map((s) => s.sessionId)).toEqual(['a', 'b']);
  });
});

describe('sessionDisplayTitle', () => {
  it('40 字符内截断（超长加 …）', () => {
    const long = 'x'.repeat(200);
    const t = sessionDisplayTitle({ sessionId: 's-1', title: long }, shortId);
    expect(t.length).toBeLessThanOrEqual(41); // 40 + '…'
    expect(t.endsWith('…')).toBe(true);
    expect(t.slice(0, 40)).not.toContain('…');
  });
  it('空标题回退「会话 <短id>」', () => {
    expect(sessionDisplayTitle({ sessionId: 's-abcdef', title: '' }, shortId)).toBe('会话 s-abcd');
  });
});

describe('normalizeSessionDetail / toProtocolEvent', () => {
  it('协议形状 {event,data} 原样通过；title 缺省取首条 user 文本（24 字符截断）', () => {
    const text = '帮我改这个 bug 的描述要长一点超过十个字了吧非常长的尾巴';
    const detail = normalizeSessionDetail({
      sessionId: 's-1',
      title: '',
      truncated: false,
      events: [
        { event: 'session-user', data: { text } },
        { event: 'assistant-delta', data: { text: '好' } },
      ],
    });
    expect(detail.title).toBe(text.slice(0, 24));
    expect(detail.totalCount).toBe(2);
    expect(detail.truncated).toBe(false);
    expect(detail.events).toHaveLength(2);
    expect(detail.events[0]).toEqual({ event: 'session-user', data: { text } });
  });

  it('truncated 判定：显式标记 或 totalCount 溢出', () => {
    const viaFlag = normalizeSessionDetail({
      truncated: true,
      events: [{ event: 'session-user', data: { text: 'hi' } }],
    });
    expect(viaFlag.truncated).toBe(true);
    const viaCount = normalizeSessionDetail({
      totalCount: 9999,
      events: [{ event: 'session-user', data: { text: 'hi' } }],
    });
    expect(viaCount.truncated).toBe(true);
    expect(viaCount.totalCount).toBe(9999);
  });

  it('事件数上限 HISTORY_EVENTS_MAX（≤500）：超出部分丢弃并置 truncated', () => {
    const events = Array.from({ length: HISTORY_EVENTS_MAX + 50 }, (_, i) => ({
      event: 'session-user',
      data: { text: `m${i}` },
    }));
    const detail = normalizeSessionDetail({ events, totalCount: events.length });
    expect(detail.events).toHaveLength(HISTORY_EVENTS_MAX);
    expect(detail.events[0]).toEqual({ event: 'session-user', data: { text: 'm0' } });
    expect(detail.truncated).toBe(true);
  });

  it('裸事件数组也可；空形状返回空', () => {
    expect(normalizeSessionDetail([]).events).toEqual([]);
    expect(normalizeSessionDetail(null).events).toEqual([]);
    expect(normalizeSessionDetail({}).events).toEqual([]);
  });

  it('存储形态（{kind,payload}）映射到协议形状', () => {
    expect(toProtocolEvent({ kind: 'user', payload: { content: 'hi' } })).toEqual({
      event: 'session-user',
      data: { text: 'hi' },
    });
    // R2-S2：评审哨兵存储形态（meta.system=true）→ 协议帧 system:true（messages.js 渲染为系统样式）
    expect(
      toProtocolEvent({ kind: 'user', payload: { content: '评审哨兵' }, meta: { system: true } }),
    ).toEqual({ event: 'session-user', data: { text: '评审哨兵', system: true } });
    // 非哨兵（显式 false / 无 meta）→ 不带 system 键（普通 user 帧零变化）
    expect(
      toProtocolEvent({ kind: 'user', payload: { content: 'hi' }, meta: { system: false } }),
    ).toEqual({ event: 'session-user', data: { text: 'hi' } });
    expect(
      toProtocolEvent({
        kind: 'assistant',
        payload: { content: '答', toolCalls: [{ id: 't1', name: 'bash', arguments: '{}' }] },
      }),
    ).toEqual({
      event: 'assistant-done',
      data: { content: '答', toolCalls: [{ id: 't1', name: 'bash', arguments: '{}' }] },
    });
    expect(
      toProtocolEvent({
        kind: 'tool',
        payload: { toolCallId: 't1', content: '{"ok":false,"error":{"message":"boom"}}' },
      }),
    ).toEqual({
      event: 'tool-result',
      data: {
        id: 't1',
        name: '',
        ok: false,
        contentPreview: '{"ok":false,"error":{"message":"boom"}}',
        content: '{"ok":false,"error":{"message":"boom"}}',
        error: 'boom',
      },
    });
    // 非 JSON 工具内容按成功展示（协议兼容旧帧）
    expect(
      toProtocolEvent({ kind: 'tool', payload: { toolCallId: 't2', content: 'plain output' } }),
    ).toMatchObject({
      data: { ok: true },
    });
    // 无对应协议事件的类型（system/reasoning/event/未知）→ null 丢弃
    expect(toProtocolEvent({ kind: 'system', payload: { content: 'x' } })).toBeNull();
    expect(toProtocolEvent({ kind: 'reasoning', payload: { content: 'x' } })).toBeNull();
    expect(toProtocolEvent({ kind: 'event', payload: { type: 'compact' } })).toBeNull();
    expect(toProtocolEvent({ kind: 'wat', payload: {} })).toBeNull();
    expect(toProtocolEvent(null)).toBeNull();
  });

  it('存储形态的 compaction 事件（kind event / type compaction）→ 协议 compaction 帧', () => {
    expect(
      toProtocolEvent({
        kind: 'event',
        payload: {
          type: 'compaction',
          data: { summary: '摘要文本', tokensBefore: 120000, tokensAfter: 45000 },
        },
      }),
    ).toEqual({
      event: 'compaction',
      data: { summary: '摘要文本', tokensBefore: 120000, tokensAfter: 45000 },
    });
    // 不携带 token 估算的旧存档：仍映射（披露标题降级）
    expect(
      toProtocolEvent({ kind: 'event', payload: { type: 'compaction', data: { summary: 's' } } }),
    ).toEqual({ event: 'compaction', data: { summary: 's' } });
    // 非 compaction 的 event 类型仍丢弃
    expect(toProtocolEvent({ kind: 'event', payload: { type: 'checkpoint' } })).toBeNull();
  });
});

describe('workspaceLabel（组头 = 文件夹 basename）', () => {
  it('取分隔符后最后一段；/ 与 \\ 双兼容', () => {
    expect(workspaceLabel('/a/b/devmate')).toBe('devmate');
    expect(workspaceLabel('C:\\Work\\repo')).toBe('repo');
    expect(workspaceLabel('/x/')).toBe('x');
  });
  it('Windows 根目录 → 盘符（C:）；纯分隔符路径原样；null/空白 → 未知项目', () => {
    expect(workspaceLabel('C:\\')).toBe('C:');
    expect(workspaceLabel('/')).toBe('/');
    expect(workspaceLabel('')).toBe(SESSION_UNKNOWN_LABEL);
    expect(workspaceLabel('   ')).toBe(SESSION_UNKNOWN_LABEL);
    expect(workspaceLabel(null)).toBe(SESSION_UNKNOWN_LABEL);
    expect(workspaceLabel(undefined)).toBe(SESSION_UNKNOWN_LABEL);
  });
});

describe('groupSessionsByWorkspace（会话按项目文件夹分组，null 组尾组）', () => {
  it('按 workspaceRoot 归组；组序 = 首现序（输入已排序 = 组内最新在前）；null 组恒尾', () => {
    const groups = groupSessionsByWorkspace([
      { sessionId: 'n1', title: '旧', updatedAt: 10, workspaceRoot: null },
      { sessionId: 'a1', title: 'A 现', updatedAt: 300, workspaceRoot: '/work/a' },
      { sessionId: 'b1', title: 'B 现', updatedAt: 200, workspaceRoot: '/work/b' },
      { sessionId: 'a2', title: 'A 暂', updatedAt: null, workspaceRoot: '/work/a' },
      { sessionId: 'n2', title: '新', updatedAt: 50, workspaceRoot: null },
    ]);
    expect(groups.map((g) => g.label)).toEqual(['a', 'b', SESSION_UNKNOWN_LABEL]);
    const ids = (session: { sessionId: string }) => session.sessionId;
    expect(groups[0]!.sessions.map(ids)).toEqual(['a1', 'a2']);
    expect(groups[1]!.sessions.map(ids)).toEqual(['b1']);
    // 「未知项目」放最后并收纳全部 null 会话（组内仍有新→旧相对序）
    expect(groups[2]!.sessions.map(ids)).toEqual(['n1', 'n2']);
    expect(groups.map((g) => g.workspaceRoot)).toEqual(['/work/a', '/work/b', null]);
  });

  it('空列表 → 空数组（UI 显示空态「暂无会话，点新建开始」）', () => {
    expect(groupSessionsByWorkspace([])).toEqual([]);
  });

  it('全 null（旧会话/无 workspace meta）→ 单一「未知项目」组', () => {
    const groups = groupSessionsByWorkspace([
      { sessionId: 'x', title: '', updatedAt: 1, workspaceRoot: null },
      { sessionId: 'y', title: '', updatedAt: 2, workspaceRoot: null },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ workspaceRoot: null, label: SESSION_UNKNOWN_LABEL });
    expect(groups[0]!.sessions).toHaveLength(2);
  });

  it('不修改原数组（只读装配）', () => {
    const list = [{ sessionId: 's1', title: '', updatedAt: 1, workspaceRoot: '/w' }];
    groupSessionsByWorkspace(list);
    expect(list[0]).toMatchObject({ sessionId: 's1' });
  });
});

describe('stats', () => {
  it('normalizeStats：数值/数字串 → number；缺字段/坏值 → null', () => {
    expect(normalizeStats({ rssMb: 84.3, heapMb: '21', sessions: 2, activeShells: 0 })).toEqual({
      rssMb: 84.3,
      heapMb: 21,
      sessions: 2,
      activeShells: 0,
    });
    expect(normalizeStats({ sessions: 'x' })).toEqual({
      rssMb: null,
      heapMb: null,
      sessions: null,
      activeShells: null,
    });
    expect(normalizeStats(null)).toEqual({
      rssMb: null,
      heapMb: null,
      sessions: null,
      activeShells: null,
    });
  });

  it('formatStatsLine：内存取整 MB；缺失用 – 占位', () => {
    expect(formatStatsLine({ rssMb: 84.6, sessions: 2, activeShells: 1 })).toBe(
      '内存 85MB · 会话 2 · Shell 1',
    );
    expect(formatStatsLine({ rssMb: 0, sessions: 0, activeShells: 0 })).toBe(
      '内存 0MB · 会话 0 · Shell 0',
    );
    expect(formatStatsLine(null)).toBe('内存 – · 会话 – · Shell –');
  });
});

describe('tools', () => {
  it('normalizeToolsList：{tools:[...]} 或裸数组；坏项/缺 name 丢弃；parameters 空壳安全', () => {
    const tools = normalizeToolsList({
      tools: [
        { name: 'bash', description: 'run', parameters: { type: 'object' } },
        { name: '', description: 'no-name' },
        null,
        { description: 'no-name-2' },
      ],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: 'bash',
      description: 'run',
      parameters: { type: 'object' },
    });
    expect(normalizeToolsList(null)).toEqual([]);
  });

  it('toolParamNames：取 properties 键名（参数摘要）；无 schema → []', () => {
    expect(
      toolParamNames({
        parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: {} } },
      }),
    ).toEqual(['path', 'recursive']);
    expect(toolParamNames({ parameters: null })).toEqual([]);
    expect(toolParamNames({})).toEqual([]);
  });

  it('toolsListSource：区分「端点缺失/501」与「200 合法空表」（空表歧义修复）', () => {
    // fetch 未取得（端点缺失/501/网络错误）→ 回退内置静态清单（static）
    expect(toolsListSource(false, [])).toBe('static');
    expect(toolsListSource(false, null)).toBe('static');
    // 200 但注册表为空 → empty（「暂无可用工具」，不得冒充内置清单）
    expect(toolsListSource(true, [])).toBe('empty');
    // 200 非空 → runtime（运行时权威清单）
    expect(toolsListSource(true, [{ name: 'bash' }])).toBe('runtime');
  });
});

describe('toProtocolEvent：images 同形透传（ADR-0015）', () => {
  it('user 事件带 images → session-user 帧 data.images 相同（存储→协议回放形状）', () => {
    const images = [{ url: 'data:image/png;base64,AA==', width: 640, height: 480 }];
    expect(toProtocolEvent({ kind: 'user', payload: { content: '看图', images } })).toEqual({
      event: 'session-user',
      data: { text: '看图', images },
    });
  });

  it('无 images / 空数组 → 不带键（旧协议形状零扰动）', () => {
    expect(toProtocolEvent({ kind: 'user', payload: { content: 'hi' } })).toEqual({
      event: 'session-user',
      data: { text: 'hi' },
    });
    expect(toProtocolEvent({ kind: 'user', payload: { content: 'hi', images: [] } })).toEqual({
      event: 'session-user',
      data: { text: 'hi' },
    });
  });
});
