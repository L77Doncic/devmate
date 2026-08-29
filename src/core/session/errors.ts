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
 * 磁盘 seq 回退（病态兜底）：本实例已成功写入的 seq 从磁盘消失——磁盘尾部的最后完整行
 * 落后于本实例缓存（lastSeqOnDisk < 缓存-1，如文件被另一进程替换/截断，概率≈0）。
 * 注意：一般性的「缓存 vs 磁盘不一致」（通常是另一实例 resume 续写了更多行）不再抛错——
 * 文件适配器以磁盘真值继续写并告警诊断（见 jsonl-file.ts reserveNextSeq），
 * 本错误只保留给「磁盘倒退」这类无法安全自愈的场景（ADR-0004「单写者假设」注释保留）。
 */
export class SessionSeqConflictError extends Error {
  constructor(id: string, cachedNext: number, diskNext: number) {
    super(
      `session seq conflict: ${JSON.stringify(id)} (cached next=${cachedNext}, disk-derived next=${diskNext}). ` +
        'Single-writer per session is assumed (ADR-0004); the disk seq fell behind this instance — ' +
        'the session file was likely replaced or truncated by another process.',
    );
    this.name = 'SessionSeqConflictError';
  }
}
