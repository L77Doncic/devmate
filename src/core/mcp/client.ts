/**
 * # core/mcp/client：McpClient——stdio 服务器客户端（CTO 定稿语义第 2 条）
 *
 * connectMcpServer(spec)：spawn（transport）→ 握手（initialize：协议版本
 * MCP_PROTOCOL_VERSION（2024-11-05）或服务器回退任意版本；+ notifications/initialized）
 * → 就绪客户端。握手失败/超时（缺省 DEFAULT_HANDSHAKE_TIMEOUT_MS=10s）→ 传输关闭 +
 * McpError('transport-error')（服务不可用——由调用方按普通结果归一）。
 *
 * - tools()：tools/list → {name, description, inputSchema}（带缓存；list 只发一次）。
 * - call(name, args, timeoutMs=DEFAULT_CALL_TIMEOUT_MS=120000)：tools/call →
 *   {content 块原样（type/text 类型化），isError 透传}；一层错误判型：
 *     timeout          单请求超时（传输存活，后续调用可继续）
 *     transport-error  进程退出/传输已死（服务不可用）
 *     protocol-error   逃逸到 JSON-RPC error（方法不在 / 参数非法…），
 *                      但 error 内容含 unknown tool/tool not found → unknown-tool
 *   content 数组的 text 拼接与非文本标记不在此层（归 registry 的 render）。
 * - 同一服务器串行化：tools()/call 全部经一个简单 mutex 链（并发度 1——
 *   一次一个在飞请求，服务器观察顺序即发起顺序）。
 * - close()：SIGTERM 优雅 + 2s SIGKILL 兜底（transport 实现）；幂等。
 *   isDead()：传输已死（exit/spawn 失败/协议错误/closed）——registry 判重连。
 *
 * 形状兼容：McpServerSpec 与 ui/server 的 McpServerConfig({name,command,args,enabled})
 * 结构一致（core 不反向依赖 ui；接线层直接透传）。
 * 重新导出 McpError/McpErrorKind（错误判型单一来源 transport）。
 */
import type { JsonSchema } from '../loop/types.js';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  MCP_PROTOCOL_VERSION,
  McpError,
  spawnMcpTransport,
  type McpRpcResponse,
} from './transport.js';

export { McpError } from './transport.js';
export type { McpErrorKind } from './transport.js';

export { DEFAULT_HANDSHAKE_TIMEOUT_MS, MCP_PROTOCOL_VERSION } from './transport.js';

// ---------------------------------------------------------------------------
// 公开类型与常量
// ---------------------------------------------------------------------------

/** MCP 服务器配置（= ui/server 的 McpServerConfig 结构：接线层直接透传）。 */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

/** tools/call 默认超时（ms；模型工具调用按此交付，registry 可覆写）。 */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** tools/list 返回的工具定义（inputSchema 原样；缺失由 registry 兜底 {type:'object'}）。 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
}

/** MCP content 块（text 有 text；其余类型原样透传——渲染归 registry）。 */
export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** tools/call 结果（content 块 + 服务器侧 isError 标记）。 */
export interface McpCallResult {
  content: McpContentBlock[];
  isError: boolean;
}

export interface McpClient {
  readonly name: string;
  /** tools/list（结果缓存）；timeoutMs 缺省 DEFAULT_CALL_TIMEOUT_MS。 */
  tools(timeoutMs?: number): Promise<McpToolDef[]>;
  /** tools/call；超时/传输/协议错误一律拒绝（判型见模块头）。 */
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult>;
  /** SIGTERM 优雅 + 2s SIGKILL 兜底；幂等。 */
  close(): Promise<void>;
  /** 传输已死（exit/spawn 失败/协议错误/closed）。 */
  isDead(): boolean;
}

export interface ConnectMcpServerOptions {
  /** 握手超时（ms；缺省 10s——超时/失败按服务不可用归一）。 */
  handshakeTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// 连接与客户端实现
// ---------------------------------------------------------------------------

/** 连接 + 握手；失败/超时 → 传输已关闭 + McpError（不返回半成品客户端）。 */
export async function connectMcpServer(
  spec: McpServerSpec,
  options: ConnectMcpServerOptions = {},
): Promise<McpClient> {
  const transport = spawnMcpTransport({ command: spec.command, args: spec.args });
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  try {
    const resp = await transport.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'devmate', version: '0.1.1' },
      },
      handshakeTimeoutMs,
    );
    const result = resp.result;
    if (typeof result !== 'object' || result === null) {
      throw new McpError('protocol-error', 'initialize result is not an object');
    }
    // 服务器回退：接受其应答的任何协议版本（不回编不回显，交给服务端惯例）
    const serverVersion = (result as Record<string, unknown>)['protocolVersion'];
    if (serverVersion !== undefined && typeof serverVersion !== 'string') {
      throw new McpError('protocol-error', 'initialize result has a non-string protocolVersion');
    }
    transport.notify('notifications/initialized', {});
  } catch (err) {
    await transport.close(); // 无残留：握手失败路径子进程必须已清理
    if (err instanceof McpError) {
      if (err.kind === 'timeout') {
        throw new McpError(
          'transport-error',
          `mcp handshake timed out after ${handshakeTimeoutMs}ms`,
        );
      }
      throw err;
    }
    throw err instanceof Error ? err : new McpError('transport-error', String(err));
  }

  /** 客户端私有态：mutex 链（tools() 与 call 共享——一次一个在飞请求）。 */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(() => fn());
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  let toolsCache: McpToolDef[] | null = null;

  return {
    name: spec.name,
    async tools(timeoutMs): Promise<McpToolDef[]> {
      return serial(async () => {
        if (toolsCache !== null) return toolsCache.map((def) => ({ ...def }));
        const resp = await transport.request(
          'tools/list',
          {},
          timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        );
        const defs = parseToolList(resp);
        toolsCache = defs;
        return defs.map((def) => ({ ...def }));
      });
    },
    call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult> {
      return serial(async () => {
        const resp = await transport.request(
          'tools/call',
          { name, arguments: args },
          timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        );
        return classifyCallResponse(resp);
      });
    },
    async close(): Promise<void> {
      await transport.close();
    },
    isDead(): boolean {
      return transport.isDead();
    },
  };
}

/** tools/list 应答解析（防御性：坏条目丢弃；inputSchema 原样）。 */
function parseToolList(resp: McpRpcResponse): McpToolDef[] {
  const result = resp.result;
  if (typeof result !== 'object' || result === null) {
    throw new McpError('protocol-error', 'tools/list result is not an object');
  }
  const raw = (result as Record<string, unknown>)['tools'];
  if (!Array.isArray(raw)) return [];
  const defs: McpToolDef[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string' || name === '') continue;
    const description = record['description'];
    const schema = record['inputSchema'];
    defs.push({
      name,
      description: typeof description === 'string' ? description : '',
      ...(schema !== undefined ? { inputSchema: schema as JsonSchema } : {}),
    });
  }
  return defs;
}

/** tools/call 应答判定：JSON-RPC error → unknown-tool/protocol-error；成功 → 块/标记。 */
function classifyCallResponse(resp: McpRpcResponse): McpCallResult {
  if (resp.error !== undefined) {
    const err = resp.error;
    const dataText = typeof err.data === 'string' ? err.data : JSON.stringify(err.data ?? '');
    if (
      /unknown tool/i.test(err.message) ||
      /tool not found/i.test(err.message) ||
      /unknown tool/i.test(dataText)
    ) {
      throw new McpError('unknown-tool', err.message);
    }
    throw new McpError('protocol-error', `JSON-RPC error from server: ${err.message}`);
  }
  const result = resp.result;
  if (typeof result !== 'object' || result === null) {
    throw new McpError('protocol-error', 'tools/call result is not an object');
  }
  const rawContent = (result as Record<string, unknown>)['content'];
  const blocks: McpContentBlock[] = Array.isArray(rawContent)
    ? rawContent.filter(
        (block): block is McpContentBlock =>
          typeof block === 'object' &&
          block !== null &&
          typeof (block as Record<string, unknown>)['type'] === 'string',
      )
    : [];
  return { content: blocks, isError: (result as Record<string, unknown>)['isError'] === true };
}
