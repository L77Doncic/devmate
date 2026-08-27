/**
 * # core/session：会话持久化（接缝 S3）
 *
 * 唯一事实来源（ADR-0004）：Session = append-only JSONL 事件流。
 * - 公共接口仅 SessionStore（base.ts）；默认实现 JsonlFileAdapter；另备 MemorySessionAdapter（内存版，同接口）。
 * - 事件行 schema 见 src/shared/session-types.ts；写序不变量由主循环（S5）保证，本模块提供 seq 单调分配、
 *   容错读与 repairOrphaned（悬空调用占位修补）。
 *
 * 导出：SessionStore / JsonlFileAdapter(+Options) / MemorySessionAdapter / 三类错误。
 */
export type { SessionStore } from './base.js';
export type { JsonlFileAdapterOptions } from './jsonl-file.js';
export { JsonlFileAdapter } from './jsonl-file.js';
export { MemorySessionAdapter } from './memory.js';
export {
  InvalidSessionIdError,
  SessionExistsError,
  SessionNotFoundError,
  SessionSeqConflictError,
} from './errors.js';
