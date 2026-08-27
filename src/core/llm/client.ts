/**
 * # client：纯传输层 LLM 客户端（ADR-0001 接缝 S1，ADRs 修订）
 *
 * 深模块：fetch 传输、SSE 字节解析、tool_calls 分片拼接、usage 探测、
 * 基础错误映射全部收在这里。对外只有 chat(wire: WireRequest, signal?)——
 * wire 是 Provider Adapter（ADR-0002）归一的产物：序列化/字段映射/供应商差异
 * 一律在 adapter，本层不做任何序列化判断，照单发送（含 extra_body 并入 JSON 顶层）。
 *
 * 解析器事实（openai-compatible-api-spec.md §8.A / §8.B）：
 * - 事件以空行分组；data: 多行按 \n 合并后 parse（§8.A.1）；
 * - CRLF 归一、`: 注释行跳过、空事件丢弃（§8.A.3）；
 * - [DONE] 用 startsWith 在 JSON.parse 之前判定（§8.A.2，官方 SDK 同款）；
 * - 增量 TextDecoder 处理 UTF-8 分帧（§8.A.4）；
 * - choices === [] 的 chunk 是 usage 标准载体，不是垃圾（§8.A.6）；
 * - tool_calls 按（choice.index, tc.index）两级为主键、字符串相加拼接（§8.A.11，
 *   §8.B.12/13/14）；
 * - 未知字段（obfuscation、audio 等）一律忽略（§8.B.24）。
 *
 * 拼接结果只随快照/终态事件对外——工具调用分片不进入公共事件流（§8.B.13），
 * 多 choice（n>1）各流道的组装互不合并。
 */
import { LlmError } from '../../shared/llm-types.js';
import { extractErrorBody, parseRetryAfter, RETRYABLE_STATUS } from './error-parse.js';
import type { WireRequest } from './provider-adapter.js';
import type {
  AssembledToolCall,
  LlmUsage,
  StreamEvent,
  StreamSnapshot,
} from '../../shared/llm-types.js';

export interface LlmClientOptions {
  /** 留空则不发送 Authorization 头（本地端点）。 */
  apiKey?: string;
  /** 依赖注入：默认真实 fetch；测试注入假 fetch。 */
  fetch?: typeof fetch;
}

export class LlmClient {
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** 前流（未读到任何增量）失败的唯一错误事件构造：快照一律空基线。 */
  private fail(error: LlmError): StreamEvent {
    return { type: 'error', error, snapshot: makeSnapshot() };
  }

  async *chat(request: WireRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const endpoint = `${request.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    // base_url 与 body 均由 adapter 归一（ADR-0002）：本层只把 extraBody（Qwen 专属）
    // 并入 JSON 顶层后原样发送，不做任何字段序列化判断。
    const wireBody =
      request.extraBody !== undefined ? { ...request.extraBody, ...request.body } : request.body;
    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify(wireBody),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      yield this.fail(toTransportError(err));
      return;
    }

    if (!response.ok) {
      yield this.fail(await readHttpError(response));
      return;
    }

    const body = response.body;
    if (body === null) {
      yield this.fail(
        new LlmError({
          kind: 'http',
          status: response.status,
          retryable: true,
          message: '响应体为空',
        }),
      );
      return;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType !== '' && !contentType.includes('text/event-stream')) {
      // §8.A.9：非 event-stream 一律按错误体处理（HTML/JSON 混入 SSE 通道）
      yield this.fail(await readHttpError(response, { forcedRetryable: true }));
      return;
    }

    yield* this.consume(body);
  }

  private async *consume(stream: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
    const decoder = new TextDecoder();
    const pending: StreamEvent[] = [];
    let dataLines: string[] = [];
    let lineBuffer = '';
    let finishReason: string | null = null;
    let usage: LlmUsage | null = null;
    let sawDone = false;
    let failed = false;
    // 两级聚合键：choice.index → tc.index（§8.A.11；n=1 时 choice 恒为 0，退化为单层）。
    // 聚合槽即公共装配形状 AssembledToolCall（§8.B.13/14）：流中 id/name === '' 表示
    // 该字段尚未出现（首个非空采纳）；index 是 choice 内的 tc.index（不是数组位置/数组序）。
    const toolCallsByChoice = new Map<number, Map<number, AssembledToolCall>>();

    const flattenToolCalls = (): AssembledToolCall[] =>
      [...toolCallsByChoice.values()].flatMap((byIndex) => [...byIndex.values()]);

    const mkSnapshot = (): StreamSnapshot =>
      makeSnapshot({
        finishReason,
        usage,
        usageMissing: usage === null, // 到终止时仍无 usage → 本地估算兜底（§4.5/§7.2）
        toolCalls: flattenToolCalls(),
      });

    const processLine = (line: string) => {
      if (line === '') {
        dispatchEvent();
        return;
      }
      if (line.startsWith(':')) return; // 注释行 / 心跳（§8.A.3）
      if (!line.startsWith('data:')) return; // event:/id:/retry: 等均忽略
      let payload = line.slice(5);
      if (payload.startsWith(' ')) payload = payload.slice(1); // SSE: 最多去掉一个前导空格
      dataLines.push(payload);
    };

    const dispatchEvent = () => {
      if (dataLines.length === 0) return; // 幽灵空 chunk（§8.A.3）
      const data = dataLines.join('\n');
      dataLines = [];
      if (data.trim() === '') return;
      if (data.startsWith('[DONE]')) {
        sawDone = true;
        return;
      }
      try {
        applyChunk(JSON.parse(data));
      } catch {
        pending.push({
          type: 'error',
          error: new LlmError({
            kind: 'protocol',
            status: 0,
            retryable: true,
            message: 'SSE 事件不是合法 JSON',
          }),
          snapshot: mkSnapshot(),
        });
        failed = true;
      }
    };

    const applyChunk = (raw: unknown) => {
      if (typeof raw !== 'object' || raw === null) return;
      const chunk = raw as Record<string, unknown>;
      // 每个 chunk 都探测 wire usage 字段（§4.5 兜底：无处不探）
      const wireUsage = chunk.usage;
      if (wireUsage !== null && typeof wireUsage === 'object') {
        usage = normalizeUsage(wireUsage as Record<string, unknown>);
      }
      const choices = chunk.choices;
      // choices 缺失/空数组：无内容 chunk（usage 已探过），一律跳过（§8.A.6）
      if (!Array.isArray(choices)) return;
      for (const choice of choices) {
        if (typeof choice !== 'object' || choice === null) continue;
        const ch = choice as Record<string, unknown>;
        const fr = ch.finish_reason;
        if (typeof fr === 'string') finishReason = fr;
        // 流道键：choices[i].index；缺省视为 0（与 tc.index 容错口径一致，§4.3）
        const choiceIndex = typeof ch.index === 'number' ? ch.index : 0;
        const delta = ch.delta;
        if (typeof delta !== 'object' || delta === null) continue;
        const d = delta as Record<string, unknown>;
        if (typeof d.content === 'string') {
          pending.push({ type: 'text', text: d.content });
        }
        // §1.6/§4.2：reasoning_content 出现在 delta；独立字段保留——是否/如何
        // 回传属 S2 adapter 的 per-provider 策略（§3.3），本层绝不处置
        if (typeof d.reasoning_content === 'string') {
          pending.push({ type: 'reasoning', text: d.reasoning_content });
        }
        if (!Array.isArray(d.tool_calls)) continue;
        let byIndex = toolCallsByChoice.get(choiceIndex);
        if (byIndex === undefined) {
          byIndex = new Map();
          toolCallsByChoice.set(choiceIndex, byIndex);
        }
        for (const tc of d.tool_calls) {
          if (typeof tc !== 'object' || tc === null) continue;
          const t = tc as Record<string, unknown>;
          const index = typeof t.index === 'number' ? t.index : 0; // 不存在视为 0（§4.3）
          const id = typeof t.id === 'string' && t.id !== '' ? t.id : undefined;
          const fn =
            typeof t.function === 'object' && t.function !== null
              ? (t.function as Record<string, unknown>)
              : undefined;
          const name = typeof fn?.name === 'string' && fn.name !== '' ? fn.name : undefined;
          const args =
            typeof fn?.arguments === 'string' && fn.arguments !== '' ? fn.arguments : undefined;

          // 拼接（§8.B.12/13/14）：id/name 采纳首个非空，arguments 纯字符串相加。
          // 分片不对外暴露——公共事件流只有快照/终态携带装配结果（模块自述：拼接隐藏内部）。
          // 口径统一：空串与缺失同视为「字段未给」（fn.arguments 空串不进聚合）。
          let acc = byIndex.get(index);
          if (acc === undefined) {
            acc = { index, id: '', name: '', arguments: '' };
            byIndex.set(index, acc);
          }
          if (id !== undefined && acc.id === '') acc.id = id;
          if (name !== undefined && acc.name === '') acc.name = name;
          if (args !== undefined) acc.arguments += args;
        }
      }
    };

    const feed = (text: string) => {
      lineBuffer += text;
      let idx = lineBuffer.indexOf('\n');
      while (idx !== -1) {
        const line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        processLine(line.endsWith('\r') ? line.slice(0, -1) : line); // CRLF 归一（§8.A.3）
        idx = lineBuffer.indexOf('\n');
      }
    };

    const reader = stream.getReader();
    let cancelled = false;
    const cancelReader = () => {
      // 每个消费出口只释放一次：正常收尾、错误断流、消费者提前 break（return() 落入 finally）
      if (cancelled) return;
      cancelled = true;
      void reader.cancel().catch(() => {});
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(decoder.decode(value, { stream: true })); // 增量 UTF-8（§8.A.4）
        yield* pending.splice(0);
        if (sawDone || failed) break;
      }
      // 正常收尾也在 try 内：消费端在任意 yield 点离开（break/提前 return）都会触发 cancel
      if (failed) return;

      feed(decoder.decode()); // UTF-8 尾帧
      dispatchEvent();
      yield* pending.splice(0);
      // 尾 flush 才 parse 出协议错误（末事件坏 JSON 且无空行收尾）：错误事件已发，
      // 不再叠加「EOF 未见 [DONE]」——一次失败恰一个错误事件（§8.A.2）
      if (failed) return;

      if (sawDone) {
        yield { type: 'end', snapshot: mkSnapshot() };
        return;
      }
      // EOF 而未收到 [DONE]：连接被切断，已读部分保留，usage 缺失（§8.A.8）
      yield {
        type: 'error',
        error: new LlmError({
          kind: 'transport',
          status: 0,
          retryable: true,
          message: 'SSE 流在收到 [DONE] 之前结束',
        }),
        snapshot: mkSnapshot(),
      };
    } catch (err) {
      // 连接断开（§8.A.8）：已派发的 delta 原样先输出，再给错误事件
      yield* pending.splice(0);
      yield { type: 'error', error: toTransportError(err), snapshot: mkSnapshot() };
      return;
    } finally {
      cancelReader();
    }
  }
}

/** fetch 拒绝 / 断流 / 中止 的统一定型：AbortError 不可重试（用户主动），其余视为传输层。 */
function toTransportError(err: unknown): LlmError {
  if (err instanceof Error && err.name === 'AbortError') {
    return new LlmError({ kind: 'abort', status: 0, retryable: false, message: '请求已中止' });
  }
  return new LlmError({
    kind: 'transport',
    status: 0,
    retryable: true,
    message: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
  });
}

/**
 * 统一 HTTP 错误：读响应体、按 §6.1 三种形状解析（见共享 error-parse），
 * 取 Retry-After（头存在且可解析才用，§6.3）。供应商业务码精修在 adapter
 * （normalizeError/retryableRules）——本层只做状态码打底。
 */
async function readHttpError(
  response: Response,
  opts: { forcedRetryable?: boolean } = {},
): Promise<LlmError> {
  const raw = await response.text().catch(() => '');
  const { message, code, bodySnippet } = extractErrorBody(raw);
  const retryAfter = parseRetryAfter(response.headers);
  return new LlmError({
    kind: 'http',
    status: response.status,
    retryable: opts.forcedRetryable ?? RETRYABLE_STATUS.has(response.status),
    message,
    ...(code !== undefined ? { code } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(bodySnippet !== undefined ? { bodySnippet } : {}),
  });
}

// §7.1：prompt/completion/total + cached（OpenAI/Kimi/GLM）+ reasoning + DeepSeek hit/miss
function normalizeUsage(wire: Record<string, unknown>): LlmUsage {
  const p = wire.prompt_tokens;
  const c = wire.completion_tokens;
  const t = wire.total_tokens;
  const usage: LlmUsage = {
    promptTokens: typeof p === 'number' ? p : 0,
    completionTokens: typeof c === 'number' ? c : 0,
    totalTokens:
      typeof t === 'number' ? t : typeof p === 'number' && typeof c === 'number' ? p + c : 0,
  };
  const details = wire.prompt_tokens_details;
  const cached =
    (typeof details === 'object' && details !== null
      ? (details as Record<string, unknown>).cached_tokens
      : undefined) ?? wire.cached_tokens;
  if (typeof cached === 'number') usage.cachedTokens = cached;
  const cdetails = wire.completion_tokens_details;
  const reasoning =
    typeof cdetails === 'object' && cdetails !== null
      ? (cdetails as Record<string, unknown>).reasoning_tokens
      : undefined;
  if (typeof reasoning === 'number') usage.reasoningTokens = reasoning;
  if (typeof wire.prompt_cache_hit_tokens === 'number') {
    usage.promptCacheHitTokens = wire.prompt_cache_hit_tokens;
  }
  if (typeof wire.prompt_cache_miss_tokens === 'number') {
    usage.promptCacheMissTokens = wire.prompt_cache_miss_tokens;
  }
  return usage;
}

/** 快照组装缺省项：按「尚无可报」基线（null / null / true / []）处理。 */
interface SnapshotParts {
  finishReason?: string | null;
  usage?: LlmUsage | null;
  usageMissing?: boolean;
  toolCalls?: AssembledToolCall[];
}

/**
 * StreamSnapshot 唯一构造来源：前流失败（空基线）与流终止（mkSnapshot）都经此组装，
 * 不再有两处各自拼形状（§4.5 兜底口径唯一：终态仍无 usage → usageMissing true）。
 */
function makeSnapshot(parts: SnapshotParts = {}): StreamSnapshot {
  return {
    finishReason: parts.finishReason ?? null,
    usage: parts.usage ?? null,
    usageMissing: parts.usageMissing ?? true,
    toolCalls: parts.toolCalls ?? [],
  };
}
