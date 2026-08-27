/** 会话已存在（如 create/fork 目标 id 已占用）。 */
export class SessionExistsError extends Error {
  constructor(id: string) {
    super(`session already exists: ${id}`);
    this.name = 'SessionExistsError';
  }
}

/** 会话不存在（如对未创建的 id 执行 append/events/fork）。 */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = 'SessionNotFoundError';
  }
}

/** 会话 id 非法（只允许 [A-Za-z0-9][A-Za-z0-9._-]*，防路径逃逸）。 */
export class InvalidSessionIdError extends Error {
  constructor(id: string) {
    super(`invalid session id: ${JSON.stringify(id)}`);
    this.name = 'InvalidSessionIdError';
  }
}

/**
 * 单写者假设被破坏：本实例缓存的下一个 seq 与磁盘实际尾部的 seq 不一致——
 * 说明有另一个写入实例（resume）也在写同一会话。避免静默复用陈旧 seq（重复行会被读端
 * 幂等去重丢弃，新事件无声消失），改为拒绝写入（ADR-0004「单写者假设」）。
 */
export class SessionSeqConflictError extends Error {
  constructor(id: string, cachedNext: number, diskNext: number) {
    super(
      `session seq conflict: ${JSON.stringify(id)} (cached next=${cachedNext}, disk-derived next=${diskNext}). ` +
        'Single-writer per session is assumed (ADR-0004); another writer may be appending to this session.',
    );
    this.name = 'SessionSeqConflictError';
  }
}
