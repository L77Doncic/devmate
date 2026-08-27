/**
 * # shared/session-types：会话事件行（Session = append-only 事件流的物理形态）
 *
 * 每行一条事件：`{v, seq, ts, kind, payload, meta?}`（context-and-error-handling.md §3.3 最小 schema；
 * 存储形态与写序不变量见 docs/adr/0004-append-only-session.md）。
 * payload 是面向本项目的**规范形态**（与供应商协议无关，默认 OpenAI 兼容线，ADR-0009）；
 * 把它映射成 provider 消息属于投影层（ADR-0005）的职责，本模块只负责事件流本身。
 * 术语遵循 CONTEXT.md：ToolCall（调用请求）与 ToolResult（执行结果）按调用 ID 严格配对。
 */

export const SESSION_SCHEMA_VERSION = 1;

export const EVENT_KINDS = ['user', 'assistant', 'tool', 'system', 'reasoning', 'event'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface UserPayload {
  content: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 模型给出的原始 JSON 字符串（保真存储，不二次编码）。 */
  arguments: string;
}

export interface AssistantPayload {
  content: string;
  toolCalls: ToolCall[];
}

export interface ToolPayload {
  toolCallId: string;
  content: string;
  /** 悬空工具调用修复占位为 true（CONTEXT「悬空工具调用」词条；普通结果为 false/缺省）。 */
  interrupted?: boolean;
}

/** 系统提示注入事件（每次会话开头注入的项目说明等系统消息，CONTEXT「会话」词条）。 */
export interface SystemPayload {
  content: string;
}

/** 推理内容事件（模型产出的推理逐事件追加，供审计/回放；CONTEXT「会话」词条）。 */
export interface ReasoningPayload {
  content: string;
}

export interface EventPayload {
  /** compaction / projection_changed / tool_truncated / approval_denied / checkpoint …… */
  type: string;
  data?: Record<string, unknown>;
}

export type SessionEventPayload =
  UserPayload | AssistantPayload | ToolPayload | SystemPayload | ReasoningPayload | EventPayload;

export type PayloadFor<K extends EventKind> = K extends 'user'
  ? UserPayload
  : K extends 'assistant'
    ? AssistantPayload
    : K extends 'tool'
      ? ToolPayload
      : K extends 'system'
        ? SystemPayload
        : K extends 'reasoning'
          ? ReasoningPayload
          : EventPayload;

/** 事件行公共骨架；kind 与 payload 通过 PayloadFor 关联。 */
export interface SessionEventCore<K extends EventKind> {
  v: typeof SESSION_SCHEMA_VERSION;
  seq: number;
  ts: number;
  kind: K;
  payload: PayloadFor<K>;
  meta?: Record<string, unknown>;
}

/**
 * 真判别联合：每个 kind 一个成员（kind 字面量与 payload 类型一一关联），
 * `ev.kind === 'assistant'` 即同时收窄 payload，无需 `'toolCalls' in ev.payload` 守卫。
 */
export type SessionEventMap = {
  [K in EventKind]: SessionEventCore<K>;
};

export type SessionEvent<K extends EventKind = EventKind> = SessionEventMap[K];

export type SessionEventInput<K extends EventKind = EventKind> = {
  kind: K;
  payload: PayloadFor<K>;
  meta?: Record<string, unknown>;
};

/**
 * 悬空工具调用的「中断占位」结果内容：把「副作用未知」如实告知模型，
 * 让它自己决定是否重新探测（CONTEXT「悬空工具调用」；research §3.2 错误回注约定：
 * 内容为合法 JSON、顶层带 ok/error 键（§4.4））。
 */
export const INTERRUPTED_RESULT_CONTENT = JSON.stringify({
  ok: false,
  error: {
    type: 'interrupted',
    message: 'The agent was interrupted before this tool call ran; its effects are unknown.',
  },
});
