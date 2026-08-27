/**
 * # provider-adapter：五家供应商协议差异归一（ADR-0002 接缝 S2）
 *
 * 深模块：主循环/会话/压缩只消费归一后的统一口径，五家的差异全部收在这一层
 * （CONTEXT「Provider Adapter」）。本层是纯变换，无 IO、零依赖、不注入。
 * 序列化职责在本层：产出 WireRequest（base_url + 蛇形 body + Qwen extra_body），
 * 客户端对 WireRequest 照单发送，不做任何字段映射（ADR-0001 修订）。
 *
 * 事实清单（openai-compatible-api-spec.md，下称 API-SPEC）：
 * - 采样参数白名单裁剪：Kimi 的 temperature/top_p/penalties 固定不可改，传了报错
 *   （§5.2 行 1/3/11）→ 发送前剔除；DeepSeek 思考模式下 temperature/top_p
 *   静默无效（§1.6 原文），等价于剔除后再发。被剔除的记录进 WireRequest.meta。
 * - strict 默认值（§1.3 表/§5.2 行 6）：Kimi 默认 true（不传等价于 true）→ 注入 true 呈显；
 *   OpenAI/DeepSeek 默认 false → 省略（缺省即 false）；DashScope/GLM 未提供该字段 → 不触碰。
 * - tool_choice 值域（§5.2 行 4 / 笔记 §3）：DashScope 无 required（预期 400，禁发）；
 *   GLM 参考文档仅支持 auto；Kimi 值域含 required（禁发的是模型级例外 k2.6/k2.7-code，
 *   默认模型 kimi-k3 不受限）→ 违规值一律抛 ProviderAdapterError，绝不静默改写调用方意图。
 * - reasoning_content 历史回传策略（§3.3，CONTEXT 三选一：剥离/保留/不回传；GLM 由
 *   clear_thinking 开关，默认 true=清除）。同一份内容先做归一化再回传：仅保留非空串，
 *   其余删键；保留策略下值原样透传（DeepSeek/Kimi 要求完整未修改）。
 * - max_tokens 命名（§5.2 行 2）：OpenAI/Kimi 已弃用 → max_completion_tokens。
 * - Qwen 专属字段（enable_thinking/thinking_budget/max_input_tokens，笔记 §1）在
 *   SDK 语义上走 extra_body：此处单列 extraBody，序列化时并入 JSON 顶层。
 * - finish_reason 词表（§4.4）：GLM 的 sensitive 是 content_filter 的替代词、
 *   network_error/model_context_window_exceeded 属提前终止；DeepSeek 的
 *   insufficient_system_resource 同理；一律归一到本层标准词表。
 * - 错误体业务码（§6.1 B / §6.2 / 笔记 §5）：GLM 字符串型业务码与 DashScope/Kimi
 *   类型词表另有「重试语义」内容——HTTP 状态码之外按业务码修正 retryable
 *   （例：GLM 1302 频率限流可退避重试，1308 周期配额重试无意义），修正表
 *   （retryableRules）随 preset 数据声明，本层解释执行。
 */
import { LlmError } from '../../shared/llm-types.js';
import { extractErrorBody, RETRYABLE_STATUS } from './error-parse.js';
import type { ChatMessage, ChatRequest, ChatTool, ToolChoice } from '../../shared/llm-types.js';

/** 五家供应商 ID（ADR-0002 选型；新供应商接入 = 新增 id + preset）。 */
export const PROVIDER_IDS = ['openai', 'deepseek', 'dashscope', 'glm', 'kimi'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * reasoning_content 历史回传策略（API-SPEC §3.3 / CONTEXT「Reasoning Content 策略」）：
 * - 'remove'：存在即剥离（GLM clear_thinking 默认清除；回传前清除后再发）；
 * - 'keep'：存在即保留（DeepSeek 带 tools 必须回传否则 400；Kimi 要求原样保留）；
 * - 'never-send'：从不发送（Qwen 默认忽略历史、回传会改变计费；OpenAI 不下发）。
 */
export type ReasoningPolicy = 'remove' | 'keep' | 'never-send';

/** tool_choice 值域种类（§5.2 行 4）；'named' 表示 {type:'function',function:{name}} 两层形状（§1.4）。 */
export type ToolChoiceKind = 'none' | 'auto' | 'required' | 'named';

/**
 * 业务码→重试语义修正规则（§6.1/§6.2/笔记 §5）。规则按表内顺序首中返回；
 * numeric* 规则仅在 code 可解析为有限数字时判定（GLM 字符串型业务码本身是数字串，
 * 如 '1302'——精确字符串规则先行，numeric 规则只兜数字集/区间）。
 */
export type RetryableRule =
  | { readonly kind: 'exact'; readonly value: string; readonly retryable: boolean }
  | { readonly kind: 'prefix'; readonly prefix: string; readonly retryable: boolean }
  | { readonly kind: 'numeric'; readonly value: number; readonly retryable: boolean }
  | {
      readonly kind: 'numeric-range';
      readonly from: number;
      readonly to: number;
      readonly retryable: boolean;
    };

/**
 * 供应商运行时配置（每供应商一个最小 adapter，ADR-0002）。
 * 所有行为差异以数据表达，核心循环零分支；字段均为 API-SPEC 核实的差异点，
 * 缺省字段=平台侧对该项无差异（或不下发为平台自身默认）。
 */
export interface ProviderPreset {
  readonly id: ProviderId;
  /** 默认 base_url（§5.1；客户端内部再拼 /chat/completions）。 */
  readonly baseUrl: string;
  /** 默认模型名（§5.1 当前代表模型）。 */
  readonly defaultModel: string;
  /**
   * 固定/禁改采样参数（wire 键名，§5.2 行 1/3/11）：unified 提供了也剔除，
   * 宁可丢失该参数也绝不触发供应商报错。
   */
  readonly fixedSamplingParams: readonly string[];
  /** 思考模式下被忽略的采样参数（§1.6 DeepSeek 原文：不报错但无效）；thinkingEnabled 为 true 时生效。 */
  readonly thinkingIgnoredSamplingParams?: readonly string[];
  /**
   * 工具函数 strict 注入值（§1.3）：undefined=不注入、平台缺省生效
   * （各家缺省值见 strictDefault）；仅 Kimi 注入 true 呈显。
   */
  readonly strict?: boolean;
  /**
   * 平台侧 strict 缺省值（§1.3 表/§5.2 行 6 权威矩阵）：OpenAI/DeepSeek=false、
   * Kimi=true；GLM/DashScope 未提供该字段（undefined=平台无此字段）。
   * 纯数据记录，供行为解释与审计，不直接驱动注入（驱动者见 strict）。
   */
  readonly strictDefault?: boolean;
  /** tool_choice 允许值域（§5.2 行 4）；违规值抛 ProviderAdapterError。 */
  readonly allowedToolChoices: readonly ToolChoiceKind[];
  /** reasoning_content 历史回传策略（§3.3）。 */
  readonly reasoningPolicy: ReasoningPolicy;
  /** GLM clear_thinking（§3.3 默认 true=清除历史轮）；false=Preserved Thinking：完整透传。 */
  readonly clearThinking?: boolean;
  /** DeepSeek 思考模式（§1.6 默认 enabled）；true+reasoning 策略共同驱动剔除与 thinking 字段。 */
  readonly thinkingEnabled?: boolean;
  /** Qwen 思考开关（Qwen 专属，走 extra_body；商业版思考默认按代系，缺省不下发=平台默认）。 */
  readonly enableThinking?: boolean;
  /** Qwen 思考预算 1–32768（默认 4000，笔记 §2，走 extra_body）。 */
  readonly thinkingBudget?: number;
  /** Qwen 输入上限（笔记 §1，走 extra_body）。 */
  readonly maxInputTokens?: number;
  /** max_tokens 的 wire 名（§5.2 行 2：OpenAI/Kimi 已弃用 → max_completion_tokens）。 */
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /**
   * 业务码→重试语义修正表（§6.1/§6.2/笔记 §5）：状态码打底（RETRYABLE_STATUS）
   * 之上按供应商业务码覆盖 retryable；无表=维持状态码口径（OpenAI/DeepSeek）。
   */
  readonly retryableRules?: readonly RetryableRule[];
}

/**
 * 适配层预检失败（未知供应商 / tool_choice 值域违规）：调用方按轮次层错误
 * 处理（错误回注），不进入传输层重试（CONTEXT 错误分层）。
 */
export class ProviderAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAdapterError';
  }
}

/** adapter 归一后的请求：客户端/底层只消费此形状，不再知道各家差异。 */
export interface WireRequest {
  /** 供应商 base_url（§5.1；供 LlmClient baseUrl，内部拼 /chat/completions）。 */
  readonly baseUrl: string;
  /** 最终 wire body（snake_case；OpenAI 同源字段与各家显式字段）。 */
  readonly body: Record<string, unknown>;
  /** Qwen 专属字段（笔记 §1「需走 extra_body」）：序列化时并入 JSON 顶层，不在 body 里。 */
  readonly extraBody?: Record<string, unknown>;
  /**
   * 观测通道（ADR-0002「adapter 决策白的、可观测」）：记录本请求被剔除的采样参数
   * （wire 键名，如 Kimi temperature/top_p；剔除才记录，无剔除不带）。
   */
  readonly meta?: { readonly strippedParams: readonly string[] };
}

/** 归一 finish_reason 词表（§4.4）：'aborted' 为一切提前终止/异常中断（含 GLM network_error/DeepSeek insufficient_system_resource）。 */
export type NormalizedFinishReason =
  'stop' | 'length' | 'tool_calls' | 'content_filter' | 'aborted';

/**
 * buildRequest(unified, provider): WireRequest —— 把统一的领域请求（unified，
 * 主循环/会话消费的统一口径，见 CONTEXT「统一口径」）翻译为该供应商的 wire 请求。
 * 纯变换：同一输入恒得同一输出；新对象，不改造入参。序列化/归一只发生在此。
 */
export function buildRequest(unified: ChatRequest, provider: ProviderPreset): WireRequest {
  assertKnownProvider(provider);

  const excludedKeys = new Set<string>(provider.fixedSamplingParams);
  if (provider.thinkingEnabled === true) {
    for (const k of provider.thinkingIgnoredSamplingParams ?? []) excludedKeys.add(k);
  }
  const policy = reasoningPolicyOf(provider);

  const body: Record<string, unknown> = {
    model: unified.model,
    messages: unified.messages.map((m) => toWireMessage(m, policy)),
    stream: true, // S1 契约：所有 agent 请求固定流式（§1.5）
  };
  if (unified.tools !== undefined) body.tools = toWireTools(unified.tools, provider);
  if (unified.toolChoice !== undefined) {
    assertToolChoiceAllowed(provider, unified.toolChoice);
    body.tool_choice = unified.toolChoice; // 两层函数形态本就与 wire 一致（§1.4）
  }
  if (unified.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = unified.parallelToolCalls;
  }
  const strippedParams: string[] = [];
  if (unified.temperature !== undefined) {
    if (excludedKeys.has('temperature')) strippedParams.push('temperature');
    else body.temperature = unified.temperature;
  }
  if (unified.topP !== undefined) {
    if (excludedKeys.has('top_p')) strippedParams.push('top_p');
    else body.top_p = unified.topP;
  }
  if (unified.maxTokens !== undefined) body[provider.maxTokensField] = unified.maxTokens;
  if (unified.stop !== undefined) body.stop = [...unified.stop];
  if (unified.streamOptions !== undefined) {
    body.stream_options = { include_usage: unified.streamOptions.includeUsage === true };
  }
  if (provider.thinkingEnabled !== undefined) {
    body.thinking = { type: provider.thinkingEnabled ? 'enabled' : 'disabled' }; // §1.6
  }
  if (provider.clearThinking !== undefined) body.clear_thinking = provider.clearThinking; // §3.3

  const extraBody: Record<string, unknown> = {};
  if (provider.enableThinking !== undefined) extraBody.enable_thinking = provider.enableThinking;
  if (provider.thinkingBudget !== undefined) extraBody.thinking_budget = provider.thinkingBudget;
  if (provider.maxInputTokens !== undefined) extraBody.max_input_tokens = provider.maxInputTokens;

  return {
    baseUrl: provider.baseUrl,
    body,
    ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
    ...(strippedParams.length > 0 ? { meta: { strippedParams } } : {}),
  };
}

/**
 * normalizeFinishReason(raw, provider): 把供应商 finish_reason 专用词归一到
 * 标准词表（§4.4）。null 原样透传（S1 快照的「尚未出现」语义）。
 */
export function normalizeFinishReason(
  raw: string | null,
  provider: ProviderPreset,
): NormalizedFinishReason | null {
  assertKnownProvider(provider);
  if (raw === null) return null;
  if (STANDARD_FINISH_REASONS.has(raw)) return raw as NormalizedFinishReason;
  if (raw === 'function_call') return 'tool_calls'; // OpenAI 弃用同义词（§4.4）
  const providerWord = PROVIDER_FINISH_WORDS[provider.id]?.[raw];
  if (providerWord !== undefined) return providerWord;
  // 未知/未来词一律按 §4.4 口径：「非 stop/tool_calls 全部当提前终止处理」
  return 'aborted';
}

/**
 * normalizeError(rawBody, status, provider): LlmError —— S1 已做错误体三种形状的
 * 基础解析（§6.1，见共享 error-parse），本层在 shape 之上按供应商字符串业务码
 * 词表（preset.retryableRules）修正重试语义（§6.1/§6.2/笔记 §5）：同是 429，
 * 频率类可退避重试、周期配额/欠费类重试无意义。纯函数：body 为响应文本，无 IO。
 */
export function normalizeError(
  rawBody: string,
  status: number,
  provider: ProviderPreset,
): LlmError {
  assertKnownProvider(provider);
  const { message, code, bodySnippet } = extractErrorBody(rawBody);
  const retryable = refineRetryable(provider, status, code);
  return new LlmError({
    kind: 'http',
    status,
    retryable,
    message,
    ...(code !== undefined ? { code } : {}),
    ...(bodySnippet !== undefined ? { bodySnippet } : {}),
  });
}

// ---------------------------------------------------------------------------
// 内部实现：纯函数，无状态
// ---------------------------------------------------------------------------

/** GLM clearThinking:false = Preserved Thinking：保留并完整透传（§3.3）。 */
function reasoningPolicyOf(provider: ProviderPreset): ReasoningPolicy {
  if (provider.clearThinking === false) return 'keep';
  return provider.reasoningPolicy;
}

/** 回传前归一化：只保留非空（trim 后非空）的真实内容；其余删键（§3.3 归一化要求）。 */
function normalizeReasoningValue(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.trim() === '') return undefined;
  return value; // 保留策略下原样透传（DeepSeek/Kimi 要求完整未修改）
}

function toWireMessage(message: ChatMessage, policy: ReasoningPolicy): Record<string, unknown> {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant': {
      const wire: Record<string, unknown> = {
        role: 'assistant',
        content: message.content,
      };
      if (message.toolCalls !== undefined) {
        // arguments 是模型产出的 JSON 串，逐字回传，禁止 parse/stringify（§8.B.17）
        wire.tool_calls = message.toolCalls.map((tc) => ({ ...tc }));
      }
      if (policy === 'keep') {
        const reasoning = normalizeReasoningValue(message.reasoningContent);
        if (reasoning !== undefined) wire.reasoning_content = reasoning;
      }
      // remove / never-send：一律不回传 reasoning_content（Qwen/GLM/OpenAI）
      return wire;
    }
    case 'tool':
      return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  }
}

/** strict 默认值按家注入（§1.3）：Kimi true 呈显；DashScope/GLM 无此字段不触碰。 */
function toWireTools(tools: ChatTool[], provider: ProviderPreset): unknown[] {
  return tools.map((tool) => {
    if (provider.strict === undefined) {
      return { type: tool.type, function: { ...tool.function } };
    }
    return {
      type: tool.type,
      function: { ...tool.function, strict: provider.strict },
    };
  });
}

function assertKnownProvider(provider: ProviderPreset): void {
  const id = (provider as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(id)) {
    throw new ProviderAdapterError(
      `未知供应商「${String(id)}」：仅支持 [${PROVIDER_IDS.join(', ')}]，不许静默当作 OpenAI 处理`,
    );
  }
}

function assertToolChoiceAllowed(provider: ProviderPreset, choice: ToolChoice): void {
  const allowed = provider.allowedToolChoices;
  const ok = typeof choice === 'string' ? allowed.includes(choice) : allowed.includes('named');
  if (ok) return;
  const shown = typeof choice === 'string' ? choice : JSON.stringify(choice);
  throw new ProviderAdapterError(
    `供应商「${provider.id}」的 tool_choice 值域为 [${allowed.join(', ')}]，不支持「${shown}」（§5.2 行 4：禁发值抢先抛出，避免 400）`,
  );
}

/** §4.4 五家通用词（OpenAI 枚举全集）；多余语义由 provider 词表补充。 */
const STANDARD_FINISH_REASONS: ReadonlySet<string> = new Set([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
]);

/** 供应商专用 finish_reason 词（§4.4/§5.2 行 15）：只能由发布该词表的一方触发。 */
const PROVIDER_FINISH_WORDS: Readonly<
  Record<ProviderId, Readonly<Record<string, NormalizedFinishReason>>>
> = {
  openai: {},
  deepseek: { insufficient_system_resource: 'aborted' },
  dashscope: {},
  glm: {
    sensitive: 'content_filter', // GLM 用 sensitive 代替 content_filter（§4.4）
    network_error: 'aborted',
    model_context_window_exceeded: 'aborted',
  },
  kimi: {},
};

/**
 * 业务码修正重试语义：HTTP 状态码打底（RETRYABLE_STATUS，与 S1 共享单一来源），
 * 命中 preset.retryableRules 首条即覆盖；code 未给或未命中时维持状态码口径。
 * （§6.1/§6.2/笔记 §5）
 */
function refineRetryable(
  provider: ProviderPreset,
  status: number,
  code: string | undefined,
): boolean {
  const base = RETRYABLE_STATUS.has(status);
  if (code === undefined) return base;
  for (const rule of provider.retryableRules ?? []) {
    if (ruleMatches(rule, code)) return rule.retryable;
  }
  return base;
}

function ruleMatches(rule: RetryableRule, code: string): boolean {
  switch (rule.kind) {
    case 'exact':
      return code === rule.value;
    case 'prefix':
      return code.startsWith(rule.prefix);
    case 'numeric': {
      const n = Number(code);
      return Number.isFinite(n) && n === rule.value;
    }
    case 'numeric-range': {
      const n = Number(code);
      return Number.isFinite(n) && n >= rule.from && n <= rule.to;
    }
  }
}
