/**
 * # test/fs-tools/support：文件工具测试脚手架——内存假 jail + 临时工作区
 *
 * 假 jail 语义（S9 实现与 S7 接缝之间的替身；接口面以 src/core/jail/index.ts 为准）：
 * - workspace = root，outside = 兄弟目录：root 之下全放行，之外一律拦截；
 * - 列表式阻断：blocked 前缀（绝对路径，resolve 归一）任一命中即拦，不区分内外；
 * - 判定结果按 S9 的 JailDecision 形状：放行 {allowed:true}；拦截 {allowed:false, reason}，
 *   reason 回填「path outside workspace: <path>」（mode 不参与判定，读取语义由工具面负责）；
 * - 符号链接双端判定：checkPath 先 realpath（不存在路径回退「最深存在祖先 realpath
 *   + 词法拼接」）再比对——链接自身在 root 内、目标解析后指向 root 外 ⇒ 目标端拦截，
 *   模拟 ADR-0013「allow 须两端命中、deny 任一命中即拦」。
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { Jail, JailDecision, JailMode } from '../../src/core/jail/index.js';
import type { Tool, ToolResult } from '../../src/core/loop/types.js';
import { createFsTools } from '../../src/core/tools/fs.js';
import type { FsToolContext } from '../../src/core/tools/types.js';
import type { ToolCall } from '../../src/shared/session-types.js';

export class FakeJail implements Jail {
  readonly workspaceRoot: string;
  readonly extraRoots: readonly string[] = [];
  readonly root: string;
  private readonly blocked: string[];

  constructor(root: string, blocked: string[] = []) {
    this.root = resolve(root);
    this.workspaceRoot = this.root;
    this.blocked = blocked.map((b) => resolve(b));
  }

  /** 全放行模式：验证「工具不自行裁决、jail 是唯一闸口」（S9 对照面上不需要的探针）。 */
  static allowAll(): Jail {
    return {
      workspaceRoot: '',
      extraRoots: [],
      async checkPath(): Promise<JailDecision> {
        return { allowed: true };
      },
      async checkRedirect(): Promise<JailDecision> {
        return { allowed: true };
      },
    };
  }

  async checkPath(path: string, _mode: JailMode): Promise<JailDecision> {
    const real = resolveLoose(path);
    for (const b of this.blocked) {
      if (real === b || real.startsWith(b + sep)) {
        return { allowed: false, reason: `path outside workspace: ${path}` };
      }
    }
    if (real === this.root || real.startsWith(this.root + sep)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `path outside workspace: ${path}` };
  }

  /** S9 语义：src 按读、dst 按写；任一被拦即拦（fs 工具无重定向调用点，此处只满足接口形状）。 */
  async checkRedirect(src: string, dst: string): Promise<JailDecision> {
    const srcD = await this.checkPath(src, 'read');
    if (!srcD.allowed) return srcD;
    return this.checkPath(dst, 'write');
  }
}

/** 词法 + realpath 混合解析：最深存在的祖先取 realpath，其下按词法拼接（模拟 S9 归一化）。 */
function resolveLoose(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(resolveLoose(parent), basename(p));
  }
}

export interface FsWorkspace {
  root: string;
  outside: string;
  ctx: FsToolContext;
  tools: Map<string, Tool>;
}

const created: string[] = [];

export function makeWorkspace(blocked?: (root: string) => string[]): FsWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'devmate-ws-'));
  const outside = mkdtempSync(join(tmpdir(), 'devmate-out-'));
  created.push(root, outside);
  const ctx: FsToolContext = {
    sessionId: 'test-session',
    jail: new FakeJail(root, blocked ? blocked(root) : []),
  };
  const tools = new Map(createFsTools(ctx).map((t) => [t.name, t]));
  return { root, outside, ctx, tools };
}

export function cleanupWorkspaces(): void {
  for (const dir of created.splice(0)) {
    // win32：文件句柄/杀进程时序造成的 EBUSY（windows CI 实测：20000 条目清理
    // hook 超时的次要成因）→ 重试屈从
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

export function putFile(fileAbs: string, content: string | Buffer): void {
  mkdirSync(dirname(fileAbs), { recursive: true });
  writeFileSync(fileAbs, content);
}

export function putDir(dirAbs: string): void {
  mkdirSync(dirAbs, { recursive: true });
}

export async function runTool(
  ws: FsWorkspace,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = ws.tools.get(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const call: ToolCall = { id: 'call_1', name, arguments: JSON.stringify(args) };
  return tool.execute(call, ws.ctx);
}

/** 把结果 content 解析为回注载荷（错误时恒为合法 JSON，§4.4）。 */
export function payloadOf(result: ToolResult): { ok: boolean; error: Record<string, unknown> } {
  const payload = JSON.parse(result.content) as { ok: boolean; error: Record<string, unknown> };
  return payload;
}
