/**
 * # core/mcp/transport：stdio JSON-RPC 传输层（零运行时依赖；node:child_process 允许）
 *
 * 职责（CTO 定稿语义第 1 条）：
 * - spawn(command, args, {stdio:'pipe', env:{...process.env, NO_COLOR:'1',
 *   MCP_LOG_LEVEL:'error'}})——**永不 shell**：数组传参，命令与参数原样；
 *   额外的 env 覆盖（options.env）叠在其上（测试注入探测用）。
 * - 行消息协议：\n 定界（写入端以 '\n'；读取端剥 \r——容忍 CRLF）；空行忽略。
 *   非 JSON 行（或非对象消息）→ protocol-error 判型（pending 全部拒绝、传输视为死）。
 * - 请求 id 单调分配（1 起）；应答按 id 路由回对应 pending（乱序/迟达不串线）；
 *   id 不在 pending 的消息静默忽略（迟到的过期应答/服务器通知）。
 * - 判型（McpError.kind）：
 *     timeout          单请求超时（传输存活，后续请求继续）
 *     transport-error  spawn 失败/进程退出/管道写失败/已关闭（传输死亡）
 *     protocol-error   收到非 JSON 行/非对象消息（传输死亡）
 *     unknown-tool     由 client 层按应答 error 内容判型（见 client.ts）
 * - close()：**进程组** SIGTERM 优雅（POSIX detached：kill(-pid) 覆盖 npm→sh→node 整树——
 *   VT-2 修复，避免中介进程先死、服务器成为孤儿）+ DEFAULT_KILL_GRACE_MS（2s）后组
 *   SIGKILL 兜底；stdin end（EOF 信号）一并发出；幂等（并发/重复 close 共享同一次等待）。
 *   pending 全部拒绝。
 *
 * 握手（initialize + notifications/initialized）在 client.ts 的 connectMcpServer：
 * 本层提供 request(id 路由)/notify 原语，协议编排（版本协商）归 client。
 */
import { spawn, type ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// 常量与公开类型
// ---------------------------------------------------------------------------

/** MCP 协议版本（2024-11-05）；服务器回退其它版本时 client 层接受。 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** 握手超时（ms；连接失败/超时 → 服务不可用判型）。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** close() 优雅等待时长（ms）：SIGTERM 后超时 → SIGKILL 兜底。 */
export const DEFAULT_KILL_GRACE_MS = 2000;

/** 传输/调用错误判型（MCP 失败是普通消息，不击穿工具队列——ADR-0010 口径）。 */
export type McpErrorKind = 'timeout' | 'transport-error' | 'protocol-error' | 'unknown-tool';

export class McpError extends Error {
  readonly kind: McpErrorKind;

  constructor(kind: McpErrorKind, message: string) {
    super(message);
    this.name = 'McpError';
    this.kind = kind;
  }
}

export interface McpTransportOptions {
  /** 服务器可执行文件（数组传参——永不经过 shell）。 */
  command: string;
  args?: string[];
  /** 追加在 {NO_COLOR, MCP_LOG_LEVEL} 之后的 env 覆盖（叠加继承环境）。 */
  env?: Record<string, string>;
}

/** JSON-RPC 应答（result/error 二择一；成功应答 error 缺省）。 */
export interface McpRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

/** 环境装配（独立纯函数：env 注入是可测契约——NO_COLOR/MCP_LOG_LEVEL 必达）。 */
export function buildMcpEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', MCP_LOG_LEVEL: 'error', ...extra };
}

/** spawn 并包装行定界 JSON-RPC 传输（client.connectMcpServer 的底座）。 */
export function spawnMcpTransport(options: McpTransportOptions): McpJsonRpcTransport {
  return new McpJsonRpcTransport(options);
}

// ---------------------------------------------------------------------------
// 传输实现
// ---------------------------------------------------------------------------

interface PendingEntry {
  subject: string;
  resolve(value: McpRpcResponse): void;
  reject(err: McpError): void;
}

export class McpJsonRpcTransport {
  private readonly child: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private exit: ExitInfo | null = null;
  private deadReason: string | null = null;
  private spawnFail = false;
  /** close() 缓存（幂等：并发/重复 close 共享一次收尾）。 */
  private closing: Promise<void> | null = null;

  constructor(options: McpTransportOptions) {
    this.child = spawn(options.command, options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildMcpEnv(options.env),
      // VT-2 修复 b：POSIX 上独立进程组（detached）——close() 按【组】终止
      // （kill(-pid) 命中 npm→sh→node 整棵树；只杀直接子进程会让中介（npm/sh）先死、
      // 真正的服务器（node）成为孤儿常驻——实测 mcp-remote 组常驻 11h+）。
      // Windows 无进程组语义：仍按直接子进程止（平台能力边界）。
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.feed(chunk));
    // stderr 排空（MCP 服务器日志走 stderr；不消费会背压堵死服务器）
    this.child.stderr?.on('data', () => undefined);
    this.child.stdin?.on('error', (err) => {
      this.die(new McpError('transport-error', `transport stdin error: ${err.message}`));
    });
    this.child.once('error', (err) => {
      this.spawnFail = true;
      this.die(new McpError('transport-error', `transport spawn failed: ${err.message}`));
    });
    this.child.once('exit', (code, signal) => {
      this.exit = { code, signal };
      this.die(
        new McpError(
          'transport-error',
          `transport exited (code=${String(code)}${signal !== null ? `, signal=${signal}` : ''})`,
        ),
      );
    });
  }

  /** 传输已死亡（spawn 失败/退出/协议错误/已关闭）：isDead 供 client 层判重连。 */
  isDead(): boolean {
    return this.deadReason !== null;
  }

  /** 子进程退出信息；未退出为 null。 */
  exitInfo(): ExitInfo | null {
    return this.exit;
  }

  /**
   * 发送一次 JSON-RPC 请求并等对应 id 的应答（路由到 pending）。
   * 传输死亡（exit/spawn 失败/管道断/closed）→ transport-error；超时 → timeout。
   */
  request(method: string, params: unknown, timeoutMs: number): Promise<McpRpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const subject = `"${method}" (id ${id})`;
    const immediate = this.deadReason;
    if (immediate !== null) {
      return Promise.reject(
        new McpError('transport-error', `${subject}: transport is closed (${immediate})`),
      );
    }
    return new Promise<McpRpcResponse>((resolve, reject) => {
      let settled = false;
      const entry: PendingEntry = {
        subject,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(value);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        entry.reject(new McpError('timeout', `${subject} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, entry);
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        if (this.deadReason !== null) {
          entry.reject(
            new McpError('transport-error', `${subject}: transport is closed (${this.deadReason})`),
          );
          return;
        }
        this.child.stdin?.write(`${line}\n`, (err?: Error | null) => {
          if (err !== undefined && err !== null) {
            entry.reject(
              new McpError('transport-error', `${subject}: write failed: ${err.message}`),
            );
          }
        });
      } catch (err) {
        entry.reject(
          new McpError(
            'transport-error',
            `${subject}: write failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  /** 发送通知（不期待应答；写入失败按传输死亡处理——stdin error 兜底）。 */
  notify(method: string, params: unknown): void {
    if (this.deadReason !== null) return; // 通知尽力而为：已死静默丢弃
    try {
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, method, params })}\n`);
    } catch {
      // stdin error 处理器会把传输置死并拒绝 pending
    }
  }

  /**
   * close()：stdin end + SIGTERM → 2s 内未退出 → SIGKILL；幂等。
   * 在飞请求全部以 transport-error 拒绝（调用方按「服务不可用」归一）。
   */
  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closing = this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.die(new McpError('transport-error', 'transport closed'));
    try {
      this.child.stdin?.end();
    } catch {
      // 已关闭的 stdin：忽略
    }
    if (this.spawnFail) return; // spawn 失败：无子进程可收
    if (this.exit === null) {
      // VT-2 修复 b：组信号优先（npm→sh→node 整棵进程树）；组杀失败（已退出/回收/
      // Windows）回退直接子进程信号。
      if (!this.signalGroup('SIGTERM')) this.signalChild('SIGTERM');
      if (this.exit === null && !(await waitExit(this.child, DEFAULT_KILL_GRACE_MS))) {
        if (!this.signalGroup('SIGKILL')) this.signalChild('SIGKILL');
        await waitExit(this.child, 1000);
      }
    }
    this.die(new McpError('transport-error', 'transport closed'));
  }

  /** 进程组信号（POSIX detached 子进程组：kill(-pid, signal)）；不适用/失败 → false。 */
  private signalGroup(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    const pid = this.child.pid;
    if (pid === undefined || process.platform === 'win32') return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** 直接子进程信号兜底（组杀失败/Windows）；失败静默（可能已不存在）。 */
  private signalChild(signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      this.child.kill(signal);
    } catch {
      // 可能已 PID 重置/不存在：SIGKILL 再试已由调用方保证
    }
  }

  /** 行定界解析：\n 定界 + \r 剥除（CRLF 容忍）；空行忽略；非 JSON → protocol-error。 */
  private feed(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.die(
          new McpError('protocol-error', `non-JSON line from server: ${line.slice(0, 120)}`),
        );
        continue;
      }
      if (typeof msg !== 'object' || msg === null) {
        this.die(
          new McpError('protocol-error', `non-object message from server: ${line.slice(0, 120)}`),
        );
        continue;
      }
      const id = (msg as Record<string, unknown>)['id'];
      if (typeof id !== 'number') continue; // 无 id（通知）/异常形态：忽略
      const entry = this.pending.get(id);
      if (entry === undefined) continue; // 迟到的过期应答：忽略
      entry.resolve(msg as unknown as McpRpcResponse);
    }
  }

  /** 传输置死 + 拒绝全部 pending（幂等：只一次生效，原因锚定首个）。 */
  private die(err: McpError): void {
    if (this.deadReason !== null) return;
    this.deadReason = err.message;
    for (const entry of [...this.pending.values()])
      entry.reject(new McpError(err.kind, `${entry.subject}: ${err.message}`));
    this.pending.clear();
  }
}

/** 等待子进程被回收（exit 事件/状态可见）；超时返回 false。 */
function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}
