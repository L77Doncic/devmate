/**
 * # tools/shell：常驻 Shell 工具（接缝 S8；ADR-0010 常驻会话 + 哨兵行 + 自动重启）
 *
 * 契约（与 loop/tools.ts、tools/fs.ts 对齐）：
 * - 每个工具 execute(call, ctx) → ToolResult；失败是普通消息（CONTEXT「错误回注」）：
 *   ok:false 且 content 为合法 JSON，顶层 {ok:false, error:{type,message,human_hint}}
 *   （回注载荷形状复用 loop/tools 的 errorContentJson——单一来源，research §4.4）。
 * - 常驻：每 ctx.sessionId 一个长寿命 shell（cwd/env/后台进程在命令间保持）；
 *   命令以「命令文本 + 完成标记脚本」一次性写入 stdin；管道通往活进程永无 EOF，
 *   命令结束 = host 侧读到完成标记文件（CONTEXT「哨兵行」语义迁移；§6.2）。
 * - 机密脱敏不在此层（输出原样返回，处理归 S11 registry 层，CONTEXT「机密脱敏」）。
 * - 危险操作审批/命令分类不在此层（归 S10 classify）：本层只提供执行原语 +
 *   重定向 jail 边界检查（分类管审批、本层管边界，ADR-0013）。
 *
 * 完成标记协议（每命令随机不可预测；token 与标记路径只存在于 harness 内存与
 * 注入脚本——不经环境变量、不暴露给模型契约；一条命令的注入文本被 bash 作为
 * 复合组 { ... } **整体解析后才执行**，因此读 stdin 的命令（cat 等）拿不到剩余的
 * 标记脚本（只会挂在永不开闭的管道上直至超时），既偷不到也伪造不了完成标记行
 * ——上一代把哨兵行写成命令后独立的一行，`cat` 与 bash 逐行读竞争同一管道，
 * 哨兵行被回显成输出时即实现虚假提前完成（E2E 实证；session 恢复语义不变）。
 *
 *   { <command>
 *     rc=$?
 *     printf '%s\n' '<token>:rc:%s:cwd:%s' "$rc" "$PWD" > <marker-file>
 *   }
 * 标记文件在**临时目录**，每命令唯一；完成判定=host 侧轮询读到可解析的标记行
 * （再留 25ms 让 stderr 尾包到达后定稿），stdout 不可能伪造完成（defense in depth：
 * 输出流中哨兵形态行仍从可见输出剥除）。
 *
 * 判定结束（无 EOF 可用）：
 *   1. 标记文件出现可解析行 → 命令结束（rc/cwd 由标记带回，cwd 供下次重定向解析）；
 *   2. 子进程正常退出（exit N）且无标记 → 视为命令完成（退出码随结果回传），
 *      会话留待下条命令重启（ADR-0010 异常即重启）；
 *   3. 子进程被信号杀死（signal）→ 本命令 shell-exited（失败是普通消息）；
 *   4. 超时（默认 120s，模型可申请，硬上限 900s=MAX_SHELL_TIMEOUT_MS，ADR-0010）
 *      → 杀整棵进程树 + 已捕获输出回注（partial_output）；
 *   5. ctx.signal 中断 → 同超时路径（interrupted）。
 * 重启在**下次执行时**懒发生，结果注明「shell restarted: cwd/env/persistent processes
 * lost」（cwd 回 workspaceRoot = spawn 初值）。
 *
 * 安全边界（ADR-0013 第一层「工作区监狱」；行为级测试 test/shell-tools/redirect.test.ts）：
 * - 命令含 `>`/`>>`/`>|`/`n>`/`&>`/`<>` 等目标 → 解析（去引号）后调
 *   jail.checkRedirect(src,dst)；deny → {ok:false, type:'path-outside-workspace'}
 *   （先问后动：deny 时命令不执行）。相对目标按**跟踪 cwd**（上次命令标记带回）
 *   转绝对后询问（jail 模块注「exec 层若以其它 cwd 运行，须自行转绝对路径后再
 *   询问」）；单命令内 `cd x && cmd > rel` 只能按命令前 cwd 判定——监狱层固有
 *   近似（监狱是模型放行层，真正可靠防线是第 3 层 OS 沙箱，ADR-0013）；文档化。
 * - 词法 fail-closed：重定向词解析异常（`>`/`<` 后无目标、引号未闭合、操作符
 *   缺操作数等 bash 语法错）→ 整命令拒绝 {ok:false, type:'redirect-parse-failed'}，
 *   绝不静默跳行尾造成后续重定向漏检（`<<<` 被误当 `<<` 后跳行尾 → 界外写入
 *   ——E2E 实证漏洞）。合法跳过清单（识别为"非文件"才跳过）：
 *     `<<<` here-string（词是内容）、`<<`/`<<-` heredoc（正文行整体跳过——正文是
 *     字面数据仅当行内容 = delimiter 截止）、fd dup/close（`2>&1`/`>&-`，目标以
 *     `&` 开头）、`<(...)`/`>(...)` 进程替换（fd 不是文件）、`/dev/null` 丢弃 sink
 *     （与 classify 豁免口径一致；`2>&1` 等 fd 复制 class 由 `&` 前缀识别）。
 *     `>|`（clobber）识别为带目标重定向（按写入检）；`>-` 按字面目标 `-` 检（bash
 *     中 `> -` 创建名为 `-` 的文件，非 fd 关闭；fd 关闭是 `>&-`）。
 * - stdin=仅 EOF 语义：只向管道写命令文本（永不喂交互输入、永不关闭）；交互程序
 *   （cat/less/vim）看不到剩余命令文本（复合组消费完毕），但会挂在永开的管道上
 *   直至超时——符合「非交互会话」（§6.1；PAGER/MANPAGER=cat 兜底，挂了也速死）。
 *
 * 平台（§6.3；h 组覆盖策略见 test/shell-tools/platform.test.ts 头注，如实记录）：
 * - posix：/bin/bash --noprofile --norc（detached:true = 进程组组长），杀树负 PID
 *   SIGKILL；win32：powershell.exe → cmd.exe → git-bash 探测（selectWindowsShell
 *   纯函数跨宿主可测），杀树 taskkill /PID /T /F；编码 UTF-8（win32 -Command/
 *   chcp 65001）。win32 全部子进程路径只在 Windows 宿主启用（构造器强制，同 S9）；
 *   该分支在 Linux 上经 typecheck 与纯函数测试，端到端未经 Windows 实测（如实声明）。
 * - 行标准化 CRLF→LF；每行前缀 [out]/[err]（保持可解析的交错顺序）。
 *
 * 输出采集（§6.2/§8B 字节硬上限（采集阶段），与投影层 10k 字符截断是两个闸门）：
 * 总 256KB 硬限（默认；可配）。超限后停止记录、继续排空管道（否则背压堵死
 * 命令），显式标记 `output truncated ... N bytes dropped`；超长单行同样按上限
 * 强制成段过期（防无换行输出撑爆内存）。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

import type { ToolCall } from '../../shared/session-types.js';
import { errorContentJson } from '../loop/tools.js';
import type { JsonSchema, Tool, ToolExecutionContext, ToolResult } from '../loop/types.js';
import type { Jail } from '../jail/index.js';

// ---------------------------------------------------------------------------
// 默认常量与公开接口
// ---------------------------------------------------------------------------

/** 单命令默认超时（ms；ADR-0010 单命令默认 120s；§8D）。 */
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/** 模型可申请超时硬上限（ms；ADR-0010：构建/测试类允许更长、硬上限 900s）。 */
export const MAX_SHELL_TIMEOUT_MS = 900_000;

/** 完成标记轮询间隔（ms）：标记文件出现即定稿（再留 25ms grace 收 stderr 尾包）。 */
const MARKER_POLL_INTERVAL_MS = 3;

/** 采集阶段输出字节硬上限（§8D 256KB；与投影层字符截断分工见模块头注）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** Shell 重启注记（ADR-0010：cwd/env/运行中进程全部消失）。 */
export const SHELL_RESTART_NOTE = 'shell restarted: cwd/env/persistent processes lost';

/** Windows 探测顺序（§8D：powershell → cmd → git-bash）。 */
const WINDOWS_SHELL_CANDIDATES = ['powershell.exe', 'cmd.exe', 'git-bash'] as const;

/**
 * win32 shell 探测（纯函数：候选顺序 + 可用性注入；跨宿主可测）。
 * 全部不可用 → null（启动失败路径，不猜测）。
 */
export function selectWindowsShell(available: (candidate: string) => boolean): string | null {
  for (const c of WINDOWS_SHELL_CANDIDATES) {
    if (available(c)) return c;
  }
  return null;
}

/**
 * spawn 启动失败的普通错误类型映射（纯函数，跨宿主可测）：
 * - win32 探测无任何可用 shell → 'shell-unavailable'；
 * - 其余（spawn 同步异常如 cwd 非法、二进制缺失等）→ 'shell-spawn-failed'。
 * 两者都是普通 ToolResult（不抛、不击穿队列，ADR-0010「失败是普通消息」）。
 */
export function spawnFailureType(err: unknown): 'shell-unavailable' | 'shell-spawn-failed' {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('no Windows shell available') ? 'shell-unavailable' : 'shell-spawn-failed';
}

function spawnFailureMessage(err: unknown): { type: string; message: string } {
  const type = spawnFailureType(err);
  const detail = err instanceof Error ? err.message : String(err);
  return {
    type,
    message: `the persistent shell could not start (${type}: ${detail})`,
  };
}

/** 创建常驻 Shell 工具的构造参数。 */
export interface ShellToolOptions {
  /** 工作区根：shell 初值 cwd（= jail 默认边界）。 */
  workspaceRoot: string;
  /** 工作区监狱（真实实现：src/core/jail/index.js 的 Jail）。 */
  jail: Jail;
  /** 单命令超时（ms）；缺省 DEFAULT_SHELL_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 采集字节上限；缺省 DEFAULT_MAX_OUTPUT_BYTES。 */
  maxOutputBytes?: number;
  /** 平台语义；缺省按当前宿主。win32 只允许在 Windows 宿主启用（构造器强制，同 S9）。 */
  platform?: 'posix' | 'win32';
  /** 追加到环境兜底之后的额外环境变量（覆盖继承值与兜底）。 */
  env?: Record<string, string>;
  /** posix shell 可执行文件覆写（缺省 /bin/bash；git-bash 场景亦可覆写）。 */
  shellPath?: string;
}

export interface PersistentShell {
  /** run_command 工具（Tool = loop 契约；ctx.sessionId 隔离 shell 实例）。 */
  tool: Tool;
  /** 杀掉全部会话的整棵进程树并释放（幂等）。 */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 常量与内部类型
// ---------------------------------------------------------------------------

const SENTINEL_BASE = '__DEV_DONE_';
/** 环境兜底默认（§8D：mini 一手前 5 项 + GIT_PAGER/TERM；交互变量清掉）。 */
const DEFAULT_ENV: Readonly<Record<string, string>> = Object.freeze({
  PAGER: 'cat',
  MANPAGER: 'cat',
  LESS: '-R',
  PIP_PROGRESS_BAR: 'off',
  TQDM_DISABLE: '1',
  GIT_PAGER: 'cat',
  TERM: 'dumb',
});
/** 交互变量：继承环境里清掉（非交互会话，§6.1）。 */
const STRIPPED_ENV_VARS = ['VISUAL', 'EDITOR'] as const;

interface ShellSession {
  child: ChildProcess | null;
  /** spawn 后确认成功的 Promise 由 wireChild 建立（executeOne 先 await）。 */
  spawned: Promise<void> | null;
  /** spawn 'error' 的吞取值（二进制缺失等）。 */
  spawnError: string | null;
  /** 显式死亡/超时杀死后置位；后面命令触发重启（懒发生）。 */
  dead: boolean;
  /** 首个 spawn 不算「重启」（restart 注记只在重启那次结果上出现）。 */
  spawnedOnce: boolean;
  /** 最近一次命令结束后完成标记回报的 cwd（重定向目标解析基准；初值=workspaceRoot）。 */
  trackedCwd: string;
  /**
   * 完成标记目录（每会话一个：mkdtemp——路径只存于 harness 内存 + 注入脚本；
   * 不进环境变量）；命令的标记文件在其下，每命令唯一。
   */
  markerDir: string;
  /** 每会话串行队列（并发度 1，§8D）。 */
  queue: Promise<void>;
}

/** 一次执行的采集/状态：完成标记 + 已定稿输出 + 截断信息。 */
interface RunOutcome {
  kind: 'done' | 'timeout' | 'interrupted' | 'exited';
  exitCode: number;
  text: string;
  truncated: boolean;
  droppedBytes: number;
  /** 完成标记带回的命令结束后 cwd（下次重定向解析基准；无标记时 null）。 */
  cwd: string | null;
}

/** 重定向目标（解析出的去引号字面路径；src=null 表示无输入侧）。 */
interface RedirectTarget {
  src: string | null;
  dst: string | null;
}

// ---------------------------------------------------------------------------
// 工具结果构造（失败是普通消息：内容恒为合法 JSON 回注载荷）
// ---------------------------------------------------------------------------

function failShellResult(
  type: string,
  message: string,
  humanHint: string,
  partial?: string,
): ToolResult {
  const payload = JSON.parse(errorContentJson({ type, message, human_hint: humanHint })) as {
    ok: false;
    error: Record<string, unknown>;
  };
  if (partial !== undefined) payload.error.partial_output = partial;
  return { ok: false, content: JSON.stringify(payload), error: { type, message } };
}

function outsideError(dst: string): ToolResult {
  return failShellResult(
    'path-outside-workspace',
    `redirect target is outside the workspace: ${dst}`,
    'The workspace jail refused a redirect target. Write into the workspace only; ' +
      'use a workspace-relative path.',
  );
}

// ---------------------------------------------------------------------------
// 重定向目标解析（shell 级词法：引号感知、heredoc 正文跳过；未知形态保守跳过）
// ---------------------------------------------------------------------------

const UNQUOTED_WORD_BREAKERS = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  "'",
  '"',
  '\\',
  '&',
  ';',
  '|',
  '<',
  '>',
]);

/** 重定向解析成功：targets 为全部可静态识别的文件端（src=null 表示无输入侧）。 */
export interface RedirectParseOk {
  ok: true;
  targets: RedirectTarget[];
}

/** 重定向解析失败：解析不了的词法形态（含 bash 语法错形态）——整命令 fail-closed。 */
export interface RedirectParseFailed {
  ok: false;
  reason: string;
}

export type RedirectParseResult = RedirectParseOk | RedirectParseFailed;

/**
 * 解析命令文本中可静态识别的重定向目标（不展开变量/命令替换/路径子串）。
 *
 * fail-closed 纪律：解析异常（`>`/`<` 后无目标、引号未闭合、`<<<`/`<<` 缺内容/
 * delimiter 等）返回 {ok:false, reason}——调用层整命令拒绝（redirect-parse-failed）。
 * 历史上「保守跳过」会静默跳到行尾，使同一行的后续重定向无检查（`echo hi <<<
 * hello > ../out.txt`：`<<<` 被当 `<<`，第三个 `<` 触发 null → 跳行尾 → 界外写入
 * 不被拦——E2E 实证漏洞）。
 *
 * 合法跳过清单（识别为「非文件」才跳过；其余一律要么产出目标要么 fail-closed）：
 * - `>` `>>` `>|` `n>` `n>>` `&>` `&>>`：目标按写入检（`>|` clobber 同样写检）；
 *   目标以 `&` 开头（`2>&1`/`>&-`）= fd dup/close，无文件目标；
 *   目标 `-` 按字面文件 `-` 检（bash 中 `> -` 是创建文件 `-`，fd 关闭是 `>&-`）。
 * - `<file`：输入侧按读检；`<> file`：r/w 打开不截断——按写入检（会创建文件）。
 * - `<<`/`<<-` heredoc：delimiter 词后同行是命令上下文；换行后正文行整体跳过
 *   （正文是字面数据，仅当整行 = delimiter 截止——防正文里的 `>` 误判）。
 * - `<<<` here-string：词是内容不是路径，词后同行继续正常解析（后续重定向仍检）。
 * - `<(...)`/`>(...)` 进程替换：fd 不是文件，整组括号跳过（未闭合 → fail-closed）。
 * - 目标字面等于 `/dev/null`：丢弃 sink（无持久写）——与 classify 豁免口径一致。
 * - 引号（'/"/\）感知：目标含空格/引号字面均按解引号文本给出（jail 接收字面路径）。
 */
export function parseRedirectTargets(command: string): RedirectParseResult {
  const targets: RedirectTarget[] = [];
  let i = 0;
  const len = command.length;
  let quote: '' | "'" | '"' = '';
  let heredoc: { bodyFrom: number; delimiter: string } | null = null;
  const parseError = (what: string): RedirectParseFailed => ({
    ok: false,
    reason: `${what}（bash 语法错误形态；fail-closed 拒绝，不猜测）`,
  });

  while (i < len) {
    const ch = command[i] as string;
    if (heredoc !== null && i >= heredoc.bodyFrom) {
      const end = heredocBodyEnd(command, i, heredoc.delimiter);
      heredoc = null;
      i = end === -1 ? len : end;
      continue;
    }
    if (quote !== '') {
      if (ch === '\\' && quote === '"' && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < len && (command[i + 1] === '>' || command[i + 1] === '<')) {
      i += 2; // 转义的重定向符：字面字符
      continue;
    }
    if (ch === '>') {
      const next = command[i + 1];
      if (next === '(') {
        const skip = skipParenGroup(command, i + 1);
        if (skip < 0) return parseError(`>(...) 括号未闭合`);
        i = skip;
        continue;
      }
      const opLen = next === '>' || next === '|' ? 2 : 1; // >> / >|（clobber）
      const start = skipWs(command, i + opLen);
      if (start >= len) return parseError(`${command.slice(i, i + opLen)} 后无重定向目标`);
      if (command[start] === '&') {
        i = start + 1; // 2>&1 / >&-：fd dup/close，无文件目标
        continue;
      }
      const dst = parsePathWord(command, start);
      if (dst === null) return parseError(`重定向目标解析失败（引号未闭合或非词首）`);
      if (dst.text !== '/dev/null') targets.push({ src: null, dst: dst.text });
      i = dst.end;
      continue;
    }
    if (ch === '&' && i + 1 < len && command[i + 1] === '>') {
      i += 1; // '&>' 由其后的 '>' 分支处理（此处只推进，不吞目标）
      continue;
    }
    if (ch === '<') {
      const next = command[i + 1];
      if (next === '(') {
        const skip = skipParenGroup(command, i + 1);
        if (skip < 0) return parseError(`<(...) 括号未闭合`);
        i = skip;
        continue;
      }
      if (next === '>') {
        // '<>'：r/w 打开（不截断、可创建）——按写入检（与 classify 的读写同义）
        const start = skipWs(command, i + 2);
        if (start >= len) return parseError(`<> 后无文件目标`);
        const t = parsePathWord(command, start);
        if (t === null) return parseError(`<> 目标解析失败`);
        if (t.text !== '/dev/null') targets.push({ src: null, dst: t.text });
        i = t.end;
        continue;
      }
      if (next === '<') {
        if (command[i + 2] === '<') {
          // <<< here-string：词是内容不是路径；词后同行继续正常解析
          const start = skipWs(command, i + 3);
          const word = parsePathWord(command, start);
          if (word === null) return parseError(`<<< 缺 here-string 内容词`);
          i = word.end;
          continue;
        }
        // heredoc（<< / <<-）：delimiter 词后同行为命令上下文；
        // 换行后正文行整体跳到 delimiter 行（正文是字面数据不是命令）。
        let dashStart = i + 2;
        if (command[dashStart] === '-') dashStart += 1; // <<-：前导 TAB 剥除
        const delimStart = skipWs(command, dashStart);
        const after = parsePathWord(command, delimStart);
        if (after === null) return parseError(`heredoc 缺 delimiter 词`);
        const firstNewline = newlineAfter(command, after.end);
        heredoc = { bodyFrom: firstNewline + 1, delimiter: after.text };
        i = after.end;
        continue;
      }
      const srcStart = skipWs(command, i + 1);
      const src = parsePathWord(command, srcStart);
      if (src === null) return parseError(`< 后无输入文件目标`);
      if (src.text !== '/dev/null') targets.push({ src: src.text, dst: null });
      i = src.end;
      continue;
    }
    i += 1;
  }
  return { ok: true, targets };
}

/**
 * 跳过从 open 位置的 '(' 起的完整括号组（进程替换 <(...)/>(...)；引号/转义/
 * 嵌套感知）。返回组后第一个位置；未闭合 → -1（调用层 fail-closed）。
 */
function skipParenGroup(cmd: string, open: number): number {
  let depth = 1;
  let i = open + 1;
  while (i < cmd.length) {
    const ch = cmd[i] as string;
    if (ch === "'") {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== "'") j += 1;
      if (j >= cmd.length) return -1;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < cmd.length) {
        if (cmd[i] === '\\') {
          i += 2;
          continue;
        }
        if (cmd[i] === '"') break;
        i += 1;
      }
      if (i >= cmd.length) return -1;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

function skipWs(cmd: string, start: number): number {
  let i = start;
  while (i < cmd.length && (cmd[i] === ' ' || cmd[i] === '\t')) i += 1;
  return i;
}

function newlineAfter(cmd: string, start: number): number {
  const idx = cmd.indexOf('\n', start);
  return idx === -1 ? cmd.length : idx;
}

/** 解析一个路径词：引号包裹则取引号内字面（\" 转义展开），否则取到词界符。 */
function parsePathWord(cmd: string, start: number): { text: string; end: number } | null {
  let i = start;
  if (i >= cmd.length) return null;
  const c = cmd[i] as string;
  if (c === "'" || c === '"') {
    const q = c;
    let text = '';
    i += 1;
    for (; i < cmd.length; i += 1) {
      const ch = cmd[i] as string;
      if (ch === q) break;
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) {
        i += 1;
        text += cmd[i] as string;
        continue;
      }
      text += ch;
    }
    if (i >= cmd.length) return null; // 未闭合：bash 报错，保守跳过
    return { text, end: i + 1 };
  }
  let text = '';
  for (; i < cmd.length; i += 1) {
    const ch = cmd[i] as string;
    if (UNQUOTED_WORD_BREAKERS.has(ch)) break;
    text += ch;
  }
  return text.length > 0 ? { text, end: i } : null;
}

/** 从行 start 起跳过 heredoc 正文直到完整 delimiter 行（<<- 的前导 TAB 剥除近似）。 */
function heredocBodyEnd(cmd: string, start: number, delimiter: string): number {
  let lineStart = start;
  for (;;) {
    const nl = cmd.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? cmd.length : nl;
    const line = cmd.slice(lineStart, lineEnd).replace(/^\t+/, '');
    if (line === delimiter) return nl === -1 ? cmd.length : nl + 1;
    if (nl === -1) return -1;
    lineStart = nl + 1;
  }
}

// ---------------------------------------------------------------------------
// 输出采集（合并流、按行标签、CRLF→LF、256KB 硬限、哨兵行识别）
// ---------------------------------------------------------------------------

/** 哨兵行识别：`<base>:rc:<N>:cwd:<path>`（与写入端 printf 严格一致）。 */
function tryParseSentinel(line: string, base: string): { rc: number; cwd: string } | null {
  const prefix = `${base}:rc:`;
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const sep = rest.indexOf(':cwd:');
  if (sep < 0) return null;
  const rc = Number(rest.slice(0, sep));
  if (!Number.isInteger(rc) || rc < 0 || rc > 255) return null;
  return { rc, cwd: rest.slice(sep + ':cwd:'.length) };
}

function renderLine(stream: 'out' | 'err', line: string): string {
  return stream === 'out' ? `[out] ${line}\n` : `[err] ${line}\n`;
}

/** 尾部空心标签行（哨兵前缀 \n 产生的 `[out] ` 行）与悬挂换行剥除。 */
function stripTrailingBlankTaggedLines(text: string): string {
  let t = text;
  for (;;) {
    if (t.endsWith('[out] \n') || t.endsWith('[err] \n')) {
      t = t.slice(0, -'[out] \n'.length);
      continue;
    }
    if (t.endsWith('\n')) {
      t = t.slice(0, -1);
      continue;
    }
    return t;
  }
}

class OutputCollector {
  private readonly base: string;
  private readonly maxBytes: number;
  private readonly out: string[] = [];
  private pendingOut = '';
  private pendingErr = '';
  private bytesIn = 0;
  private emitted = 0;
  private truncated = false;

  constructor(base: string, maxBytes: number) {
    this.base = base;
    this.maxBytes = maxBytes;
  }

  feed(stream: 'out' | 'err', chunk: Buffer): void {
    this.bytesIn += chunk.byteLength;
    if (stream === 'out') {
      this.pendingOut += chunk.toString('utf8');
      this.drainLines('out');
    } else {
      this.pendingErr += chunk.toString('utf8');
      this.drainLines('err');
    }
  }

  private drainLines(stream: 'out' | 'err'): void {
    let pending = stream === 'out' ? this.pendingOut : this.pendingErr;
    for (;;) {
      const idx = pending.indexOf('\n');
      if (idx === -1) break;
      const line = pending.slice(0, idx).replace(/\r$/, ''); // 行标准化 CRLF→LF
      pending = pending.slice(idx + 1);
      this.consumeLine(stream, line);
    }
    if (pending.length > this.maxBytes + 64) {
      this.truncated = true; // 无换行巨型输出：强制过期（防内存膨胀）
      pending = pending.slice(this.maxBytes + 64);
    }
    if (stream === 'out') this.pendingOut = pending;
    else this.pendingErr = pending;
  }

  private consumeLine(stream: 'out' | 'err', line: string): void {
    // 纵深防御：哨兵形态行（__DEV_DONE_<hex>__:rc:...）从可见输出剥除。
    // 完成判定**不再**经 stdout（标记文件才是判据——stdout 可被任意命令回显伪造）。
    if (tryParseSentinel(line, this.base) !== null) return;
    if (this.truncated) return; // 记录停止、排空继续（防管道背压堵死命令）
    const lineBytes = Buffer.byteLength(line) + 1;
    if (this.emitted + lineBytes <= this.maxBytes) {
      this.out.push(renderLine(stream, line));
      this.emitted += lineBytes;
    } else {
      this.truncated = true;
    }
  }

  /** flush 半行并汇总；kind 由等待方按结束原因给定。 */
  finish(forced: boolean): Pick<RunOutcome, 'exitCode' | 'text' | 'truncated' | 'droppedBytes'> {
    if (!forced) {
      if (this.pendingOut.length > 0) this.consumeLine('out', this.pendingOut.replace(/\r$/, ''));
      if (this.pendingErr.length > 0) this.consumeLine('err', this.pendingErr.replace(/\r$/, ''));
    }
    let text = stripTrailingBlankTaggedLines(this.out.join(''));
    if (this.truncated) {
      const dropped = Math.max(0, this.bytesIn - this.emitted);
      text +=
        `\n--- output truncated: collection buffer capped at ${this.maxBytes} bytes; ` +
        `${dropped} bytes dropped ---`;
    }
    return {
      exitCode: -1,
      text,
      truncated: this.truncated,
      droppedBytes: Math.max(0, this.bytesIn - this.emitted),
    };
  }
}

// ---------------------------------------------------------------------------
// 会话与平台
// ---------------------------------------------------------------------------

function buildEnv(opts: ShellToolOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIPPED_ENV_VARS) delete env[k];
  Object.assign(env, DEFAULT_ENV, opts.env);
  return env;
}

function posixSpawn(opts: ShellToolOptions): ChildProcess {
  const shell = opts.shellPath ?? '/bin/bash';
  return spawn(shell, ['--noprofile', '--norc'], {
    cwd: opts.workspaceRoot,
    env: buildEnv(opts),
    detached: true, // 进程组组长：杀树用负 PID（§6.3）
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** win32：探测顺序 powershell → cmd → git-bash（真实可用性探测，构造器强制宿主 win32）。 */
function win32Spawn(opts: ShellToolOptions): ChildProcess {
  const picked = probeWindowsShell();
  if (picked === null) {
    throw new Error('shell: no Windows shell available (powershell/cmd/git-bash all missing)');
  }
  const env = buildEnv(opts);
  if (picked === 'cmd.exe') {
    return spawn('cmd.exe', ['/d', '/k', 'chcp 65001>NUL'], {
      cwd: opts.workspaceRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  if (picked === 'powershell.exe') {
    return spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-Command',
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;function global:prompt {""}',
      ],
      { cwd: opts.workspaceRoot, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }
  const shell = opts.shellPath ?? 'git-bash';
  return spawn(shell, ['--noprofile', '--norc'], {
    cwd: opts.workspaceRoot,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function probeWindowsShell(): string | null {
  return selectWindowsShell((candidate) => {
    try {
      const cookie = `__devmate_probe_${randomBytes(4).toString('hex')}`;
      const res =
        candidate === 'cmd.exe'
          ? spawnSync('cmd.exe', ['/d', '/c', `echo ${cookie}`], {
              encoding: 'utf8',
              timeout: 5_000,
            })
          : spawnSync(candidate, ['-NoProfile', '-Command', `echo ${cookie}`], {
              encoding: 'utf8',
              timeout: 5_000,
            });
      return res.status === 0 && String(res.stdout).includes(cookie);
    } catch {
      return false;
    }
  });
}

function sessionAlive(session: ShellSession): boolean {
  const c = session.child;
  if (session.dead || c === null || c.pid === undefined) return false;
  if (c.exitCode !== null || c.signalCode !== null) return false;
  try {
    process.kill(c.pid, 0);
    return true;
  } catch {
    return false; // ESRCH：已被系统级击杀（kill -9 从事件流外部发生）
  }
}

/** 杀整棵进程树（POSIX 负 PID SIGKILL；win32 taskkill /PID /T /F；§6.3）。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000 });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // 进程组已不存在等：目标本来就结束，静默
  }
}

function wireChild(session: ShellSession, child: ChildProcess): void {
  session.spawned = new Promise<void>((resolve) => {
    child.once('spawn', () => resolve());
    child.once('error', (err) => {
      session.spawnError = err.message;
      session.dead = true;
      resolve();
    });
  });
  child.once('exit', () => {
    session.dead = true;
  });
  // stdout/stderr/stdin 'error' 事件吞掉（EPIPE/管道破裂等不崩进程）
  child.stdout?.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);
  child.stdin?.on('error', () => undefined);
}

/** 等待子进程被回收（exit 事件/状态可见）；超时返回 false。 */
async function waitReaped(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
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

async function writeAndDrain(child: ChildProcess, text: string): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null) throw new Error('shell stdin is closed');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      stdin.off('error', onError);
      if (err !== null) reject(err);
      else resolve();
    };
    const onError = (err: Error): void => done(err);
    stdin.once('error', onError);
    const ok = stdin.write(text, (err?: Error | null) => done(err ?? null));
    if (!ok) stdin.once('drain', () => done(null));
  });
}

function absResolve(p: string, base: string): string {
  return isAbsolute(p) ? normalize(p) : normalize(join(base, p));
}

// ---------------------------------------------------------------------------
// 工具主体
// ---------------------------------------------------------------------------

/**
 * 一次命令执行（队列串行、不抛异常——一律 ToolResult；失败是普通消息）。
 * 顶层 try/catch 兜底：进程启动（win32Spawn 无 shell、spawn 同步异常如 cwd 失效）
 * 等任何漏网抛错都归为普通失败结果（shell-unavailable/shell-spawn-failed）——
 * 绝不击穿每会话队列（ADR-0010「失败是普通消息」）。
 * 会话在「写入时死亡」（EPIPE）判定的处理：属「shell 已死、重启趁此一次」——
 * 立即重开一次新会话并重跑本命令（这正是 ADR-0010 的自动重启语义，生变时
 * 在本次结果注明状态丢失）；一次写入仍死 → shell-exited（失败是普通消息）。
 */
async function executeOne(
  session: ShellSession,
  command: string,
  opts: ShellToolOptions,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  try {
    return await executeOneInner(session, command, opts, timeoutMs, signal);
  } catch (err) {
    const f = spawnFailureMessage(err);
    return failShellResult(
      f.type,
      f.message,
      'The shell binary could not be launched; fix the underlying error, ' +
        'or continue without shell if it is recoverable.',
    );
  }
}

async function executeOneInner(
  session: ShellSession,
  command: string,
  opts: ShellToolOptions,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  // 0) 重定向词法解析先行：解析异常 → 整命令 fail-closed（redirect-parse-failed）
  const parsed = parseRedirectTargets(command);
  if (!parsed.ok) {
    return failShellResult(
      'redirect-parse-failed',
      `redirect parse failed: ${parsed.reason}`,
      'The redirect grammar could not be parsed safely; the command was refused. ' +
        'Rewrite the redirect (e.g. quote the target or add the missing word).',
    );
  }
  // 0.1) 重定向边界检查：解析目标 → jail.checkRedirect(src,dst)（先问后动）
  for (const t of parsed.targets) {
    const src = t.src === null ? '' : absResolve(t.src, session.trackedCwd);
    const dst = t.dst === null ? '' : absResolve(t.dst, session.trackedCwd);
    let allowed = false;
    try {
      allowed = (await opts.jail.checkRedirect(src, dst)).allowed;
    } catch {
      allowed = false; // jail 自身故障按拦截处理（fail-closed，不放大权限）
    }
    if (!allowed) return outsideError(t.dst ?? t.src ?? '(unknown path)');
  }

  // 1) 执行（最多一次重开重试；null = 写入时已死 → 重开）
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runAttempt(session, command, opts, timeoutMs, signal);
    if (result !== null) return result;
  }
  return failShellResult(
    'shell-exited',
    'the shell session died while writing the command and stayed dead after a restart attempt',
    'The persistent shell vanished; the next command will start a fresh session.',
  );
}

/** 单次执行尝试；会话死亡时返回 null（调用方重开重试一次）。 */
async function runAttempt(
  session: ShellSession,
  command: string,
  opts: ShellToolOptions,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ToolResult | null> {
  // 会话存活保证（死 → 懒重启；该会话首次 spawn 不叫重启）
  let restarted = false;
  if (!sessionAlive(session)) {
    let child: ChildProcess;
    try {
      child = opts.platform === 'win32' ? win32Spawn(opts) : posixSpawn(opts);
    } catch (err) {
      // spawn 同步异常（win32 无 shell / cwd 无效等）→ 普通失败结果（不击穿队列）
      const f = spawnFailureMessage(err);
      return failShellResult(
        f.type,
        f.message,
        'The shell binary could not be launched; fix the underlying error, ' +
          'or continue without shell if it is recoverable.',
      );
    }
    session.child = child;
    session.dead = false;
    session.spawnError = null;
    session.trackedCwd = opts.workspaceRoot;
    restarted = session.spawnedOnce;
    session.spawnedOnce = true;
    wireChild(session, child);
  }
  const child = session.child;
  if (child === null) {
    return failShellResult(
      'tool-error',
      'cannot start the persistent shell',
      'The shell could not be started; retry once, or reset the session.',
    );
  }
  if (session.spawned !== null) await session.spawned; // spawn 成功/失败已定夺
  if (session.spawnError !== null) {
    return failShellResult(
      'tool-error',
      `cannot start the persistent shell: ${session.spawnError}`,
      'The shell binary may be missing; platform probe may be off.',
    );
  }

  // 完成标记（每命令随机不可预测；路径只存 harness 内存与注入脚本）：
  // 命令文本与标记脚本整个包进复合组 { ... }——bash 解析完整体才执行，
  // 读 stdin 的命令（cat 等）拿到的是 EOF，偷不到也伪造不了标记行。
  const token = `${SENTINEL_BASE}${randomBytes(12).toString('hex')}__`;
  const markerPath = join(session.markerDir, `marker-${randomBytes(8).toString('hex')}.tmp`);
  let markerPrepared = false;
  try {
    // 标记路径只含 alnum/-/.，单引号注入安全（mkdtemp 前缀亦仅路径字母）
    if (!/^[A-Za-z0-9/._-]+$/.test(markerPath)) {
      return failShellResult(
        'tool-error',
        'cannot create a completion marker file (unsafe temp path)',
        'The temp directory path cannot be injected safely; retry or reset the session.',
      );
    }
    writeFileSync(markerPath, '');
    markerPrepared = true;
    const payload =
      `{\n` +
      `${command}\n` +
      `rc=$?\n` +
      `printf '%s:rc:%s:cwd:%s\\n' '${token}' "$rc" "$PWD" > '${markerPath}'\n` +
      `}\n`;
    const collector = new OutputCollector(token, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    const exitInfoRef: { value: { code: number | null; signal: string | null } | null } = {
      value: null,
    };
    const onOut = (chunk: Buffer): void => collector.feed('out', chunk);
    const onErr = (chunk: Buffer): void => collector.feed('err', chunk);
    const onExit = (code: number | null, sig: string | null): void => {
      exitInfoRef.value = { code, signal: sig };
    };
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onErr);
    child.once('exit', onExit);

    try {
      await writeAndDrain(child, payload);
    } catch (err) {
      // 写入即失败：多半 shell 刚死（EPIPE）——等其上吊后重开重试一次
      const reaped = await waitReaped(child, 500);
      child.stdout?.removeListener('data', onOut);
      child.stderr?.removeListener('data', onErr);
      child.removeListener('exit', onExit);
      if (reaped) return null; // 死透 → 调用方重开一次（本次结果将注明重启）
      return failShellResult(
        'shell-exited',
        `the shell session died while writing the command (${err instanceof Error ? err.message : String(err)})`,
        'The persistent shell is gone; the next command starts a fresh session.',
      );
    }

    const outcome = await waitForCompletion(collector, child, markerPath, token, timeoutMs, signal);
    child.stdout?.removeListener('data', onOut);
    child.stderr?.removeListener('data', onErr);
    child.removeListener('exit', onExit);

    if (outcome.kind === 'timeout' || outcome.kind === 'interrupted') {
      killTree(child);
      session.dead = true;
    }

    if (outcome.cwd !== null) session.trackedCwd = outcome.cwd;
    const restartNote = restarted ? `\n--- ${SHELL_RESTART_NOTE} ---` : '';

    if (outcome.kind === 'done') {
      return {
        ok: true,
        content: `${outcome.text}${restartNote}\n--- exit code: ${outcome.exitCode} ---`,
      };
    }
    if (outcome.kind === 'exited') {
      const info = exitInfoRef.value;
      const detail =
        info !== null && info.code !== null
          ? `exit code ${info.code}`
          : `signal ${info?.signal ?? 'unknown'}`;
      return failShellResult(
        'shell-exited',
        `the shell was killed before the command finished (${detail})`,
        'The persistent shell died mid-command (crash or external kill). ' +
          'The next command restarts it in the workspace root.',
        outcome.text,
      );
    }
    const partialText = `${outcome.text}\n[partial output up to ${outcome.kind === 'timeout' ? 'timeout' : 'interrupt'}]`;
    return failShellResult(
      outcome.kind === 'timeout' ? 'command-timeout' : 'interrupted',
      outcome.kind === 'timeout'
        ? `timed out after ${timeoutMs}ms`
        : 'interrupted by the user signal',
      outcome.kind === 'timeout'
        ? 'The command did not finish in time and its whole process tree was killed; ' +
            'the session restarts on the next command (cwd/env/background processes lost).'
        : 'The command was interrupted; partial output above.',
      partialText,
    );
  } finally {
    if (markerPrepared) rmSync(markerPath, { force: true }); // 每次执行后清掉标记文件
  }
}

/**
 * 等待一次执行的完成出口（完成标记/退出/超时/中断；无 EOF 可依赖）。
 * 定稿规则：
 * - 标记文件（host 侧轮询；命令结束后由 shell 脚本写入）→ 25ms 后 'done'
 *   （grace 收 stderr 尾包）；完成判据只在标记文件——stdout 上的任何行
 *   （含被命令回显的哨兵形态行）都不触发完成（哨兵物经 stdin 可被伪造——E2E 实证）；
 * - 子进程正常退出（含 `exit N`）且标记未到 → 25ms 后视同命令完成（退出码回传），
 *   会话留待下条命令重启；被信号杀死 → 'exited'（同 grace）；
 * - 超时计时器 → 'timeout'（即时收集现有输出，杀树由调用方执行）；
 * - signal 中断 → 'interrupted'。
 */
function waitForCompletion(
  collector: OutputCollector,
  child: ChildProcess,
  markerPath: string,
  markerBase: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    let settled = false;
    let exitInfo: { code: number | null; signal: string | null } | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let marker: { rc: number; cwd: string } | null = null;

    const settle = (kind: 'done' | 'timeout' | 'interrupted' | 'exited'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      child.off('exit', onExit); // 每次执行的 exit 探针在定稿时摘除（防累积）
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      const collected = collector.finish(kind !== 'done'); // 超时/中断：不 flush 半行
      const exitCode =
        kind === 'done' && marker !== null
          ? marker.rc
          : kind === 'done' && exitInfo !== null
            ? (exitInfo.code ?? -1)
            : collected.exitCode;
      resolve({ ...collected, kind, exitCode, cwd: marker?.cwd ?? null });
    };
    const onMarker = (m: { rc: number; cwd: string }): void => {
      if (settled) return;
      marker = m;
      grace(25, 'done');
    };
    const onExit = (code: number | null, sig: string | null): void => {
      exitInfo = { code, signal: sig };
      if (settled) return;
      grace(25, sig !== null ? 'exited' : 'done');
    };
    const grace = (ms: number, kind: 'done' | 'exited'): void => {
      if (settled) return;
      graceTimer = setTimeout(() => {
        graceTimer = null;
        settle(kind);
      }, ms);
    };
    const onAbort = (): void => {
      if (settled) return;
      settle('interrupted');
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settle('timeout');
    }, timeoutMs);

    // 标记文件轮询：内容 `<base>:rc:<N>:cwd:<path>`（与写入端 printf 严格一致）。
    let readingMarker = false;
    const pollMarker = (): void => {
      if (settled || readingMarker) return;
      readingMarker = true;
      let content = '';
      try {
        content = readFileSync(markerPath, 'utf8');
      } catch {
        // ENOENT/还未写入：继续轮询
      }
      readingMarker = false;
      if (content.length > 0) {
        const s = tryParseSentinel(content.replace(/\n+$/, ''), markerBase);
        if (s !== null) onMarker(s);
      }
    };
    const pollTimer = setInterval(pollMarker, MARKER_POLL_INTERVAL_MS);

    child.once('exit', onExit);
    if (signal !== undefined) {
      if (signal.aborted) {
        settle('interrupted');
        return;
      }
      signal.addEventListener('abort', onAbort);
    }
    // 逃逸舱：已有 exit/已死信号时不出等待（child.once 在 write 前注册过的
    // listener 已带走 exit 事件，这里再查一遍状态兜底，避免停等）
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    }
  });
}

// ---------------------------------------------------------------------------
// 公共工厂
// ---------------------------------------------------------------------------

const RUN_COMMAND_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'Command to run in the persistent workspace shell (bash on posix; powershell/cmd/git-bash on win32). ' +
        'cwd and env persist between calls; the default per-command timeout is 120s and the model may ' +
        'request a longer timeout via timeout_ms (hard cap 900s per ADR-0010); ' +
        'redirect targets are jail-checked (writing outside the workspace is refused).',
    },
    timeout_ms: {
      type: 'integer',
      description:
        `Optional per-command timeout in milliseconds (default ${DEFAULT_SHELL_TIMEOUT_MS}ms; ` +
        `integer in [1, ${MAX_SHELL_TIMEOUT_MS}], hard cap 900s per ADR-0010 — ` +
        'requests above the cap are rejected as invalid arguments).',
    },
  },
  required: ['command'],
};

interface CommandArgument {
  command: string;
  timeoutMs?: number;
}

function parseCommandArgument(call: ToolCall): CommandArgument | { err: ToolResult } {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(call.arguments);
  } catch (err) {
    return {
      err: failShellResult(
        'invalid-tool-arguments',
        `run_command: arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'Arguments must be a JSON object with a "command" string.',
      ),
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      err: failShellResult(
        'invalid-tool-arguments',
        'run_command: arguments must be a JSON object',
        'Arguments must be a JSON object with a "command" string.',
      ),
    };
  }
  const obj = parsed as Record<string, unknown>;
  const command = obj['command'];
  if (typeof command !== 'string' || command.length === 0) {
    return {
      err: failShellResult(
        'invalid-arguments',
        'run_command: "command" must be a non-empty string',
        'Provide the shell command text to run.',
      ),
    };
  }
  const timeoutRaw = obj['timeout_ms'];
  if (timeoutRaw !== undefined) {
    if (
      typeof timeoutRaw !== 'number' ||
      !Number.isInteger(timeoutRaw) ||
      timeoutRaw < 1 ||
      timeoutRaw > MAX_SHELL_TIMEOUT_MS
    ) {
      return {
        err: failShellResult(
          'invalid-arguments',
          `run_command: "timeout_ms" must be an integer in [1, ${MAX_SHELL_TIMEOUT_MS}] ` +
            `(hard cap ${MAX_SHELL_TIMEOUT_MS}ms = 900s per ADR-0010)`,
          'Request the timeout within the documented cap, or omit timeout_ms for the default.',
        ),
      };
    }
  }
  return timeoutRaw === undefined ? { command } : { command, timeoutMs: timeoutRaw as number };
}

export function createPersistentShell(options: ShellToolOptions): PersistentShell {
  const platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  if (platform === 'win32' && process.platform !== 'win32') {
    throw new Error(
      'shell: platform=win32 只允许在 Windows 宿主启用（win32 分支纯函数测试请直接使用 selectWindowsShell/parseRedirectTargets）',
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const sessions = new Map<string, ShellSession>();

  const makeSession = (): ShellSession => ({
    child: null,
    spawned: null,
    spawnError: null,
    dead: false,
    spawnedOnce: false,
    trackedCwd: options.workspaceRoot,
    markerDir: mkdtempSync(join(tmpdir(), 'devmate-shell-')),
    queue: Promise.resolve(undefined),
  });

  /** 单条调用超时：模型申请（timeout_ms，已在参数解析层验证 1..硬上限）优先。 */
  const perCallTimeout = (arg: CommandArgument): number => arg.timeoutMs ?? timeoutMs;

  const execute = async (call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult> => {
    const arg = parseCommandArgument(call);
    if ('err' in arg) return arg.err;
    let session = sessions.get(ctx.sessionId);
    if (session === undefined) {
      session = makeSession();
      sessions.set(ctx.sessionId, session);
    }
    // 每会话串行（并发度 1，§8D）；executeOne 顶层兜底：任何漏网抛错 → 普通结果
    const work = session.queue.then(() =>
      executeOne(session, arg.command, options, perCallTimeout(arg), ctx.signal),
    );
    session.queue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };

  const tool: Tool = {
    name: 'run_command',
    description:
      'Run a shell command in the persistent workspace shell (cwd, env and background ' +
      'processes persist between calls). Returns merged stdout/stderr with [out]/[err] line ' +
      'prefixes and the exit code; hangs are killed after the timeout and the session ' +
      'auto-restarts on the next call. Redirect targets outside the workspace are refused ' +
      '(workspace jail).',
    parameters: RUN_COMMAND_PARAMETERS,
    execute,
  };

  const dispose = async (): Promise<void> => {
    for (const session of sessions.values()) {
      session.dead = true;
      const child = session.child;
      session.child = null;
      if (child !== null) killTree(child);
      rmSync(session.markerDir, { recursive: true, force: true }); // 含未清标记文件
    }
    sessions.clear();
  };

  return { tool, dispose };
}
