/**
 * # context：上下文管理（占位）
 *
 * 职责：
 * - 从会话（Session，append-only 事件流，ADR-0004）推导投影（Projection）。
 * - 两级压缩（ADR-0005）：工具输出截断 -> 工具结果裁剪 -> 对话摘要（含压缩防抖）；
 *   只作用于投影，原始事件流永不动。
 * - Token 预算估算 + 真实 usage 校准（ADR-0012），供 loop 保险丝预检使用。
 */
export {};
