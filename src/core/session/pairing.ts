import type { SessionEvent } from '../../shared/session-types.js';

/**
 * 返回「请求事件在、结果缺失」的调用 ID 列表（悬空工具调用），按首次出现顺序。
 * 与实现无关的对账逻辑：assistant.payload.toolCalls 计入请求，tool.payload.toolCallId 计入应答；
 * 形状不符的条目视为不存在——读端逐行校验（parseEventLine）已保证事件形状符合声明类型，
 * 这里仍保留运行时防御：非法条目宁缺勿砍（语义上视为没有该项）。
 */
export function missingToolCallIds(events: readonly SessionEvent[]): string[] {
  const requested: string[] = [];
  const seen = new Set<string>();
  const answered = new Set<string>();
  for (const ev of events) {
    if (ev.kind === 'assistant' && Array.isArray(ev.payload.toolCalls)) {
      for (const call of ev.payload.toolCalls) {
        if (typeof call.id !== 'string') {
          continue;
        }
        if (!seen.has(call.id)) {
          seen.add(call.id);
          requested.push(call.id);
        }
      }
    } else if (ev.kind === 'tool' && typeof ev.payload.toolCallId === 'string') {
      answered.add(ev.payload.toolCallId);
    }
  }
  return requested.filter((id) => !answered.has(id));
}
