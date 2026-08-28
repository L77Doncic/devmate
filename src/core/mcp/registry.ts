/**
 * # core/mcp/registry：MCP 工具面注册（CTO 定稿语义第 3/4/5 条）
 *
 * createMcpTools({clients}) → Tool[]：每服务器每工具一个 Tool——
 *   name        = mcp_<server>_<toolname>（分节清洗：非 [A-Za-z0-9_] → _；
 *                `my-server.my tool` → `mcp_my_server_my_tool`——清洗防名歧义；
 *                清洗碰撞（a-b 与 a.b 同面）→ defineRegistry 按 name 后写覆盖）
 *   description = 工具描述 + 换行「（源自 MCP 服务器 <server>）」
 *   parameters  = inputSchema 原样；缺失 → {type:'object'}
 * execute(call) 永不 throw（失败是普通消息，CONTEXT「错误回注」）：
 *   - 参数校验：call.arguments 必须 JSON 解析为对象；失败 → invalid-arguments 回注
 *     （content 为 errorContentJson 载荷——loop/tools 单一构造实现）。
 *   - 取客户端（ensureClient）：null（工厂未启用/不可用）→ mcp-server-unavailable；
 *   - 成功：content 渲染（text 拼接 + 非 text → [非文本内容]，块间 \n）→ 20k 截断
 *     （DEFAULT_MCP_CONTENT_TRUNCATE_CHARS；附缺省字样标记——注意力成本）；
 *   - 服务器 isError → content-error（content 仍是渲染文本）；ok:false 普通失败。
 *   - 客户端判型 → 错误分层：
 *       unknown-tool → tool-not-found         （服务器回「未知工具」）
 *       timeout      → mcp-call-timeout
 *       protocol-error → mcp-protocol-error
 *       transport-error → mcp-server-unavailable（并进入负缓存）
 *   服务器未启用（mcp-server-not-enabled）：构建期工厂返回 null/不在 map → 该服务器
 *   不产生任何工具（list 过滤）——工具面枚举期即剔除，不存在 execute 期命中。
 *
 * 懒连接与负缓存（第 4 条）：
 * - 构建期对每个服务器发现有向连接（tools/list 必须——工具名/描述/schema 只有连上才
 *   可枚举；list 超时 toolsTimeoutMs 缺省 10s，坏服务器不堵死构建）。连线失败 →
 *   该服务器本次不产生工具（工厂结果不缓存：execute 期仍可重连）。
 * - execute 期复用已连客户端；客户端已死（isDead）→ 记为一次失败：负缓存
 *   negativeCacheMs（缺省 60s）内不再调工厂（简单时间戳）；到期后自动重连
 *   （工厂 = 重建连接，新 spawn）。
 * - 服务器崩溃（exit）后调用 → mcp-server-unavailable + 负缓存生效（工厂不再被调）。
 *
 * ## 接线契约（已接线：见 src/ui/server/deps.ts 的 McpLauncher；首个接入 anysearch）
 * ui/server 已有 deps.mcpServers（{name,command,args,enabled}）= McpServerSpec 结构。
 * 建议 McpLauncher（deps 传入）：
 *   {
 *     clients(): Map<name, () => Promise<McpClient | null>>;  // enabled=false → null
 *     dispose(): Promise<void>;                                // close 全部客户端
 *   }
 * 装配：tools.push(...await createMcpTools({ clients: launcher.clients() }));
 * launcher.factory = (name) => spec.enabled ? connectMcpServer(spec) : () => null；
 * 同一 name 永远同一 spec——execute 重连也以该 spec 重建。
 */
import { errorContentJson } from '../loop/tools.js';
import type { JsonSchema, Tool, ToolExecutionContext, ToolResult } from '../loop/types.js';
import type { ToolCall } from '../../shared/session-types.js';
import { McpError, type McpClient, type McpContentBlock, type McpToolDef } from './client.js';

// ---------------------------------------------------------------------------
// 公开常量与类型
// ---------------------------------------------------------------------------

/** 连接失败负缓存（ms）：窗口内不重连（简单时间戳）。 */
export const DEFAULT_MCP_NEGATIVE_CACHE_MS = 60_000;

/** 工具结果 content 截断上限（字符；超限保留前段 + 缺省字样标记——注意力成本）。 */
export const DEFAULT_MCP_CONTENT_TRUNCATE_CHARS = 20_000;

/** 构建期 tools/list 发现超时（ms；坏服务器不堵死工具面构建）。 */
export const DEFAULT_MCP_TOOLS_TIMEOUT_MS = 10_000;

export type McpClientFactory = () => Promise<McpClient | null>;

export interface CreateMcpToolsOptions {
  /** name → 客户端工厂（未启用/不可用返回 null）。 */
  clients: Map<string, McpClientFactory>;
  /** 负缓存窗口（ms；缺省 60s）。 */
  negativeCacheMs?: number;
  /** 时钟注入（负缓存与失败时间戳；测试快进用）。 */
  now?: () => number;
  /** tools/call 超时（ms；缺省 120s = DEFAULT_CALL_TIMEOUT_MS）。 */
  callTimeoutMs?: number;
  /** 构建期 tools/list 超时（ms；缺省 10s）。 */
  toolsTimeoutMs?: number;
}

/** 服务器私有态：客户端 + 失败时间戳（负缓存判据）。 */
interface ServerState {
  server: string;
  factory: McpClientFactory;
  client: McpClient | null;
  failedAt: number | null;
}

// ---------------------------------------------------------------------------
// 命名清洗与 content 渲染（纯函数；跨宿主可测）
// ---------------------------------------------------------------------------

/** 工具面分节清洗：非 [A-Za-z0-9_] → _（含 `-`/`.`/空格——防名歧义）。 */
export function sanitizeMcpPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_]/g, '_');
}

/** 完整工具名：mcp_<server>_<toolname>（分节清洗后拼接）。 */
export function mcpToolFullName(server: string, tool: string): string {
  return `mcp_${sanitizeMcpPart(server)}_${sanitizeMcpPart(tool)}`;
}

/** content 块渲染：text 原样拼接（块间 \n）；其余类型标记 [非文本内容]。 */
export function renderMcpContent(blocks: readonly McpContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const text = block['text'];
    if (block.type === 'text' && typeof text === 'string') parts.push(text);
    else parts.push('[非文本内容]');
  }
  return parts.join('\n');
}

/** 截断：保留前 limit 字符 + 缺省字样标记（超限才加）。 */
export function truncateMcpContent(
  text: string,
  limit = DEFAULT_MCP_CONTENT_TRUNCATE_CHARS,
): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `${text.slice(0, limit)}\n--- [mcp content truncated: ${limit} char limit; ${dropped} chars dropped] ---`;
}

// ---------------------------------------------------------------------------
// 工具面装配
// ---------------------------------------------------------------------------

/** 装配 MCP 工具面：每服务器每工具一个 Tool（失败是普通消息，全部不 throw）。 */
export async function createMcpTools(options: CreateMcpToolsOptions): Promise<Tool[]> {
  const negativeCacheMs = options.negativeCacheMs ?? DEFAULT_MCP_NEGATIVE_CACHE_MS;
  const now = options.now ?? Date.now;
  const toolsTimeoutMs = options.toolsTimeoutMs ?? DEFAULT_MCP_TOOLS_TIMEOUT_MS;
  const tools: Tool[] = [];
  for (const [server, factory] of options.clients) {
    const state: ServerState = { server, factory, client: null, failedAt: null };
    // 构建期 enum 连接（tools/list；失败/负缓存 → 本次无工具）
    const defs = await ensureTools(state, now, negativeCacheMs, toolsTimeoutMs);
    for (const def of defs) {
      tools.push(makeTool(state, def, options, now, negativeCacheMs));
    }
  }
  return tools;
}

/** 有向发现：取客户端 + tools/list（失败 → 负缓存时间戳并返回空清单）。 */
async function ensureTools(
  state: ServerState,
  now: () => number,
  negativeCacheMs: number,
  listTimeoutMs: number,
): Promise<McpToolDef[]> {
  const client = await ensureClient(state, now, negativeCacheMs);
  if (client === null) return [];
  try {
    return await client.tools(listTimeoutMs);
  } catch {
    // list_tools 失败同连接失败：负缓存（execute 期以重连补救）
    state.client = null;
    state.failedAt = now();
    return [];
  }
}

/**
 * 取客户端（懒连接 + 负缓存）：
 * - 负缓存窗口内（failedAt 距今 < negativeCacheMs）→ null（不碰工厂）；
 * - 已连且活着 → 复用；
 * - 已连但死了 → 记为一次失败（failedAt=now）并给 null——本次不做重连尝试；
 * - 窗口外（或从未连）→ 调工厂：null/抛错 → failedAt=now；成功 → 缓存并保留。
 */
async function ensureClient(
  state: ServerState,
  now: () => number,
  negativeCacheMs: number,
): Promise<McpClient | null> {
  const nowValue = now();
  if (state.failedAt !== null && nowValue - state.failedAt < negativeCacheMs) return null;
  const existing = state.client;
  if (existing !== null) {
    if (!existing.isDead()) return existing;
    state.client = null;
    if (state.failedAt === null) {
      state.failedAt = nowValue;
      return null;
    }
    // failedAt 已存在且窗口已过期：落空进工厂（窗口外重连）
  }
  let client: McpClient | null;
  try {
    client = await state.factory();
  } catch {
    client = null;
  }
  if (client === null) {
    state.failedAt = nowValue;
    return null;
  }
  state.client = client;
  state.failedAt = null;
  return client;
}

function makeTool(
  state: ServerState,
  def: { name: string; description: string; inputSchema?: JsonSchema },
  options: CreateMcpToolsOptions,
  now: () => number,
  negativeCacheMs: number,
): Tool {
  return {
    name: mcpToolFullName(state.server, def.name),
    description:
      `${def.description}${def.description === '' ? '' : '\n'}` +
      `（源自 MCP 服务器 ${state.server}）`,
    parameters: def.inputSchema ?? { type: 'object' },
    async execute(call: ToolCall, _ctx: ToolExecutionContext): Promise<ToolResult> {
      return executeMcpTool(state, def, call, options, now, negativeCacheMs);
    },
  };
}

/** 单次执行：参数校验 → 取客户端 → 调 call → 渲染（截断）→ 错误归一（永不 throw）。 */
async function executeMcpTool(
  state: ServerState,
  def: { name: string },
  call: ToolCall,
  options: CreateMcpToolsOptions,
  now: () => number,
  negativeCacheMs: number,
): Promise<ToolResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch (err) {
    return invalidArgsResult(
      state.server,
      def.name,
      `tool arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalidArgsResult(state.server, def.name, 'tool arguments must be a JSON object');
  }

  const client = await ensureClient(state, now, negativeCacheMs);
  if (client === null) {
    return failResult(
      'mcp-server-unavailable',
      `MCP server "${state.server}" is unavailable: connection attempt failed` +
        `(negative-cached for ${negativeCacheMs}ms)`,
      'Check that the MCP server is enabled and its command works; the agent will retry after the cache window.',
    );
  }

  try {
    // 未配置 callTimeoutMs → 交给客户端缺省（120s）；显式 0 也无意义（正向超时）
    const result = await client.call(
      def.name,
      parsed as Record<string, unknown>,
      options.callTimeoutMs,
    );
    const text = truncateMcpContent(renderMcpContent(result.content));
    if (result.isError) {
      // 服务器侧错误结果：content 照常渲染、整体按失败回注
      return { ok: false, content: text, error: { type: 'content-error', message: text } };
    }
    return { ok: true, content: text };
  } catch (err) {
    if (err instanceof McpError) {
      if (err.kind === 'transport-error' || err.kind === 'protocol-error') {
        // 传输已死/协议断裂：客户端作废 + 负缓存（下次调用窗口外重建）
        state.client = null;
        if (state.failedAt === null) state.failedAt = now();
      }
      return failResult(mcpRegistryErrorType(err.kind), err.message);
    }
    return failResult('tool-error', err instanceof Error ? err.message : String(err));
  }
}

/** 客户端判型 → 注册表错误分层（unknown-tool→tool-not-found 等；见模块头表）。 */
function mcpRegistryErrorType(
  kind: 'timeout' | 'transport-error' | 'protocol-error' | 'unknown-tool',
): string {
  switch (kind) {
    case 'timeout':
      return 'mcp-call-timeout';
    case 'transport-error':
      return 'mcp-server-unavailable';
    case 'protocol-error':
      return 'mcp-protocol-error';
    case 'unknown-tool':
      return 'tool-not-found';
  }
}

function invalidArgsResult(server: string, tool: string, message: string): ToolResult {
  return failResult(
    'invalid-arguments',
    `mcp tool "${mcpToolFullName(server, tool)}": ${message}`,
    'The MCP tool arguments must be a valid JSON object matching the tool schema.',
  );
}

/** 失败载荷恒为合法 JSON 回注形状（errorContentJson 单一构造实现）。 */
function failResult(type: string, message: string, humanHint?: string): ToolResult {
  return {
    ok: false,
    content: errorContentJson({
      type,
      message,
      ...(humanHint !== undefined ? { human_hint: humanHint } : {}),
    }),
    error: { type, message },
  };
}
