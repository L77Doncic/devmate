/**
 * # presets：五家供应商默认接入数据（base_url / 默认模型 / 行为差异，ADR-0002）
 *
 * 主默认 DeepSeek（用户拍板 + ADR-0002：主默认 DeepSeek、兼容 Qwen/GLM/Kimi/OpenAI）。
 * 每个 preset 是 buildRequest 等纯变换的行为参数表：字段均来自
 * openai-compatible-api-spec.md §5.1/§5.2 与 notes/dashscope-qwen-compat-notes.md
 * 的核实事实；「待实测验证」项不固化进默认值（属 Phase 2 冒烟定案，ADR-0002 依据段）。
 * 行为字段按适配切片推进补齐（切片完成前为安全缺省：无裁剪、无 strict、tool_choice
 * 全拒、不回传 reasoning——宁可保守不越界，绝不发送未核实字段）。
 */
import { PROVIDER_IDS, ProviderAdapterError } from './provider-adapter.js';
import type { ProviderId, ProviderPreset } from './provider-adapter.js';

export const DEFAULT_PROVIDER_ID: ProviderId = 'deepseek';

const openai: ProviderPreset = {
  id: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-5.2',
  fixedSamplingParams: [],
  // C 档思考强度：OpenAI-family 走 reasoning_effort（low/medium/high 逐字；off 不发）
  reasoningParam: 'reasoning_effort',
  // 估算（research 未能核实一手数字；「估算，可在设置覆盖」——settings.windowTokens 优先）
  contextWindowTokens: 128_000,
  // §1.3 表/§5.2 行 6：Chat Completions 缺省即 false（Responses 才会自动严格化）→ 不注入（缺省即 false）
  strictDefault: false,
  allowedToolChoices: ['none', 'auto', 'required', 'named'],
  reasoningPolicy: 'never-send',
  // §5.2 行 2：max_tokens 已弃用（不兼容 o 系列）→ max_completion_tokens
  maxTokensField: 'max_completion_tokens',
};

const deepseek: ProviderPreset = {
  id: 'deepseek',
  // §5.1：官方 curl 例用无 /v1 形式；Beta 特性才须 https://api.deepseek.com/beta
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-v4-flash',
  fixedSamplingParams: [],
  // C 档思考强度：DeepSeek 走 thinking（enabled + budget_tokens 1024/4096/16384；off 显式 disabled）
  reasoningParam: 'thinking',
  // 估算（research 标注「未能核实」——给保守可调值：128k；「估算，可在设置覆盖」）
  // V3.x 代际公开 128K，未经实测页核实（settings.windowTokens 优先）
  // （2026-08-30 现场取证：DeepSeek /models 实测仅 {id, object, owned_by} 无窗口字段
  //  ——预设为估算，非实测；窗口来源=显式覆盖/网关探测/preset（模型名标注层已取消，2026-08-30 用户裁定）。）
  contextWindowTokens: 128_000,
  // §1.6：思考模式默认 enabled；temperature/top_p 静默无效 → 思考时剔除。
  // penalties 在 §1.6 同被忽略，但 ChatRequest 无其载体（死数据不入剔除集）
  thinkingEnabled: true,
  thinkingIgnoredSamplingParams: ['temperature', 'top_p'],
  // §1.3 表/§5.2 行 6：缺省 false（strict:true 还要换 /beta 端点，属接入配置）
  strictDefault: false,
  // §3.3：带 tools 的请求必须每轮回传 reasoning_content，否则 400
  reasoningPolicy: 'keep',
  allowedToolChoices: ['none', 'auto', 'required', 'named'],
  // 图像理解（ADR-0015）：供应商级 vision 能力 = true——模型级裁决按
  // sanitizeProviderModel 后 /vision/i 匹配（官方仅 deepseek-v4-flash-vision-exp
  // 接受图片，其余模型 400 "This model does not support image"——本地适配层先降级）。
  // 文档（pricing 功能表）：vision 模型 Tool Calls / Json Output / Responses / Anthropic
  // 均支持（FIM 不支持）→ 主循环 tools 零改动（deepseek-vision.md §7）。
  vision: true,
  maxTokensField: 'max_tokens',
};

const dashscope: ProviderPreset = {
  id: 'dashscope',
  // §5.1 北京兼容端点；新加坡 dashscope-intl / workspace 专属域名属接入配置可覆盖
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  defaultModel: 'qwen3-coder-plus',
  fixedSamplingParams: [],
  // 笔记 §3：值域无 required 记载（预期 400）→ 禁发；n 与 tools 互斥已由平台强制
  allowedToolChoices: ['none', 'auto', 'named'],
  // 笔记 §2：历史 reasoning_content 默认忽略、回传计入输入 token → 从不回传
  reasoningPolicy: 'never-send',
  // C 档：reasoningParam 未核实（无据）→ 保守 off（任何思考强度都不下发）
  // 估算（Qwen 系列 128k；「估算，可在设置覆盖」——settings.windowTokens 优先）
  contextWindowTokens: 128_000,
  // §1.3 表/§5.2 行 6：DashScope/Qwen 未提供 strict 字段（strictDefault 缺省即 undefined）
  maxTokensField: 'max_tokens',
  // A 档 max_input_tokens 白名单：仅 DashScope/Qwen 支持（笔记 §1，走 extra_body；
  // 请求值来自 settings.maxInputTokens → ChatRequest.maxInputTokens；
  // DeepSeek 官方无该参数——绝不发送，见 deepseek-vision.md §8）。
  maxInputTokensField: 'max_input_tokens',
  // 笔记 §5：Throttling 系 429 成因不同——频率类退避，配额/鉴权/系统类重试无意义
  retryableRules: [
    { kind: 'prefix', prefix: 'InternalError', retryable: true },
    { kind: 'prefix', prefix: 'SystemError', retryable: true },
    { kind: 'exact', value: 'ModelServiceFailed', retryable: true },
    { kind: 'exact', value: 'RequestTimeOut', retryable: true },
    { kind: 'prefix', prefix: 'Throttling.RateQuota', retryable: true },
    { kind: 'prefix', prefix: 'Throttling.LimitRequests', retryable: true },
    { kind: 'prefix', prefix: 'Throttling.BurstRate', retryable: true },
    { kind: 'exact', value: 'limit_burst_rate', retryable: true },
    { kind: 'prefix', prefix: 'Throttling.AllocationQuota', retryable: false },
    { kind: 'exact', value: 'insufficient_quota', retryable: false },
    { kind: 'exact', value: 'AllocationQuota.FreeTierOnly', retryable: false },
    { kind: 'prefix', prefix: 'InvalidApiKey', retryable: false },
    { kind: 'prefix', prefix: 'AccessDenied', retryable: false },
    { kind: 'exact', value: 'NOT AUTHORIZED', retryable: false },
  ],
};

const glm: ProviderPreset = {
  id: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
  defaultModel: 'glm-5.3',
  fixedSamplingParams: [],
  // C 档：reasoningParam 未核实（无据）→ 保守 off（任何思考强度都不下发）
  // 估算（GLM 128k；「估算，可在设置覆盖」——settings.windowTokens 优先）
  contextWindowTokens: 128_000,
  // §5.2 行 4：参考文档仅支持 auto；其余值在适配层即抛错，不发不可核实字段
  allowedToolChoices: ['auto'],
  // §3.3：clear_thinking 默认 true=清除历史轮 reasoning_content；Preserved 需显式 false
  reasoningPolicy: 'remove',
  clearThinking: true,
  // §1.3 表/§5.2 行 6：GLM 参考 schema 未提供 strict 字段（strictDefault 缺省即 undefined）
  maxTokensField: 'max_tokens',
  // §6.1 B：频率/服务端类可退避重试；周期配额/欠费/参数/鉴权类一律不重试
  retryableRules: [
    { kind: 'exact', value: '1200', retryable: true },
    { kind: 'exact', value: '1230', retryable: true },
    { kind: 'exact', value: '1234', retryable: true },
    { kind: 'exact', value: '1302', retryable: true },
    { kind: 'exact', value: '1305', retryable: true },
    { kind: 'numeric-range', from: 1313, to: 1321, retryable: false }, // 周月配额类
    { kind: 'numeric', value: 1308, retryable: false }, // 周期配额
    { kind: 'numeric', value: 1310, retryable: false },
    { kind: 'numeric', value: 1113, retryable: false }, // 欠费
    { kind: 'numeric', value: 1220, retryable: false },
    { kind: 'numeric', value: 1301, retryable: false }, // 内容安全
    { kind: 'numeric-range', from: 1210, to: 1215, retryable: false }, // 参数错误
    { kind: 'numeric', value: 1261, retryable: false }, // 参数/超长
    { kind: 'numeric', value: 1000, retryable: false }, // 鉴权类
    { kind: 'numeric', value: 1001, retryable: false },
    { kind: 'numeric', value: 1003, retryable: false },
    { kind: 'numeric', value: 1005, retryable: false },
  ],
};

const kimi: ProviderPreset = {
  id: 'kimi',
  baseUrl: 'https://api.moonshot.cn/v1',
  defaultModel: 'kimi-k3',
  // C 档：reasoningParam 未核实（无据）→ 保守 off（任何思考强度都不下发）
  // 估算（Kimi 128k；「估算，可在设置覆盖」——settings.windowTokens 优先）
  contextWindowTokens: 128_000,
  // §5.2 行 1/3/11：temperature/top_p/penalties 固定不可改，传其他值报错 → 一律剔除
  fixedSamplingParams: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'],
  // §1.3 表/§5.2 行 6：Kimi strict 缺省即 true（与 OpenAI/DeepSeek 相反）→ 注入 true 呈显
  strict: true,
  strictDefault: true,
  // §5.2 行 4：值域 auto/none/required/named。
  // 模型级例外：k2.6/k2.7-code 不支持 required（传了报错）——模型级限制由接入配置
  // 管控，默认模型 kimi-k3 不受限，预设值域保持全量。
  allowedToolChoices: ['none', 'auto', 'required', 'named'],
  // §3.3：务必将每一轮 assistant 的 reasoning_content 原样保留
  reasoningPolicy: 'keep',
  // §5.2 行 2：max_tokens 已弃用 → max_completion_tokens
  maxTokensField: 'max_completion_tokens',
  // §6.2：engine_overloaded 按 Retry-After 退避；rate_limit 退避；配额/安全/参数类不重试
  retryableRules: [
    { kind: 'exact', value: 'engine_overloaded_error', retryable: true },
    { kind: 'exact', value: 'rate_limit_reached_error', retryable: true },
    { kind: 'exact', value: 'server_error', retryable: true },
    { kind: 'exact', value: 'server_unavailable', retryable: true },
    { kind: 'exact', value: 'unexpected_output', retryable: true },
    { kind: 'exact', value: 'client_closed_request', retryable: true },
    { kind: 'exact', value: 'exceeded_current_quota_error', retryable: false },
    { kind: 'exact', value: 'content_filter', retryable: false },
    { kind: 'exact', value: 'invalid_request_error', retryable: false },
    { kind: 'exact', value: 'invalid_authentication_error', retryable: false },
    { kind: 'exact', value: 'incorrect_api_key_error', retryable: false },
    { kind: 'exact', value: 'permission_denied_error', retryable: false },
    { kind: 'exact', value: 'resource_not_found_error', retryable: false },
  ],
};

/** 五家 preset 只读表（按 id 取值；接入新供应商 = 此处加一行）。 */
export const PROVIDER_PRESETS: Readonly<Record<ProviderId, ProviderPreset>> = Object.freeze({
  openai,
  deepseek,
  dashscope,
  glm,
  kimi,
});

/** 按 id 取 preset；未知供应商直接抛错（S2 接缝纪律：不许静默把它当 OpenAI）。
 * 用 Object.hasOwn 防原型链污染：'constructor'/'toString' 等继承键一律当作未知 id。 */
export function getProviderPreset(id: string): ProviderPreset {
  if (!Object.hasOwn(PROVIDER_PRESETS, id)) {
    throw new ProviderAdapterError(
      `未知供应商「${id}」：仅支持 [${PROVIDER_IDS.join(', ')}]，不许静默当作 OpenAI 处理`,
    );
  }
  return PROVIDER_PRESETS[id as ProviderId];
}

/** 主默认（DeepSeek，ADR-0002）。 */
export function defaultProviderPreset(): ProviderPreset {
  // 主默认 preset 恒在表内；索引安全以 getProviderPreset 口径兜底
  return PROVIDER_PRESETS[DEFAULT_PROVIDER_ID]!;
}
