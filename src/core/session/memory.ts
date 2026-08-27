import type { EventKind, SessionEvent, SessionEventInput } from '../../shared/session-types.js';
import { assertValidSessionId, BaseSessionStore, buildSavedEvent } from './base.js';
import { SessionExistsError, SessionNotFoundError } from './errors.js';

/**
 * 内存实现：与 JsonlFileAdapter 同接口（SessionStore），供后续模块做快速测试与重放缓存。
 * 语义对齐：create/append/events/exists 做与文件适配器相同的 id 校验；
 * append 分配单调 seq；append 与 events 都存储/返回副本（调用方改动不污染存储）；
 * fork 深拷贝；repairOrphaned 复用 BaseSessionStore（幂等）。
 */
export class MemorySessionAdapter extends BaseSessionStore {
  private readonly sessions = new Map<string, SessionEvent[]>();
  private readonly nextSeqBySession = new Map<string, number>();

  async create(id: string): Promise<void> {
    assertValidSessionId(id);
    if (this.sessions.has(id)) {
      throw new SessionExistsError(id);
    }
    this.sessions.set(id, []);
    this.nextSeqBySession.set(id, 1);
  }

  async exists(id: string): Promise<boolean> {
    assertValidSessionId(id);
    return this.sessions.has(id);
  }

  async append<K extends EventKind>(
    id: string,
    input: SessionEventInput<K>,
  ): Promise<SessionEvent<K>> {
    assertValidSessionId(id);
    const list = this.sessions.get(id);
    if (list === undefined) {
      throw new SessionNotFoundError(id);
    }
    const seq = this.takeNextSeq(id);
    const saved = buildSavedEvent(input, seq);
    list.push(saved);
    return saved;
  }

  async *events(id: string): AsyncGenerator<SessionEvent> {
    assertValidSessionId(id);
    const list = this.sessions.get(id);
    if (list === undefined) {
      throw new SessionNotFoundError(id);
    }
    for (const ev of list) {
      yield structuredClone(ev);
    }
  }

  async fork(fromId: string, newId: string): Promise<void> {
    assertValidSessionId(fromId);
    assertValidSessionId(newId);
    const source = this.sessions.get(fromId);
    if (source === undefined) {
      throw new SessionNotFoundError(fromId);
    }
    if (this.sessions.has(newId)) {
      throw new SessionExistsError(newId);
    }
    this.sessions.set(newId, structuredClone(source));
    this.nextSeqBySession.set(newId, this.nextSeqBySession.get(fromId) ?? source.length + 1);
  }

  private takeNextSeq(id: string): number {
    const next = this.nextSeqBySession.get(id) ?? 1;
    this.nextSeqBySession.set(id, next + 1);
    return next;
  }
}
