/**
 * # shared：内部消息模型（占位）
 *
 * core 与 UI 之间共享的类型定义（当前为占位，实现随 ADR 落地）：
 * - 事件行：Session 的 append-only 事件流条目（ADR-0004，含写序不变量）。
 * - 调用配对：ToolCall <-> ToolResult 按调用 ID 严格一一对应（含错误回注）。
 * - 终止原因：自然结束 / 保险丝熔断 / 用户中断等（CONTEXT「终止条件」词条）。
 *
 * 命名一律遵循 CONTEXT.md 术语，禁止引入对话（conversation）与轨迹（trajectory）混用。
 */
export {};
