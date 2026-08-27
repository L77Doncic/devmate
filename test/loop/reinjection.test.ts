import { describe, expect, it } from 'vitest';
import { run } from '../../src/core/loop/index.js';
import type { ToolCall } from '../../src/shared/session-types.js';
import {
  FakeLlm,
  assistantPayload,
  collectEvents,
  eventPayload,
  kindsOf,
  makeRegistry,
  readyStore,
  toolPayload,
} from './support.js';

/**
 * 错误回注 + 熔断（ADR-0006：轮次层错误一律回注、与熔断成对；APIS §3.2 配对规则）＋
 * 危险操作审批（ADR-0013：带备注拒绝拒因回注、无备注拒绝结束本轮）。
 *
 * 回注载荷约定（research §4.4 / ADR-0006）：content 恒为合法 JSON，顶层 ok/error，
 * error = {type, message, human_hint?, available_tools?, issues?}，逐调用 ID 配对为工具结果。
 */
const TASK = 'write a test';

type Options = Parameters<typeof run>[1];

function opts(overrides: Options): Options {
  return { ...overrides };
}

function badArgs(): Array<{ id: string; name: string; arguments: string }> {
  return [{ id: 'call_bad', name: 'echo', arguments: '{"text":' }]; // 非合法 JSON
}

describe('loop：错误回注与熔断（接缝 S5）', () => {
  describe('f) 回注内容规格', () => {
    it('未知工具：error.type=unknown_tool + 可用工具名列表 + 建议（human_hint）', async () => {
      const store = readyStore();
      const { registry } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: [{ id: 'call_x', name: 'ghost', arguments: '{}' }] },
        { content: 'ok' },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'm' }),
      );

      expect(result.status).toBe('completed');
      const events = await collectEvents(store, 's1');
      const injected = events.find((ev) => ev.kind === 'tool');
      const content = toolPayload(injected)?.content;
      const parsed = JSON.parse(content ?? '{}') as {
        ok: boolean;
        error: { type: string; message?: string; human_hint?: string; available_tools?: string[] };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.type).toBe('unknown_tool');
      expect(parsed.error.available_tools).toEqual(['echo', 'boom']);
      expect(parsed.error.human_hint).toMatch(/Use one of the available tools/);
      expect(parsed.error.message).toMatch(/ghost/);
    });

    it('arguments 非 JSON：error.type=invalid_tool_arguments + 建议 + 原始参数前段', async () => {
      const store = readyStore();
      const { registry } = makeRegistry();
      const llm = new FakeLlm([{ toolCalls: badArgs() }, { content: 'ok' }]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'm' }),
      );

      expect(result.status).toBe('completed');
      const events = await collectEvents(store, 's1');
      const injected = events.find((ev) => ev.kind === 'tool');
      const parsed = JSON.parse(toolPayload(injected)?.content ?? '{}') as {
        error: { type: string; message?: string; human_hint?: string; arguments_head?: string };
      };
      expect(parsed.error.type).toBe('invalid_tool_arguments');
      expect(parsed.error.human_hint).toStrictEqual(expect.any(String));
      expect(parsed.error.arguments_head).toContain('"text":');
    });

    it('schema 违例（缺必填参数）：error.type=invalid_arguments + issues 逐字段', async () => {
      const store = readyStore();
      const { registry } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: [{ id: 'call_s', name: 'echo', arguments: '{"wrong":"x"}' }] }, // 缺 text
        { content: 'ok' },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'm' }),
      );

      expect(result.status).toBe('completed');
      const events = await collectEvents(store, 's1');
      const injected = events.find((ev) => ev.kind === 'tool');
      const parsed = JSON.parse(toolPayload(injected)?.content ?? '{}') as {
        error: { type: string; issues?: Array<{ path: string; code: string }> };
      };
      expect(parsed.error.type).toBe('invalid_arguments');
      expect(parsed.error.issues).toEqual([{ path: 'text', code: 'required' }]);
    });
  });

  describe('e) 熔断：连续格式错误', () => {
    it('畸形 arguments 连续 3 轮 → circuit-break；每轮回注成对；工具未被执行', async () => {
      const store = readyStore();
      const { registry, executions } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: badArgs() },
        { toolCalls: badArgs() },
        { toolCalls: badArgs() },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'm' }),
      );

      expect(result.status).toBe('circuit-break');
      expect(result.steps).toBe(3);
      expect(llm.requests).toHaveLength(3);
      expect(executions).toEqual([]); // 畸形调用从未抵达工具层

      const events = await collectEvents(store, 's1');
      const toolets = events.filter((ev) => ev.kind === 'tool');
      expect(toolets).toHaveLength(3); // 三次回注（每轮恰一条，配对 call_bad）
      for (const ev of toolets) {
        const parsed = JSON.parse(toolPayload(ev)?.content ?? '{}') as { error: { type: string } };
        expect(parsed.error.type).toBe('invalid_tool_arguments');
        expect(toolPayload(ev)?.toolCallId).toBe('call_bad');
      }
      expect(eventPayload(events.at(-1))?.type).toBe('run_result');
    });

    it('一次干净轮清零：bad→good→bad→bad→自然结束 = completed（未达 3 次熔断）', async () => {
      const store = readyStore();
      const { registry, executions } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: badArgs() }, // +1
        { toolCalls: [{ id: 'call_ok', name: 'echo', arguments: '{"text":"hi"}' }] }, // 清零
        { toolCalls: badArgs() }, // +1
        { toolCalls: badArgs() }, // +2（未到 3）
        { content: 'done' },
      ]);

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'm' }),
      );

      expect(result.status).toBe('completed');
      expect(result.steps).toBe(5);
      expect(executions).toEqual(['call_ok']);
      const events = await collectEvents(store, 's1');
      const injected = events.filter((ev) => ev.kind === 'tool');
      expect(injected).toHaveLength(4); // 3 次回注 + 1 次正常结果
      expect(eventPayload(events.at(-1))?.data?.status).toBe('completed');
    });
  });

  describe('g) 危险操作审批', () => {
    it('approver deny 带理由：工具结果 user-denied（拒因在 message）回注、循环继续', async () => {
      const store = readyStore();
      const { registry, executions } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
        { content: 'ok' },
      ]);
      const approvalLog: string[] = [];
      const approver = async (call: ToolCall) => {
        approvalLog.push(call.id);
        return { deny: true, reason: 'not now' };
      };

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'm', approver }),
      );

      expect(result.status).toBe('completed');
      expect(result.steps).toBe(2);
      expect(executions).toEqual([]); // 被拒 → 未执行
      expect(approvalLog).toEqual(['call_1']);

      const events = await collectEvents(store, 's1');
      expect(kindsOf(events)).toEqual([
        'user',
        'assistant(1tc)',
        'event(approval_denied)',
        'tool(call_1)',
        'assistant(0tc)',
        'event(run_result)',
      ]);
      const injected = events.find((ev) => ev.kind === 'tool');
      const parsed = JSON.parse(toolPayload(injected)?.content ?? '{}') as {
        ok: boolean;
        error: { type: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.type).toBe('user-denied');
      expect(parsed.error.message).toBe('not now');
      expect((eventPayload(events[2])?.data as { reason?: string } | undefined)?.reason).toBe(
        'not now',
      );
      // 第二轮请求带拒因回注（配对 call_1）
      const toolMsg = llm.requests[1]?.messages.find((m) => m.role === 'tool');
      expect(toolMsg?.toolCallId).toBe('call_1');
      expect(String(toolMsg?.content)).toContain('user-denied');
    });

    it('approver deny 无理由：用户中止本轮（user-interrupted；无工具结果 → 悬空，resume 时补 interrupted 占位）', async () => {
      const store = readyStore();
      const { registry, executions } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
        { content: 'ok' },
      ]);
      const approver = async (call: ToolCall) => {
        void call;
        return { deny: true }; // 无理由
      };

      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'm', approver }),
      );

      // 无备注拒绝 = 用户拒绝停止本轮 → user-interrupted（与「拒绝停止本轮」、悬空/resume 语义自洽）
      expect(result.status).toBe('user-interrupted');
      expect(executions).toEqual([]);
      const events = await collectEvents(store, 's1');
      // 无工具结果事件；approval_denied 留下审计
      expect(kindsOf(events)).toEqual([
        'user',
        'assistant(1tc)',
        'event(approval_denied)',
        'event(run_result)',
      ]);
      // 悬空的调用，resume 修复为 interrupted 占位
      const result2 = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'm' }),
      );
      expect(result2.status).toBe('completed');
      const events2 = await collectEvents(store, 's1');
      const repaired = events2.filter((ev) => ev.kind === 'tool');
      expect(repaired).toHaveLength(1);
      expect(toolPayload(repaired[0])?.toolCallId).toBe('call_1');
      expect(toolPayload(repaired[0])?.interrupted).toBe(true);
    });

    it('无 approver = 全放行（默认路径）', async () => {
      const store = readyStore();
      const { registry, executions } = makeRegistry();
      const llm = new FakeLlm([
        { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
        { content: 'ok' },
      ]);
      const result = await run(
        { sessionId: 's1', task: TASK },
        opts({ store, tools: registry, llm, model: 'm' }),
      );
      expect(result.status).toBe('completed');
      expect(executions).toEqual(['call_1']);
      expect(assistantPayload((await collectEvents(store, 's1'))[1])?.toolCalls[0]?.id).toBe(
        'call_1',
      );
    });
  });
});
