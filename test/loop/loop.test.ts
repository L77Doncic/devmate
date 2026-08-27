import { describe, expect, it } from 'vitest';
import { run } from '../../src/core/loop/index.js';
import { DEFAULT_PRICING, defineRegistry } from '../../src/core/loop/index.js';
import type { Approver, Tool } from '../../src/core/loop/index.js';
import { INTERRUPTED_RESULT_CONTENT } from '../../src/shared/session-types.js';
import type { ToolCall } from '../../src/shared/session-types.js';
import {
  FakeLlm,
  assistantPayload,
  collectEvents,
  deferred,
  echoTool,
  eventPayload,
  kindsOf,
  makeRegistry,
  readyStore,
  seededStore,
  sleep,
  toolPayload,
  userPayload,
} from './support.js';

/**
 * 主循环（接缝 S5）：切片 a/b/c + h/i + 步数与墙钟保险丝。
 * 预期值独立来源（手算，非实现复算）：
 * - 「write a test」投影估算（S4 estimator 口径，无工具）：内容 6 token
 *   （write=ceil(5/4)=2、space=1、a=1、space=1、test=ceil(4/4)=1），消息开销 3+3 → 12；
 * - 「done」输出估算 ceil(4/4)=1 token；
 * - 占位价 DEFAULT_PRICING = {prompt: 1e-6, completion: 3e-6}（ADR-0003 单价表缺口期）
 *   → 自然结束轮成本 = 12×1e-6 + 1×3e-6 = 1.5e-5。
 */
const TASK = 'write a test';

function baseOpts(overrides: Partial<Parameters<typeof run>[1]>): Parameters<typeof run>[1] {
  return {
    store: undefined as never,
    tools: undefined as never,
    llm: undefined as never,
    model: 'test-model',
    ...overrides,
  };
}

describe('loop：主循环（接缝 S5）', () => {
  describe('a) 单轮自然结束', () => {
    it('无 toolCalls → completed；user 任务事件是首个事件；assistant 在会话', async () => {
      const store = readyStore();
      const llm = new FakeLlm([{ content: 'done' }]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        baseOpts({ store, tools: defineRegistry([], { sessionId: 's1' }), llm }),
      );

      expect(result.status).toBe('completed');
      expect(result.steps).toBe(1);
      expect(result.usage.promptTokens).toBe(12);
      expect(result.usage.completionTokens).toBe(1);
      expect(result.usage.totalTokens).toBe(13);
      expect(result.usage.costUsd).toBeCloseTo(
        12 * DEFAULT_PRICING.promptPerToken + 1 * DEFAULT_PRICING.completionPerToken,
        12,
      );
      expect(result.usage.estimated).toBe(true); // 流未带 usage → 本地估算兜底

      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual(['user', 'assistant(0tc)', 'event(run_result)']);
      expect(userPayload(events[0])?.content).toBe(TASK);
      expect(assistantPayload(events[1])?.content).toBe('done');
      expect(assistantPayload(events[1])?.toolCalls).toEqual([]);
      expect(eventPayload(events[2])?.type).toBe('run_result');

      expect(llm.requests).toHaveLength(1);
      expect(llm.requests[0]?.model).toBe('test-model');
      expect(llm.requests[0]?.messages).toEqual([{ role: 'user', content: TASK }]);
    });

    it('systemPrompt 作为投影系统前缀（请求消息[0] role=system）', async () => {
      const store = readyStore();
      const llm = new FakeLlm([{ content: 'ok' }]);
      const result = await run(
        { sessionId: 's1', task: TASK },
        baseOpts({
          store,
          tools: defineRegistry([], { sessionId: 's1' }),
          llm,
          systemPrompt: 'You are DevMate.',
        }),
      );

      expect(result.status).toBe('completed');
      expect(llm.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'You are DevMate.' });
      expect(llm.requests[0]?.messages[1]).toEqual({ role: 'user', content: TASK });
    });
  });

  describe('b) 一轮工具', () => {
    it('工具结果落盘后再第二轮；写序：assistant 先于 tool 结果、结果先于下一次 assistant', async () => {
      const store = readyStore();
      const { registry, executions } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
        { content: 'done' },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        baseOpts({ store, tools: registry, llm }),
      );

      expect(result.status).toBe('completed');
      expect(result.steps).toBe(2);
      expect(executions).toEqual(['call_1']);

      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual([
        'user',
        'assistant(1tc)',
        'tool(call_1)',
        'assistant(0tc)',
        'event(run_result)',
      ]);
      expect(toolPayload(events[2])?.toolCallId).toBe('call_1');
      expect(toolPayload(events[2])?.content).toBe('echo:hi');
      expect(toolPayload(events[2])?.interrupted).toBeUndefined();

      // 写序：seq 严格递增（append-only），且 tool 结果发生在下一次 assistant 之前
      const seqs = events.map((ev) => ev.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      // 第二次请求按 toolCallId 配对回传
      const toolMsg = llm.requests[1]?.messages.find((m) => m.role === 'tool');
      expect(toolMsg).toEqual({ role: 'tool', content: 'echo:hi', toolCallId: 'call_1' });
    });
  });

  describe('c) 并行工具调用', () => {
    it('2 个 toolCalls 并行执行、按 toolCallId 配对落盘（内容不串）', async () => {
      const store = readyStore();
      let active = 0;
      let maxActive = 0;
      const base = echoTool();
      const parallelEcho: Tool = {
        ...base,
        async execute(call, ctx) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(30);
          active -= 1;
          return base.execute(call, ctx);
        },
      };
      const registry = defineRegistry([parallelEcho], { sessionId: 's1' });
      const llm = new FakeLlm([
        {
          toolCalls: [
            { id: 'call_1', name: 'echo', arguments: '{"text":"one"}' },
            { id: 'call_2', name: 'echo', arguments: '{"text":"two"}' },
          ],
        },
        { content: 'done' },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        baseOpts({ store, tools: registry, llm }),
      );

      expect(result.status).toBe('completed');
      expect(result.steps).toBe(2);
      expect(maxActive).toBe(2); // 真并行执行，非串行

      const events = await collectEvents(store, 's1');
      const toolEvents = events.filter((ev) => ev.kind === 'tool');
      // 结果按发出顺序落盘；每条按自己的 toolCallId 配对
      expect(toolEvents.map((ev) => toolPayload(ev)?.toolCallId)).toEqual(['call_1', 'call_2']);
      expect(toolPayload(toolEvents[0])?.content).toBe('echo:one'); // 内容不串
      expect(toolPayload(toolEvents[1])?.content).toBe('echo:two');
    });
  });

  describe('h) resume：悬空工具调用', () => {
    it('repairOrphaned 补齐 interrupted 占位后从投影恢复继续；写序校验', async () => {
      const store = await seededStore([
        { kind: 'user', content: TASK },
        {
          kind: 'assistant',
          content: 'use echo',
          toolCalls: [{ id: 'call_A', name: 'echo', arguments: '{"text":"hi"}' }],
        },
      ]);
      const { registry } = makeRegistry();
      const llm = new FakeLlm([{ content: 'done' }]);

      const result = await run(
        { sessionId: 's1', task: 'IGNORED-ON-RESUME' },
        baseOpts({ store, tools: registry, llm }),
      );

      expect(result.status).toBe('completed');
      expect(result.steps).toBe(1);

      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual([
        'user',
        'assistant(1tc)',
        'tool(call_A)',
        'assistant(0tc)',
        'event(run_result)',
      ]);
      expect(toolPayload(events[2])?.content).toBe(INTERRUPTED_RESULT_CONTENT);
      expect(toolPayload(events[2])?.interrupted).toBe(true);
      // 写序：占位结果在调用之后
      const seqs = events.map((ev) => ev.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      // 恢复后模型看到的是 interrupted 占位（回传配对）
      const toolMsg = llm.requests[0]?.messages.find((m) => m.role === 'tool');
      expect(toolMsg).toEqual({
        role: 'tool',
        content: INTERRUPTED_RESULT_CONTENT,
        toolCallId: 'call_A',
      });
      // resume 不改写既有历史：任务事件仍是唯一 user 事件
      expect(events.filter((ev) => ev.kind === 'user')).toHaveLength(1);
    });
  });

  describe('i) 用户中断', () => {
    it('signal abort 中途 → user-interrupted；已落盘事件完整；未及执行的调用以 interrupted 占位落盘', async () => {
      const store = readyStore();
      const gate = deferred();
      const llm = new FakeLlm([
        {
          content: 'thinking',
          toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }],
          gate: gate.promise,
        },
        { content: 'done' },
      ]);
      const { registry } = makeRegistry();
      const controller = new AbortController();

      const entered = new Promise<void>((res) => {
        llm.onEnter = () => res();
      });
      const runP = run(
        { sessionId: 's1', task: TASK },
        baseOpts({ store, tools: registry, llm, signal: controller.signal }),
      );
      await entered;
      controller.abort();
      gate.resolve();
      const result = await runP;

      expect(result.status).toBe('user-interrupted');
      expect(result.steps).toBe(1);

      // 现场一致：assistant 已落盘（含 toolCalls）；中断时未及执行的调用以 interrupted 占位落盘
      // （最小缺口：settle 全部 → 只剩「真正没跑完的」，不留给 resume 修补）。
      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual([
        'user',
        'assistant(1tc)',
        'tool(call_1)',
        'event(run_result)',
      ]);
      expect(assistantPayload(events[1])?.content).toBe('thinking');
      expect(assistantPayload(events[1])?.toolCalls[0]?.id).toBe('call_1');
      expect(toolPayload(events[2])?.content).toBe(INTERRUPTED_RESULT_CONTENT);
      expect(toolPayload(events[2])?.interrupted).toBe(true);

      // 可再 run 继续：占位已就位（repairOrphaned 无悬空可补）、循环恢复
      const result2 = await run(
        { sessionId: 's1', task: TASK },
        baseOpts({ store, tools: registry, llm }),
      );
      expect(result2.status).toBe('completed');
      const events2 = await collectEvents(store, 's1');
      expect(kindsOf(events2)).toEqual([
        'user',
        'assistant(1tc)',
        'tool(call_1)',
        'event(run_result)',
        'assistant(0tc)',
        'event(run_result)',
      ]);
      // 中断占位如实回传模型
      const toolMsg = llm.requests[1]?.messages.find((m) => m.role === 'tool');
      expect(toolMsg).toEqual({
        role: 'tool',
        content: INTERRUPTED_RESULT_CONTENT,
        toolCallId: 'call_1',
      });
    });

    it('工具执行阶段中断（Promise.all 中信号断）：已完成的照常落盘，未及执行的 interrupted 占位', async () => {
      const store = readyStore();
      const firstStarted = deferred();
      const secondApproval = deferred();
      const executions: string[] = [];
      const base = echoTool();
      const tool: Tool = {
        ...base,
        async execute(call, ctx) {
          executions.push(call.id);
          if (call.id === 'call_1') firstStarted.resolve();
          return base.execute(call, ctx);
        },
      };
      const registry = defineRegistry([tool], { sessionId: 's1' });
      // call_2 审批挂起：信号在 call_1 执行期内断开；放行后 call_2 在「执行前」检查中被判 skipped。
      const approver: Approver = async (call: ToolCall) => {
        if (call.id === 'call_2') await secondApproval.promise;
        return 'allow';
      };
      const llm = new FakeLlm([
        {
          toolCalls: [
            { id: 'call_1', name: 'echo', arguments: '{"text":"one"}' },
            { id: 'call_2', name: 'echo', arguments: '{"text":"two"}' },
          ],
        },
        { content: 'should never run' },
      ]);
      const controller = new AbortController();

      const runP = run(
        { sessionId: 's1', task: TASK },
        baseOpts({ store, tools: registry, llm, approver, signal: controller.signal }),
      );
      await firstStarted.promise; // call_1 已开始执行（双检查已过）
      controller.abort();
      secondApproval.resolve();
      const result = await runP;

      expect(result.status).toBe('user-interrupted');
      expect(result.steps).toBe(1);
      expect(executions).toEqual(['call_1']); // call_2 从未触达工具层

      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual([
        'user',
        'assistant(2tc)',
        'tool(call_1)',
        'tool(call_2)',
        'event(run_result)',
      ]);
      // 第一工具已成功 → 结果照常落盘（内容完整、非占位）
      const first = toolPayload(events[2]);
      expect(first?.toolCallId).toBe('call_1');
      expect(first?.content).toBe('echo:one');
      expect(first?.interrupted).toBeUndefined();
      // 第二未跑 → interrupted 占位（副作用未知，如实告知）
      const second = toolPayload(events[3]);
      expect(second?.toolCallId).toBe('call_2');
      expect(second?.content).toBe(INTERRUPTED_RESULT_CONTENT);
      expect(second?.interrupted).toBe(true);
    });
  });

  describe('保险丝：步数与墙钟', () => {
    it('maxSteps=1：第一轮执行完后即 max-steps，不再发起下一次查询', async () => {
      const store = readyStore();
      const { registry, executions } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
        { content: 'should never run' },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        baseOpts({ store, tools: registry, llm, maxSteps: 1 }),
      );

      expect(result.status).toBe('max-steps');
      expect(result.steps).toBe(1);
      expect(llm.requests).toHaveLength(1);
      expect(executions).toEqual(['call_1']);
    });

    it('墙钟超限在下一轮查询前 wall-time（时钟注入）', async () => {
      const store = readyStore();
      let t = 0;
      const now = () => t;
      const { registry } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
        { content: 'should never run' },
      ]);
      llm.onEnter = () => {
        t = 40_000; // 第一轮查询期间墙钟已走满 40s（上限 30s）
      };

      const result = await run(
        { sessionId: 's1', task: TASK },
        baseOpts({ store, tools: registry, llm, wallTimeMs: 30_000, now }),
      );

      expect(result.status).toBe('wall-time');
      expect(result.steps).toBe(1);
      expect(llm.requests).toHaveLength(1);
      expect(result.durationMs).toBe(40_000);
      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual([
        'user',
        'assistant(1tc)',
        'tool(call_1)',
        'event(run_result)',
      ]);
    });
  });
});
