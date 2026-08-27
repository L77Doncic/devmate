import { SESSION_SCHEMA_VERSION } from '../../src/shared/session-types.js';
import type {
  EventKind,
  PayloadFor,
  SessionEvent,
  ToolCall,
} from '../../src/shared/session-types.js';

/**
 * test/context 共用构造器：生成完整的落盘事件（带 v/seq/ts），
 * seq 从 1 起自动递增、ts 统一用常数（与实现无关，只保序）。
 */

let seq = 0;

/** 重置自动序号（避免跨用例受计数污染）。 */
export function resetSeq(): void {
  seq = 0;
}

export function nextTs(): number {
  return seq; // ts 只需保序，不需要真实时钟
}

export function ev<K extends EventKind>(kind: K, payload: PayloadFor<K>): SessionEvent<K> {
  seq += 1;
  return {
    v: SESSION_SCHEMA_VERSION,
    seq,
    ts: nextTs(),
    kind,
    payload,
  } as SessionEvent<K>;
}

export function userEvent(content: string): SessionEvent<'user'> {
  return ev('user', { content });
}

export function assistantEvent(content: string, toolCalls: ToolCall[]): SessionEvent<'assistant'> {
  return ev('assistant', { content, toolCalls });
}

export function toolEvent(toolCallId: string, content: string): SessionEvent<'tool'> {
  return ev('tool', { toolCallId, content });
}

export function call(id: string, name: string, argumentsJson = '{}'): ToolCall {
  return { id, name, arguments: argumentsJson };
}

/**
 * 组装一组「assistant 请求 + 结果」：
 * 生成 seq 递减无关的 n 组调用，每组一个工具结果（content 均为 outcome）。
 * 返回事件数组（按流序：a1, r1, a2, r2, …）。
 */
export function toolRound(
  n: number,
  opts: { name?: string; outcome?: string; content?: (i: number) => string } = {},
): SessionEvent[] {
  const name = opts.name ?? 'ls';
  const outcome = opts.content ?? ((i: number) => `z`.repeat(100) + `#${i}`);
  const out: SessionEvent[] = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(assistantEvent('', [call(`c${i}`, name)]));
    out.push(toolEvent(`c${i}`, outcome(i)));
  }
  return out;
}

/** 长 ASCII 填充串（k=4 下 ceil(len/4) 个 token 可手算）。 */
export function fillerAscii(len: number): string {
  return 'a'.repeat(len);
}

/** 会话事件的深快照（用于「输入不被改动」断言）。 */
export function snapshot(events: readonly SessionEvent[]): string {
  return JSON.stringify(events);
}
