/**
 * # core/mcp：MCP 客户端（stdio JSON-RPC；零运行时依赖，node:child_process）
 *
 * 分层（CTO 定稿语义 1/2/3）：
 * - transport：spawn + 行消息 + 请求 id 路由 + 错误判型 + close（SIGTERM/2s SIGKILL）；
 * - client：connectMcpServer（握手）+ tools/call + 服务器内串行化 + isDead；
 * - registry：createMcpTools（Tool[] 工具面，20k 截断/非文本标记/负缓存）。
 * 服务端接线（下一小步）：deps.mcpServers → McpLauncher（见 registry.ts 头注契约）。
 */
export { connectMcpServer, DEFAULT_CALL_TIMEOUT_MS } from './client.js';
export type {
  ConnectMcpServerOptions,
  McpCallResult,
  McpClient,
  McpContentBlock,
  McpServerSpec,
  McpToolDef,
} from './client.js';
export { McpError, DEFAULT_HANDSHAKE_TIMEOUT_MS, MCP_PROTOCOL_VERSION } from './client.js';
export type { McpErrorKind } from './client.js';
export {
  createMcpTools,
  mcpToolFullName,
  renderMcpContent,
  sanitizeMcpPart,
  truncateMcpContent,
  DEFAULT_MCP_CONTENT_TRUNCATE_CHARS,
  DEFAULT_MCP_NEGATIVE_CACHE_MS,
  DEFAULT_MCP_TOOLS_TIMEOUT_MS,
} from './registry.js';
export type { CreateMcpToolsOptions, McpClientFactory } from './registry.js';
export { spawnMcpTransport, buildMcpEnv, DEFAULT_KILL_GRACE_MS } from './transport.js';
export type {
  ExitInfo,
  McpJsonRpcTransport,
  McpRpcResponse,
  McpTransportOptions,
} from './transport.js';
