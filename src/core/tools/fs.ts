/**
 * # tools/fs：内置文件工具集（接缝 S7）
 *
 * 六个 Tool（ADR-0008 工具面 7 个中的六个文件面）：read_file / write_file /
 * edit_file / list_dir / glob / grep；run_command 属 S10（常驻 Shell），不在本模块。
 *
 * 契约（与 loop/tools.ts 对齐）：
 * - 每个工具 execute(call) → ToolResult；失败是普通消息（CONTEXT「错误回注」）：
 *   ok:false 且 content 为合法 JSON，顶层 {ok:false, error:{type,message,human_hint?}}
 *   （回注载荷形状复用 loop/tools 的 errorContentJson——单一来源，research §4.4）。
 *   execute 签名按 loop/types 的 Tool.execute(call, ctx)——本层 ctx 于 createFsTools
 *   构造期闭包绑定（jail 只能来自构造面），execute 忽略 defineRegistry 注入的 call 侧
 *   执行上下文；协调契约见 makeTool 的注。
 * - 路径安全（ADR-0013「工作区监狱」）：任何底层操作前先经 ctx.jail.checkPath(p, mode)
 *   放行（读入 'read'、写入 'write'，mode 按工具语义选）；S9 的真实判定（realpath 归一化 +
 *   符号链接两端同检 + 额外目录登记）不在本层，本层只保证「先问后动、拒则回报
 *   path-outside-workspace」——jail 契约（jail/index）缺省「deny 必带拒因」，
 *   本层对判定层异常按拦截处理（fail-closed，兜底拒因 'jail check failed'），
 *   绝不自行放宽或绕过 jail。
 * - 输出容量：本层为采集阶段防内存爆炸做字节硬上限 MAX_COLLECTION_BYTES（§8B
 *   「输出字节硬上限（采集阶段）」机制；研究默认表 256KB 面向 shell 采集面，
 *   本层文件线先落 64KB——与投影层 10k 字符截断的分工：前者是采集缓冲、后者是
 *   送入上下文前的截断，不是同一次输出的两次截断）。read_file 超限时头尾各半 +
 *   显式省略标记；grep 对超限文件跳过并明说；edit_file 对超限文件拒绝并建议整写。
 *   条目上限 MAX_COLLECTION_ENTRIES（遍历爆炸防线）超限时 list_dir/glob 输出附显式截断标记。
 * - 编辑格式：edit_file 采用 SEARCH/REPLACE 精确匹配（aider diff 方言，ARCH §4.2）：
 *   空 SEARCH 拒绝、无匹配 / 多处匹配都不猜（无普适最优格式，本工具只保证精确性与
 *   可执行的失败信息）；降级链（重试 / write_file 整写）是模型侧决策。
 * - 二进制判定复用 S4（context/truncate 的 isLikelyBinary）；read_file 的占位符用
 *   文件语境文案（FILE_BINARY_PLACEHOLDER——文件内容不是「命令输出」，不复用
 *   BINARY_OUTPUT_PLACEHOLDER 的 shell 口吻）；read_file 对大文件采样判定
 *   （头尾采样段，中间省略区不扫描——注明）。
 * - 工具锚点统一（P1-1）：六个工具的 path/pattern 参数——相对路径一律先按
 *   「会话工作区根」（ctx.jail.workspaceRoot——createSessionTools 的 per-session jail 根）
 *   resolve 成绝对路径（workspacePath），绝对路径原样；**同一解析值**同时喂给
 *   jail 判定与实际 I/O、并用于错误/结果消息。锚定语义与 jail 一致（jail 本就按
 *   workspaceRoot 解析相对路径）、与 run_command 初始 cwd 同根——绝不锚进程 cwd
 *   （cwd≠workspace 时「写入成功却找不到/写到别处」：jail 判的是工作区根下路径，
 *   而裸相对路径的 I/O 在进程 cwd 执行——P1-1 修复即消除该分裂）。
 */
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { basename, dirname, join, resolve } from 'node:path';

import type { ToolCall } from '../../shared/session-types.js';
import { isLikelyBinary } from '../context/truncate.js';
import { errorContentJson } from '../loop/tools.js';
import type { JsonSchema, Tool, ToolResult } from '../loop/types.js';
import type { JailDecision, JailMode } from '../jail/index.js';
import type { FsToolContext } from './types.js';

// ---------------------------------------------------------------------------
// 常量与通用工具
// ---------------------------------------------------------------------------

/** 采集阶段字节缓冲上限（防内存爆炸；§8B 机制、数值见模块头注）。 */
export const MAX_COLLECTION_BYTES = 64 * 1024;

/** 目录条目收集上限（防遍历爆炸；超限时结果带显式截断标记——不静默）。 */
export const MAX_COLLECTION_ENTRIES = 20_000;

/**
 * 文件语境二进制占位符（read_file 专用）：文件内容不是「上个命令的输出」——不复用
 * truncate.ts 的 shell 口吻 BINARY_OUTPUT_PLACEHOLDER（「your last command…」对文件是误导）。
 */
export const FILE_BINARY_PLACEHOLDER =
  'The file contains binary data; the content has been replaced with this marker ' +
  '(binary or non-text content). The content is not shown here; use a text file instead.';

/** 采集截断的显式省略标记（字节数与文件大小明示——model 可据此收窄）。 */
export function collectionElideMarker(elidedBytes: number, totalBytes: number): string {
  return (
    `\n\n--- ${elidedBytes} bytes elided (file size ${totalBytes} bytes; ` +
    `collection buffer capped at ${MAX_COLLECTION_BYTES} bytes) ---\n\n` +
    '(middle content omitted; read the omitted part with a targeted tool: grep for a term, ' +
    'list_dir to find files, or a shell head/tail)\n'
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** 失败结果构造：content 恒为合法 JSON（§4.4 载荷；human_hint 可选）。 */
export function failToolResult(type: string, message: string, humanHint?: string): ToolResult {
  const payload: { type: string; message: string; human_hint?: string } = { type, message };
  if (humanHint !== undefined) payload.human_hint = humanHint;
  return { ok: false, content: errorContentJson(payload), error: { type, message } };
}

function okResult(content: string): ToolResult {
  return { ok: true, content };
}

/**
 * jail 放行判定（S9 接口：JailDecision，mode 按工具语义选——读入 'read'、写入 'write'）。
 * 正常路径 deny 恒带拒因（jail/index 契约「deny 必带拒因」，reason 回填模型）；
 * jail 自身异常按拦截处理（不因判定层故障放大权限）——防的兜底 deny 同样带 reason
 * （'jail check failed'）；outsideError 的缺省文案只应命中非合规实现。
 */
async function jailDecision(
  ctx: FsToolContext,
  path: string,
  mode: JailMode,
): Promise<JailDecision> {
  try {
    return await ctx.jail.checkPath(path, mode);
  } catch {
    return { allowed: false, reason: 'jail check failed' };
  }
}

/**
 * 越界错误（唯一构造点：jail 判 allowed=false；reason 缺省也拒绝——缺省文案只是
 * 防御性兜底，按 jail 契约 deny 必带拒因，本层正常路径恒有 reason）。
 */
function outsideError(path: string, decision?: JailDecision): ToolResult {
  return failToolResult(
    'path-outside-workspace',
    decision?.reason ?? `path outside workspace: ${path}`,
    'The workspace jail rejected this path. Use a path inside the workspace; ' +
      'use list_dir or glob to discover valid paths.',
  );
}

/** 参数解析：主循环已做 JSON 合法性与 schema 校验（loop/tools），此处只做类型收窄。 */
type ParsedArgs = { args: Record<string, unknown> } | { err: ToolResult };

function parseArgs(call: ToolCall, toolName: string): ParsedArgs {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        err: failToolResult(
          'invalid-tool-arguments',
          `${toolName}: arguments must be a JSON object`,
        ),
      };
    }
    return { args: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      err: failToolResult(
        'invalid-tool-arguments',
        `${toolName}: arguments are not valid JSON: ${errMsg(err)}`,
      ),
    };
  }
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

function boolArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

/**
 * 工具锚点统一（P1-1）：相对路径按「会话工作区根」解析（jail 的 workspaceRoot——
 * createSessionTools per-session 根，见模块头注）；绝对路径原样。解析值即工具
 * 实际使用的路径（jail 判定 / 全部 I/O / 结果与错误消息同一来源）。
 * 注意：absolute 判定必须做——`path.resolve(wsRoot, abs)` 会丢弃 wsRoot，但显式
 * 分支让语义自明；jail 的 workspaceRoot 在 FakeJail.allowAll 等探针形态可为空串，
 * 相对路径回退进程 cwd 解析仅在该（全放行探针）形态下发生。
 */
function workspacePath(ctx: FsToolContext, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx.jail.workspaceRoot, p);
}

/** stat 失败归一：ENOENT → file-not-found（含路径与可执行线索），其余 → tool-error。 */
function statError(toolName: string, path: string, err: unknown): ToolResult {
  if (errCode(err) === 'ENOENT') {
    return failToolResult(
      'file-not-found',
      `${path}: no such file or directory`,
      `Verify the path with list_dir (names and base directory) and retry; ` +
        `e.g. run list_dir on the parent directory of ${path} first.`,
    );
  }
  return failToolResult('tool-error', `${toolName}: cannot stat ${path}: ${errMsg(err)}`);
}

// ---------------------------------------------------------------------------
// 有界读取（采集缓冲）：≤cap 全量；>cap 头尾各半 + 显式省略标记
// ---------------------------------------------------------------------------

function utf8EndBefore(buf: Buffer, end: number): number {
  let e = end;
  while (e > 0 && ((buf[e] ?? 0) & 0xc0) === 0x80) e -= 1;
  return e;
}

function utf8StartAfter(buf: Buffer, start: number): number {
  let s = start;
  while (s < buf.length && ((buf[s] ?? 0) & 0xc0) === 0x80) s += 1;
  return s;
}

/**
 * 有界读取：内存占住 ≤cap 字节（头尾各半）；大文件对头尾采样段做二进制判定
 * （中间省略区不扫描——只判断「是否应显示」而非「是否全部可读」；S4 对完整输入的
 * 扫描语义保留在 ≤cap 文件上）。
 */
async function readBounded(path: string, size: number): Promise<{ text: string; binary: boolean }> {
  const handle = await open(path, 'r');
  try {
    if (size <= MAX_COLLECTION_BYTES) {
      const buf = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const { bytesRead } = await handle.read(buf, off, size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      const text = buf.toString('utf8');
      return { text, binary: isLikelyBinary(text) };
    }
    const headLen = Math.floor(MAX_COLLECTION_BYTES / 2);
    const tailLen = MAX_COLLECTION_BYTES - headLen;
    const head = Buffer.alloc(headLen);
    const tail = Buffer.alloc(tailLen);
    await handle.read(head, 0, headLen, 0);
    const tailStartFile = Math.max(0, size - tailLen);
    await handle.read(tail, 0, tailLen, tailStartFile);
    const headEnd = utf8EndBefore(head, headLen);
    const tailStart = utf8StartAfter(tail, 0);
    const headText = head.subarray(0, headEnd).toString('utf8');
    const tailText = tail.subarray(tailStart).toString('utf8');
    const elided = tailStartFile + tailStart - headEnd;
    const text = headText + collectionElideMarker(elided, size) + tailText;
    return { text, binary: isLikelyBinary(headText + tailText) };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

async function readOp(ctx: FsToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = strArg(args, 'path');
  if (rawPath === '')
    return failToolResult('invalid-arguments', 'read_file: "path" must be a non-empty string');
  const path = workspacePath(ctx, rawPath); // 锚点统一：相对 → 会话工作区根（P1-1）
  const decision = await jailDecision(ctx, path, 'read');
  if (!decision.allowed) return outsideError(path, decision);
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    return statError('read_file', path, err);
  }
  if (st.isDirectory()) {
    return failToolResult(
      'is-a-directory',
      `${path}: is a directory`,
      'Read a file path instead; to see what it contains, use list_dir.',
    );
  }
  let text = '';
  let binary = false;
  try {
    const r = await readBounded(path, st.size);
    text = r.text;
    binary = r.binary;
  } catch (err) {
    return failToolResult('tool-error', `reading ${path} failed: ${errMsg(err)}`);
  }
  if (binary) {
    return okResult(
      `${FILE_BINARY_PLACEHOLDER}\n\n(${path} is binary, ${st.size} bytes; the content is not shown.)`,
    );
  }
  return okResult(text);
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

async function writeOp(ctx: FsToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = strArg(args, 'path');
  const content = strArg(args, 'content');
  if (rawPath === '')
    return failToolResult('invalid-arguments', 'write_file: "path" must be a non-empty string');
  const path = workspacePath(ctx, rawPath); // 锚点统一：相对 → 会话工作区根（P1-1）
  const decision = await jailDecision(ctx, path, 'write');
  if (!decision.allowed) return outsideError(path, decision);
  try {
    const target = await stat(path);
    if (target.isDirectory()) {
      return failToolResult(
        'is-a-directory',
        `${path}: is a directory`,
        'write_file writes to a file; pick a file path (or remove the directory first).',
      );
    }
  } catch (err) {
    if (errCode(err) !== 'ENOENT')
      return failToolResult('tool-error', `cannot stat ${path}: ${errMsg(err)}`);
  }
  try {
    const parent = await stat(dirname(path));
    if (!parent.isDirectory()) {
      return failToolResult(
        'parent-directory-not-found',
        `${path}: parent is not a directory: ${dirname(path)}`,
      );
    }
  } catch (err) {
    if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') {
      return failToolResult(
        'parent-directory-not-found',
        `${path}: parent directory does not exist: ${dirname(path)}`,
        `Create the missing directory first, e.g. via run_command "mkdir -p ${dirname(path)}", ` +
          'or write into an existing directory; list_dir to see what exists.',
      );
    }
    return failToolResult('tool-error', `cannot stat parent of ${path}: ${errMsg(err)}`);
  }
  try {
    await writeFile(path, content, 'utf8');
  } catch (err) {
    return failToolResult('tool-error', `writing ${path} failed: ${errMsg(err)}`);
  }
  return okResult(`wrote ${path} (${Buffer.byteLength(content, 'utf8')} bytes)`);
}

// ---------------------------------------------------------------------------
// edit_file（SEARCH/REPLACE 精确匹配；aider diff 方言，ARCH §4.2）
// ---------------------------------------------------------------------------

/** SEARCH 片段在错误消息中的展示（截断保字面，便于模型对照）。 */
function searchSnippet(search: string): string {
  return search.length <= 80
    ? JSON.stringify(search)
    : `${JSON.stringify(search.slice(0, 80))}…(${search.length} chars total)`;
}

async function editOp(ctx: FsToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = strArg(args, 'path');
  const search = strArg(args, 'search');
  const replace = strArg(args, 'replace'); // 缺省 = 删除段（空串合法）
  if (rawPath === '')
    return failToolResult('invalid-arguments', 'edit_file: "path" must be a non-empty string');
  const path = workspacePath(ctx, rawPath); // 锚点统一：相对 → 会话工作区根（P1-1）
  // edit_file 对已存在文件做写覆盖 → 写语义
  const decision = await jailDecision(ctx, path, 'write');
  if (!decision.allowed) return outsideError(path, decision);
  if (search === '') {
    return failToolResult(
      'edit-empty-search',
      `${path}: the SEARCH text must not be empty`,
      'Provide the exact text to locate; to replace a whole file, use write_file instead.',
    );
  }
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    return statError('edit_file', path, err);
  }
  if (st.isDirectory()) {
    return failToolResult(
      'is-a-directory',
      `${path}: is a directory`,
      'edit_file edits a file; use list_dir to see the directory.',
    );
  }
  if (st.size > MAX_COLLECTION_BYTES) {
    return failToolResult(
      'edit-file-too-large',
      `${path}: file is ${st.size} bytes, larger than the edit buffer cap (${MAX_COLLECTION_BYTES} bytes)`,
      'Use write_file to rewrite the whole file with the full new content.',
    );
  }
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    return failToolResult('tool-error', `reading ${path} failed: ${errMsg(err)}`);
  }
  const occurrences = content.split(search).length - 1;
  if (occurrences === 0) {
    return failToolResult(
      'edit-no-match',
      `SEARCH text not found in ${path}: ${searchSnippet(search)}, 0 occurrences`,
      'The SEARCH block must match the file exactly, including whitespace and line endings. ' +
        'Read the file with read_file to get the exact text, then retry — or rewrite the whole file with write_file.',
    );
  }
  if (occurrences > 1) {
    return failToolResult(
      'edit-multiple-matches',
      `SEARCH text matches ${occurrences} occurrences in ${path}; refusing to guess`,
      'Enlarge the SEARCH text with surrounding lines until it matches exactly once, ' +
        'or rewrite the whole file with write_file. The file was left unchanged.',
    );
  }
  const next = content.split(search).join(replace);
  try {
    await writeFile(path, next, 'utf8');
  } catch (err) {
    return failToolResult('tool-error', `writing ${path} failed: ${errMsg(err)}`);
  }
  return okResult(`updated ${path}: replaced 1 occurrence`);
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

/** 统一字符串比较器（list_dir/glob 排序单一来源：字典序，与裸 sort 语义一致）。 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byName(a: { name: string }, b: { name: string }): number {
  return compareStrings(a.name, b.name);
}

/** 递归走目录（rel 为 posix 相对路径，''=根）。目录符号链接不展开（防逃狱）；符号链接条目按文件列示。 */
async function collectEntries(
  root: string,
  rel: string,
  recursive: boolean,
  dirs: string[],
  files: string[],
  truncated: { value: boolean },
): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  entries.sort(byName);
  for (const e of entries) {
    if (dirs.length + files.length >= MAX_COLLECTION_ENTRIES) {
      // 上限已到且本目录仍有未处理条目：输出必须附截断标记（不静默）
      truncated.value = true;
      return;
    }
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      dirs.push(`${childRel}/`);
      if (recursive) await collectEntries(root, childRel, true, dirs, files, truncated);
    } else {
      files.push(childRel);
    }
  }
}

async function listDirOp(ctx: FsToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = strArg(args, 'path');
  const recursive = boolArg(args, 'recursive');
  if (rawPath === '')
    return failToolResult('invalid-arguments', 'list_dir: "path" must be a non-empty string');
  const path = workspacePath(ctx, rawPath); // 锚点统一：相对 → 会话工作区根（P1-1）
  const decision = await jailDecision(ctx, path, 'read');
  if (!decision.allowed) return outsideError(path, decision);
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    return statError('list_dir', path, err);
  }
  if (!st.isDirectory()) {
    return failToolResult(
      'not-a-directory',
      `${path}: is not a directory`,
      'list_dir requires a directory; use read_file to read a file, or list_dir on a directory instead.',
    );
  }
  try {
    const dirs: string[] = [];
    const files: string[] = [];
    const truncated = { value: false };
    await collectEntries(path, '', recursive, dirs, files, truncated);
    dirs.sort(compareStrings);
    files.sort(compareStrings);
    if (dirs.length === 0 && files.length === 0) return okResult(`${path} (empty)`);
    const out: string[] = [`${path}:`];
    if (dirs.length > 0) out.push('dirs:', ...dirs.map((d) => `  ${d}`));
    if (files.length > 0) out.push('files:', ...files.map((f) => `  ${f}`));
    if (truncated.value) {
      out.push(
        `(output truncated at ${MAX_COLLECTION_ENTRIES} entries; use a narrower directory or list_dir on subdirectories)`,
      );
    }
    return okResult(out.join('\n'));
  } catch (err) {
    return failToolResult('tool-error', `listing ${path} failed: ${errMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

/** 单段通配：`*` 任意字符（不含 `/`）、`?` 单字符；大小写敏感。 */
function segmentMatches(pat: string, name: string): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < name.length) {
    if (p < pat.length && ((pat[p] ?? '') === (name[s] ?? '') || (pat[p] ?? '') === '?')) {
      p += 1;
      s += 1;
    } else if (p < pat.length && (pat[p] ?? '') === '*') {
      starP = p;
      p += 1;
      starS = s;
    } else if (starP !== -1) {
      p = starP + 1;
      starS += 1;
      s = starS;
    } else {
      return false;
    }
  }
  while (p < pat.length && (pat[p] ?? '') === '*') p += 1;
  return p === pat.length;
}

/** 全模式匹配：按 `/` 分段，`**` 段匹配零或多层目录（跨段 DP）。 */
export function patternMatches(pattern: string, relPath: string): boolean {
  const parts = pattern.split('/').filter((seg) => seg !== '' && seg !== '.');
  const relParts = relPath.split('/');
  const memo = new Map<string, boolean>();
  function m(i: number, j: number): boolean {
    const key = `${i}:${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const res = ((): boolean => {
      if (i >= parts.length) return j >= relParts.length;
      const part = parts[i] as string;
      if (part === '**') {
        for (let k = j; k <= relParts.length; k += 1) {
          if (m(i + 1, k)) return true;
        }
        return false;
      }
      if (j >= relParts.length) return false;
      if (!segmentMatches(part, relParts[j] as string)) return false;
      return m(i + 1, j + 1);
    })();
    memo.set(key, res);
    return res;
  }
  return m(0, 0);
}

/** 递归收集文件 rel posix 路径；目录符号链接不展开（防逃狱），文件型符号链接按文件收集。 */
async function collectFiles(
  root: string,
  rel: string,
  files: string[],
  truncated: { value: boolean },
): Promise<void> {
  if (files.length >= MAX_COLLECTION_ENTRIES) return;
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  entries.sort(byName);
  for (const e of entries) {
    if (files.length >= MAX_COLLECTION_ENTRIES) {
      // 上限已到且仍有未处理条目：输出必须附截断标记（不静默）
      truncated.value = true;
      return;
    }
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      await collectFiles(root, childRel, files, truncated);
    } else if (e.isSymbolicLink()) {
      let target;
      try {
        target = await stat(join(root, childRel));
      } catch {
        continue; // 断裂链接：无法解析目标，跳过
      }
      if (target.isDirectory()) continue; // 链接到目录：不展开（防逃狱）
      files.push(childRel);
    } else {
      files.push(childRel);
    }
  }
}

async function globOp(ctx: FsToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = strArg(args, 'pattern');
  const rawBase = strArg(args, 'path');
  if (pattern === '')
    return failToolResult('invalid-pattern', 'glob: "pattern" must be a non-empty string');
  if (rawBase === '')
    return failToolResult(
      'invalid-arguments',
      'glob: "path" (base directory) must be a non-empty string',
    );
  const base = workspacePath(ctx, rawBase); // 锚点统一：相对 → 会话工作区根（P1-1）
  const baseDecision = await jailDecision(ctx, base, 'read');
  if (!baseDecision.allowed) return outsideError(base, baseDecision);
  let st;
  try {
    st = await stat(base);
  } catch (err) {
    return statError('glob', base, err);
  }
  if (!st.isDirectory()) {
    return failToolResult(
      'not-a-directory',
      `${base}: is not a directory`,
      'glob walks a directory; pass a directory as "path".',
    );
  }
  try {
    const files: string[] = [];
    const truncated = { value: false };
    await collectFiles(base, '', files, truncated);
    const matched = files.filter((rel) => patternMatches(pattern, rel)).sort(compareStrings);
    // 不逃狱：glob 结果再经 jail 校验（S9 双端判定：符号链接目标解析在外 → 剔除）
    const allowed: string[] = [];
    for (const rel of matched) {
      const d = await jailDecision(ctx, join(base, rel), 'read');
      if (d.allowed) allowed.push(rel);
    }
    if (allowed.length === 0) {
      return okResult(
        truncated.value
          ? `no matches for "${pattern}" in ${base}\n(glob output truncated at ${MAX_COLLECTION_ENTRIES} entries; matches may exist beyond the collected tree)`
          : `no matches for "${pattern}" in ${base}`,
      );
    }
    const out: string[] = [];
    let bytes = 0;
    let capped = false;
    for (const rel of allowed) {
      bytes += Buffer.byteLength(rel) + 1;
      if (bytes > MAX_COLLECTION_BYTES) {
        capped = true;
        break;
      }
      out.push(rel);
    }
    if (capped) out.push('... (glob output capped; use a narrower pattern or base)');
    if (truncated.value) {
      out.push(
        `(glob output truncated at ${MAX_COLLECTION_ENTRIES} entries; use a narrower pattern or base)`,
      );
    }
    return okResult(out.join('\n'));
  } catch (err) {
    return failToolResult('tool-error', `glob ${pattern} in ${base} failed: ${errMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// grep（字面量匹配；行号 1 起；命中 ":" / 上下文 "-"；组间 "--"）
// ---------------------------------------------------------------------------

const GREP_MAX_CONTEXT_LINES = 20;

/** 目标文件收集：输入可为文件或目录（目录递归）；符号链接目录不展开；绝对路径去重。 */
async function collectGrepFiles(root: string, out: string[], seen: Set<string>): Promise<void> {
  if (out.length >= MAX_COLLECTION_ENTRIES) return;
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort(byName);
  for (const e of entries) {
    if (out.length >= MAX_COLLECTION_ENTRIES) return;
    const abs = join(root, e.name);
    if (e.isDirectory()) {
      await collectGrepFiles(abs, out, seen);
    } else if (e.isSymbolicLink()) {
      let target;
      try {
        target = await stat(abs);
      } catch {
        continue;
      }
      if (target.isDirectory()) continue;
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    } else if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
}

/** 编译单文件的命中视图（带上下文分组合并；返回 null = 无命中）。 */
function renderFileMatches(
  file: string,
  text: string,
  pattern: string,
  caseSensitive: boolean,
  contextLines: number,
): string[] | null {
  const fileLines = text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const haystack = caseSensitive ? fileLines : fileLines.map((l) => l.toLowerCase());
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const matches: number[] = [];
  for (let i = 0; i < fileLines.length; i += 1) {
    if ((haystack[i] ?? '').includes(needle)) matches.push(i + 1);
  }
  if (matches.length === 0) return null;
  if (contextLines === 0) {
    return matches.map((ln) => `${file}:${ln}:${fileLines[ln - 1] ?? ''}`);
  }
  const windows: Array<{ s: number; e: number }> = [];
  for (const ln of matches) {
    windows.push({
      s: Math.max(1, ln - contextLines),
      e: Math.min(fileLines.length, ln + contextLines),
    });
  }
  const merged: Array<{ s: number; e: number }> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last !== undefined && w.s <= last.e + 1) {
      last.e = Math.max(last.e, w.e);
    } else {
      merged.push({ s: w.s, e: w.e });
    }
  }
  const matchSet = new Set(matches);
  const out: string[] = [];
  for (let gi = 0; gi < merged.length; gi += 1) {
    if (gi > 0) out.push('--');
    const w = merged[gi] as { s: number; e: number };
    for (let ln = w.s; ln <= w.e; ln += 1) {
      const lineText = fileLines[ln - 1] ?? '';
      out.push(`${file}:${ln}:${matchSet.has(ln) ? '' : '-'}${lineText}`);
    }
  }
  return out;
}

async function grepOp(ctx: FsToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = strArg(args, 'pattern');
  if (pattern === '') {
    return failToolResult(
      'invalid-pattern',
      'grep: "pattern" must be a non-empty string',
      'Provide the literal text to search for; use glob or list_dir first to find candidate files.',
    );
  }
  const rawPaths = args['paths'];
  const paths: string[] = [];
  if (Array.isArray(rawPaths)) {
    for (const p of rawPaths) {
      if (typeof p !== 'string') {
        // 严格口径（CTO 裁定）：非 string 元素不再静默过滤——按 invalid-arguments 报错
        return failToolResult(
          'invalid-arguments',
          'grep: "paths" must contain only string paths (found a non-string element)',
        );
      }
      paths.push(p);
    }
  }
  if (paths.length === 0)
    return failToolResult(
      'invalid-arguments',
      'grep: "paths" must be a non-empty array of file or directory paths',
    );
  const caseSensitive = boolArg(args, 'case_sensitive');
  const rawCtx = args['context_lines'];
  const contextLines = rawCtx === undefined ? 0 : typeof rawCtx === 'number' ? rawCtx : Number.NaN;
  if (
    !Number.isInteger(contextLines) ||
    contextLines < 0 ||
    contextLines > GREP_MAX_CONTEXT_LINES
  ) {
    return failToolResult(
      'invalid-context-lines',
      `grep: context_lines must be an integer between 0 and ${GREP_MAX_CONTEXT_LINES}, got ${String(rawCtx)}`,
      'Retry with a context_lines in the allowed range, or omit it for no context.',
    );
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    // 锚点统一（P1-1）：每个路径参数（含 paths 数组元素）相对 → 会话工作区根后
    // 才进入 jail 判定与实际扫描（jail 判定与 I/O 同一路径）。
    const p = workspacePath(ctx, rawPath);
    const decision = await jailDecision(ctx, p, 'read');
    if (!decision.allowed) return outsideError(p, decision);
    let st;
    try {
      st = await stat(p);
    } catch (err) {
      return statError('grep', p, err);
    }
    const key = resolve(p);
    if (st.isDirectory()) {
      await collectGrepFiles(p, files, seen);
    } else if (!seen.has(key)) {
      seen.add(key);
      files.push(p);
    }
  }
  const out: string[] = [];
  const skippedBinary: string[] = [];
  const skippedLarge: string[] = [];
  let bytes = 0;
  let capped = false;
  outer: for (const f of files) {
    // 与 glob 同款的逐文件 jail 复核：递归发现（或收集时 stat）≠ 实际读取授权——
    // 目录内软链目标解析在界外的文件不得读取（目录根校验不能替代逐文件；S9 双端判定）
    const readDecision = await jailDecision(ctx, f, 'read');
    if (!readDecision.allowed) continue;
    let st;
    try {
      st = await stat(f);
    } catch (err) {
      return statError('grep', f, err);
    }
    if (bytes > MAX_COLLECTION_BYTES) {
      capped = true;
      break;
    }
    if (st.size > MAX_COLLECTION_BYTES) {
      skippedLarge.push(f);
      continue;
    }
    let text: string;
    try {
      text = await readFile(f, 'utf8');
    } catch (err) {
      return failToolResult('tool-error', `reading ${f} failed: ${errMsg(err)}`);
    }
    if (isLikelyBinary(text)) {
      skippedBinary.push(f);
      continue;
    }
    const rendered = renderFileMatches(f, text, pattern, caseSensitive, contextLines);
    if (rendered === null) continue;
    for (const line of rendered) {
      if (bytes + Buffer.byteLength(line) + 1 > MAX_COLLECTION_BYTES) {
        capped = true;
        break outer;
      }
      bytes += Buffer.byteLength(line) + 1;
      out.push(line);
    }
  }
  if (capped)
    out.push(
      `(grep output capped at ${MAX_COLLECTION_BYTES} bytes; further matches omitted — narrow the pattern or paths)`,
    );
  const noteNames = (names: string[]): string =>
    names
      .slice(0, 3)
      .map((n) => basename(n))
      .join(', ');
  if (skippedBinary.length > 0) {
    out.push(`skipped ${skippedBinary.length} binary file(s): ${noteNames(skippedBinary)}`);
  }
  if (skippedLarge.length > 0) {
    out.push(
      `skipped ${skippedLarge.length} file(s) larger than the collection cap (${MAX_COLLECTION_BYTES} bytes): ${noteNames(skippedLarge)}`,
    );
  }
  if (out.length === 0) return okResult(`no matches for "${pattern}"`);
  return okResult(out.join('\n'));
}

// ---------------------------------------------------------------------------
// 工具面注册
// ---------------------------------------------------------------------------

/**
 * 构造工具定义。execute 签名按 loop/types 的 Tool.execute(call, ctx)——但 ctx 只在
 * createFsTools 构造期闭包绑定（FsToolContext 含 jail，而 defineRegistry 注入的
 * ToolExecutionContext 不带 jail，无法经 call 侧进入），本组 execute 因此只收 call。
 * 协调契约（与 loop/tools.defineRegistry 对齐，loop/types 是唯一契约源，绝不另行扩面）：
 * - defineRegistry 注入的 ctx（sessionId/signal）供消费执行期会话状态的工具；fs 工具
 *   当前不消费 sessionId/signal（只用构造期 jail），故忽略注入 ctx 安全（无漂移面）；
 * - 若未来 fs 工具需要透传 signal 等执行期状态，应改为消费注入 ctx（签名按 loop/types
 *   不变）并保持 jail 走构造面——注意：届时 createFsTools 的 ctx 与 defineRegistry 注入
 *   的 ctx 必须来自同一会话，接线层（boot）负责保证，本模块不做假设。
 */
function makeTool(
  name: string,
  description: string,
  parameters: JsonSchema,
  run: (args: Record<string, unknown>) => Promise<ToolResult>,
): Tool {
  return {
    name,
    description,
    parameters,
    execute: (call: ToolCall) => executeWithArgs(call, name, run),
  };
}

async function executeWithArgs(
  call: ToolCall,
  toolName: string,
  run: (args: Record<string, unknown>) => Promise<ToolResult>,
): Promise<ToolResult> {
  const parsed = parseArgs(call, toolName);
  if ('err' in parsed) return parsed.err;
  return run(parsed.args);
}

/**
 * 只读工具子集（子代理工具面——Claude Code subagent 只读语义）：
 * read_file / grep / glob / list_dir；**不含** write_file / edit_file（子代理不得写）、
 * 更不含 run_command / use_skill / spawn_subagent / MCP。只读性由「工具集选择」保证，
 * 不另造权限系统（同一 jail/路径锚定语义：绑定构造期注入的会话 jail——宿主会话工作区根）。
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = ['read_file', 'grep', 'glob', 'list_dir'];

/**
 * 只读工具集合成：createFsTools 全集的只读切片（同构造面、同监狱、同路径锚定语义；
 * 顺序 = createFsTools 声明序——read_file/list_dir/glob/grep）。
 */
export function createReadOnlyFsTools(ctx: FsToolContext): Tool[] {
  return createFsTools(ctx).filter((tool) => READ_ONLY_TOOL_NAMES.includes(tool.name));
}

/** 六个文件工具（构造注入 ctx 闭包绑定；registry 由 loop 的 defineRegistry 包装，Phase 3/接线层负责——协调契约见 makeTool 注）。 */
export function createFsTools(ctx: FsToolContext): Tool[] {
  return [
    makeTool(
      'read_file',
      'Read a text file from the workspace and return its content verbatim. ' +
        'Bounded at 64KB (head/tail with an explicit elide marker); binary files are not shown.',
      {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path of the file to read (absolute, or relative to the workspace root).',
          },
        },
        required: ['path'],
      },
      (args) => readOp(ctx, args),
    ),
    makeTool(
      'write_file',
      'Write content to a file, replacing it entirely. ' +
        'The parent directory must already exist (it is not created implicitly).',
      {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path of the file to write (absolute, or relative to the workspace root).',
          },
          content: {
            type: 'string',
            description: 'Full file content; written verbatim (UTF-8, line endings preserved).',
          },
        },
        required: ['path', 'content'],
      },
      (args) => writeOp(ctx, args),
    ),
    makeTool(
      'edit_file',
      'Apply one precise SEARCH/REPLACE edit to a file (exact text match). ' +
        'SEARCH must match exactly once; empty SEARCH, no-match and multiple matches all fail with actionable errors.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file to edit.' },
          search: {
            type: 'string',
            description:
              'Exact text to locate (must be unique in the file; whitespace and line endings matter).',
          },
          replace: {
            type: 'string',
            description: 'Replacement text; omitted or "" deletes the SEARCH block.',
          },
        },
        required: ['path', 'search'],
      },
      (args) => editOp(ctx, args),
    ),
    makeTool(
      'list_dir',
      'List a directory: dirs and files separately (dirs with a trailing "/"), optionally recursive. ' +
        'Certified sorted; entries are relative to the listed directory.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list.' },
          recursive: {
            type: 'boolean',
            description: 'If true, list all descendants (paths relative to the listed directory).',
          },
        },
        required: ['path'],
      },
      (args) => listDirOp(ctx, args),
    ),
    makeTool(
      'glob',
      'List files under a directory matching a glob pattern. ' +
        'Supports * (** within a segment) and ? ; "**" as a full segment matches zero or more directories. ' +
        'Case-sensitive. Results are relative to the base path and re-checked against the workspace jail.',
      {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern relative to "path" (e.g. "**/*.ts").',
          },
          path: { type: 'string', description: 'Base directory to search from.' },
        },
        required: ['pattern', 'path'],
      },
      (args) => globOp(ctx, args),
    ),
    makeTool(
      'grep',
      'Search files for a literal text pattern (case-insensitive by default) and return matching lines. ' +
        'Optionally show context lines; binary files and files above the collection cap are skipped with an explicit note.',
      {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Literal text to find (NOT a regex).' },
          paths: {
            type: 'array',
            description: 'Files or directories to search (directories are scanned recursively).',
          },
          case_sensitive: {
            type: 'boolean',
            description: 'If true, matching is case-sensitive (default: insensitive).',
          },
          context_lines: {
            type: 'integer',
            description: 'Number of context lines around each match (0-20, default 0).',
          },
        },
        required: ['pattern', 'paths'],
      },
      (args) => grepOp(ctx, args),
    ),
  ];
}
