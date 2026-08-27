/**
 * # test/loop/support：主循环测试专用 fakes 与手算常量
 *
 * - FakeLlm：按脚本队列出流的假 LLM 接缝（记录每次请求、追踪被消费者提前中止的流）。
 * - echo/boom：符合接缝 S5 Tool 形态的最简假工具（由 defineRegistry 包装为 ToolRegistry）。
 * - readyStore：内存会话存储 + 事件收集读器。
 * 全部为最简实现（TDD 铁律：fakes 最简、独立于被测代码）。
 */
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import { defineRegistry } from '../../src/core/loop/index.js';
import type { LlmAdapter, Tool, ToolRegistry } from '../../src/core/loop/index.js';
import {
  type AssembledToolCall,
  type ChatRequest,
  type LlmError,
  type LlmUsage,
  type StreamEvent,
  type StreamSnapshot,
} from '../../src/shared/llm-types.js';
import type { SessionEvent } from '../../src/shared/session-types.js';

/** 一条假响应脚本：content 先流为一条 text；toolCalls/usage 在 end 快照上给出。 */
export interface FakeScript {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: LlmUsage;
  usageMissing?: boolean;
  error?: LlmError;
  /** end 前等待（模拟流式挂起/中断窗口；测试用 promise gate）。 */
  gate?: Promise<void>;
}

export function snapshotOf(script: FakeScript): StreamSnapshot {
  const toolCalls: AssembledToolCall[] = (script.toolCalls ?? []).map((tc, index) => ({
    index,
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
  }));
  return {
    finishReason: null,
    usage: script.usage ?? null,
    usageMissing: script.usageMissing ?? script.usage === undefined,
    toolCalls,
  };
}

export class FakeLlm implements LlmAdapter {
  /** 每次 chat 收到的请求（被深拷贝，防测试因共享引用误判）。 */
  readonly requests: ChatRequest[] = [];
  /** 被消费者提前中止（未 yield end）的流编号（下标 = 请求序）。 */
  readonly cancelled: number[] = [];
  /** 每次进入 chat 的回调（测试同步点）。 */
  onEnter?: (index: number) => void;

  private readonly scripts: FakeScript[];
  private readonly done: number[] = [];
  private next = 0;

  constructor(scripts: FakeScript[]) {
    this.scripts = scripts;
  }

  get callCount(): number {
    return this.next;
  }

  async *chat(request: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const index = this.next;
    this.requests.push(structuredClone(request));
    this.next += 1;
    this.onEnter?.(index);
    const script = this.scripts[index];
    if (script === undefined) {
      throw new Error(`FakeLlm: no script for call #${index}`);
    }
    try {
      if (script.error !== undefined) {
        yield { type: 'error', error: script.error, snapshot: snapshotOf(script) };
        return;
      }
      if (script.content !== undefined && script.content !== '') {
        yield { type: 'text', text: script.content };
      }
      if (script.gate !== undefined) await script.gate;
      yield { type: 'end', snapshot: snapshotOf(script) };
      this.done.push(index);
    } finally {
      if (!this.done.includes(index)) this.cancelled.push(index);
    }
  }
}

/** 标准 echo 工具：参数 {text}，返回 `echo:<text>`。 */
export function echoTool(): Tool {
  return {
    name: 'echo',
    description: 'Echo back the given text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async execute(call) {
      const parsed = JSON.parse(call.arguments) as { text?: unknown };
      return { ok: true, content: `echo:${String(parsed.text ?? '')}` };
    },
  };
}

/** boom 工具：正常失败结果（失败=普通消息，非异常）。 */
export function boomTool(): Tool {
  return {
    name: 'boom',
    description: 'Always fails.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      return { ok: false, content: '', error: { type: 'boom', message: 'boom: failed by design' } };
    },
  };
}

/**
 * 新会话存储（未 create：由 run() 按「新会话 → create + task 落首个 user 事件」引导）。
 * 预置事件（resume 用例）另行 create + append。
 */
export function readyStore(): MemorySessionAdapter {
  return new MemorySessionAdapter();
}

/** 预置事件用的会话（与 run 的新会话引导区分：显式 create）。 */
export async function seededStore(
  events: Array<
    | { kind: 'user'; content: string }
    | {
        kind: 'assistant';
        content: string;
        toolCalls: Array<{ id: string; name: string; arguments: string }>;
      }
  >,
): Promise<MemorySessionAdapter> {
  const store = new MemorySessionAdapter();
  await store.create('s1');
  for (const ev of events) {
    if (ev.kind === 'user') {
      await store.append('s1', { kind: 'user', payload: { content: ev.content } });
    } else {
      await store.append('s1', {
        kind: 'assistant',
        payload: { content: ev.content, toolCalls: ev.toolCalls },
      });
    }
  }
  return store;
}

/** 读取会话全部事件（保留顺序）。 */
export async function collectEvents(
  store: MemorySessionAdapter,
  sessionId: string,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const ev of store.events(sessionId)) events.push(ev);
  return events;
}

/**
 * 事件序列的紧凑摘要：`user` / `assistant(Ntc)` / `tool(id)` / `event(type)`，
 * 供写序（assistant 先于 tool 结果、结果先于下一次 assistant）断言。
 */
export function kindsOf(events: readonly SessionEvent[]): string[] {
  return events.map((ev) => {
    switch (ev.kind) {
      case 'assistant':
        return `assistant(${ev.payload.toolCalls.length}tc)`;
      case 'tool':
        return `tool(${ev.payload.toolCallId})`;
      case 'event':
        return `event(${ev.payload.type})`;
      default:
        return ev.kind;
    }
  });
}

/** 最简注册表（echo + boom）＋执行记录。 */
export function makeRegistry(): { registry: ToolRegistry; executions: string[] } {
  const executions: string[] = [];
  const base = echoTool();
  const tool: Tool = {
    ...base,
    async execute(call, ctx) {
      executions.push(call.id);
      return base.execute(call, ctx);
    },
  };
  return { registry: defineRegistry([tool, boomTool()], { sessionId: 's1' }), executions };
}

/** 简单挂起（无依赖）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 手动放行型 promise（测试同步点）。 */
export function deferred(): { resolve: () => void; promise: Promise<void> } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { resolve, promise };
}

/** 按 kind 收窄的取件辅组（判空返回 undefined，避免测试里写 payload.kind 错键）。 */
export function assistantPayload(ev: SessionEvent | undefined) {
  return ev?.kind === 'assistant' ? ev.payload : undefined;
}
export function toolPayload(ev: SessionEvent | undefined) {
  return ev?.kind === 'tool' ? ev.payload : undefined;
}
export function eventPayload(ev: SessionEvent | undefined) {
  return ev?.kind === 'event' ? ev.payload : undefined;
}
export function userPayload(ev: SessionEvent | undefined) {
  return ev?.kind === 'user' ? ev.payload : undefined;
}
