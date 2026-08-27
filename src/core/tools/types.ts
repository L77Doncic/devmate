/**
 * # tools/types：工具上下文与工作区监狱接缝（S7）
 *
 * - FsToolContext：文件工具执行上下文 = 会话骨架（透传主循环的 sessionId/signal）
 *   + 监狱（构造注入）。本模块不负责监狱判定本身——只保证「先问 jail、再动手」；
 *   jail 拒绝即回报 path-outside-workspace，绝不绕过判定直操作路径。
 * - Jail / JailDecision / JailMode 以 S9 为单一来源（src/core/jail/index.ts）：
 *   本文件不重复定义最小面，只做类型转导出与消费（CTO 裁定「接口只有一份」）。
 *   判定语义见 S9 模块注与 ADR-0013（工作区监狱是模型行为约束层）；
 *   测试用内存假 jail（全放行 / 列表式阻断，见 test/fs-tools/support.ts）。
 */
import type { ToolExecutionContext } from '../loop/types.js';
import type { Jail } from '../jail/index.js';

export type { Jail, JailDecision, JailMode } from '../jail/index.js';

/** 文件工具上下文（S7 接缝）：会话骨架 + 工作区监狱（S9 实现，构造注入）。 */
export interface FsToolContext extends ToolExecutionContext {
  jail: Jail;
}
