/**
 * # ui/server/emit：SSE 帧序列化（纯函数；接缝 S12）
 *
 * 权威协议（CTO 定义，S13 前端逐字实现；本文件是服务端唯一序列化点）：
 * 下行 /api/stream 每帧两行——`event: <name>` + `data: <JSON>`（data 恒为单行 JSON），
 * 以空行结束；连接保活为注释行 `: ping`（默认每 30s 一发）。帧清单（10 类）与
 * payload 字段名全部钉死在 SseEventData 判别联合里，禁止改名/加嵌套/re-encode。
 * 术语遵循 CONTEXT.md：ToolCall（工具调用请求）与 ToolResult（工具执行结果）按调用 ID 配对。
 */
import type { SessionEvent } from '../../shared/session-types.js';

/** toolCalls 的线上形状（与会话事件 assistant.toolCalls 同构；arguments 为原始 JSON 字符串）。 */
export interface ToolCallView {
  id: string;
  name: string;
  arguments: string;
}

// ---------------------------------------------------------------------------
// 会话 workspaceRoot 元数据（A 档：会话按项目文件夹分组）
// ---------------------------------------------------------------------------

/** workspace 元事件的事件类型（事件流 meta：kind event + 本 type；data.workspaceRoot）。 */
export const SESSION_WORKSPACE_EVENT_TYPE = 'session-workspace';

/**
 * 单事件提取 workspaceRoot：kind=event 且 type=session-workspace 且 data.workspaceRoot
 * 为字符串 → 该值；其余（非本 meta / 畸形 data）→ null（映射不崩；详情/列表按 null
 * 显示「未知项目」）。
 */
export function sessionWorkspaceOf(ev: SessionEvent): string | null {
  if (ev.kind !== 'event' || ev.payload.type !== SESSION_WORKSPACE_EVENT_TYPE) return null;
  const data = ev.payload.data;
  if (typeof data !== 'object' || data === null) return null;
  const workspaceRoot = (data as Record<string, unknown>).workspaceRoot;
  return typeof workspaceRoot === 'string' ? workspaceRoot : null;
}

// ---------------------------------------------------------------------------
// 会话列表/详情的标题规则（A 档；从会话事件流派生的展示字段）
// ---------------------------------------------------------------------------

/** 标题最大字符数（中文按字符裁：JS 的 UTF-16 切片对 BMP 字符即按字符）。 */
export const TITLE_MAX_CHARS = 40;

/** 无 user 事件（空会话）的标题。 */
export const SESSION_EMPTY_TITLE = '（空会话）';

/** 由第一段 user 事件文本派生态标题；无内容则（空会话）。 */
export function deriveTitle(firstUserContent: string | undefined): string {
  if (firstUserContent === undefined || firstUserContent === '') return SESSION_EMPTY_TITLE;
  return firstUserContent.slice(0, TITLE_MAX_CHARS);
}

/**
 * 10 类协议帧（event 名与 data 字段逐字遵守 CTO 协议）：
 * session-user / assistant-delta / assistant-done / tool-start / tool-result /
 * approval-request / usage / run-status / run-error / compaction。
 *
 * compaction（上下文压缩披露折叠记）：summary 为摘要全文（无值给空串——前端只兜底显示
 * 「上下文已压缩」）；tokensBefore/tokensAfter 为可选 token 估算（缺省/非 number 时
 * 不带键，与 src/ui/web/sessions.js 的 toProtocolEvent 映射同规）。
 */
export type SseEventData =
  | { event: 'session-user'; data: { text: string } }
  | { event: 'assistant-delta'; data: { text: string } }
  | { event: 'assistant-done'; data: { content: string; toolCalls: ToolCallView[] } }
  | { event: 'tool-start'; data: { id: string; name: string; arguments: string } }
  | {
      event: 'tool-result';
      data: {
        id: string;
        name: string;
        ok: boolean;
        contentPreview: string;
        /** 全量结果内容（收集缓冲 64KB 上限内完整；preview 供列表，本字段供展开详情）。 */
        content: string;
        error?: string;
      };
    }
  | { event: 'approval-request'; data: { toolCallId: string; name: string; arguments: string } }
  | {
      event: 'usage';
      data: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        costUsd: number;
        estimated: boolean;
        /** 上下文估算 token（C 档：run 内最后一次投影 estimates；无投影路径缺省不带键）。 */
        contextEstimateTokens?: number;
      };
    }
  | { event: 'run-status'; data: { status: string; steps: number; durationMs: number } }
  | { event: 'run-error'; data: { message: string } }
  | {
      event: 'compaction';
      data: {
        summary: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
    };

export type SseEventName = SseEventData['event'];

/** 序列化一帧：`event: <name>\n` + `data: <JSON>\n` + 空行（帧终结）。 */
export function serializeEvent(frame: SseEventData): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** 心跳注释帧（`: ping`）：SSE 注释行不触发浏览器事件，只保活链路。 */
export function pingFrame(): string {
  return ': ping\n\n';
}
