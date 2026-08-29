/**
 * messages.js 单测：SSE 事件 → 视图状态机（累积/工具卡生命周期/审批队列/用量/运行状态/重置）。
 * 事件形状与 sse.js 输出、S12 协议一一对应。
 */
import { describe, expect, it } from 'vitest';
import { createMessageStore, msgKind } from '../../src/ui/web/messages.js';
import { TERMINAL_STATUSES } from '../../src/ui/web/format.js';

const ev = (event: string, data: unknown) => ({ event, data });

function run(stream: Array<[string, unknown]>) {
  const store = createMessageStore();
  for (const [event, data] of stream) store.dispatch(ev(event, data));
  return store.snapshot();
}

describe('用户消息与会话', () => {
  it('session-user 追加用户气泡并生成标题', () => {
    const snap = run([
      ['session-user', { text: '帮我改代码' }],
      ['session-user', { text: '第二句话' }],
    ]);
    expect(snap.items.map((i) => i.kind)).toEqual(['user', 'user']);
    // Wave 2：user 快照携带 at（行 meta 时钟锚；只认 number）
    expect(snap.items[0]).toEqual({
      id: expect.any(String),
      kind: 'user',
      text: '帮我改代码',
      at: expect.any(Number),
    });
    expect(snap.title).toBe('帮我改代码');
  });

  it('与最后一条用户消息相同的 session-user 去重（POST 乐观渲染 + 流回放）', () => {
    const store = createMessageStore();
    store.addUser('hi');
    store.dispatch(ev('session-user', { text: 'hi' })); // 流回放同一句
    store.dispatch(ev('session-user', { text: '你好' }));
    const users = store.snapshot().items.filter((i) => i.kind === 'user');
    expect(users).toHaveLength(2);
    expect(users[0]!.text).toBe('hi');
    expect(users[1]!.text).toBe('你好');
  });
});

describe('assistant 累积与定稿', () => {
  it('delta 就地累积进同一个气泡', () => {
    const snap = run([
      ['assistant-delta', { text: '你' }],
      ['assistant-delta', { text: '好' }],
      ['assistant-delta', { text: '！' }],
    ]);
    const a = snap.items.find((i) => i.kind === 'assistant');
    expect(a?.text).toBe('你好！');
    expect(a?.done).toBe(false);
    expect(snap.streaming).toBe(true);
  });

  it('assistant-done 用 content 定稿（覆盖累积），streaming 关闭', () => {
    const snap = run([
      ['assistant-delta', { text: '正确' }],
      ['assistant-done', { content: '最终完整答案', toolCalls: [] }],
    ]);
    const a = snap.items.find((i) => i.kind === 'assistant');
    expect(a?.text).toBe('最终完整答案');
    expect(a?.done).toBe(true);
    expect(snap.streaming).toBe(false);
  });

  it('多个 assistant 回合（用户消息分隔）各自成气泡', () => {
    const snap = run([
      ['assistant-delta', { text: '第一答' }],
      ['assistant-done', { content: '第一答', toolCalls: [] }],
      ['session-user', { text: '再说' }],
      ['assistant-delta', { text: '第二答' }],
    ]);
    const as = snap.items.filter((i) => i.kind === 'assistant');
    expect(as).toHaveLength(2);
    expect(as[1]!.text).toBe('第二答');
    expect(as[1]!.done).toBe(false);
  });
});

describe('工具卡生命周期', () => {
  const events: Array<[string, unknown]> = [
    ['assistant-delta', { text: '先分析' }],
    ['tool-start', { id: 't1', name: 'bash', arguments: '{"cmd":"ls"}' }],
    ['tool-result', { id: 't1', name: 'bash', ok: true, contentPreview: 'file.txt' }],
  ];

  it('tool-start 生成卡（running）→ tool-result 成功', () => {
    const mid = run(events.slice(0, 2));
    const card = mid.items.find((i) => i.kind === 'assistant')?.tools[0];
    expect(card).toMatchObject({
      id: 't1',
      name: 'bash',
      arguments: '{"cmd":"ls"}',
      state: 'running',
      result: null,
    });

    const snap = run(events);
    const doneCard = snap.items.find((i) => i.kind === 'assistant')?.tools[0];
    expect(doneCard?.state).toBe('success');
    expect(doneCard?.result).toEqual({ ok: true, preview: 'file.txt', content: null, error: null });
  });

  it('tool-result ok:false → failed + error 保存', () => {
    const snap = run([
      ['tool-start', { id: 't9', name: 'bash', arguments: '{}' }],
      [
        'tool-result',
        { id: 't9', name: 'bash', ok: false, contentPreview: '', error: 'command not found' },
      ],
    ]);
    const card = snap.items.find((i) => i.kind === 'assistant')?.tools[0];
    expect(card?.state).toBe('failed');
    expect(card?.result?.error).toBe('command not found');
  });

  it('assistant-done 携带 toolCalls：deltas 先到时按 id 去重', () => {
    const snap = run([
      ['assistant-delta', { text: '用工具' }],
      ['tool-start', { id: 'a', name: 'read', arguments: '{"path":"x"}' }],
      [
        'assistant-done',
        { content: '用工具', toolCalls: [{ id: 'a', name: 'read', arguments: '{"path":"x"}' }] },
      ],
    ]);
    const a = snap.items.find((i) => i.kind === 'assistant');
    expect(a?.tools).toHaveLength(1);
    expect(a?.tools[0]?.state).toBe('running'); // 保持 tool-start 的运行时状态
  });

  it('done 后仍未执行完毕的卡（done-waiting-result）保持可见', () => {
    const snap = run([
      [
        'assistant-done',
        { content: 'ok', toolCalls: [{ id: 'z', name: 'bash', arguments: '{}' }] },
      ],
    ]);
    const card = snap.items.find((i) => i.kind === 'assistant')?.tools[0];
    expect(card?.state).toBe('done-waiting-result');
  });
});

describe('审批', () => {
  function approvalStream() {
    return [
      ['assistant-delta', { text: '等一下' }],
      ['tool-start', { id: 't1', name: 'bash', arguments: '{"cmd":"rm -rf dist"}' }],
      ['approval-request', { toolCallId: 't1', name: 'bash', arguments: '{"cmd":"rm -rf dist"}' }],
    ] as Array<[string, unknown]>;
  }

  it('approval-request → 卡 pending + 审批队列 waiting', () => {
    const snap = run(approvalStream());
    expect(snap.approvals).toHaveLength(1);
    expect(snap.approvals[0]).toMatchObject({ toolCallId: 't1', name: 'bash', state: 'waiting' });
    const card = snap.items.find((i) => i.kind === 'assistant')?.tools[0];
    expect(card?.state).toBe('pending');
  });

  it('同一工具重复 approval-request 不重复入队', () => {
    const store = createMessageStore();
    for (const [e, d] of [
      ...approvalStream(),
      ['approval-request', { toolCallId: 't1', name: 'bash', arguments: '{}' }] as [
        string,
        unknown,
      ],
    ]) {
      store.dispatch(ev(e, d));
    }
    expect(store.snapshot().approvals).toHaveLength(1);
  });

  it('批准 → 卡恢复 running（等服务端 tool-start/result），队列清空', () => {
    const store = createMessageStore();
    for (const [e, d] of approvalStream()) store.dispatch(ev(e, d));
    store.decideApproval('t1', true, '');
    const snap = store.snapshot();
    expect(snap.approvals).toHaveLength(0);
    expect(snap.items.find((i) => i.kind === 'assistant')?.tools[0]?.state).toBe('running');
  });

  it('队列保序一次一个：两个等待项先呈现第一个，应答后第二个才呈现', () => {
    // 内嵌审批卡 = snap.approvals[0]（渲染层）；快照保序 → 一次一个语义成立
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: '先看' }));
    store.dispatch(ev('tool-start', { id: 't1', name: 'bash', arguments: '{"cmd":"a"}' }));
    store.dispatch(
      ev('approval-request', { toolCallId: 't1', name: 'bash', arguments: '{"cmd":"a"}' }),
    );
    store.dispatch(ev('tool-start', { id: 't2', name: 'bash', arguments: '{"cmd":"b"}' }));
    store.dispatch(
      ev('approval-request', { toolCallId: 't2', name: 'bash', arguments: '{"cmd":"b"}' }),
    );
    // snapshot() 由 JS 推断：approvals 初始字面量 [] → never[]；测试只用可读字段，
    // 以显式形状归一去断言（tsc 视角最小断言，与文件既有 cast 风格一致）
    type Snap = {
      approvals: Array<{ toolCallId: string }>;
      items: Array<{ kind: string; tools?: Array<{ state: string }> }>;
    };
    const mid = store.snapshot() as Snap;
    expect(mid.approvals.map((a) => a.toolCallId)).toEqual(['t1', 't2']); // 保序
    expect(mid.approvals[0]?.toolCallId).toBe('t1'); // 内嵌卡只呈现第一个
    // 应答第一个（无附注框拒绝只可能无备注）→ 队列余项就地成为第一个
    store.decideApproval('t1', false, '');
    const next = store.snapshot() as Snap;
    expect(next.approvals.map((a) => a.toolCallId)).toEqual(['t2']);
    expect(next.approvals[0]?.toolCallId).toBe('t2');
    expect(next.items.find((i) => i.kind === 'assistant')?.tools?.[0]?.state).toBe('pending');
  });

  it('拒绝（带理由）→ 卡 denied、结果含「用户拒绝执行」与理由', () => {
    const store = createMessageStore();
    for (const [e, d] of approvalStream()) store.dispatch(ev(e, d));
    store.decideApproval('t1', false, '参数不对');
    const card = store.snapshot().items.find((i) => i.kind === 'assistant')?.tools[0];
    expect(card?.state).toBe('denied');
    expect(card?.result?.ok).toBe(false);
    expect(card?.result?.error).toContain('用户拒绝执行');
    expect(card?.result?.error).toContain('参数不对');
  });

  it('真实时序（assistant-done 先于 approval）：批准按 toolCallId 找卡（不经 activeAssistantId）', () => {
    // 服务端真实事件序：assistant-done → tool-start → approval-request（定稿后 activeAssistantId 已置空）
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: '让我看看' }));
    store.dispatch(
      ev('assistant-done', {
        content: '让我看看',
        toolCalls: [{ id: 't1', name: 'bash', arguments: '{"cmd":"ls"}' }],
      }),
    );
    store.dispatch(ev('tool-start', { id: 't1', name: 'bash', arguments: '{"cmd":"ls"}' }));
    store.dispatch(
      ev('approval-request', { toolCallId: 't1', name: 'bash', arguments: '{"cmd":"ls"}' }),
    );
    expect(store.snapshot().approvals).toHaveLength(1);
    store.decideApproval('t1', true, '');
    const card = store.snapshot().items.find((i) => i.kind === 'assistant')?.tools[0];
    expect(card?.state).toBe('running'); // 定稿后（activeAssistantId=null）仍能落卡
  });

  it('无理由拒绝：卡保持 pending；run-status=user-interrupted 时统一置「已中断」终态', () => {
    const store = createMessageStore();
    for (const [e, d] of approvalStream()) store.dispatch(ev(e, d));
    store.decideApproval('t1', false, ''); // 无理由：本地只清队列，不落卡
    const mid = store.snapshot();
    expect(mid.approvals).toHaveLength(0);
    expect(mid.items.find((i) => i.kind === 'assistant')?.tools[0]?.state).toBe('pending');
    // 服务端不落 tool 事件；终态到达 → pending 卡 → 已中断（不再永脉冲）
    store.dispatch(ev('run-status', { status: 'user-interrupted', steps: 1, durationMs: 30 }));
    const card = store.snapshot().items.find((i) => i.kind === 'assistant')?.tools[0];
    expect(card?.state).toBe('interrupted');
    expect(card?.result?.error).toContain('未批准');
    expect(store.snapshot().approvals).toHaveLength(0);
  });

  it('tool-result 存全量 content（展开详情用）与 preview（列表用）', () => {
    const snap = run([
      ['tool-start', { id: 'x', name: 'bash', arguments: '{}' }],
      [
        'tool-result',
        { id: 'x', name: 'bash', ok: true, contentPreview: '预…', content: 'y'.repeat(500) },
      ],
    ]);
    const card = snap.items.find((i) => i.kind === 'assistant')?.tools[0];
    expect(card?.result?.content).toBe('y'.repeat(500));
    expect(card?.result?.preview).toBe('预…');
  });
});

describe('usage / run-status / run-error', () => {
  it('usage 最新一次覆盖', () => {
    const snap = run([
      [
        'usage',
        { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.001, estimated: true },
      ],
      [
        'usage',
        { promptTokens: 2, completionTokens: 2, totalTokens: 4, costUsd: 0.002, estimated: false },
      ],
    ]);
    expect(snap.usage).toEqual({
      promptTokens: 2,
      completionTokens: 2,
      totalTokens: 4,
      costUsd: 0.002,
      estimated: false,
    });
  });

  it('无数字值的 usage 丢弃（空壳）', () => {
    const snap = run([['usage', { estimated: true }]]);
    expect(snap.usage).toBeNull();
  });

  it('usage.contextEstimateTokens 透传（C 档上下文环数据源）；缺省不带键时无该字段', () => {
    const withEst = run([
      [
        'usage',
        {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          costUsd: 0.001,
          estimated: false,
          contextEstimateTokens: 41_200,
        },
      ],
    ]);
    expect(withEst.usage?.contextEstimateTokens).toBe(41200);
    const withoutEst = run([
      [
        'usage',
        { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.001, estimated: true },
      ],
    ]);
    expect('contextEstimateTokens' in (withoutEst.usage ?? {})).toBe(false);
  });

  it('costUsdCum：usage 按 run 边界累加（会话累计成本 = /cost 面板数据源），reset 清零', () => {
    // 第一轮：单条 usage 全额累加
    const s1 = run([
      ['session-user', { text: '问题一' }],
      [
        'usage',
        { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.001, estimated: true },
      ],
    ]);
    expect(s1.costUsdCum).toBe(0.001);
    // 第二轮（session-user 边界）：同 run 内重复 usage 取增量；新 run 全额
    const s2 = run([
      ['session-user', { text: '问题一' }],
      [
        'usage',
        { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.001, estimated: true },
      ],
      [
        'usage',
        { promptTokens: 2, completionTokens: 2, totalTokens: 4, costUsd: 0.0015, estimated: true },
      ],
      ['session-user', { text: '问题二' }],
      [
        'usage',
        { promptTokens: 9, completionTokens: 1, totalTokens: 10, costUsd: 0.0005, estimated: true },
      ],
    ]);
    // 0.001（新 run 全额） + 0.0005（同 run 增量） + 0.0005（新 run 全额）= 0.002
    expect(s2.costUsdCum).toBeCloseTo(0.002, 9);
    // 无 costUsd 的空壳 usage 不参与累计
    const s3 = run([['usage', { totalTokens: null, costUsd: null, estimated: true }]]);
    expect(s3.costUsdCum).toBe(0);
    // reset 清零（切换会话 = 新会话累计从 0 开始）
    const store = createMessageStore();
    store.dispatch(
      ev('usage', {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        costUsd: 0.001,
        estimated: true,
      }),
    );
    store.reset();
    expect(store.snapshot().costUsdCum).toBe(0);
  });

  it('run-status running 保持 streaming；8 个终态收流（S12 RunStatus 权威值）', () => {
    const s1 = run([['run-status', { status: 'running', steps: null, durationMs: null }]]);
    expect(s1.streaming).toBe(true);
    expect(s1.runActive).toBe(true);
    // 终态清单来自 format.js 单一权威源（RUN_STATUS_SEMANTICS）：
    // 表里加终态收流行为自动跟随，杜绝状态机与终态表漂移
    expect(TERMINAL_STATUSES).toHaveLength(8);
    for (const status of TERMINAL_STATUSES) {
      const s = run([['run-status', { status, steps: 3, durationMs: 1500 }]]);
      expect(s.streaming).toBe(false);
      expect(s.runActive).toBe(false);
      expect(s.runStatus).toEqual({ status, steps: 3, durationMs: 1500 });
    }
  });

  it('run-error → lastError 置顶 + 挂到当前助手气泡', () => {
    const snap = run([
      ['assistant-delta', { text: '进行中…' }],
      ['run-error', { message: '模型返回格式错误' }],
    ]);
    expect(snap.lastError).toBe('模型返回格式错误');
    const a = snap.items.find((i) => i.kind === 'assistant');
    expect(a?.error).toBe('模型返回格式错误');
    expect(snap.streaming).toBe(false);
  });

  it('未知事件防御性忽略', () => {
    const snap = run([['future-event', { x: 1 }]]);
    expect(snap.items).toHaveLength(0);
  });

  it('run-status 终态步骤/耗时与 usage 双源保留（composer footer 统计行数据源）', () => {
    const snap = run([
      ['run-status', { status: 'completed', steps: 3, durationMs: 2500 }],
      [
        'usage',
        { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001, estimated: true },
      ],
    ]);
    expect(snap.runStatus).toEqual({ status: 'completed', steps: 3, durationMs: 2500 });
    expect(snap.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.001,
      estimated: true,
    });
    // 新 run 的 running 帧替换 runStatus（步骤/耗时归新 run），usage 由服务端后续覆盖
    const snap2 = run([['run-status', { status: 'running', steps: null, durationMs: null }]]);
    expect(snap2.runStatus).toEqual({ status: 'running', steps: null, durationMs: null });
  });
});

describe('compaction 披露（上下文压缩折叠小记）', () => {
  it('分发 compaction → 插入折叠小记（带 token 估算），按事件序落在消息流', () => {
    const snap = run([
      ['session-user', { text: '第一问' }],
      ['compaction', { summary: '前面对话摘要……', tokensBefore: 120_000, tokensAfter: 45_650 }],
      ['session-user', { text: '继续' }],
    ]);
    expect(snap.items.map((i) => i.kind)).toEqual(['user', 'compaction', 'user']);
    const item = snap.items[1];
    expect(item).toEqual({
      id: expect.any(String),
      kind: 'compaction',
      tokensBefore: 120_000,
      tokensAfter: 45_650,
      summary: '前面对话摘要……',
    });
  });

  it('缺 token 值：快照保留 null（compactionLine 简化标题；不因缺数吞事件）', () => {
    const snap = run([['compaction', { summary: 's' }]]);
    expect(snap.items[0]).toEqual({
      id: expect.any(String),
      kind: 'compaction',
      tokensBefore: null,
      tokensAfter: null,
      summary: 's',
    });
  });

  it('summary 缺省为空串（旧帧兼容；披露标题仍可渲染）', () => {
    const snap = run([['compaction', {}]]);
    const item = snap.items[0] as { kind: string; summary: string };
    expect(item.kind).toBe('compaction');
    expect(item.summary).toBe('');
  });
});

describe('run 生命周期（单流模型：runActive 门禁）', () => {
  it('startStream 置 runActive；assistant-done 后仍 true（run 未结束）；终态 run-status 后 false', () => {
    const store = createMessageStore();
    expect(store.startStream()).toBe(true);
    expect(store.snapshot().runActive).toBe(true);
    store.dispatch(ev('assistant-delta', { text: '做…' }));
    store.dispatch(ev('assistant-done', { content: '做…', toolCalls: [] }));
    expect(store.snapshot().runActive).toBe(true); // 定稿不代表 run 结束（可能还有工具/审批）
    store.dispatch(ev('run-status', { status: 'completed', steps: 1, durationMs: 0 }));
    expect(store.snapshot().runActive).toBe(false);
  });

  it('runStartedAt：startStream 置秒表锚点；终态/endRun/reset 清空（展示层耗时推算依据）', () => {
    const store = createMessageStore();
    expect(store.snapshot().runStartedAt).toBeNull();
    expect(store.startStream()).toBe(true);
    expect(typeof store.snapshot().runStartedAt).toBe('number'); // 运行中：可算墙钟耗时
    store.dispatch(ev('run-status', { status: 'completed', steps: 1, durationMs: 0 }));
    expect(store.snapshot().runStartedAt).toBeNull(); // 终态：耗时以 run-status 的 durationMs 为准

    expect(store.startStream()).toBe(true);
    store.dispatch(ev('run-status', { status: 'fatal', steps: 0, durationMs: 0 }));
    store.dispatch(ev('run-status', { status: 'running', steps: null, durationMs: null }));
    expect(store.snapshot().runStartedAt).toBeNull(); // running 帧（无秒表锚点）不凭空起表

    store.endRun();
    store.reset();
    expect(store.snapshot().runStartedAt).toBeNull();
  });

  it('运行中再 startStream 返回 false（发送门禁：调用方 toast「仍在运行」）', () => {
    const store = createMessageStore();
    expect(store.startStream()).toBe(true);
    expect(store.startStream()).toBe(false); // 运行中禁发
    store.dispatch(ev('run-status', { status: 'fatal', steps: 0, durationMs: 0 }));
    expect(store.startStream()).toBe(true); // 终态后恢复可发
  });

  it('同会话第二条消息：连接先于 run（单流），消息序无重复、run2 的 delta 进新气泡', () => {
    const store = createMessageStore();
    // 第一轮：发送端乐观渲染 → 流回放去重
    store.addUser('第一问');
    store.dispatch(ev('session-user', { text: '第一问' }));
    expect(store.snapshot().items.filter((i) => i.kind === 'user')).toHaveLength(1);
    store.startStream();
    store.dispatch(ev('assistant-delta', { text: '答一' }));
    store.dispatch(ev('assistant-done', { content: '答一', toolCalls: [] }));
    store.dispatch(ev('run-status', { status: 'completed', steps: 1, durationMs: 10 }));
    // 第二轮：不再重放旧 run 事件（只有 session-user 回声 + 本轮 delta）
    store.addUser('第二问');
    store.dispatch(ev('session-user', { text: '第二问' }));
    store.startStream();
    store.dispatch(ev('assistant-delta', { text: '答二' }));
    store.dispatch(ev('assistant-done', { content: '答二', toolCalls: [] }));
    store.dispatch(ev('run-status', { status: 'completed', steps: 1, durationMs: 10 }));
    const snap = store.snapshot();
    expect(snap.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const as = snap.items.filter((i) => i.kind === 'assistant');
    expect(as[0]?.text).toBe('答一');
    expect(as[1]?.text).toBe('答二');
    // 第三问的 delta 不再并入「答二」（去重回放重置了轮次边界）
    store.dispatch(ev('session-user', { text: '第二问' })); // 重复回声：去重但仍重置边界
    store.startStream();
    store.dispatch(ev('assistant-delta', { text: '答三' }));
    const as3 = store.snapshot().items.filter((i) => i.kind === 'assistant');
    expect(as3).toHaveLength(3);
    expect(as3[2]?.text).toBe('答三');
    expect(as3[1]?.text).toBe('答二');
  });

  it('turn 边界：run1 未定稿（user-interrupted）后的 run2 delta 也进新气泡', () => {
    const store = createMessageStore();
    store.startStream();
    store.dispatch(ev('assistant-delta', { text: '半截' }));
    store.dispatch(ev('run-status', { status: 'user-interrupted', steps: 1, durationMs: 5 }));
    expect(store.snapshot().streaming).toBe(false);
    // 没有 assistant-done（中断未定稿）：activeAssistantId 仍指旧气泡 —— 新 run 必须重置边界
    store.addUser('继续问');
    store.dispatch(ev('session-user', { text: '继续问' })); // 回放回声（去重）
    store.startStream();
    store.dispatch(ev('assistant-delta', { text: '新答' }));
    const as = store.snapshot().items.filter((i) => i.kind === 'assistant');
    expect(as).toHaveLength(2);
    expect(as[0]?.text).toBe('半截');
    expect(as[1]?.text).toBe('新答');
  });
});

describe('重置', () => {
  it('reset 清空视图（切换会话）', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: 'x' }));
    store.dispatch(
      ev('usage', {
        totalTokens: 9,
        costUsd: 0.1,
        promptTokens: 1,
        completionTokens: 8,
        estimated: false,
      }),
    );
    store.reset();
    const snap = store.snapshot();
    expect(snap.items).toHaveLength(0);
    expect(snap.usage).toBeNull();
    expect(snap.title).toBe('');
  });
});

describe('订阅', () => {
  it('subscribe 立即收到快照并持续收到变更', () => {
    const store = createMessageStore();
    const seen: number[] = [];
    store.subscribe((s: { seq: number }) => seen.push(s.seq));
    const before = seen.length;
    store.dispatch(ev('assistant-delta', { text: 'a' }));
    expect(seen.length).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// S13 DOM 轻量化：消息上限（默认 200，测试用小上限验证裁剪/折叠计数）
// ---------------------------------------------------------------------------

describe('长会话上限（maxItems）', () => {
  it('超过上限裁剪最旧消息，foldedCount 累积计数', () => {
    const store = createMessageStore({ maxItems: 5 });
    for (let i = 0; i < 8; i += 1) store.addUser(`m${i}`);
    const snap = store.snapshot();
    expect(snap.items).toHaveLength(5);
    expect(snap.foldedCount).toBe(3);
    // 保留的是最新 5 条（顺序不变）
    expect(snap.items.map((i) => i.text)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('dispatch 路径同样裁剪：收起已完成的旧回合，不裁当前活动助手', () => {
    const store = createMessageStore({ maxItems: 4 });
    // 旧回合（完成，第 1 条）
    store.dispatch(ev('assistant-delta', { text: '头' }));
    store.dispatch(ev('assistant-done', { content: '头', toolCalls: [] }));
    // 三个用户消息填满上限（assistant+3 users = 4 = max，未裁）
    store.dispatch(ev('session-user', { text: 'a' }));
    store.dispatch(ev('session-user', { text: 'b' }));
    store.dispatch(ev('session-user', { text: 'c' }));
    // 新一轮 delta 溢出：裁最旧的「已结束回合」头部（历史回放/长流式同路径）
    store.dispatch(ev('assistant-delta', { text: '尾' }));
    const snap = store.snapshot();
    expect(snap.items.map((i) => i.text)).toEqual(['a', 'b', 'c', '尾']);
    expect(snap.foldedCount).toBe(1);
    // 活动助手未被误裁：delta 继续并入（activeAssistantId 完好）
    store.dispatch(ev('assistant-delta', { text: '续' }));
    const a2 = store.snapshot().items.find((i) => i.kind === 'assistant');
    expect(a2?.text).toBe('尾续');
  });

  it('reset 清空折叠计数（会话切换后摘要行消失）', () => {
    const store = createMessageStore({ maxItems: 2 });
    for (let i = 0; i < 4; i += 1) store.addUser(`m${i}`);
    expect(store.snapshot().foldedCount).toBe(2);
    store.reset();
    expect(store.snapshot().foldedCount).toBe(0);
    expect(store.snapshot().items).toHaveLength(0);
  });

  it('默认上限 200：大规模回放只保留最近 200 条', () => {
    const store = createMessageStore();
    for (let i = 0; i < 210; i += 1) store.addUser(`m${i}`);
    const snap = store.snapshot();
    expect(snap.items).toHaveLength(200);
    expect(snap.foldedCount).toBe(10);
  });
});

describe('setTitle（历史恢复标题）', () => {
  it('写入标题并随快照读出；reset 清空', () => {
    const store = createMessageStore();
    store.setTitle('来自历史会话的标题');
    expect(store.snapshot().title).toBe('来自历史会话的标题');
    store.reset();
    expect(store.snapshot().title).toBe('');
  });
});

describe('Wave 2：reasoning 思考帧与行 meta 数据（Think Disclosure / Ran-for 钟差）', () => {
  it('reasoning 增量累积进当前助手气泡；快照携带 reasoning/thinkDone', () => {
    const snap = run([
      ['reasoning', { text: '第一段' }],
      ['reasoning', { text: '第二段' }],
      ['assistant-delta', { text: '结论' }],
    ]);
    const a = snap.items.find((i) => i.kind === 'assistant');
    expect(a?.reasoning).toBe('第一段第二段');
    expect(a?.thinkDone).toBe(false);
  });

  it('reasoning 先于 delta 到达：自建气泡（非孤立帧）', () => {
    const snap = run([['reasoning', { text: '独自到达' }]]);
    const a = snap.items.find((i) => i.kind === 'assistant');
    expect(a).toBeTruthy();
    expect(a?.reasoning).toBe('独自到达');
  });

  it('assistant-done：thinkDone=true；Ran-for 钟差落定（doneAt-startedAt 非负 number）', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: 'a' }));
    store.dispatch(ev('reasoning', { text: '想' }));
    store.dispatch(ev('assistant-done', { content: 'a', toolCalls: [] }));
    const a = store.snapshot().items.find((i) => i.kind === 'assistant');
    expect(a?.thinkDone).toBe(true);
    expect(typeof a?.ranForMs).toBe('number');
    expect((a?.ranForMs ?? -1) as number).toBeGreaterThanOrEqual(0);
    expect(a?.at).toEqual(expect.any(Number));
  });

  it('定稿后迟到 reasoning 帧并入最后一条助手气泡（不回退新建）', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: 'a' }));
    store.dispatch(ev('assistant-done', { content: 'a', toolCalls: [] }));
    store.dispatch(ev('reasoning', { text: '迟到' }));
    const as = store.snapshot().items.filter((i) => i.kind === 'assistant');
    expect(as).toHaveLength(1);
    expect(as[0]?.reasoning).toBe('迟到');
  });

  it('reset 清空 reasoning（会话切换后思考行消失）', () => {
    const store = createMessageStore();
    store.dispatch(ev('reasoning', { text: 'x' }));
    store.reset();
    expect(store.snapshot().items).toHaveLength(0);
  });

  it('user 快照携带 at（行 meta 时钟锚）', () => {
    const store = createMessageStore();
    store.addUser('hi');
    expect(store.snapshot().items[0]?.at).toEqual(expect.any(Number));
    store.dispatch(ev('session-user', { text: 'sse' }));
    expect(store.snapshot().items[1]?.at).toEqual(expect.any(Number));
  });
});

// ---------------------------------------------------------------------------
// R2-S1：方法论线（模型首条回复「方法线：<skillId>」→ snap.methodLine；run-strip 小牌数据源）
// ---------------------------------------------------------------------------

describe('方法论线（R2-S1：回合首条 assistant 提取；用户回合/reset 清空）', () => {
  it('增量命中：delta 到达即提取（运行中即显示）；快照暴露 methodLine', () => {
    const snap = run([
      ['assistant-delta', { text: '方法线：tdd\n我先复现这个 bug。' }],
    ]);
    expect(snap.methodLine).toBe('tdd');
  });

  it('流式校正：半截值随 delta 增长校正为全量（t → td → tdd）', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: '方法线：t' }));
    expect(store.snapshot().methodLine).toBe('t');
    store.dispatch(ev('assistant-delta', { text: 'd' }));
    expect(store.snapshot().methodLine).toBe('td');
    store.dispatch(ev('assistant-delta', { text: 'd' }));
    expect(store.snapshot().methodLine).toBe('tdd');
  });

  it('assistant-done 以定稿权威 content 定值（delta 半截/缺行排版漂移的最终修正）', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: '方法线：t' }));
    store.dispatch(ev('assistant-done', { content: '方法线：tdd\n开始', toolCalls: [] }));
    expect(store.snapshot().methodLine).toBe('tdd');
  });

  it('无命中 → null（小牌不显示；定稿后仍 null）', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: '直接动手。' }));
    store.dispatch(ev('assistant-done', { content: '直接动手。', toolCalls: [] }));
    expect(store.snapshot().methodLine).toBeNull();
  });

  it('methodLine 缺省 null（新会话快照字段稳定可读）', () => {
    expect(run([]).methodLine).toBeNull();
  });

  it('新用户回合清空（session-user）：旧 run 的小牌不跨回合持续', () => {
    const snap = run([
      ['session-user', { text: '问我' }],
      ['assistant-delta', { text: '方法线：tdd' }],
      ['session-user', { text: '再问' }],
    ]);
    expect(snap.methodLine).toBeNull();
  });

  it('新用户回合清空（去重回放同样重置边界 —— 与 turn 边界语义对齐）', () => {
    const store = createMessageStore();
    store.addUser('问');
    store.dispatch(ev('assistant-delta', { text: '方法线：tdd' }));
    expect(store.snapshot().methodLine).toBe('tdd');
    store.dispatch(ev('session-user', { text: '问' })); // 回声去重；边界仍重置
    expect(store.snapshot().methodLine).toBeNull();
  });

  it('addUser（乐观渲染）同边界清空', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: '方法线：tdd' }));
    store.addUser('新问题');
    expect(store.snapshot().methodLine).toBeNull();
  });

  it('reset（切换会话）清空', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: '方法线：tdd' }));
    store.reset();
    expect(store.snapshot().methodLine).toBeNull();
  });

  it('只采本轮首个气泡：首气泡无命中 → 后续气泡出现方法线也不采（不回退）', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: '好的。' }));
    store.dispatch(ev('assistant-done', { content: '好的。', toolCalls: [] }));
    // 同 run 工具往返后的下一段文字（新气泡）：方法线属首条回复语义，此处不复采
    store.dispatch(ev('assistant-delta', { text: '参考 方法线：random 的说法' }));
    expect(store.snapshot().methodLine).toBeNull();
  });

  it('已命中后后续气泡的再出现不覆盖（首命中即钉住）', () => {
    const store = createMessageStore();
    store.dispatch(ev('assistant-delta', { text: '方法线：tdd' }));
    store.dispatch(ev('assistant-done', { content: '方法线：tdd', toolCalls: [] }));
    store.dispatch(ev('assistant-delta', { text: '方法线：other\n等等' }));
    expect(store.snapshot().methodLine).toBe('tdd');
  });

  it('多轮回放：最终 = 最后一个用户回合的值（session-user 逐轮清空重采）', () => {
    const snap = run([
      ['session-user', { text: '第一问' }],
      ['assistant-delta', { text: '方法线：tdd' }],
      ['assistant-done', { content: '方法线：tdd', toolCalls: [] }],
      ['session-user', { text: '第二问' }],
      ['assistant-delta', { text: '方法线：domain-modeling' }],
    ]);
    expect(snap.methodLine).toBe('domain-modeling');
  });
});

// ---------------------------------------------------------------------------
// R2-S2：评审哨兵系统样式消息（session-user 帧 data.system===true → 独立 'sys' 消息项）
// ---------------------------------------------------------------------------

describe('评审哨兵系统样式消息（R2-S2：system:true 帧 → 独立 sys 消息项，不算新用户回合）', () => {
  it('system:true → 追加独立 sys 消息项（非用户气泡）；快照暴露 systemUser 计数', () => {
    const snap = run([
      ['session-user', { text: '帮我改代码' }],
      ['assistant-delta', { text: '正在改' }],
      ['assistant-done', { content: '正在改', toolCalls: [] }],
      ['session-user', { text: '【评审哨兵】本轮任务产生了实质变更…', system: true }],
    ]);
    expect(snap.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'sys']);
    const sys = snap.items[2]!;
    expect(sys).toEqual({
      id: expect.any(String),
      kind: 'sys',
      text: '【评审哨兵】本轮任务产生了实质变更…',
      at: expect.any(Number),
    });
    expect(snap.systemUser).toBe(1);
  });

  it('不重置回合边界：流式期间的哨兵帧不打断 delta 累加（同气泡续写，runActive 保持）', () => {
    const store = createMessageStore();
    store.dispatch(ev('session-user', { text: '第一问' }));
    store.dispatch(ev('assistant-delta', { text: '你好' }));
    store.dispatch(ev('run-status', { status: 'running' }));
    store.dispatch(ev('session-user', { text: '【评审哨兵】…', system: true }));
    const mid = store.snapshot();
    // 哨兵不是用户回合：activeAssistantId 未清 —— 后续 delta 继续进同一气泡
    store.dispatch(ev('assistant-delta', { text: '，世界' }));
    const snap = store.snapshot();
    const assistants = snap.items.filter((i) => i.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe('你好，世界');
    expect(snap.runActive).toBe(true);
    expect(mid.systemUser).toBe(1);
  });

  it('哨兵不重置方法论线 / usage run 边界标记 / lastDoneAssistantId（同回合归并视角）', () => {
    const store = createMessageStore();
    store.dispatch(ev('session-user', { text: '第一问' }));
    store.dispatch(ev('assistant-delta', { text: '方法线：tdd\n开始' }));
    store.dispatch(ev('assistant-done', { content: '方法线：tdd\n开始', toolCalls: [] }));
    store.dispatch(ev('session-user', { text: '【评审哨兵】…', system: true }));
    // 定稿后的哨兵帧：late reasoning 仍归并最后一条助手气泡（lastDoneAssistantId 未被清）
    store.dispatch(ev('reasoning', { text: '（思考）' }));
    const snap = store.snapshot();
    expect(snap.methodLine).toBe('tdd'); // 当前用户回合未终结
    const assistant = snap.items.find((i) => i.kind === 'assistant');
    expect(assistant?.reasoning).toBe('（思考）');
    // 后续 assistant-delta（审查回应）进新气泡 —— 仍属同一用户回合
    store.dispatch(ev('assistant-delta', { text: '我来审查' }));
    expect(store.snapshot().items.filter((i) => i.kind === 'assistant')).toHaveLength(2);
    expect(store.snapshot().methodLine).toBe('tdd');
  });

  it('哨兵从不设置标题（会话标题 = 首条真实用户消息）', () => {
    const snap = run([
      ['session-user', { text: '【评审哨兵】…', system: true }],
      ['session-user', { text: '真实问题' }],
    ]);
    // 哨兵先到也不抢标题：真实用户消息成为标题（防御：回放序保证哨兵后于真实首句）
    expect(snap.title).toBe('真实问题');
  });

  it('哨兵帧不参与用户去重（kind 不同；同文本的真用户消息仍按用户去重）', () => {
    const store = createMessageStore();
    store.addUser('hi');
    store.dispatch(ev('session-user', { text: 'hi' }));
    store.dispatch(ev('session-user', { text: '【评审哨兵】hi', system: true }));
    const users = store.snapshot().items.filter((i) => i.kind === 'user');
    expect(users).toHaveLength(1);
    expect(store.snapshot().items).toHaveLength(2); // user + sys
    expect(store.snapshot().systemUser).toBe(1);
  });

  it('非 system 帧行为零变化：不产生 sys 项；边界重置照旧（去重/新回合）', () => {
    const store = createMessageStore();
    store.dispatch(ev('session-user', { text: '第一问' }));
    store.dispatch(ev('assistant-delta', { text: '答1' }));
    store.dispatch(ev('assistant-done', { content: '答1', toolCalls: [] }));
    store.dispatch(ev('session-user', { text: '第一问' })); // 同句回放：去重
    expect(store.snapshot().items.filter((i) => i.kind === 'user')).toHaveLength(1);
    // system 缺省（undefined）与显式 false 都不触发 sys 分支
    store.dispatch(ev('session-user', { text: '【评审哨兵】…', system: false }));
    expect(store.snapshot().systemUser).toBe(0);
    expect(store.snapshot().items.every((i) => i.kind !== 'sys')).toBe(true);
  });

  it('reset 清空 systemUser 计数（切换会话后哨兵计数归零）', () => {
    const store = createMessageStore();
    store.dispatch(ev('session-user', { text: 'a' }));
    store.dispatch(ev('session-user', { text: '【评审哨兵】…', system: true }));
    expect(store.snapshot().systemUser).toBe(1);
    store.reset();
    expect(store.snapshot().systemUser).toBe(0);
    expect(store.snapshot().items).toEqual([]);
  });

  it('snapshot 缺省 systemUser 字段恒在（新会话可读，0 = 未注入）', () => {
    const snap = run([['session-user', { text: '你好' }]]);
    expect(snap.systemUser).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 渲染形态分类：msgKind（纯函数；渲染层入口 —— 哨兵归一/非 system 不受影响）
// ---------------------------------------------------------------------------

describe('msgKind（渲染逻辑纯函数）', () => {
  it('sys 消息项 → sys（状态机归一后的渲染目标）', () => {
    expect(msgKind({ id: '1', kind: 'sys', text: 'x' })).toBe('sys');
  });

  it('原始形状归一：kind user + system:true → sys（防御渲染层双入口）', () => {
    expect(msgKind({ kind: 'user', system: true, text: 'x' })).toBe('sys');
  });

  it('非 system 用户项不受影响：user / assistant / compaction / system 原样', () => {
    expect(msgKind({ kind: 'user', text: 'x' })).toBe('user');
    expect(msgKind({ kind: 'user', system: false, text: 'x' })).toBe('user');
    expect(msgKind({ kind: 'assistant', text: 'x' })).toBe('assistant');
    expect(msgKind({ kind: 'compaction', summary: '' })).toBe('compaction');
    expect(msgKind({ kind: 'system', text: 'x' })).toBe('system');
  });

  it('未知/空项 → system（防御兜底：渲染层永不落入空洞分支）', () => {
    expect(msgKind({ kind: 'wat' })).toBe('system');
    expect(msgKind(null)).toBe('system');
    expect(msgKind(undefined)).toBe('system');
    expect(msgKind('nope' as unknown as { kind: string })).toBe('system');
  });
});

describe('评审哨兵去重（R2-S2：重连重放同文本哨兵帧 → 不重复累积）', () => {
  it('最后一条 sys 同文本 → 跳过且计数不增；不同文本 → 新项', () => {
    const store = createMessageStore();
    store.dispatch(ev('session-user', { text: '第一问' }));
    store.dispatch(ev('session-user', { text: '【评审哨兵】A', system: true }));
    store.dispatch(ev('session-user', { text: '【评审哨兵】A', system: true })); // 重连重放
    let snap = store.snapshot();
    expect(snap.items.filter((i) => i.kind === 'sys')).toHaveLength(1);
    expect(snap.systemUser).toBe(1);
    // 哨兵后的新会话重放（B = 另一事件）→ 新项
    store.dispatch(ev('session-user', { text: '【评审哨兵】B', system: true }));
    snap = store.snapshot();
    expect(snap.items.filter((i) => i.kind === 'sys')).toHaveLength(2);
    expect(snap.systemUser).toBe(2);
  });
});
