/**
 * # test/loop/methodology：方法论前置门（R2-S1）主循环行为
 *
 * 门契约（loop 层，RunOptions.methodology）：
 * - 命中未加载且调用组不含 use_skill(<id>) → 整组拦截：替代执行一次——回注
 *   {ok:false, error:{type:'methodology-first', message:'先加载方法：use_skill(<id>)…'}}
 *   （普通回注管线；工具未真执行；不计熔断）；
 * - use_skill(id) 执行成功（ok:true）→ markLoaded → 之后不再拦（同 run 后续轮与后续 run）；
 * - 组内含 use_skill(<id>) → 放行（加载调用自身执行）；
 * - methodology 未注入（undefined）→ 门关闭（E2E/老配置默认路径）；
 * - route 未命中（参考型技能在 route 表外——由 deps 侧 matchMethodologyTask 过滤）→ 不拦。
 * 预期值独立：FakeLlm 脚本 + 假工具执行记录（executions）手算。
 */
import { describe, expect, it } from 'vitest';
import { defineRegistry, run } from '../../src/core/loop/index.js';
import type { MethodologyGate, RunOptions, Tool } from '../../src/core/loop/index.js';
import { collectEvents, echoTool, readyStore } from './support.js';
import { FakeLlm } from './support.js';
import { kindsOf, toolPayload } from './support.js';

/** 会话级假门：route 可编程；loaded 可预置；观察 route/isLoaded/markLoaded 调用。 */
function fakeGate(options: {
  route: (task: string) => string | null;
  preloaded?: readonly string[];
}): MethodologyGate & {
  loaded: Set<string>;
  routeCalls: string[];
  markCalls: string[];
} {
  const loaded = new Set(options.preloaded ?? []);
  const gate = {
    loaded,
    routeCalls: [] as string[],
    markCalls: [] as string[],
    async route(task: string) {
      gate.routeCalls.push(task);
      return options.route(task);
    },
    isLoaded(_sessionId: string, id: string) {
      return loaded.has(id);
    },
    markLoaded(_sessionId: string, id: string) {
      gate.markCalls.push(id);
      loaded.add(id);
    },
  };
  return gate;
}

/** use_skill 假工具（参数 {skill}；执行即记录——执行成功才会被观察器 mark）。 */
function skillTool(executions: string[]): Tool {
  return {
    name: 'use_skill',
    description: 'Load a skill by id (fake).',
    parameters: {
      type: 'object',
      properties: { skill: { type: 'string' } },
      required: ['skill'],
    },
    async execute(call) {
      executions.push('use_skill');
      const parsed = JSON.parse(call.arguments) as { skill?: unknown };
      return { ok: true, content: `SKILL:${String(parsed.skill ?? '')}` };
    },
  };
}

/** 执行记录 echo（与 support.makeRegistry 同构，但含 use_skill 编成单表）。 */
function toolsFor(executions: string[]): Tool[] {
  const base = echoTool();
  const echo: Tool = {
    ...base,
    async execute(call, ctx) {
      executions.push('echo');
      return base.execute(call, ctx);
    },
  };
  return [echo, skillTool(executions)];
}

function baseOpts(overrides: Partial<RunOptions>): RunOptions {
  return {
    store: undefined as never,
    tools: undefined as never,
    llm: undefined as never,
    model: 'test-model',
    ...overrides,
  };
}

describe('loop：方法论前置门（RunOptions.methodology）', () => {
  it('m1) 命中未加载：整组拦截——methodology-first 回注（合法 JSON 载荷），工具从未执行，模型继续后 completed', async () => {
    const store = readyStore();
    const executions: string[] = [];
    const gate = fakeGate({ route: () => 'tdd' });
    const llm = new FakeLlm([
      {
        content: '直接动手',
        toolCalls: [
          { id: 'call_1', name: 'echo', arguments: '{"text":"one"}' },
          { id: 'call_2', name: 'echo', arguments: '{"text":"two"}' },
        ],
      },
      { content: '先加载，加载完了再改' },
      { content: 'done' },
    ]);

    const result = await run(
      { sessionId: 's1', task: '修复一个 bug' },
      baseOpts({
        store,
        tools: defineRegistry(toolsFor(executions), { sessionId: 's1' }),
        llm,
        methodology: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2); // 第一轮拦截（无真执行）→ 第二轮自然结束
    expect(executions).toEqual([]); // 工具从未真执行（拦截不触达工具层）
    expect(gate.routeCalls).toEqual(['修复一个 bug']);

    const events = await collectEvents(store, 's1');
    expect(kindsOf(events)).toEqual([
      'user',
      'assistant(2tc)',
      'tool(call_1)',
      'tool(call_2)',
      'assistant(0tc)',
      'event(run_result)',
    ]);
    // 指导性回注：合法 JSON + methodology-first + 指明技能
    const first = toolPayload(events[2]);
    expect(first?.toolCallId).toBe('call_1');
    const payload = JSON.parse(first!.content!) as {
      ok: boolean;
      error: { type: string; message: string; available_tools?: string[] };
    };
    expect(payload).toMatchObject({
      ok: false,
      error: { type: 'methodology-first', available_tools: ['use_skill'] },
    });
    expect(payload.error.message).toContain('use_skill(tdd)');
    // 全部调用同判型（整组拦截）
    expect(JSON.parse(toolPayload(events[3])!.content!).error.type).toBe('methodology-first');
    // 第二次请求回传的是拦截结果（普通工具消息，配对不落单）
    const toolMsg = llm.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.toolCallId).toBe('call_1');
    expect(String(toolMsg?.content)).toContain('methodology-first');
  });

  it('m2) use_skill 加载成功 → markLoaded → 后续轮放行（工具真执行）', async () => {
    const store = readyStore();
    const executions: string[] = [];
    const gate = fakeGate({ route: () => 'tdd' });
    const llm = new FakeLlm([
      {
        content: '先加载',
        toolCalls: [{ id: 'call_load', name: 'use_skill', arguments: '{"skill":"tdd"}' }],
      },
      {
        content: '开始实现',
        toolCalls: [{ id: 'call_echo', name: 'echo', arguments: '{"text":"hi"}' }],
      },
      { content: 'done' },
    ]);

    const result = await run(
      { sessionId: 's1', task: '修复 bug 报告' },
      baseOpts({
        store,
        tools: defineRegistry(toolsFor(executions), { sessionId: 's1' }),
        llm,
        methodology: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(executions).toEqual(['use_skill', 'echo']);
    expect(gate.markCalls).toEqual(['tdd']);
    const events = await collectEvents(store, 's1');
    // 无 methodology-first 载荷
    const contents = events
      .filter((ev) => ev.kind === 'tool')
      .map((ev) => toolPayload(ev)?.content ?? '');
    expect(contents.some((c) => c.includes('methodology-first'))).toBe(false);
    expect(contents[0]).toBe('SKILL:tdd');
    expect(contents[1]).toBe('echo:hi');
  });

  it('m3) 组内含 use_skill(<id>)：整组放行（加载与其它调用并行执行；无拦截）', async () => {
    const store = readyStore();
    const executions: string[] = [];
    const gate = fakeGate({ route: () => 'tdd' });
    const llm = new FakeLlm([
      {
        content: '加载并动手',
        toolCalls: [
          { id: 'call_load', name: 'use_skill', arguments: '{"skill":"tdd"}' },
          { id: 'call_echo', name: 'echo', arguments: '{"text":"hi"}' },
        ],
      },
      { content: 'done' },
    ]);

    const result = await run(
      { sessionId: 's1', task: '新增功能：测试先行' },
      baseOpts({
        store,
        tools: defineRegistry(toolsFor(executions), { sessionId: 's1' }),
        llm,
        methodology: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(executions.sort()).toEqual(['echo', 'use_skill']);
    const events = await collectEvents(store, 's1');
    const contents = events
      .filter((ev) => ev.kind === 'tool')
      .map((ev) => toolPayload(ev)?.content ?? '');
    expect(contents.some((c) => c.includes('methodology-first'))).toBe(false);
  });

  it('m4) 已加载不拦（preloaded）：命中但 isLoaded → 直接执行', async () => {
    const store = readyStore();
    const executions: string[] = [];
    const gate = fakeGate({ route: () => 'tdd', preloaded: ['tdd'] });
    const llm = new FakeLlm([
      { content: '动手', toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"x"}' }] },
      { content: 'done' },
    ]);

    const result = await run(
      { sessionId: 's1', task: '修复 bug' },
      baseOpts({
        store,
        tools: defineRegistry(toolsFor(executions), { sessionId: 's1' }),
        llm,
        methodology: gate,
      }),
    );

    expect(result.status).toBe('completed');
    expect(executions).toEqual(['echo']);
    const events = await collectEvents(store, 's1');
    expect(kindsOf(events)).toEqual([
      'user',
      'assistant(1tc)',
      'tool(call_1)',
      'assistant(0tc)',
      'event(run_result)',
    ]);
  });

  it('m5) 关闭不拦：methodology 不注入 → 命中文本也直接执行（E2E/老配置默认路径）', async () => {
    const store = readyStore();
    const executions: string[] = [];
    const llm = new FakeLlm([
      { content: '动手', toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"x"}' }] },
      { content: 'done' },
    ]);

    const result = await run(
      { sessionId: 's1', task: '修复 bug' },
      baseOpts({
        store,
        tools: defineRegistry(toolsFor(executions), { sessionId: 's1' }),
        llm,
      }),
    );

    expect(result.status).toBe('completed');
    expect(executions).toEqual(['echo']);
    const events = await collectEvents(store, 's1');
    const contents = events
      .filter((ev) => ev.kind === 'tool')
      .map((ev) => toolPayload(ev)?.content ?? '');
    expect(contents.some((c) => c.includes('methodology-first'))).toBe(false);
  });

  it('m6) 不命中不拦：route 返回 null（参考型不在路由表 / 未收录）/ 路由抛错按关闭', async () => {
    // route null
    const store = readyStore();
    const executions: string[] = [];
    const gate = fakeGate({ route: () => null });
    const llm = new FakeLlm([
      { content: '动手', toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"x"}' }] },
      { content: 'done' },
    ]);
    const result = await run(
      { sessionId: 's1', task: '修复 bug' },
      baseOpts({
        store,
        tools: defineRegistry(toolsFor(executions), { sessionId: 's1' }),
        llm,
        methodology: gate,
      }),
    );
    expect(result.status).toBe('completed');
    expect(executions).toEqual(['echo']);

    // route 抛错 → 门按关闭收敛（不拦截、不打断 run）
    const store2 = readyStore();
    const executions2: string[] = [];
    const throwingGate = fakeGate({ route: () => 'tdd' });
    throwingGate.route = async () => {
      throw new Error('route failure');
    };
    const llm2 = new FakeLlm([
      { content: '动手', toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"x"}' }] },
      { content: 'done' },
    ]);
    const result2 = await run(
      { sessionId: 's2', task: '修复 bug' },
      baseOpts({
        store: store2,
        tools: defineRegistry(toolsFor(executions2), { sessionId: 's2' }),
        llm: llm2,
        methodology: throwingGate,
      }),
    );
    expect(result2.status).toBe('completed');
    expect(executions2).toEqual(['echo']);
  });

  it('m7) 拦截不计熔断：连续拦截轮不触发 circuit-break（指导性回注非格式错误，模型继续）', async () => {
    const store = readyStore();
    const executions: string[] = [];
    const gate = fakeGate({ route: () => 'tdd' });
    // 三轮都只发调用、无视指导（模拟不配合模型）；第四轮自然结束
    const llm = new FakeLlm([
      { content: 'a', toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"a"}' }] },
      { content: 'b', toolCalls: [{ id: 'c2', name: 'echo', arguments: '{"text":"b"}' }] },
      { content: 'c', toolCalls: [{ id: 'c3', name: 'echo', arguments: '{"text":"c"}' }] },
      { content: 'done' },
    ]);

    const result = await run(
      { sessionId: 's1', task: '修复 bug' },
      baseOpts({
        store,
        tools: defineRegistry(toolsFor(executions), { sessionId: 's1' }),
        llm,
        methodology: gate,
      }),
    );

    expect(result.status).toBe('completed'); // maxFormatErrors=3 也未被触发（拦截非畸形）
    expect(executions).toEqual([]);
    expect(result.steps).toBe(4);
  });
});
