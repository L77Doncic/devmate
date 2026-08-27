import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';

import type { SessionStore } from '../../src/core/session/index.js';
import type {
  AssistantPayload,
  EventKind,
  PayloadFor,
  SessionEvent,
  SessionEventInput,
  ToolCall,
  ToolPayload,
  UserPayload,
} from '../../src/shared/session-types.js';

let createdDirs: string[] = [];

export function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-session-'));
  createdDirs.push(dir);
  return dir;
}

export function cleanupTmpDirs(): void {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs = [];
}

export function userPayload(content: string): UserPayload {
  return { content };
}

export function assistantPayload(content: string, toolCalls: ToolCall[] = []): AssistantPayload {
  return { content, toolCalls };
}

export function toolResultPayload(toolCallId: string, content: string): ToolPayload {
  return { toolCallId, content };
}

export function event<K extends EventKind>(kind: K, payload: PayloadFor<K>): SessionEventInput<K> {
  return { kind, payload };
}

export async function readAll(store: SessionStore, id: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of store.events(id)) out.push(ev);
  return out;
}

/** 取 user 事件的文本内容（用于回放断言）。 */
export function userText(ev: SessionEvent): string {
  if (ev.kind === 'user') {
    return ev.payload.content;
  }
  return '';
}

/** 取 assistant 事件的调用列表（无调用或非 assistant 返回空）。 */
export function callsOf(ev: SessionEvent): ToolCall[] {
  if (ev.kind === 'assistant') {
    return ev.payload.toolCalls;
  }
  return [];
}

/** 调用配对不变量（独立于实现的规格谓词）：每个被请求的调用 ID 在请求之后都有恰好一个结果事件。 */
export function expectCallsPaired(events: readonly SessionEvent[]): void {
  const requestSeq = new Map<string, number>();
  const resultCount = new Map<string, number>();
  let sawRequest = false;
  for (const ev of events) {
    const calls = callsOf(ev);
    if (calls.length > 0) {
      for (const call of calls) {
        sawRequest = true;
        expect(typeof call.id).toBe('string');
        requestSeq.set(call.id, ev.seq);
      }
    } else if (ev.kind === 'tool' && 'toolCallId' in ev.payload) {
      const id = ev.payload.toolCallId;
      const reqSeq = requestSeq.get(id);
      expect(reqSeq, `tool result ${id} 无对应请求`).toBeDefined();
      if (reqSeq !== undefined) {
        expect(ev.seq, `result ${id} 应晚于请求而出现`).toBeGreaterThan(reqSeq);
      }
      resultCount.set(id, (resultCount.get(id) ?? 0) + 1);
    }
  }
  expect(sawRequest).toBe(true);
  for (const count of resultCount.values()) {
    expect(count).toBe(1);
  }
  for (const id of requestSeq.keys()) {
    expect(resultCount.get(id), `call ${id} 应恰有一个结果`).toBe(1);
  }
}
