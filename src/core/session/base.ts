import {
  INTERRUPTED_RESULT_CONTENT,
  SESSION_SCHEMA_VERSION,
  type EventKind,
  type SessionEvent,
  type SessionEventCore,
  type SessionEventInput,
} from '../../shared/session-types.js';
import { InvalidSessionIdError } from './errors.js';
import { missingToolCallIds } from './pairing.js';

/**
 * # core/session：SessionStore 公共接口
 *
 * 会话 = append-only 事件流（唯一事实来源，ADR-0004）。
 * 语义：
 * - `create(id)`：开新会话；同 id 已存在则抛 SessionExistsError。
 * - `append`：追加一个事件，seq 由实现分配（单调递增，用于幂等去重；读尾容忍坏行）。
 * - `events`：按写入顺序回放；实现必须容忍坏行（跳过 + 告警），不得因单行脏数据崩掉整个读取。
 * - `fork(from, newId)`：复制历史到新会话，原会话不动（会话分叉）。
 * - `repairOrphaned`：为悬空工具调用补「中断占位」结果；返回补齐的调用 ID 列表（幂等）。
 * - resume 语义 = 同一 id 直接继续 append（不要求重置、不要求复制）。
 */
export interface SessionStore {
  create(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
  append<K extends EventKind>(id: string, event: SessionEventInput<K>): Promise<SessionEvent<K>>;
  events(id: string): AsyncIterable<SessionEvent>;
  fork(fromId: string, newId: string): Promise<void>;
  repairOrphaned(id: string): Promise<string[]>;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 会话 id 只允许安全字符（防路径逃逸），违者抛 InvalidSessionIdError。 */
export function assertValidSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new InvalidSessionIdError(id);
  }
}

/**
 * 由输入构建落盘事件（文件与内存适配器共用，一处的 seq 分配与 schema 装配逻辑）：
 * - ts 由写端分配（普通调用方不允许指定，避免回放误读时序）；
 * - payload/meta 存副本（structuredClone），调用方事后改动输入对象不污染存储。
 */
export function buildSavedEvent<K extends EventKind>(
  input: SessionEventInput<K>,
  seq: number,
): SessionEvent<K> {
  // 以核心骨架构造；与具体 K 的关联由 SessionEventMap 保证（cast 语义：kind 与 payload 是同一 K）。
  const saved: SessionEventCore<K> = {
    v: SESSION_SCHEMA_VERSION,
    seq,
    ts: Date.now(),
    kind: input.kind,
    payload: structuredClone(input.payload),
  };
  if (input.meta !== undefined) {
    saved.meta = structuredClone(input.meta);
  }
  return saved as unknown as SessionEvent<K>;
}

/**
 * 悬空工具调用的修补（B 形态，research §3.2）：为每个缺失结果的调用 ID
 * 追加一条「中断占位」tool 结果事件——把「效果未知」如实告知模型，让它决定是否重新探测
 * （CONTEXT「悬空工具调用」）。占位结果落盘在流尾（写序不变量 T2 之后可安全继续）。
 */
export abstract class BaseSessionStore implements SessionStore {
  abstract create(id: string): Promise<void>;
  abstract exists(id: string): Promise<boolean>;
  abstract append<K extends EventKind>(
    id: string,
    event: SessionEventInput<K>,
  ): Promise<SessionEvent<K>>;
  abstract events(id: string): AsyncIterable<SessionEvent>;
  abstract fork(fromId: string, newId: string): Promise<void>;

  async repairOrphaned(id: string): Promise<string[]> {
    const events: SessionEvent[] = [];
    for await (const ev of this.events(id)) {
      events.push(ev);
    }
    const missing = missingToolCallIds(events);
    const repaired: string[] = [];
    for (const callId of missing) {
      await this.append(id, {
        kind: 'tool',
        payload: {
          toolCallId: callId,
          content: INTERRUPTED_RESULT_CONTENT,
          interrupted: true,
        },
      });
      repaired.push(callId);
    }
    return repaired;
  }
}
