/**
 * # models：网关模型清单探测（三源取窗 · 网关层）
 *
 * 上下文窗口三源取窗：用户显式覆盖（windowTokens）> 网关探测（GET {baseUrl}/models）
 * > 供应商 preset 估算（contextWindowTokens）。本模块只实现**网关源**：探一次
 * `GET {baseUrl}/models`，对与当前模型名匹配的条目做窗口字段宽容嗅探。
 *
 * 诚实纪律：OpenAI 兼容 protocol **没有**窗口字段标准——嗅探命中才报告
 * （source:'gateway'），字段全缺 → source:'none' + detail 说明协议无标准字段，
 * 绝不猜数。合理域 [1, 1_000_000]：域外值视为字段不可信（normalizeWindow → null）。
 *
 * 契约：
 * - 零依赖（只消费原生 fetch/AbortController；fetchImpl 为测试接缝）；
 * - 无 apiKey（含空串）→ 不发起任何请求，直接 {window:null, source:'none'}；
 * - 任何失败（网络拒绝/超时/4xx/5xx/非 JSON/无清单/无字段）一律静默收敛为
 *   {window:null, source:'none', detail}——调用方按相应 detail 回退 preset，不惊扰；
 * - 超时 3s（AbortController；timeoutMs 可注入快测）；timer.unref（不拖住进程退出）；
 * - baseUrl 归一：已是 `.../v1`（大小写宽容）则不重复叠；缺 `/v1` 的网关按其
 *   OpenAI 兼容面补 `/v1`（DeepSeek/OpenAI 同款语义）。
 */

/** 窗口字段嗅探键（宽容集；按此顺序取第一个可归一值——确定性优先级）。 */
export const WINDOW_FIELD_KEYS: readonly string[] = [
  'context_length',
  'context_window',
  'contextWindow',
  'max_input',
  'max_input_tokens',
  'max_context',
];

/** 窗口值合理域上限（token；超过视为异常值 → null，不取巨型平台特殊值）。 */
export const WINDOW_MAX = 1_000_000;

/** 缺省探测超时（ms）。 */
export const DEFAULT_WINDOW_TIMEOUT_MS = 3_000;

/**
 * 窗口值归一（纯函数）：可接受 number 或数字字符串（网关 JSON 两种常见形态）；
 * 必须是有限正整数且 ≤ WINDOW_MAX；其余（NaN/Infinity/负数/0/小数/非数字字符串/
 * 非 number|string 类型）→ null。不抛错。
 */
export function normalizeWindow(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 1 || n > WINDOW_MAX) return null;
  return n;
}

/**
 * models 端点归一（纯函数）：去尾斜杠；已是 `.../v1` 则不叠（大小写宽容）；
 * 缺 `/v1` 的网关按兼容面补 `/v1`（DeepSeek 官方同款：base 无 /v1 时 /models
 * 与 /v1/models 均有效——统一补 /v1 与 OpenAI 参考形态一致）。
 */
export function modelsEndpointOf(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

export interface DiscoverWindowParams {
  /** 供应商/网关 base_url（含或不含 /v1；内部归一一次）。 */
  baseUrl: string;
  /** 网关 API key；undefined/空串 → 不发起请求（本地端点）。 */
  apiKey: string | undefined;
  /** 当前模型名（settings.model）：条目匹配键（id/model/name，大小写不敏感）。 */
  model?: string;
  /** 测试接缝：替换全局 fetch（真实装配不传 → 全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 探测超时（ms；缺省 DEFAULT_WINDOW_TIMEOUT_MS；测试注入小值快测）。 */
  timeoutMs?: number;
}

/** 来源：'gateway' = 从网关清单嗅探出字段；'none' = 未探得（含全部失败形态）。 */
export type DiscoverWindowSource = 'gateway' | 'none';

export interface DiscoverWindowResult {
  /** 探得的窗口（token）；未探得 → null。 */
  window: number | null;
  source: DiscoverWindowSource;
  /** 说明（命中字段/失败原因；给 GET /api/settings 的 windowDetail 注来源）。 */
  detail?: string;
}

/** 静默失败收敛（network/HTTP/解析/无字段共用入口）。 */
function none(detail: string): DiscoverWindowResult {
  return { window: null, source: 'none', detail };
}

/**
 * 探测一次（幂等；不超 3s；绝不 throw——任何失败按 none 收敛）。
 * 解析口径：
 * - 清单载体：响应体数组本身 / `data` 数组（OpenAI/OpenRouter 形态）/ `models` 数组
 *   （Ollama 形态）；其余 → none；
 * - 条目匹配：当前模型名（大小写不敏感）对比条目 id/model/name；命中 → **只**嗅探
 *   该条目（裁决：以当前模型名优先）；
 * - 无匹配 → 按序取**第一条**含窗口字段的条目（裁决：其次任意一条）；
 * - 字段嗅探：WINDOW_FIELD_KEYS 按序（大小写不敏感，顶层先、单层子对象兜底），
 *   第一个 normalizeWindow 命中即采纳；全部缺失 → none（协议无标准字段，诚实）。
 */
export async function discoverWindow(params: DiscoverWindowParams): Promise<DiscoverWindowResult> {
  const { baseUrl, apiKey, model, fetchImpl, timeoutMs } = params;
  if (apiKey === undefined || apiKey === '') {
    return none('无 apiKey，跳过探测（本地端点/未配置密钥）');
  }

  const fetcher = fetchImpl ?? fetch;
  const endpoint = modelsEndpointOf(baseUrl);
  const timeout = timeoutMs ?? DEFAULT_WINDOW_TIMEOUT_MS;
  const controller = new AbortController();
  // unref：探测不拖住进程退出（悬死网关不阻塞 CLI 关闭）
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } catch (err) {
    const detail = controller.signal.aborted
      ? `GET ${endpoint} 超时（${timeout}ms）`
      : `GET ${endpoint} 失败：${err instanceof Error ? err.message : String(err)}`;
    return none(detail);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return none(`GET ${endpoint} HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return none('响应体不是合法 JSON');
  }

  const entries = entriesOf(body);
  if (entries === null) {
    return none('响应体无模型清单（data/models 数组缺失）');
  }

  const modelName = model?.toLowerCase();
  let matched: Record<string, unknown> | undefined;
  let matchedKey: string | undefined;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    for (const key of ['id', 'model', 'name']) {
      const value = rec[key];
      if (
        typeof value === 'string' &&
        modelName !== undefined &&
        value.toLowerCase() === modelName
      ) {
        matched = rec;
        matchedKey = key;
        break;
      }
    }
    if (matched !== undefined) break;
  }

  if (matched !== undefined) {
    const hit = sniffWindow(matched);
    if (hit !== null) {
      return {
        window: hit.value,
        source: 'gateway',
        detail: `命中模型「${String(matched[matchedKey!])}」（字段 ${hit.key}=${hit.value}）`,
      };
    }
    return none('命中模型条目无窗口字段（协议无标准字段，不猜数）');
  }

  // 无匹配：取第一条含窗口字段的条目（其次任意一条）
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const hit = sniffWindow(rec);
    if (hit !== null) {
      const id =
        typeof rec.id === 'string' ? rec.id : typeof rec.model === 'string' ? rec.model : undefined;
      return {
        window: hit.value,
        source: 'gateway',
        detail: `未命中模型名，取首条含窗口字段条目（id=${id ?? '?'}，字段 ${hit.key}=${hit.value}）`,
      };
    }
  }
  return none('条目均无窗口字段（协议无标准字段，不猜数）');
}

/** 模型清单提取（数组 / data / models；其余 → null）。 */
function entriesOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as Record<string, unknown>;
  if (Array.isArray(rec.data)) return rec.data;
  if (Array.isArray(rec.models)) return rec.models;
  return null;
}

/** 大小写不敏感取字段。 */
function fieldValueOf(rec: Record<string, unknown>, key: string): unknown {
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === key.toLowerCase()) return v;
  }
  return undefined;
}

/** 单条目嗅探：按 WINDOW_FIELD_KEYS 顺序取第一个可归一值；未命中 → null。 */
function sniffWindow(rec: Record<string, unknown>): { key: string; value: number } | null {
  // 条目自身的对象子字段兜底（常见形态：{id, model:{context_length}}）
  const children: Array<Record<string, unknown>> = [];
  for (const value of Object.values(rec)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      children.push(value as Record<string, unknown>);
    }
  }
  for (const key of WINDOW_FIELD_KEYS) {
    let value = fieldValueOf(rec, key);
    if (value === undefined) {
      for (const child of children) {
        value = fieldValueOf(child, key);
        if (value !== undefined) break;
      }
    }
    if (value === undefined) continue;
    const normalized = normalizeWindow(value);
    if (normalized !== null) return { key, value: normalized };
  }
  return null;
}
