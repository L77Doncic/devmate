/**
 * # context/estimator：L2 分类加权启发式 token 估算（§1.2 选型；A-1 常数体系）
 *
 * 设计：CJK 每字符 1 token（保守）、ASCII 字母数字连续段 ceil(len/K)（K=4 散文 / K=3 代码）、
 * 其余字符（标点/空白/符号）逐字 1 token——正文部分 O(n) 一趟可手算；
 * 结构开销按 OpenAI Cookbook 常数表（§1.3 一手）独立计量（消息 +3、回复 priming +3、
 * function +7、property +3、key +3、enum -3 每项 +3、tools 收尾 +12；
 * 函数 name/description 属真实负载，按正文规则计入——名称 K=3、描述 K=4）。
 * 精确性声明：Cookbook 自己也称「estimate, not a timeless guarantee」（§1.1），
 * 本估算标记 approximate: true；最终真值是服务端 usage.prompt_tokens（L0 事后校准）。
 * 标定声明：K 与结构常数落地前需 tiktoken 离线标定（REVIEW.md C 表），标定前按偏高估算。
 * 校准接口（ADR-0012「估算 × EMA 校正系数滑动」）：TokenEstimateCalibrator 维护
 * estimate/actual 比值的滑动平均系数，估算经 apply() 乘系数（默认 1 = 未校准）；
 * coefficient 由调用方在拿到真实 usage 后 update()。
 */
import type { ChatMessage, ChatTool } from '../../shared/llm-types.js';
import {
  ENUM_PROPERTY_ADJUSTMENT,
  REPLY_PRIMING_TOKENS,
  TEXT_TOKENS_PER_ASCII_CODE,
  TEXT_TOKENS_PER_ASCII_PROSE,
  TOKENS_PER_CJK_CHAR,
  TOKENS_PER_ENUM_ITEM,
  TOKENS_PER_FUNCTION,
  TOKENS_PER_MESSAGE,
  TOKENS_PER_PROPERTY,
  TOKENS_PER_PROPERTY_KEY,
  TOOLS_END_TOKENS,
} from './constants.js';

/** 估算分解：正文与结构开销独立计量（§1.3 结论：estimator 必须有 overhead(messages) 与 overhead(tools) 两个分量）。 */
export interface TokenEstimateParts {
  /** 正文 token（消息内容 + 工具调用名/参数）。 */
  contentTokens: number;
  /** 消息级结构开销（每消息 +3 × N + 回复 priming +3）。 */
  messageOverhead: number;
  /** 工具定义结构开销（function/property/key/enum/收尾）。 */
  toolsOverhead: number;
}

export interface TokenEstimate {
  /** 估算总 token 数（近似值）。 */
  tokens: number;
  /** 估算不是精确值（§1.1/§1.2：L2 档相对误差 ±5%~±15%；真值以服务端 usage 为准）。 */
  approximate: true;
  /** 消息条数。 */
  messageCount: number;
  parts: TokenEstimateParts;
}

function isCjkChar(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols & Punctuation（「CJK 标点 1 token」，§8 A-1）
    (code >= 0xff01 && code <= 0xff5e) // Fullwidth Forms（全角，保守计 1）
  );
}

function isAsciiAlnum(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
  );
}

/**
 * 单段文本的 token 估算：CJK 1/字、ASCII 字母数字连续段 ceil(len/charsPerToken)、其余逐字 1。
 * charsPerToken = TEXT_TOKENS_PER_ASCII_PROSE（4）或 TEXT_TOKENS_PER_ASCII_CODE（3）——
 * 语义是「每 token 覆盖的连续 ASCII 字符数（除数）」，名称不再用裸 k。
 */
export function estimateTextTokens(text: string, charsPerToken: number): number {
  let tokens = 0;
  let run = 0;
  const flush = (): void => {
    if (run > 0) {
      tokens += Math.ceil(run / charsPerToken);
      run = 0;
    }
  };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCjkChar(code)) {
      flush();
      tokens += TOKENS_PER_CJK_CHAR;
    } else if (isAsciiAlnum(code)) {
      run += 1;
    } else {
      flush();
      tokens += 1;
    }
  }
  flush();
  return tokens;
}

/** 单个角色消息的正文开销角色映射：tool（代码/JSON）K=3，其余 K=4。 */
function estimateMessageContent(message: ChatMessage): number {
  switch (message.role) {
    case 'system':
    case 'user':
      return estimateTextTokens(message.content, TEXT_TOKENS_PER_ASCII_PROSE);
    case 'assistant': {
      let tokens = estimateTextTokens(message.content ?? '', TEXT_TOKENS_PER_ASCII_PROSE);
      for (const tc of message.toolCalls ?? []) {
        tokens += estimateTextTokens(tc.function.name, TEXT_TOKENS_PER_ASCII_CODE);
        tokens += estimateTextTokens(tc.function.arguments, TEXT_TOKENS_PER_ASCII_CODE);
      }
      return tokens;
    }
    case 'tool':
      return estimateTextTokens(message.content, TEXT_TOKENS_PER_ASCII_CODE);
  }
}

/**
 * 工具定义结构开销（Cookbook num_tokens_for_tools 常数字面量；§1.3）。
 * name/description 正文计入：工具定义整体随请求发送，名称/描述是真实负载——
 * 名称按代码口径 K=3、描述按散文口径 K=4（长描述调用面不再被低估）。
 */
export function estimateToolsOverhead(tools: readonly ChatTool[]): number {
  let tokens = TOOLS_END_TOKENS;
  for (const tool of tools) {
    const fn = tool.function;
    tokens += TOKENS_PER_FUNCTION;
    tokens += estimateTextTokens(fn.name, TEXT_TOKENS_PER_ASCII_CODE);
    if (fn.description !== undefined) {
      tokens += estimateTextTokens(fn.description, TEXT_TOKENS_PER_ASCII_PROSE);
    }
    const params = fn.parameters as { properties?: unknown } | undefined;
    const properties =
      params !== null && typeof params === 'object' && 'properties' in params
        ? params.properties
        : undefined;
    if (properties === null || typeof properties !== 'object') {
      continue;
    }
    for (const prop of Object.values(properties)) {
      tokens += TOKENS_PER_PROPERTY_KEY + TOKENS_PER_PROPERTY; // key +3、property +3
      if (prop !== null && typeof prop === 'object' && 'enum' in prop && Array.isArray(prop.enum)) {
        tokens += ENUM_PROPERTY_ADJUSTMENT + prop.enum.length * TOKENS_PER_ENUM_ITEM;
      }
    }
  }
  return tokens;
}

/**
 * 计算一组消息 + 可选工具定义的估算 token 数。
 * tools 缺省（undefined）视为本轮不携带工具定义（toolsOverhead = 0）；
 * 传空数组则计入 tools 段收尾 +12（工具段已存在）。
 */
export function estimateTokens(
  messages: readonly ChatMessage[],
  tools?: readonly ChatTool[],
): TokenEstimate {
  let contentTokens = 0;
  for (const message of messages) {
    contentTokens += estimateMessageContent(message);
  }
  const messageOverhead = messages.length * TOKENS_PER_MESSAGE + REPLY_PRIMING_TOKENS;
  const toolsOverhead = tools !== undefined ? estimateToolsOverhead(tools) : 0;
  return {
    tokens: contentTokens + messageOverhead + toolsOverhead,
    approximate: true,
    messageCount: messages.length,
    parts: { contentTokens, messageOverhead, toolsOverhead },
  };
}

// ---------------------------------------------------------------------------
// L0 事后校准（ADR-0012）：估算 × EMA 校正系数
// ---------------------------------------------------------------------------

export interface TokenEstimateCalibratorOptions {
  /** ratio 的平滑阻尼（EMA 权重；默认 0.5 = 半衰平滑）。 */
  damping?: number;
  /** 初始系数（默认 1 = 未校准）。 */
  initial?: number;
}

/**
 * 校正系数：estimate/actual 比值的滑动平均（L0 事后校准，最终态贴近 0% 误差；§1.2）。
 * update(estimated, actual) 以 ratio = actual / estimated 做 EMA 更新；
 * apply(tokens) = round(tokens × coefficient)。默认系数 1（未校准时估算原样）。
 * 校准建议（ADR-0012 Consequences）：换模型换系数，per-provider/per-model 维护。
 */
export class TokenEstimateCalibrator {
  readonly damping: number;
  #coefficient: number;

  constructor(options: TokenEstimateCalibratorOptions = {}) {
    this.damping = options.damping ?? 0.5;
    this.#coefficient = options.initial ?? 1;
  }

  /** 当前校正系数（滑动 EMA 结果）。 */
  get coefficient(): number {
    return this.#coefficient;
  }

  /** 校准一次：真实 usage 到位后调用；estimated ≤ 0 的无效输入忽略（不产生噪声）。 */
  update(estimatedTokens: number, actualTokens: number): void {
    if (estimatedTokens <= 0 || actualTokens <= 0) return;
    const ratio = actualTokens / estimatedTokens;
    this.#coefficient = (1 - this.damping) * this.#coefficient + this.damping * ratio;
  }

  /** 估算应用校正系数（≥ 0，四舍五入到整数 token）。 */
  apply(tokens: number): number {
    return Math.max(0, Math.round(tokens * this.#coefficient));
  }
}
