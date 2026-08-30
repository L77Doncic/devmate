/**
 * # context/project：两级压缩主实现（S4 接缝；ADR-0005「三级瀑布」的落地层）
 *
 * 纯变换、无 IO（唯一 IO 是注入的摘要器）；`project(events, opts)` 由会话事件流推导
 * 此刻发给模型的投影（CONTEXT「投影」）。压缩顺序硬性：先截断 → 再裁剪 → 最后摘要
 * （成本与信息损失同向递增，官方原话规定；ADR-0005）。只作用于投影：
 * 输入 events 永不被改动，append-only 事件流原样。
 *
 * 触发语义（§8 A-1/A-2 口径）：
 * - 截断：无条件（对单条超长工具输出，无阈值需求）；
 * - 裁剪：est > window×0.45（clearTrigger）且被裁者估算合计 ≥ clearAtLeastTokens（默认 8000）
 *   时；窗口未知时不以此做阈值计算（报告 §1.4/§8A），此时由调用方用 forceLevel 显式升级
 *   （「超限报错→压缩→重试」链；force 不再过清出门槛）；
 * - 摘要：est > window×0.72（compactTrigger）时；forceLevel=2 时必执行（穿透 maxLevel）；
 *   窗口未知一律不触发（需窗口判定，§8A）；摘要器以依赖注入（项目阶段可传 fake）。
 * - isOverBudget(projection, budget)?：窗口未知返回 null（不预判，由服务端 400 兜底）；
 *   已知则返回 boolean。
 */
import type { ChatMessage, ChatTool, ChatToolCall } from '../../shared/llm-types.js';
import type { SessionEvent } from '../../shared/session-types.js';
import {
  CLEAR_TRIGGER_RATIO,
  COMPACT_TRIGGER_RATIO,
  DEFAULT_CLEAR_AT_LEAST_TOKENS,
  DEFAULT_EXCLUDE_TOOLS,
  KEEP_GROUPS,
  MAX_IMAGE_WIRE_DATAURL_CHARS,
  MAX_OUTPUT_CHARS,
} from './constants.js';
import { estimateTokens } from './estimator.js';
import {
  buildPrunePlan,
  estimatePruneClearance,
  pruneToolResults,
  pruneWarningFor,
} from './prune.js';
import type { MessageItem, PruneResult } from './prune.js';
import { buildSummaryPrompt, extractSummaryContent } from './summary.js';
import { truncateToolOutput } from './truncate.js';

/** 压缩级：0=截断 / 1=+裁剪 / 2=+摘要（与 maxLevel/forceLevel 共用同一枚举）。 */
export type CompactionLevel = 0 | 1 | 2;

/** 摘要器：只接收 prompt（五段式）与待摘要的投影消息；由注入方执行 LLM 调用（fake 可测）。 */
export interface SummarizeRequest {
  /** 五段式摘要指令（含显式「禁止调用工具」与 <summary> 包裹要求）。 */
  prompt: string;
  /** 待摘要的投影消息（截断 + 裁剪完成后）。 */
  messages: ChatMessage[];
}

export type ConversationSummarizer = (request: SummarizeRequest) => string | Promise<string>;

/**
 * 附件引用展开器（ADR-0015 请求时展开）：ref → dataURL（服务端 AttachmentStore.resolve：
 * 读文件 + `data:<mime>;base64,` 组装——DeepSeek wire 协议仍旧 dataURL）；缺失 → null
 * = 该图降级文本提示（不 400）。零 IO 在本层：resolver 是调用方注入的接缝。
 */
export type AttachmentResolver = (ref: string) => Promise<string | null>;

export interface ProjectOptions {
  /**
   * 窗口 token 预算（来自 {provider}/{model} 覆盖或请求参数，例如 max_input_tokens——§1.4）。
   * 缺省 = 窗口未知：不做任何触发阈值计算（截断仍无条件执行；裁剪/摘要按报告口径退避）。
   */
  windowTokens?: number;
  /**
   * 附件 ref 展开（ADR-0015）：投影构建前把 user 事件 payload.images 的 ref 形条目展开为
   * dataURL（旧 url 形直通——兼容）；ref 缺失（resolver null/未注入）→ 该图降级为文本提示。
   * 展开后请求维度总量 ≤ MAX_IMAGE_WIRE_DATAURL_CHARS（40MiB）——超额图降级（诚实路径）。
   */
  resolveImageRef?: AttachmentResolver;
  /** 工具定义（仅用于估算结构开销；不被本模块作为 send 载荷处理）。 */
  tools?: readonly ChatTool[];
  /** 注入的摘要器；未注入且触发摘要时只产摘要请求（stats.summary.prompt），status='no-summarizer'。 */
  summarizer?: ConversationSummarizer;
  /** 永不裁剪的工具名集合（默认 DEFAULT_EXCLUDE_TOOLS：副作用型全集，§8 A-2）。 */
  excludeTools?: readonly string[];
  /**
   * 裁剪前对被裁者估算合计的最低清出量（token，§2.4 第 1 层 / §8 A-2「至少清出 ≥8k tokens」）：
   * 触顶但将被清出量不足时本层跳过（stats.pruned.status='insufficient-clearance'，
   * 跳过不视为一次压缩尝试，不得计入压缩防抖）。默认 DEFAULT_CLEAR_AT_LEAST_TOKENS = 8000；
   * 只约束阈值触发路径——force 显式升级（调用方已收到服务端超限证据）不重复过门槛。
   */
  clearAtLeastTokens?: number;
  /** 稳定系统前缀段（持久规则载体，压缩永不触碰；置于投影最前）。 */
  systemPrefix?: string;
  /** 最大压缩级：0=截断 / 1=+裁剪 / 2=+摘要。默认 2；force 穿透本上限（见 forceLevel）。 */
  maxLevel?: CompactionLevel;
  /**
   * 强制压缩级（跳过阈值判定；「超限报错 → 压缩 → 重试，上限 2 次」的显式升级链）。
   * forceLevel≥1 时裁剪必执行；forceLevel=2 时摘要必执行（穿透 maxLevel 上限）——
   * 摘要仍要求窗口已知（§8A）。
   */
  forceLevel?: CompactionLevel;
}

export interface TruncateStats {
  /** 被截断或二进制抑制（替换为 BINARY_OUTPUT_PLACEHOLDER）的工具输出条数。 */
  count: number;
  /** 截断阈值（字符）。 */
  maxChars: number;
}

export type PruneStatus =
  | 'not-triggered' // 未触顶（est ≤ clearTrigger 且未被 force），本层未进入判定
  | 'insufficient-clearance' // 触顶但将被清出量 < clearAtLeastTokens：本层跳过（§2.4 第 1 层）
  | 'pruned'; // 门槛通过（或 force 必执行），已执行替换

export interface PruneStats {
  /** 被替换为占位符的工具结果条数。 */
  count: number;
  /** 保留的最近组数（keep）。 */
  groupsKept: number;
  /** 副作用型豁免条数。 */
  excludedCount: number;
  /** 本层判定状态（见 PruneStatus）。 */
  status: PruneStatus;
  /**
   * 将被清出量的估算合计（按被裁者估算，token；进入门槛判定或执行时给出）。
   * 跳过不足门槛时注记：调用方不得将本状态计入压缩防抖（未发生压缩，不算一次尝试）。
   */
  clearedTokens?: number;
}

export type SummaryStatus =
  | 'not-triggered' // 未触顶（est ≤ compactTrigger 且未被 force）
  | 'window-unknown' // 触顶但窗口未知：不触发摘要（报告 §8A 口径）
  | 'no-summarizer' // 触顶但未注入摘要器：只产请求（prompt），摘要内容由调用方补齐
  | 'summarized'; // 已由注入的摘要器完成

export interface SummaryStats {
  status: SummaryStatus;
  /** 是否进入摘要判定（需要执行一层压缩）。 */
  triggered: boolean;
  /**
   * 五段式摘要请求：仅 no-summarizer / summarized 状态时有（这两层已构造 request）；
   * window-unknown 分支被窗口判定挡住、不会构造请求，故无此字段。
   */
  prompt?: string;
  /** 摘要内容（去 <summary> 标签后；仅 summarized）。 */
  content?: string;
  /** 摘要前投影估算（token，近似）。 */
  tokensBefore?: number;
  /** 摘要后投影估算（token，近似）。 */
  tokensAfter?: number;
}

export interface ProjectionStats {
  /** 最终投影消息的估算 token 数（近似；L2 启发式 ±5%~±15%，§1.2）。 */
  estimatedTokens: number;
  /**
   * 附件 ref 展开期被降级的图片数（ADR-0015：ref 缺失 / 展开后超 40MiB 请求维度——
   * 该图未发送并以文本提示并入消息；旧 url 形直通不计）。仅最后一次样本有值。
   */
  degradedImages?: number;
  truncated: TruncateStats;
  pruned: PruneStats;
  summary: SummaryStats;
}

export interface Projection {
  /** 送模型的最终消息形状（OpenAI 兼容 ChatMessage；S1 客户端序列化）。 */
  messages: ChatMessage[];
  /**
   * 压缩过程产生的一次性提示（§2.3 准则 2：清理前提醒「即将清理 X 工具历史结果，
   * 如仍需请自行落盘」）。本实现以投影上的警告列表承载（不插消息，避免打乱既有消息序号）；
   * 无警告时为空数组。
   */
  warnings: string[];
  stats: ProjectionStats;
}

/** 事件流中的压缩记录（由调用方追加写入：kind 'event'、type 'compaction'、data.summary）。 */
interface CompactionInfo {
  summary: string;
  /** 压缩事件在完整事件数组中的下标（其后的事件为压缩后新产生）。 */
  index: number;
}

/** 取最近一次压缩记录（会话恢复时按事件流重建投影：以该摘要为前缀继续推导）。 */
function extractLatestCompaction(events: readonly SessionEvent[]): CompactionInfo | null {
  let found: CompactionInfo | null = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event !== undefined && event.kind === 'event' && event.payload.type === 'compaction') {
      const summary = event.payload.data?.summary;
      if (typeof summary === 'string') {
        found = { summary, index: i };
      }
    }
  }
  return found;
}

/** 调用 ID → 工具名（配对表；供裁剪豁免判定）。 */
function buildCallNameMap(events: readonly SessionEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const event of events) {
    if (event.kind === 'assistant') {
      for (const tc of event.payload.toolCalls) {
        map.set(tc.id, tc.name);
      }
    }
  }
  return map;
}

/**
 * 事件 → 投影消息项（第 0 层截断在此应用，返回截断计数）。
 * 映射规则：system/user/assistant/tool 一一入消息；reasoning 不进请求（S2 回传策略负责，
 * CONTEXT「Reasoning Content 策略」）；event 不入（compaction 由 extractLatestCompaction 单独处理）。
 */
function buildItems(
  events: readonly SessionEvent[],
  callNames: ReadonlyMap<string, string>,
  excludeTools: readonly string[],
): { items: MessageItem[]; truncatedCount: number } {
  const excluded = new Set(excludeTools);
  let truncatedCount = 0;
  let currentGroup = 0;
  const items: MessageItem[] = [];
  for (const event of events) {
    switch (event.kind) {
      case 'system':
        items.push({
          message: { role: 'system', content: event.payload.content },
          prunable: false,
        });
        break;
      case 'user': {
        // 多模态（ADR-0015）：payload.images 存在 → 内容块数组（text + image_url；
        // 官方形状 deepseek-vision.md §1；宽高仅在部分级供估算，不进 wire）。
        // 纯文本（无 images）→ 经典字符串形态不变。
        const text = event.payload.content;
        const images = event.payload.images;
        const message =
          images === undefined || images.length === 0
            ? { role: 'user' as const, content: text }
            : {
                role: 'user' as const,
                content: [
                  ...(text === '' ? [] : [{ type: 'text' as const, text }]),
                  ...images.map((img) => ({
                    type: 'image_url' as const,
                    // materializeImages 保证到这里全部是展开后的 url 形（ref 已还原/降级）
                    image_url: { url: (img as { url: string }).url },
                    ...(img.width !== undefined ? { width: img.width } : {}),
                    ...(img.height !== undefined ? { height: img.height } : {}),
                  })),
                ],
              };
        items.push({ message, prunable: false });
        break;
      }
      case 'assistant': {
        if (event.payload.toolCalls.length > 0) {
          currentGroup += 1;
        }
        const toolCalls: ChatToolCall[] = event.payload.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
        items.push({
          message: {
            role: 'assistant',
            content: event.payload.content.length > 0 ? event.payload.content : null,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          },
          groupIndex: currentGroup,
          prunable: false,
        });
        break;
      }
      case 'tool': {
        const content = event.payload.content;
        const truncated = truncateToolOutput(content);
        if (truncated !== content) {
          truncatedCount += 1;
        }
        const toolName = callNames.get(event.payload.toolCallId);
        const item: MessageItem = {
          message: { role: 'tool', content: truncated, toolCallId: event.payload.toolCallId },
          prunable: toolName !== undefined && !excluded.has(toolName),
        };
        if (toolName !== undefined) {
          item.toolName = toolName;
          item.groupIndex = currentGroup;
        }
        items.push(item);
        break;
      }
      case 'reasoning':
      case 'event':
        break;
    }
  }
  return { items, truncatedCount };
}

export function isOverBudget(projection: Projection, budgetTokens?: number): boolean | null {
  if (budgetTokens === undefined) {
    return null; // 窗口未知：不预判（不以此做阈值计算，§1.4）——由「超限报错 → 压缩 → 重试」兜底
  }
  return projection.stats.estimatedTokens > budgetTokens;
}

// ---------------------------------------------------------------------------
// 附件 ref 展开（ADR-0015 请求时展开；纯变换——resolver 接缝注入，本层无 IO）
// ---------------------------------------------------------------------------

/** ref 缺失时并入消息文本的说明（诚实路径：模型知道「图没进来」——避免凭空想象图内容）。 */
export function attachmentMissingNote(ref: string): string {
  return `\n（图像未能处理：附件不存在（${ref}），图片未发送。）`;
}

/** 展开后超请求维度限额（40MiB）被降级的说明（N 张图未发送）。 */
export function attachmentOversizeNote(droppedCount: number): string {
  const mb = Math.round(MAX_IMAGE_WIRE_DATAURL_CHARS / 1024 / 1024);
  return `\n（图像未能处理：${droppedCount} 张图片超过展开后单请求体积上限（${mb}MiB），未发送。）`;
}

/** 形如 {ref,...} 的图片条目 → 展开后的 dataURL 条目（{url,...}；投影层直接消费）。 */
interface ResolvedImageEntry {
  url: string;
  width?: number;
  height?: number;
}

/**
 * 展开预检：逐 user 事件把 ref 条目换成 dataURL（缓存按唯一 ref——同图多消息只读一次；
 * 旧 url 形直通）；ref 缺失（resolver null/未注入）→ 该图降级（消息文本并入说明）；
 * 展开后全请求 dataURL 字符总量 > MAX_IMAGE_WIRE_DATAURL_CHARS（20×20MiB 最坏 400MiB
 * 情形）→ 保序前缀保留，超额图降级。文件缺失 → 文本提示，绝不 400、绝不发坏 URL。
 */
async function materializeImages(
  events: readonly SessionEvent[],
  resolver: AttachmentResolver | undefined,
): Promise<{ events: SessionEvent[]; degradedImages: number }> {
  const cache = new Map<string, string | null>();
  let wireChars = 0;
  let degradedImages = 0;
  const out: SessionEvent[] = [];
  for (const event of events) {
    if (event.kind !== 'user') {
      out.push(event);
      continue;
    }
    const images = event.payload.images;
    if (images === undefined || images.length === 0) {
      out.push(event);
      continue;
    }
    const kept: ResolvedImageEntry[] = [];
    const missingRefs: string[] = [];
    let oversizeCount = 0;
    let rebuilt = false; // 恒为 true 当事件含 ref（展开后的 url 形必须替换原条目——缺省路径见下）
    for (const img of images) {
      let dataUrl: string;
      if ('ref' in img) {
        rebuilt = true;
        // ref 形：resolver 展开（缓存按唯一 ref——同图多消息只读一次）；缺失 → 降级
        const ref = img.ref;
        if (!cache.has(ref)) {
          cache.set(ref, resolver !== undefined ? await resolver(ref) : null);
        }
        const resolved = cache.get(ref) ?? null;
        if (resolved === null) {
          missingRefs.push(ref);
          degradedImages += 1;
          continue;
        }
        dataUrl = resolved;
      } else if ('url' in img) {
        dataUrl = img.url; // 旧 dataURL 形：直通（兼容旧事件——回放渲染不经网络）
      } else {
        continue; // 形状异常（源已被服务端校验——此处防御）→ 跳过
      }
      if (wireChars + dataUrl.length > MAX_IMAGE_WIRE_DATAURL_CHARS) {
        oversizeCount += 1;
        degradedImages += 1;
        continue;
      }
      wireChars += dataUrl.length;
      const entry: ResolvedImageEntry = { url: dataUrl };
      if (img.width !== undefined) entry.width = img.width;
      if (img.height !== undefined) entry.height = img.height;
      kept.push(entry);
    }
    if (!rebuilt) {
      out.push(event); // 纯旧 dataURL 事件：原样直通（不含 ref——无需展开）
      continue;
    }
    const notes = missingRefs.map((ref) => attachmentMissingNote(ref));
    if (oversizeCount > 0) notes.push(attachmentOversizeNote(oversizeCount));
    out.push({
      ...event,
      payload: { ...event.payload, content: event.payload.content + notes.join(''), images: kept },
    });
  }
  return { events: out, degradedImages };
}

/**
 * 推导投影：固定顺序 截断（无条件）→ 裁剪（clearTrigger 触发或 force）→ 摘要（compactTrigger 触发或 force）。
 * 摘要只在窗口已知时触发（§8A：摘要需要窗口判定）；摘要器缺省时只产请求。
 * 不抛出运行时异常（窗口未知是正常输入，不是错误）。
 */
export async function project(
  events: readonly SessionEvent[],
  opts: ProjectOptions = {},
): Promise<Projection> {
  const {
    windowTokens,
    tools,
    summarizer,
    excludeTools = DEFAULT_EXCLUDE_TOOLS,
    clearAtLeastTokens = DEFAULT_CLEAR_AT_LEAST_TOKENS,
    systemPrefix,
    maxLevel = 2,
    forceLevel = 0,
  } = opts;

  const clearTrigger =
    windowTokens !== undefined ? Math.floor(windowTokens * CLEAR_TRIGGER_RATIO) : undefined;
  const compactTrigger =
    windowTokens !== undefined ? Math.floor(windowTokens * COMPACT_TRIGGER_RATIO) : undefined;

  const compaction = extractLatestCompaction(events);
  const liveEvents = compaction === null ? events : events.slice(compaction.index + 1);
  const callNames = buildCallNameMap(events);

  // 附件 ref 展开（ADR-0015）：live 事件先展开（ref → dataURL；缺失/超限 → 文本提示），
  // 投影/估算/适配器全部消费展开后的 url 形——DeepSeek wire 协议不变。
  const materialized = await materializeImages(liveEvents, opts.resolveImageRef);
  const resolvedEvents = materialized.events;

  const prefixMessage: ChatMessage | null =
    systemPrefix !== undefined ? { role: 'system', content: systemPrefix } : null;
  const replayMessage: ChatMessage | null =
    compaction !== null ? { role: 'system', content: compaction.summary } : null;

  const buildMessages = (items: readonly MessageItem[]): ChatMessage[] => {
    const out: ChatMessage[] = [];
    if (prefixMessage !== null) out.push(prefixMessage);
    if (replayMessage !== null) out.push(replayMessage);
    for (const item of items) out.push(item.message);
    return out;
  };

  const estimate = (items: readonly MessageItem[]): number =>
    estimateTokens(buildMessages(items), tools).tokens;

  const built = buildItems(resolvedEvents, callNames, excludeTools);
  const est0 = estimate(built.items);

  // 第 1 层：组包期裁剪（clearTrigger 触顶 + 至少清出 clearAtLeastTokens，§2.4 第 1 层 / §8 A-2）
  let pruned: PruneResult = {
    items: built.items,
    prunedCount: 0,
    excludedCount: 0,
    groupsKept: KEEP_GROUPS,
    prunedToolNames: [],
  };
  let pruneStatus: PruneStatus = 'not-triggered';
  let clearedTokens: number | undefined;
  const prunePlan = buildPrunePlan(built.items, excludeTools);
  if (forceLevel >= 1) {
    // force：显式升级（调用方已收到服务端超限证据），必执行——不再过清出门槛
    clearedTokens = estimatePruneClearance(prunePlan);
    pruned = pruneToolResults(built.items, excludeTools, prunePlan);
    pruneStatus = 'pruned';
  } else if (maxLevel >= 1 && clearTrigger !== undefined && est0 > clearTrigger) {
    clearedTokens = estimatePruneClearance(prunePlan);
    if (clearedTokens >= clearAtLeastTokens) {
      pruned = pruneToolResults(built.items, excludeTools, prunePlan);
      pruneStatus = 'pruned';
    } else {
      // 清出量不足：本层跳过（不替换；stats 注明 insufficient-clearance）。
      // 跳过未发生压缩——调用方不得将其计入压缩防抖（不算一次压缩尝试）。
      pruned = { ...pruned, excludedCount: prunePlan.excludedCount }; // 豁免计数照实上报
      pruneStatus = 'insufficient-clearance';
    }
  }
  const warnings: string[] = [];
  if (pruned.prunedCount > 0) {
    warnings.push(pruneWarningFor(pruned.prunedToolNames, pruned.prunedCount));
  }
  const est1 = estimate(pruned.items);

  // 第 2 层：触顶期摘要（固定最后执行：先截断→再裁剪→再摘要）
  // force 穿透：forceLevel=2 时摘要必执行，不受 maxLevel < 2 上限约束（与选项注释一致）。
  const summaryWanted =
    forceLevel === 2 || (maxLevel >= 2 && compactTrigger !== undefined && est1 > compactTrigger);

  let messages = buildMessages(pruned.items);
  let summary: SummaryStats = { status: 'not-triggered', triggered: false }; // 估算 < compactTrigger（或窗口未知未请求）
  if (summaryWanted) {
    if (windowTokens === undefined) {
      // 需窗口判定：不触发摘要（报告 §8A；由「超限报错 → 压缩 → 重试」兜底）
      summary = { status: 'window-unknown', triggered: true, tokensBefore: est1 };
    } else if (summarizer === undefined) {
      // 未注入摘要器：只产摘要请求（prompt），内容由调用方补齐
      summary = {
        status: 'no-summarizer',
        triggered: true,
        prompt: buildSummaryPrompt(messages),
        tokensBefore: est1,
      };
    } else {
      const prompt = buildSummaryPrompt(messages);
      const raw = await summarizer({ prompt, messages });
      const content = extractSummaryContent(raw);
      const summaryMessage: ChatMessage = { role: 'system', content };
      const summarized: ChatMessage[] = [];
      if (prefixMessage !== null) summarized.push(prefixMessage);
      summarized.push(summaryMessage);
      const tokensAfter = estimateTokens(summarized, tools).tokens;
      summary = {
        status: 'summarized',
        triggered: true,
        prompt,
        content,
        tokensBefore: est1,
        tokensAfter,
      };
      messages = summarized;
    }
  }

  const estimatedTokens = estimateTokens(messages, tools).tokens;

  return {
    messages,
    warnings,
    stats: {
      estimatedTokens,
      degradedImages: materialized.degradedImages,
      truncated: { count: built.truncatedCount, maxChars: MAX_OUTPUT_CHARS },
      pruned: {
        count: pruned.prunedCount,
        groupsKept: pruned.groupsKept,
        excludedCount: pruned.excludedCount,
        status: pruneStatus,
        ...(clearedTokens !== undefined ? { clearedTokens } : {}),
      },
      summary,
    },
  };
}
