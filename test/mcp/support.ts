/**
 * # test/mcp/support：MCP 客户端测试脚手架——假 stdio 服务器（fixture-server.mjs）
 *
 * 真进程策略：每个 fixture 由宿主以 process.execPath 启动一个真实 node 进程
 * （test/mcp/fixture-server.mjs，行定界 JSON-RPC；事件簿写 --log 文件——
 * stdout 只走协议，观察永不污染协议流）。客户端全程经 src/core/mcp 的
 * transport/client（真实 spawn + 握手），registry 级用例用假 McpClient。
 * 每个测试结束必须 close()（afterEach 兜底——进程无残留是断言之一）。
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServerSpec } from '../../src/core/mcp/client.js';

/** fixture 脚本绝对路径（宿主 vitest 进程启动用）。 */
export function fixturePath(): string {
  return fileURLToPath(new URL('./fixture-server.mjs', import.meta.url));
}

let logCounter = 0;

/** 唯一日志文件路径（每 fixture 一个；直写 tmpdir，无残留目录）。 */
export function mkLogPath(): string {
  logCounter += 1;
  return join(tmpdir(), `devmate-mcp-fix-${process.pid}-${logCounter}-${Date.now()}.jsonl`);
}

/**
 * 组装 spawn 形态的 McpServerSpec（command = process.execPath，args 为 argv——
 * 与真实服务器同形态：数组传参、永不 shell）。
 */
export function fixtureSpec(
  cfg: Record<string, string | number | boolean> = {},
  name = 'fixture',
  log = mkLogPath(),
): McpServerSpec {
  const args: string[] = [fixturePath()];
  for (const [key, value] of Object.entries(cfg)) {
    if (value === true) args.push(`--${key}`);
    else args.push(`--${key}=${value}`);
  }
  if (cfg['log'] === undefined) args.push(`--log=${log}`);
  return { name, command: process.execPath, args, enabled: true };
}

export interface FixtureLogEntry {
  ev: string;
  pid?: number;
  id?: number;
  protocolVersion?: string;
  toolNames?: string[];
  name?: string;
  args?: unknown;
  method?: string;
  error?: string;
  line?: string;
}

/** 读日志全量条目（缺文件/未开始 → []）。 */
export function readLog(logPath: string): FixtureLogEntry[] {
  try {
    const content = fetchLogContent(logPath);
    if (content === '') return [];
    return content
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as FixtureLogEntry);
  } catch {
    return [];
  }
}

function fetchLogContent(logPath: string): string {
  return readFileSync(logPath, 'utf8');
}

/** 轮询等待日志命中谓词（fixture 异步写入；超时抛错）。 */
export async function waitForLog(
  logPath: string,
  predicate: (entries: FixtureLogEntry[]) => boolean,
  timeoutMs = 5000,
): Promise<FixtureLogEntry[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = readLog(logPath);
    if (predicate(entries)) return entries;
    if (Date.now() > deadline) {
      throw new Error(
        `fixture log did not reach expected state within ${timeoutMs}ms; last entries: ` +
          JSON.stringify(entries.slice(-20)),
      );
    }
    await sleep(10);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待 pid 从系统消失（close 清理断言：进程无残留）。 */
export async function waitForPidGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH：已不存在
    }
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

/** 等 fixture 把 start 事件（含 pid）写进日志。 */
export async function waitForStart(logPath: string): Promise<number> {
  const entries = await waitForLog(logPath, (list) => list.some((entry) => entry.ev === 'start'));
  const pid = entries.find((entry) => entry.ev === 'start')?.pid;
  if (pid === undefined || pid === 0) throw new Error('fixture start event has no pid');
  return pid;
}
