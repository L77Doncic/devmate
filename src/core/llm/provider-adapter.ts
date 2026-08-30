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
import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatTool,
  ReasoningEffort,
  ToolChoice,
} from '../../shared/llm-types.js';

/** 五家供应商 ID（ADR-0002 选型；新供应商接入 = 新增 id + preset）。 */
export const PROVIDER_IDS = ['openai', 'deepseek', 'dashscope', 'glm', 'kimi'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * 模型名尾部 UI 标记后缀语法：`[N]m`（N 百万）/ `[N]k`（N 千），大小写宽容，仅当
 * 出现在模型名**末尾**。单一权威来源：sanitizeProviderModel（发送前剥离）——窗口
 * 标注层已于 2026-08-30 用户裁定取消，本语法仅保留用于发送净化。
 */
export const MODEL_WINDOW_HINT_RE: RegExp = /\[([0-9]+(?:\.[0-9]+)?)([kKmM])\]$/;

/**
 * 模型名后缀净化（纯函数）：末尾的 `[N]m`/`[N]k`（大小写宽容，可多个连续）是 UI
 * 标记后缀而非供应商模型 ID 的一部分——带后缀直发网关会 400（供应商无此模型名
 * 形态，如 DeepSeek 直发 `deepseek-v4-flash[1m]`）。尾部逐层剥离
 * （`my/model[1m][2m]` → `my/model`）；非尾部保留（`my/model-1m-v2`、
 * `my[m]model[1m]` → `my[m]model`——只剥到尾后，其余逐字）。
 */
export function sanitizeProviderModel(model: string): string {
  let out = model;
  for (;;) {
    const next = out.replace(MODEL_WINDOW_HINT_RE, '');
    if (next === out) return out;
    out = next;
  }
}

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
   * 思考强度（reasoningEffort）的 wire 载体（C 档）：
   * 'reasoning_effort'（OpenAI-family：low/medium/high 逐字下发；off 不发）、
   * 'thinking'（DeepSeek：thinking {type:'enabled', budget_tokens}；off 显式 {type:'disabled'}）。
   * undefined = 未核实（无据）→ 保守 off：任何 effort 都不下发（Kimi/GLM/Qwen 当前口径）。
   */
  readonly reasoningParam?: 'reasoning_effort' | 'thinking';
  /**
   * 请求侧上下文窗口 token 估算（D/C 档；GET /api/settings 的 window 初值）。
   * 注意：全部为**估算**值（research 未能核实的一手数字；「估算，可在设置覆盖」——
   * settings 的 windowTokens 覆盖优先于本字段）。
   */
  readonly contextWindowTokens: number;
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
  /** Qwen 输入上限预设默认（笔记 §1，走 extra_body）。 */
  readonly maxInputTokens?: number;
  /**
   * 请求侧 max_input_tokens 的 wire 载体（A 档；settings.maxInputTokens）：
   * 'max_input_tokens' = DashScope/Qwen 专属字段（笔记 §1：走 extra_body）——本家支持，
   * 未声明（*不发送该字段*）的供应商在适配层剔除并要求客户端见 meta（deepseek-vision.md §8：
   * DeepSeek 官方无该参数——未证实，绝不发）。undefined = 不接受该参数。
   */
  readonly maxInputTokensField?: 'max_input_tokens';
  /**
   * 图像理解（ADR-0015）能力标记：供应商拥有接受图片的 vision 模型时 true
   * （deepseek-vision.md §7/§4-2：仅 deepseek-v4-flash-vision-exp 接受图片；其余模型
   * 官方返回 400 "This model does not support image"——本地预案在适配层先降级，绝不 400）。
   * 缺省 false = 无 vision 面 → 任何带图消息在适配层降级为纯文本（不崩溃）。
   * 注意：**该标记是供应商级**；模型级裁决 = visionModelsPatternOf 再匹配（只在
   * `-vision-` 命名的模型上放行——官方文档「仅视觉模型接受图片」）。
   */
  readonly vision?: boolean;
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
   * （wire 键名，如 Kimi temperature/top_p；剔除才记录，无剔除不带）与
   * 被降级的图片数（ADR-0015：非 vision 模型/供应商的带图消息——图片不发送，
   * 消息降级为文本 + 系统说明；降级才记录，无降级不带）。
   */
  readonly meta?: {
    readonly strippedParams?: readonly string[];
    readonly degradedImages?: number;
  };
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

  // 思考强度 → 思考态（C 档）：本次请求是否处于「思考开启」——支配
  // thinkingIgnoredSamplingParams 裁剪（§1.6 思考关闭时 temperature/top_p 不再静默剔除）。
  const effort = unified.reasoningEffort;
  const thinkingActive =
    effort !== undefined ? effort !== 'off' : provider.thinkingEnabled === true;

  const excludedKeys = new Set<string>(provider.fixedSamplingParams);
  if (thinkingActive) {
    for (const k of provider.thinkingIgnoredSamplingParams ?? []) excludedKeys.add(k);
  }
  const policy = reasoningPolicyOf(provider);

  // 模型名净化（B 档）：尾标 `[N]m`/`[N]k` 是 UI 标记后缀不是供应商模型 ID —— 发送值
  // 剥离后再发（如 DeepSeek 直发 `deepseek-v4-flash[1m]` → 400；净化后 200）。
  // 注意：只净化**发送值**；unified.model 原样保留（窗口标注层已取消——2026-08-30
  // 用户裁定；窗口来源 = 显式 windowTokens/网关探测/preset，不在本层）。
  // 图像多模态（ADR-0015）：vision 是否放行 = 供应商级（preset.vision）∧ 模型级
  // （官方仅 `-vision-` 命名模型接受图片；模型名经净化后判定）。非放行模型收到带图
  // 消息一律降级为纯文本 + 系统说明（官方做法是 400 "This model does not support image"——
  // 本地预案先降级，绝不 400、绝不崩），图像数记入 meta.droppedImages（可观测）。
  const visionModel =
    provider.vision !== true ? false : /vision/i.test(sanitizeProviderModel(unified.model));
  const degradedImages = countImagesNotAllowed(unified.messages, visionModel);

  const body: Record<string, unknown> = {
    model: sanitizeProviderModel(unified.model),
    messages: unified.messages.map((m) => toWireMessage(m, policy, visionModel)),
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
  const extraBody: Record<string, unknown> = {};
  if (unified.temperature !== undefined) {
    if (excludedKeys.has('temperature')) strippedParams.push('temperature');
    else body.temperature = unified.temperature;
  }
  if (unified.topP !== undefined) {
    if (excludedKeys.has('top_p')) strippedParams.push('top_p');
    else body.top_p = unified.topP;
  }
  if (unified.maxTokens !== undefined) body[provider.maxTokensField] = unified.maxTokens;
  // A 档：请求侧输入上限只在白名单供应商发送（deepseek-vision.md §8：DeepSeek 官方
  // 无 max_input_tokens——未证实绝不发；仅 DashScope/Qwen 走 extra_body）。
  if (unified.maxInputTokens !== undefined) {
    if (provider.maxInputTokensField !== undefined) {
      extraBody.max_input_tokens = unified.maxInputTokens;
    } else {
      strippedParams.push('max_input_tokens');
    }
  }
  if (unified.stop !== undefined) body.stop = [...unified.stop];
  if (unified.streamOptions !== undefined) {
    body.stream_options = { include_usage: unified.streamOptions.includeUsage === true };
  }
  if (effort !== undefined) {
    // 思考强度语义（C 档）：effort 明确给出时优先于 preset 缺省；'off' = 不传/显式禁用；
    // reasoningParam 未核实（无据）→ 保守不发任何字段（宁可参数不生效，绝不触发 400）。
    if (provider.reasoningParam === 'reasoning_effort') {
      // §5.2 词表：low/medium/high 逐字；off → 不传（无法关闭的平台以缺省为兜底）
      if (effort !== 'off') body.reasoning_effort = effort;
    } else if (provider.reasoningParam === 'thinking') {
      body.thinking =
        effort === 'off'
          ? { type: 'disabled' } // DeepSeek §1.6：显式关闭思考（off 不传将保持平台默认 enabled）
          : { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS[effort] };
    }
  } else if (provider.thinkingEnabled !== undefined) {
    body.thinking = { type: provider.thinkingEnabled ? 'enabled' : 'disabled' }; // §1.6
  }
  if (provider.clearThinking !== undefined) body.clear_thinking = provider.clearThinking; // §3.3

  if (provider.enableThinking !== undefined) extraBody.enable_thinking = provider.enableThinking;
  if (provider.thinkingBudget !== undefined) extraBody.thinking_budget = provider.thinkingBudget;
  if (provider.maxInputTokens !== undefined) extraBody.max_input_tokens = provider.maxInputTokens;

  return {
    baseUrl: provider.baseUrl,
    body,
    ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
    ...(strippedParams.length > 0 || degradedImages > 0
      ? {
          meta: {
            ...(strippedParams.length > 0 ? { strippedParams } : {}),
            ...(degradedImages > 0 ? { degradedImages } : {}),
          },
        }
      : {}),
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

/**
 * DeepSeek thinking budget_tokens 档位（C 档；§1.6 思考模式下对预算的保守档位——
 * low/medium/high 三档取值；数值为估算，可在 settings 侧换档不可细调）。
 */
const THINKING_BUDGET_TOKENS: Readonly<Record<Exclude<ReasoningEffort, 'off'>, number>> =
  Object.freeze({ low: 1024, medium: 4096, high: 16384 });

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

function toWireMessage(
  message: ChatMessage,
  policy: ReasoningPolicy,
  visionModel: boolean,
): Record<string, unknown> {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user': {
      if (typeof message.content === 'string') {
        return { role: 'user', content: message.content };
      }
      // 多模态块（ADR-0015）：vision 放行 → 块数组原样序列化（text/image_url 与
      // deepseek-vision.md §1 官方形状逐字一致）；不放行 → 降级为纯文本+系统说明。
      const text = textOfParts(message.content);
      if (!visionModel) {
        return {
          role: 'user',
          content: degradedImageText(text, countImagesOf(message.content)),
        };
      }
      const wireParts: unknown[] = [];
      if (text !== '') wireParts.push({ type: 'text', text });
      for (const part of message.content) {
        if (part.type !== 'image_url') continue;
        wireParts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
      }
      return { role: 'user', content: wireParts };
    }
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

// ---------------------------------------------------------------------------
// 多模态辅助（ADR-0015；纯函数）
// ---------------------------------------------------------------------------

/**
 * 降级注记文案（非 vision 模型的带图消息：图像未发送，模型只收到文本 ——
 * 系统说明给模型一个「图像没进来」的事实，避免模型凭空想象图内容）。
 */
export const DEGRADED_IMAGE_NOTE =
  '（图像未能处理：当前模型不支持图像输入，以下内容不含图片信息。）';

/** 块数组中 text 块文本拼接（逐块；仅文本块参与）。 */
function textOfParts(parts: readonly ChatContentPart[]): string {
  let out = '';
  for (const p of parts) {
    if (p.type === 'text') out += p.text;
  }
  return out;
}

/** 块数组中图片块个数（降级注记/meta 计数共用）。 */
function countImagesOf(parts: readonly ChatContentPart[]): number {
  let n = 0;
  for (const p of parts) {
    if (p.type === 'image_url') n += 1;
  }
  return n;
}

/** 带图消息总数（非放行裁决用；消息 content 为纯字符串无图）。 */
function countImagesNotAllowed(messages: readonly ChatMessage[], visionModel: boolean): number {
  if (visionModel) return 0;
  let n = 0;
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content !== 'string') n += countImagesOf(m.content);
  }
  return n;
}

/** 降级消息正文：原文本（原文保留）+ 注记（附该消息图片数）。 */
function degradedImageText(text: string, imageCount: number): string {
  const note = `\n${DEGRADED_IMAGE_NOTE}（${imageCount} 张图）`;
  return text === '' ? note.trim() : text + note;
}
