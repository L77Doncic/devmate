/**
 * # tools/classify：只读命令白名单与危险分类（接缝 S10；纯函数、无 IO）
 *
 * classify(cmd) 对单条 shell 命令做三档裁定：read-only（免审批）/ ask（须审批）/ deny（拒绝）。
 * 它是「危险操作审批」与许可模式（Auto 后台分类器：风险项改拦截而非提问）的输入之一；
 * 按 CONTEXT「只读命令白名单」与 ADR-0013，判定前先做命令规则化，规则顺序：
 *
 *   1. 剥离包装器层（timeout/time/nice/nohup/stdbuf/command/builtin/xargs）直到命令本体；
 *      xargs 属「参数转发」而非「执行器框架」——`xargs rm` 执行的命令就是剥离后的
 *      本体 rm（`curl|bash` 与 `find|xargs rm` 的危险模式必须按本体裁定），与第 4 条
 *      「执行器组合（npx/docker exec/...）」的显式枚举语义是两回事（后者是"套壳"：
 *      `devbox run rm` 执行的是 devbox 包装下的非 PATH 裸动作，不能按 `rm` 放行）；
 *   2. 复合命令（&& / || / ; / | 管道 / & 后台）逐段判定——任一段不顺则整体降级
 *      （deny > ask > read-only）；
 *   3. 重定向（> >> 2> 2>> &> 等）目标按写入对待——含写重定向至少 ask；
 *      豁免：目标为 /dev/null（丢弃 sink，无持久写）、fd 复制（2>&1）、fd 关闭（2>&-）；
 *      </<< 输入重定向不写文件，不触发审批（并满足「无文件参数会挂起 stdin」规则）；
 *   4. 执行器（npx / docker exec / devbox run / mise exec / direnv exec 等）不在剥离名单内
 *      ——「runner + 内部命令」组合在 v1 无免审批：内部命令命中危险名单则 deny，
 *      其余一律 ask（`Bash(devbox run *)` 不等于放行 `devbox run rm -rf .`）；
 *   5. 变量赋值前缀（FOO=1 cmd / env FOO=1 cmd）不得豁免 deny，且白名单穿透被禁止：
 *      `FOO=1 ls` 至少 ask；$(...) / 反引号 / <(...) 内的命令按自身规则裁定；
 *      sudo 提权至少 ask；
 *   6. 危险本体（rm、dd、mkfs 及 mkfs.* 族、shutdown、reboot、find -delete/-exec、
 *      chmod -R、git clean / reset --hard / branch -d、管道接收端 shell（curl|bash）等）→ deny；
 *   7. 未知命令 → ask（不放行不明命令；白名单只放行「明显只读 + 目标在界内」）。
 *
 * 安全定位（tripwire）：字符串判定是官方明确定性的 tripwire（"a tripwire for obvious
 * mistakes, not an enforcement boundary"），真正的防线是隔离（ADR-0013 三层基线的沙箱层）
 * 与预算——本模块只负责免审批区间与审批/拦截分档，不构成安全边界。已知限制：
 * git 别名、PATH 可替换二进制、脚本内容（sh script.sh、python -c…）无法静态看穿——
 * 一律 ask；白名单为初版参考群（ls/cat/head/tail/grep/find/stat/wc/pwd/whoami/env +
 * 只读 git 子命令及 blame/grep/show-ref/rev-parse/describe；find 深度不限，交资源层），
 * 过严可调（cd、echo 等按未知命令 ask），过松不行。工作区监狱边界判定（realpath、
 * 符号链接两端同检）由监狱层执行，本模块仅按「目标不越界」的语形代理：
 * 绝对路径 / .. 前缀 / ~ 前缀 → 疑似界外 → ask；git 的仓库定位值
 * （-C / --git-dir / --work-tree）同口径——`git -C /tmp status` 不得判只读
 * （越界读；局限：classify 无 jail，真实判定归监狱层）。
 */

export type Verdict = 'read-only' | 'ask' | 'deny';

/** 逐段评定：复合命令/管道/含分隔符的命令拆成多段后的单段结果。 */
export interface CommandSegment {
  /** 原样子命令文本（去首尾空白；不含分隔符）。 */
  text: string;
  /** 剥离包装器/变量前缀/执行器框架后到达的命令本体（ls / rm / git / npx 内部命令…）。 */
  command: string;
  verdict: Verdict;
  /** 该段被判非 read-only 的原因（read-only 段为空数组）。 */
  reasons: string[];
}

export interface Classification {
  /** 段级裁定聚合：任一段 deny → deny；任一段 ask → ask；全只读 → read-only。 */
  verdict: Verdict;
  /** 非 read-only 时的去重原因列表（read-only 时省略）。 */
  reasons?: string[];
  /** 逐段评定（恒给出：单段也逐段评定——每段含 text/command/verdict/reasons）。 */
  segments?: CommandSegment[];
}

// ---------------------------------------------------------------------------
// 裁定聚合
// ---------------------------------------------------------------------------

const RANK: Record<Verdict, number> = { deny: 2, ask: 1, 'read-only': 0 };

function worst(a: Verdict, b: Verdict): Verdict {
  return RANK[a] >= RANK[b] ? a : b;
}

/** 包裹层（sudo/执行器/shell/变量前缀/规则逃逸入口）：只读不保留，deny 不放松。 */
function escalate(v: Verdict): Verdict {
  return v === 'deny' ? 'deny' : 'ask';
}

// ---------------------------------------------------------------------------
// 词法：分词（引号感知）、复合分割、重定向、命令替换
// ---------------------------------------------------------------------------

interface RawToken {
  text: string;
  /** 含引号/转义：引号内的运算符不属于语法重定向。 */
  quoted: boolean;
}

/** 引号感知分词：单引号/双引号/反斜杠转义；引号未配对则 ok=false。 */
function tokenize(text: string): { tokens: RawToken[]; ok: boolean } {
  const tokens: RawToken[] = [];
  let cur = '';
  let curQuoted = false;
  let state: 'normal' | 'sq' | 'dq' | 'esc' = 'normal';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    switch (state) {
      case 'normal':
        if (ch === "'") {
          curQuoted = true;
          state = 'sq';
        } else if (ch === '"') {
          curQuoted = true;
          state = 'dq';
        } else if (ch === '\\') {
          curQuoted = true;
          state = 'esc';
        } else if (ch === ' ' || ch === '\t') {
          if (cur.length > 0) {
            tokens.push({ text: cur, quoted: curQuoted });
            cur = '';
            curQuoted = false;
          }
        } else {
          cur += ch;
        }
        break;
      case 'sq':
        if (ch === "'") state = 'normal';
        else cur += ch;
        break;
      case 'dq':
        if (ch === '"') state = 'normal';
        else if (ch === '\\') {
          const next = text[i + 1];
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            cur += next!;
            i += 1;
          } else {
            cur += ch;
          }
        } else cur += ch;
        break;
      case 'esc':
        cur += ch;
        state = 'normal';
        break;
    }
  }
  if (state !== 'normal') return { tokens: [], ok: false };
  if (cur.length > 0) tokens.push({ text: cur, quoted: curQuoted });
  return { tokens, ok: true };
}

interface SegmentRaw {
  text: string;
  /** 该段是否紧随管道（stdin 已由上游供给）。 */
  pipedFrom: boolean;
}

/**
 * 顶层复合分割：&& / || / ; / | / |& / & / 换行处分割；引号内与
 * `$(...)` / `<(...)` / `>(...)` / 反引号内不分割（只按「括号/引号可能早闭即分割」的
 * 语形近似——即便早闭导致分割错位，逐段与替换体内命令仍会各自裁定，方向只会更严）。
 * 引号/替换未配对 → balanced=false。
 */
function splitSegments(cmd: string): { segments: SegmentRaw[]; balanced: boolean } {
  const segments: SegmentRaw[] = [];
  let cur = '';
  let state: 'normal' | 'sq' | 'dq' = 'normal';
  let subDepth = 0;
  let piped = false;
  let balanced = true;

  const push = (): void => {
    const text = cur.trim();
    if (text.length > 0) segments.push({ text, pipedFrom: piped });
    cur = '';
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (state === 'sq') {
      cur += ch;
      if (ch === "'") state = 'normal';
      continue;
    }
    if (state === 'dq') {
      cur += ch;
      if (ch === '\\') {
        cur += cmd[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        state = 'normal';
      } else if (ch === '`') {
        // 双引号内反引号仍执行替换：整段保住（含中间内容——丢失会让替换体
        // 缺字，替换提取跟着失真），跳到下一个未转义反引号
        let j = i + 1;
        while (j < cmd.length) {
          if (cmd[j] === '\\') j += 2;
          else if (cmd[j] === '`') {
            // 开头的 ` 已被状态机入口的 cur += ch 收入，这里只补中间内容与闭合 `
            cur += cmd.slice(i + 1, j + 1);
            i = j;
            break;
          } else j += 1;
        }
        if (j >= cmd.length) balanced = false;
        continue;
      }
      continue;
    }
    if (ch === '\\') {
      cur += ch;
      cur += cmd[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = 'sq';
      cur += ch;
      continue;
    }
    if (ch === '"') {
      state = 'dq';
      cur += ch;
      continue;
    }
    if (ch === '$' && cmd[i + 1] === '(') {
      subDepth += 1;
      cur += '$(';
      i += 1;
      continue;
    }
    if ((ch === '<' || ch === '>') && cmd[i + 1] === '(') {
      subDepth += 1;
      cur += ch + '(';
      i += 1;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      let closed = false;
      while (j < cmd.length) {
        if (cmd[j] === '\\') j += 2;
        else if (cmd[j] === '`') {
          closed = true;
          break;
        } else j += 1;
      }
      if (!closed) {
        balanced = false;
        cur += ch;
        continue;
      }
      cur += cmd.slice(i, j + 1);
      i = j;
      continue;
    }
    if (subDepth > 0) {
      cur += ch;
      if (ch === '(') subDepth += 1;
      if (ch === ')') subDepth -= 1;
      continue;
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      push();
      piped = false;
      i += 1;
      continue;
    }
    if (ch === '&' && (cmd[i + 1] === '>' || cmd[i - 1] === '<' || cmd[i - 1] === '>')) {
      // '&>' 重定向与 '2>&1' 之类的 fd 复制/关闭：不是后台分隔符
      cur += ch;
      continue;
    }
    if (ch === '|' && cmd[i + 1] === '|') {
      push();
      piped = false;
      i += 1;
      continue;
    }
    if (ch === '|' && cmd[i + 1] === '&') {
      push();
      piped = true;
      i += 1;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n' || ch === '\r') {
      if (ch === '|' || ch === '&') piped = ch === '|';
      push();
      continue;
    }
    cur += ch;
  }
  if (state !== 'normal' || subDepth > 0) balanced = false;
  push();
  return { segments, balanced };
}

// --- 命令替换提取 ------------------------------------------------------------

/**
 * 提取 $(...) / `...` / <(...) / >(...) 的命令文本；未配对 → balanced=false。
 *
 * 引号语义（shell 规则，安全关键）：
 * - 单引号内**任何都不执行**（$()/``/<() 全是字面量）——整段跳过；
 * - 双引号内 **$(...) 与 `` 仍被执行**（替换发生在引号内，`"$(rm -rf .)"` 的
 *   内命令会被 shell 执行——若跳过引号区，这类命令会被误判为只读，E2E 实证漏洞）；
 * - 双引号内 <(...) / >(...) 是字面量（进程替换不在引号内识别）——不提取。
 */
function extractSubstitutions(text: string): { subs: string[]; balanced: boolean } {
  const subs: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'") j += 1;
      if (j >= text.length) return { subs, balanced: false };
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const c = text[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          j += 1;
          break;
        }
        if (c === '$' && text[j + 1] === '(') {
          const { body, end } = readParen(text, j + 2);
          if (end < 0) return { subs, balanced: false };
          subs.push(body);
          j = end + 1; // 引号内可能还有更多 $()/``
          continue;
        }
        if (c === '`') {
          let k = j + 1;
          while (k < text.length) {
            if (text[k] === '\\') k += 2;
            else if (text[k] === '`') break;
            else k += 1;
          }
          if (k >= text.length) return { subs, balanced: false };
          subs.push(text.slice(j + 1, k));
          j = k + 1;
          continue;
        }
        j += 1;
      }
      if (!closed) return { subs, balanced: false };
      i = j - 1;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      const { body, end } = readParen(text, i + 2);
      if (end < 0) return { subs, balanced: false };
      subs.push(body);
      i = end - 1;
      continue;
    }
    if ((ch === '<' || ch === '>') && text[i + 1] === '(') {
      const { body, end } = readParen(text, i + 2);
      if (end < 0) return { subs, balanced: false };
      subs.push(body);
      i = end - 1;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '`') break;
        else j += 1;
      }
      if (j >= text.length) return { subs, balanced: false };
      subs.push(text.slice(i + 1, j));
      i = j;
      continue;
    }
  }
  return { subs, balanced: true };
}

/** 从 open 位置读括号体（引号/转义感知）；返回值未配对 → end=-1。 */
function readParen(text: string, open: number): { body: string; end: number } {
  let depth = 1;
  let i = open;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'") j += 1;
      if (j >= text.length) return { body: '', end: -1 };
      i = j;
    } else if (ch === '"') {
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === '"') break;
        else i += 1;
      }
      if (i >= text.length) return { body: '', end: -1 };
    } else if (ch === '\\') {
      i += 2;
      continue;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open, i), end: i };
    }
    i += 1;
  }
  return { body: '', end: -1 };
}

// --- 重定向解析 ---------------------------------------------------------------

type RedirectOp = '>' | '>>' | '>|' | '&>' | '&>>' | '<' | '<<' | '<<<' | '<>' | '>&' | '<&';

interface ParsedRedirect {
  op: RedirectOp;
  /** 粘连目标；空 = 从下一 token 取。 */
  target: string;
}

// 备选次序即优先（最长/特异优先）：>& 必须先于 >（2>&1 → fd 复制豁免，万万不可
// 被解析成「> 写 &1」）；<<< 先于 <<；<> 先于 <；>| 不在此表——它有带目标的读写
// 语义，但按 `>` 匹配已保证「写方向至少 ask」（不会只读），方向只严不松。
const REDIRECT_RE = /^(\d+|&)(>>|>&|<<<|<>|<<|<&|>|<)(.*)$|^(>>|>&|<<<|<>|<<|<&|>|<)(.*)$/;

function parseRedirectToken(tok: string): ParsedRedirect | null {
  const m = tok.match(REDIRECT_RE);
  if (!m) return null;
  const op = (m[2] ?? m[4]) as RedirectOp;
  const target = m[3] ?? m[5] ?? '';
  return { op, target };
}

/** 目标为数字/&-/-时是 fd 复制/关闭（非文件写）。 */
function isFdDupOrClose(target: string): boolean {
  return /^&?-?\d+$/.test(target) || target === '&' || target === '-';
}

/** 扫描令牌流：区分写重定向（须审批）/ fd 复制与 /dev/null（豁免）/ 输入重定向。 */
function scanRedirects(tokens: RawToken[]): {
  writeTargets: string[];
  inputRedirect: boolean;
  kept: RawToken[];
} {
  const writeTargets: string[] = [];
  let inputRedirect = false;
  const kept: RawToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.quoted) {
      kept.push(tok);
      continue;
    }
    if (tok.text.startsWith('<(') || tok.text.startsWith('>(')) {
      kept.push(tok); // 进程替换不是重定向
      continue;
    }
    const parsed = parseRedirectToken(tok.text);
    if (!parsed) {
      kept.push(tok);
      continue;
    }
    const { op } = parsed;
    let target = parsed.target;
    if (target === '') {
      const next = tokens[i + 1];
      if (next) {
        target = next.text;
        i += 1;
      } else {
        target = '(未给出目标)';
      }
    }
    if (op === '>' || op === '>>' || op === '>|' || op === '&>' || op === '&>>' || op === '<>') {
      if (target === '/dev/null') continue; // 丢弃 sink：无持久写，豁免
      writeTargets.push(target);
      continue;
    }
    if (op === '>&' || op === '<&') {
      if (isFdDupOrClose(target)) continue; // fd 复制/关闭：不写文件
      if (target === '/dev/null') continue;
      if (op === '>&') writeTargets.push(target);
      else inputRedirect = true;
      continue;
    }
    // < << <<<：输入重定向（heredoc 内联体不写文件；/dev/null 与 fd 复制同样满足「stdin 已接」）
    inputRedirect = true;
  }
  return { writeTargets, inputRedirect, kept };
}

// ---------------------------------------------------------------------------
// 常量集
// ---------------------------------------------------------------------------

const WRAPPERS: Record<string, { flagArgs: string[] }> = {
  timeout: { flagArgs: ['-s', '--signal', '-k', '--kill-after'] },
  nice: { flagArgs: ['-n', '--adjustment'] },
  nohup: { flagArgs: [] },
  stdbuf: { flagArgs: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  command: { flagArgs: [] },
  builtin: { flagArgs: [] },
  xargs: { flagArgs: ['-n', '-L', '-d', '-E', '-a', '-s', '-I', '-P'] },
};

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'csh', 'tcsh', 'fish']);

const INTERPRETERS = new Set([
  'python',
  'python2',
  'python3',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'lua',
  'tsx',
  'Rscript',
  'julia',
]);

const DENY_COMMANDS = new Set([
  'rm',
  'unlink',
  'rmdir',
  'dd',
  'mkswap',
  'fdisk',
  'sfdisk',
  'cfdisk',
  'parted',
  'wipefs',
  'shutdown',
  'poweroff',
  'reboot',
  'halt',
  'init',
  'killall',
  'pkill',
  'chmod',
]);

/** 只读白名单初版参考群（命令名即 PATH 裸名；绝对路径调用解析不到 → 按未知命令 ask）。 */
const WHITELIST: Record<string, { flagArgs: string[]; stdinReads: boolean }> = {
  ls: { flagArgs: [], stdinReads: false },
  cat: { flagArgs: [], stdinReads: true },
  head: { flagArgs: ['-n', '-c', '--lines', '--bytes'], stdinReads: true },
  tail: { flagArgs: ['-n', '-c', '--lines', '--bytes'], stdinReads: true },
  grep: {
    flagArgs: [
      '-f',
      '--file',
      '-e',
      '--regexp',
      '-m',
      '--max-count',
      '-A',
      '-B',
      '-C',
      '--after-context',
      '--before-context',
      '--context',
    ],
    stdinReads: false, // grep 的 stdin 语义特殊：见 grepRule
  },
  stat: { flagArgs: ['-c', '--format', '--printf'], stdinReads: false },
  wc: { flagArgs: [], stdinReads: true },
  pwd: { flagArgs: [], stdinReads: false },
  whoami: { flagArgs: [], stdinReads: false },
  find: { flagArgs: [], stdinReads: false }, // find 的具体参数约束在 findRule
};

const GIT_READONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'ls-files',
  'blame',
  'grep',
  'show-ref',
  'rev-parse',
  'describe',
]);

const GIT_MUTATING = new Set([
  'add',
  'commit',
  'checkout',
  'switch',
  'restore',
  'stash',
  'merge',
  'rebase',
  'pull',
  'push',
  'fetch',
  'apply',
  'cherry-pick',
  'tag',
  'clone',
  'init',
  'remote',
  'config',
  'mv',
  'cp',
  'update-index',
  'gc',
  'fsck',
  'prune',
  'maintenance',
  'revert',
  'am',
]);

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

export function classify(cmd: string): Classification {
  const { segments, balanced } = splitSegments(cmd);
  if (!balanced) {
    return { verdict: 'ask', reasons: ['命令解析失败：引号/括号未配对'] };
  }
  if (segments.length === 0) {
    return { verdict: 'ask', reasons: ['命令为空'] };
  }
  const verdicts = segments.map((s) => classifySegment(s.text, s.pipedFrom));
  let verdict: Verdict = 'read-only';
  const allReasons: string[] = [];
  for (const v of verdicts) {
    verdict = worst(verdict, v.verdict);
    if (v.verdict !== 'read-only') allReasons.push(...v.reasons);
  }
  const segmentOut: CommandSegment[] = verdicts.map((v) => ({
    text: v.text,
    command: v.command,
    verdict: v.verdict,
    reasons: v.verdict === 'read-only' ? [] : v.reasons,
  }));
  if (verdict === 'read-only') {
    return { verdict, segments: segmentOut };
  }
  return {
    verdict,
    reasons: [...new Set(allReasons)],
    segments: segmentOut,
  };
}

interface Ctx {
  pipedFrom: boolean;
  inputRedirect: boolean;
}

function classifySegment(text: string, pipedFrom: boolean): CommandSegment {
  const { subs, balanced } = extractSubstitutions(text);
  if (!balanced) {
    return { text, command: '', verdict: 'ask', reasons: ['命令解析失败：替换未闭合'] };
  }
  let substitutionsVerdict: Verdict = 'read-only';
  for (const body of subs) {
    substitutionsVerdict = worst(substitutionsVerdict, classify(body).verdict);
  }
  const { tokens, ok } = tokenize(text);
  if (!ok) {
    return { text, command: '', verdict: 'ask', reasons: ['命令解析失败：引号未配对'] };
  }
  const { writeTargets, inputRedirect, kept } = scanRedirects(tokens);
  const ctx: Ctx = { pipedFrom, inputRedirect };

  let toks = kept;
  // 1) 直至稳定：剥离变量赋值前缀 + 打包器层（可交替出现）
  let varPrefix = false;
  for (;;) {
    const preStrip = stripAssignments(toks);
    if (preStrip.any) {
      varPrefix = true;
      toks = preStrip.rest;
      continue;
    }
    const wrapped = stripWrapper(toks);
    if (wrapped === null) break;
    toks = wrapped;
  }

  const base =
    toks.length === 0
      ? { command: '', verdict: 'ask' as Verdict, reasons: ['命令本体为空'] }
      : dispatch(toks, ctx);

  const reasons = [...base.reasons];
  let verdict = base.verdict;
  // 2) 变量赋值前缀：白名单穿透禁止——至少 ask（deny 不放松）
  if (varPrefix && verdict !== 'deny') {
    verdict = 'ask';
    reasons.push('变量赋值前缀后的命令不得免审批');
  }
  // 3) 命令替换：内部命令按自身裁定聚合
  if (substitutionsVerdict !== 'read-only' && verdict !== 'deny') {
    verdict = worst(verdict, substitutionsVerdict);
    if (substitutionsVerdict === 'deny') {
      reasons.push('$(...) / 反引号 / <(...) 内的命令被执行且含危险命令');
    } else {
      reasons.push('$(...) / 反引号 / <(...) 内的命令须审批');
    }
  } else if (substitutionsVerdict === 'deny') {
    verdict = 'deny';
    reasons.push('$(...) / 反引号 / <(...) 内的命令被执行且含危险命令');
  }
  // 4) 重定向按写入对待：至少 ask（deny 优先）
  if (writeTargets.length > 0 && verdict !== 'deny') {
    verdict = 'ask';
    for (const target of writeTargets) {
      reasons.push(`重定向写入 ${target} 须审批`);
    }
  }
  return {
    text,
    command: base.command || toks[0]?.text || '',
    verdict,
    reasons: verdict === 'read-only' ? [] : reasons,
  };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

interface DispatchResult {
  command: string;
  verdict: Verdict;
  reasons: string[];
}

/** 剥离变量赋值前缀（FOO=1 / VAR="a b"）。 */
function stripAssignments(tokens: RawToken[]): { any: boolean; rest: RawToken[] } {
  const rest: RawToken[] = [...tokens];
  let any = false;
  while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!.text)) {
    any = true;
    rest.shift();
  }
  return { any, rest };
}

/**
 * 剥离一层包装器（timeout/time/nice/nohup/stdbuf/command/builtin/xargs）。
 * 返回剥离后的剩余令牌；null = 首词不是包装器（或形式不合法）。
 */
function stripWrapper(tokens: RawToken[]): RawToken[] | null {
  if (tokens.length === 0) return null;
  const name = tokens[0]!.text;
  const spec = WRAPPERS[name];
  if (!spec) return null;
  let i = 1;
  while (i < tokens.length && tokens[i]!.text.startsWith('-') && tokens[i]!.text.length > 1) {
    const flag = tokens[i]!.text;
    if (flag === '--') {
      i += 1;
      break;
    }
    if (spec.flagArgs.includes(flag)) i += 1; // 该 flag 消耗下一 token
    i += 1;
  }
  if (name === 'timeout') {
    const duration = tokens[i];
    if (!duration || !/^\d+(\.\d+)?(s|m|h|d)?$/i.test(duration.text)) return null;
    i += 1;
  }
  return tokens.slice(i);
}

/** 命令分发：危险名单 → sudo/shell/解释器 → chmod → git → env → 执行器 → 白名单 → 未知。 */
function dispatch(tokens: RawToken[], ctx: Ctx): DispatchResult {
  const name = tokens[0]!.text;
  if (DENY_COMMANDS.has(name) || /^mkfs(\.\w+)?$/.test(name)) {
    if (name === 'chmod') {
      return hasFlag(tokens.slice(1), ['-R', '--recursive'])
        ? { command: name, verdict: 'deny', reasons: ['chmod -R 递归修改权限（破坏性）'] }
        : { command: name, verdict: 'ask', reasons: ['chmod 修改文件权限，须审批'] };
    }
    return {
      command: name,
      verdict: 'deny',
      reasons: [`${name} 是危险命令（不可恢复的破坏性操作）`],
    };
  }
  if (name === 'sudo') return sudoRule(tokens);
  if (SHELLS.has(name)) return shellRule(tokens, ctx);
  if (INTERPRETERS.has(name)) return interpreterRule(name, tokens, ctx);
  if (name === 'git') return gitRule(tokens, ctx);
  if (name === 'env') return envRule(tokens, ctx);
  if (
    name === 'npx' ||
    name === 'docker' ||
    name === 'podman' ||
    name === 'devbox' ||
    name === 'mise' ||
    name === 'direnv'
  ) {
    return executorRule(name, tokens);
  }
  if (name in WHITELIST) return whitelistRule(name, tokens, ctx);
  return {
    command: name,
    verdict: 'ask',
    reasons: [`未知命令 ${name} 未在白名单内（不放行不明命令）`],
  };
}

function hasFlag(tokens: RawToken[], flags: string[]): boolean {
  return tokens.some((t) => flags.includes(t.text));
}

function interpretInner(command: string, innerTokens: RawToken[], inner: string): DispatchResult {
  const v = classify(inner).verdict;
  return {
    command: innerTokens[0]?.text || command,
    verdict: escalate(v),
    reasons: [
      v === 'deny'
        ? `${command} 内部命令为危险命令（执行器组合不在剥离名单内）`
        : `${command} 内部命令未枚举免审批组合，须审批`,
    ],
  };
}

// --- sudo ---------------------------------------------------------------------

function sudoRule(tokens: RawToken[]): DispatchResult {
  const { args, interactive } = consumeFlags(tokens.slice(1), [
    '-u',
    '-U',
    '-g',
    '-p',
    '-C',
    '-H',
    '-h',
    '-V',
  ]);
  if (interactive) {
    return { command: 'sudo', verdict: 'deny', reasons: ['sudo -i/-s：提权交互 shell'] };
  }
  if (args.length === 0) {
    return { command: 'sudo', verdict: 'ask', reasons: ['sudo 提权须审批'] };
  }
  const inner = args.map((t) => t.text).join(' ');
  const v = classify(inner).verdict;
  return {
    command: 'sudo',
    verdict: escalate(v),
    reasons: [v === 'deny' ? 'sudo 提权执行的命令为危险命令' : 'sudo 提权须审批'],
  };
}

// --- shell / 解释器 ------------------------------------------------------------

/**
 * 脚本提取：`-c <script>`、选项簇中含 `-c` 的（`-lc`/`-lcs`/`-cs`/`-cl` ——
 * bash 语义：簇内 c 后的字符仍是选项，-c 的脚本取**下一个 argv**，已实测钉住；
 * `-l` 登录选项与 `-c` 组合如 `bash -lc 'rm -rf x'` 只认 -c 会漏判——E2E 实证漏洞）。
 * 无脚本返回 null（落到交互/管道判定分支）。
 */
function takeShellScript(arg: string, next: string | null): string | null {
  if (arg === '-c' || /^-l?c[A-Za-z]*$/.test(arg)) {
    return next !== null && next.length > 0 ? next : null;
  }
  return null;
}

function shellRule(tokens: RawToken[], ctx: Ctx): DispatchResult {
  const name = tokens[0]!.text;
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const script = takeShellScript(args[i]!.text, args[i + 1]?.text ?? null);
    if (script !== null) {
      const v = classify(script).verdict;
      return {
        command: name,
        verdict: escalate(v),
        reasons: [v === 'deny' ? `${name} -c 脚本含危险命令` : `${name} -c 脚本内命令须审批`],
      };
    }
  }
  if (args.some((t) => ['-i', '--interactive', '-l', '--login'].includes(t.text))) {
    return { command: name, verdict: 'ask', reasons: [`${name} 交互命令（常驻会话禁止交互）`] };
  }
  if (args.some((t) => t.text === '-s' || t.text === '-')) {
    return ctx.pipedFrom
      ? {
          command: name,
          verdict: 'deny',
          reasons: [`${name} 以管道内容作脚本执行（curl|${name} 模式）`],
        }
      : {
          command: name,
          verdict: 'ask',
          reasons: [`${name} 从 stdin 读脚本（等待输入/执行任意外部内容）`],
        };
  }
  if (!args.some((t) => !t.text.startsWith('-'))) {
    return ctx.pipedFrom
      ? {
          command: name,
          verdict: 'deny',
          reasons: [`${name} 以管道内容作脚本执行（curl|${name} 模式）`],
        }
      : {
          command: name,
          verdict: 'ask',
          reasons: [`${name} 裸 shell 等待 stdin（常驻会话将挂起）或执行任意外部内容`],
        };
  }
  return { command: name, verdict: 'ask', reasons: [`${name} 执行脚本文件（内容不可静态研判）`] };
}

function interpreterRule(name: string, tokens: RawToken[], ctx: Ctx): DispatchResult {
  const hasSource = tokens.slice(1).some((t) => !t.text.startsWith('-') || t.text === '-');
  if (!hasSource) {
    return ctx.pipedFrom
      ? {
          command: name,
          verdict: 'deny',
          reasons: [`${name} 以管道内容作脚本执行（curl|${name} 模式）`],
        }
      : {
          command: name,
          verdict: 'ask',
          reasons: [`${name} 无参数等待 stdin/解释执行，无法静态研判`],
        };
  }
  return { command: name, verdict: 'ask', reasons: [`${name} 解释执行未知代码，须审批`] };
}

// --- env（print / execute 双形态）---------------------------------------------

function envRule(tokens: RawToken[], _ctx: Ctx): DispatchResult {
  const { args } = consumeFlags(tokens.slice(1), [
    '-u',
    '--unset',
    '-C',
    '--chdir',
    '-S',
    '--split-string',
  ]);
  const command = args.filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text));
  if (command.length === 0) {
    return { command: 'env', verdict: 'read-only', reasons: [] }; // 纯环境打印
  }
  const inner = command.map((t) => t.text).join(' ');
  const v = classify(inner).verdict;
  return {
    command: 'env',
    verdict: escalate(v),
    reasons: [
      v === 'deny' ? 'env 执行形态的内部命令为危险命令' : 'env 执行形态（变量前缀）不得免审批',
    ],
  };
}

// --- git ----------------------------------------------------------------------

function gitRule(tokens: RawToken[], _ctx: Ctx): DispatchResult {
  const args = tokens.slice(1);
  let i = 0;
  let sub: string | null = null;
  // -C / --git-dir / --work-tree 的**值**是仓库定位路径（-c 是配置键值，非路径）。
  // 路径形态启发式（classify 无 jail，真实 realpath 判定在监狱层）：「目标在界内」
  // 口径要求值不得为绝对路径 / .. 前缀 / ~ 前缀，否则至少 ask——`git -C /tmp
  // status` 判只读 = 越界读（E2E 实证）。局限：非路径值（如 `-C -c` 怪形）与
  // 词法外的排列不作穷举，方向只会更严。
  const dirish: string[] = [];
  while (i < args.length) {
    const a = args[i]!.text;
    if (a === '--') {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
        const value = args[i + 1];
        if (value) {
          dirish.push(value.text);
          i += 1;
        }
      } else if (a === '-c') {
        i += 1; // 配置键=值（key=value），非路径
      } else if (a.startsWith('--git-dir=')) {
        dirish.push(a.slice('--git-dir='.length));
      } else if (a.startsWith('--work-tree=')) {
        dirish.push(a.slice('--work-tree='.length));
      } else if (a.startsWith('-C') && a.length > 2) {
        dirish.push(a.slice(2)); // 粘连形 -C/tmp
      }
      i += 1;
      continue;
    }
    sub = a;
    i += 1;
    break;
  }
  if (!sub) {
    return { command: 'git', verdict: 'ask', reasons: ['git 缺少子命令（不进行子命令猜测）'] };
  }
  const bad = dirish.filter((p) => isOutOfJailPath(p));
  if (bad.length > 0) {
    return {
      command: 'git',
      verdict: 'ask',
      reasons: bad.map((p) => `git 参数 ${p} 疑似界外（工作区监狱以外）`),
    };
  }
  const rest = args.slice(i);
  if (sub === 'branch') return gitBranchRule(rest);
  if (sub === 'clean') {
    return { command: 'git', verdict: 'deny', reasons: ['git clean 删除未跟踪文件（不可恢复）'] };
  }
  if (sub === 'reset') {
    return args.some((t) => t.text.includes('--hard'))
      ? {
          command: 'git',
          verdict: 'deny',
          reasons: ['git reset --hard 丢弃工作区修改（不可恢复）'],
        }
      : { command: 'git', verdict: 'ask', reasons: ['git reset 移动当前分支指针，须审批'] };
  }
  if (sub === 'rm') {
    return args.some((t) => t.text === '--cached')
      ? { command: 'git', verdict: 'ask', reasons: ['git rm --cached 从索引移除，须审批'] }
      : { command: 'git', verdict: 'deny', reasons: ['git rm 删除工作区文件（不可恢复）'] };
  }
  if (GIT_READONLY.has(sub)) {
    const bad = outOfJailArgs(rest);
    return bad.length > 0
      ? {
          command: 'git',
          verdict: 'ask',
          reasons: bad.map((p) => `git 参数 ${p} 疑似界外（工作区监狱以外）`),
        }
      : { command: 'git', verdict: 'read-only', reasons: [] };
  }
  if (GIT_MUTATING.has(sub)) {
    return { command: 'git', verdict: 'ask', reasons: [`git ${sub} 改变仓库/远端状态，须审批`] };
  }
  return {
    command: 'git',
    verdict: 'ask',
    reasons: [`git 子命令 ${sub} 不在只读/已知清单，须审批`],
  };
}

function gitBranchRule(args: RawToken[]): DispatchResult {
  const destructive = new Set([
    '-d',
    '-D',
    '--delete',
    '-m',
    '-M',
    '--move',
    '-f',
    '--force',
    '-c',
    '-C',
  ]);
  let positional = false;
  let destructiveFlag = false;
  let unknownFlag = false;
  for (const a of args) {
    const t = a.text;
    if (t.startsWith('-')) {
      if (destructive.has(t)) destructiveFlag = true;
      else if (
        [
          '-a',
          '-r',
          '-v',
          '--list',
          '--all',
          '--remotes',
          '--verbose',
          '--no-color',
          '--merged',
          '--no-merged',
        ].includes(t) ||
        t.startsWith('--sort') ||
        t.startsWith('--points-at')
      ) {
        // 列表模式标志
      } else {
        unknownFlag = true;
      }
    } else {
      positional = true;
    }
  }
  if (destructiveFlag) {
    return {
      command: 'git',
      verdict: 'deny',
      reasons: ['git branch 删除/移动/强制改动分支（不可恢复）'],
    };
  }
  if (positional) {
    return {
      command: 'git',
      verdict: 'ask',
      reasons: ['git branch 携带分支名（新建/改名分支），须审批'],
    };
  }
  if (unknownFlag) {
    return { command: 'git', verdict: 'ask', reasons: ['git branch 不明标志，须审批'] };
  }
  return { command: 'git', verdict: 'read-only', reasons: [] };
}

// --- 执行器（npx / docker / podman / devbox / mise / direnv）-------------------

function executorRule(name: string, tokens: RawToken[]): DispatchResult {
  if (name === 'npx') return npxRule(tokens);
  if (name === 'docker' || name === 'podman') return dockerRule(name, tokens);
  if (name === 'devbox') return devboxRule(tokens);
  return genericExecutorRule(name, tokens);
}

function npxRule(tokens: RawToken[]): DispatchResult {
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.text;
    if ((a === '-c' || a === '--call') && args[i + 1]) {
      const v = classify(args[i + 1]!.text).verdict;
      return {
        command: 'npx',
        verdict: escalate(v),
        reasons: [
          v === 'deny' ? 'npx -c 内部 shell 命令含危险命令' : 'npx -c 执行 shell 命令，须审批',
        ],
      };
    }
  }
  const positionals = args.filter((t) => !t.text.startsWith('-'));
  if (positionals.length === 0) {
    return { command: 'npx', verdict: 'ask', reasons: ['npx 裸调用须审批（下载并执行包）'] };
  }
  const inner = positionals[0]!.text;
  const v = classify(inner).verdict;
  return {
    command: inner,
    verdict: escalate(v),
    reasons: [
      v === 'deny'
        ? `npx 内部命令 ${inner} 为危险命令`
        : `npx 内部命令 ${inner} 未在白名单枚举（执行器组合必须显式枚举）`,
    ],
  };
}

function dockerRule(name: string, tokens: RawToken[]): DispatchResult {
  const { args } = consumeFlags(tokens.slice(1), ['-H', '--host', '-c', '--context']);
  const sub = args.length > 0 ? args[0]!.text : null;
  if (!sub) {
    return { command: name, verdict: 'ask', reasons: [`${name} 缺少子命令，须审批`] };
  }
  if (sub === 'exec') {
    const innerTokens = dockerExecTokens(args.slice(1));
    if (innerTokens.length === 0) {
      return { command: name, verdict: 'ask', reasons: [`${name} exec 缺少内部命令，须审批`] };
    }
    return interpretInner(name, innerTokens, innerTokens.map((t) => t.text).join(' '));
  }
  if (sub === 'run' || sub === 'runi' || sub === 'runb') {
    return {
      command: name,
      verdict: 'ask',
      reasons: [`${name} run 启动容器（网络/挂载面），须审批`],
    };
  }
  if (
    [
      'rm',
      'rmi',
      'stop',
      'kill',
      'pause',
      'restart',
      'update',
      'pull',
      'build',
      'commit',
      'save',
      'load',
      'push',
      'network',
      'volume',
    ].includes(sub)
  ) {
    return { command: name, verdict: 'ask', reasons: [`${name} ${sub} 改变容器/镜像状态，须审批`] };
  }
  // ps/images/inspect/logs/version/stats 等「读类」子命令：v1 未枚举为免审批，宁可多问
  return {
    command: name,
    verdict: 'ask',
    reasons: [`${name} ${sub} 未在白名单枚举（执行器组合必须显式枚举）`],
  };
}

function dockerExecTokens(rest: RawToken[]): RawToken[] {
  // docker exec [flags] <container> <cmd>...：跳过 flag 及带参 flag
  const flagArgs = ['-e', '--env', '-w', '--workdir', '-u', '--user', '--env-file', '--privileged'];
  let i = 0;
  while (i < rest.length && rest[i]!.text.startsWith('-') && rest[i]!.text.length > 1) {
    if (flagArgs.includes(rest[i]!.text)) i += 1;
    i += 1;
  }
  return rest.slice(i + 1); // 第一个非 flag 为容器名；其后为内部命令
}

function devboxRule(tokens: RawToken[]): DispatchResult {
  const { args } = consumeFlags(tokens.slice(1), ['-c', '--config']);
  const sub = args.length > 0 ? args[0]!.text : null;
  if (sub === 'run') {
    const innerTokens = args.slice(1);
    if (innerTokens.length === 0) {
      return { command: 'devbox', verdict: 'ask', reasons: ['devbox run 缺少内部命令，须审批'] };
    }
    return interpretInner('devbox', innerTokens, innerTokens.map((t) => t.text).join(' '));
  }
  return {
    command: 'devbox',
    verdict: 'ask',
    reasons: [`devbox ${sub ?? ''} 未在白名单枚举（执行器组合必须显式枚举）`],
  };
}

function genericExecutorRule(name: string, tokens: RawToken[]): DispatchResult {
  const args = tokens.slice(1);
  const sub = args.length > 0 ? args[0]!.text : null;
  if (sub !== 'exec' && sub !== 'x') {
    return {
      command: name,
      verdict: 'ask',
      reasons: [`${name} ${sub ?? ''} 未在白名单枚举（执行器组合必须显式枚举）`],
    };
  }
  let innerTokens: RawToken[];
  const dashIndex = args.findIndex((t, idx) => idx > 0 && t.text === '--');
  if (dashIndex >= 0) {
    innerTokens = args.slice(dashIndex + 1);
  } else {
    // 无 --：取第一个位置参数作为内部命令名（direnv exec 常见路径占位 → unknown → ask，安全方向）
    const positionals = args.slice(1).filter((t) => !t.text.startsWith('-') || t.text === '-');
    innerTokens = positionals.length > 0 ? [positionals[0]!] : [];
  }
  if (innerTokens.length === 0) {
    return { command: name, verdict: 'ask', reasons: [`${name} ${sub} 缺少内部命令，须审批`] };
  }
  return interpretInner(name, innerTokens, innerTokens.map((t) => t.text).join(' '));
}

function consumeFlags(
  tokens: RawToken[],
  flagArgs: string[],
): { args: RawToken[]; interactive: boolean } {
  const out: RawToken[] = [];
  let interactive = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.text.startsWith('-') || t.text === '-') {
      out.push(t);
      continue;
    }
    const a = t.text;
    if (a === '-i' || a === '--login' || a === '-s' || a === '--shell') interactive = true;
    if (flagArgs.includes(a)) i += 1; // 消耗 flag 参数
  }
  return { args: out, interactive };
}

// --- 白名单命令规则 -------------------------------------------------------------

function outOfJailArgs(tokens: RawToken[]): string[] {
  return tokens
    .filter((t) => !t.text.startsWith('-') && t.text !== '--')
    .map((t) => t.text)
    .filter((p) => isOutOfJailPath(p));
}

function isOutOfJailPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~') || p === '..' || p.startsWith('../');
}

function whitelistRule(name: string, tokens: RawToken[], ctx: Ctx): DispatchResult {
  if (name === 'find') return findRule(tokens, ctx);
  if (name === 'grep') return grepRule(tokens, ctx);
  const spec = WHITELIST[name]!;
  const { targets } = consumeWhitelistArgs(tokens.slice(1), spec.flagArgs);
  const bad = targets.map((t) => t.text).filter((p) => isOutOfJailPath(p));
  if (bad.length > 0) {
    return {
      command: name,
      verdict: 'ask',
      reasons: bad.map((p) => `${p} 疑似界外（工作区监狱以外）`),
    };
  }
  if (name === 'tail' && hasFlag(tokens.slice(1), ['-f', '--follow'])) {
    return { command: name, verdict: 'ask', reasons: ['tail -f 阻塞式跟踪（常驻会话将挂起）'] };
  }
  const hasTarget = targets.some((t) => t.text !== '-');
  if (spec.stdinReads && !hasTarget && !ctx.inputRedirect && !ctx.pipedFrom) {
    return {
      command: name,
      verdict: 'ask',
      reasons: [`${name} 无文件参数且不在管道下游：等待 stdin 会挂住常驻会话`],
    };
  }
  return { command: name, verdict: 'read-only', reasons: [] };
}

const FIND_FLAG_ARGS = [
  '-name',
  '-iname',
  '-type',
  '-maxdepth',
  '-mindepth',
  '-path',
  '-ipath',
  '-size',
  '-mtime',
  '-atime',
  '-ctime',
  '-mmin',
  '-amin',
  '-cmin',
  '-newer',
  '-anewer',
  '-cnewer',
  '-newermt',
  '-newerat',
  '-newerct',
  '-regex',
  '-iregex',
  '-perm',
  '-user',
  '-group',
  '-fstype',
  '-links',
  '-inum',
  '-samefile',
  '-lname',
  '-ilname',
  '-wholename',
  '-printf',
  '-fprintf',
];

function findRule(tokens: RawToken[], _ctx: Ctx): DispatchResult {
  const args = tokens.slice(1);
  let writeReason: string | null = null;
  for (const t of args) {
    const a = t.text;
    if (a === '-delete' || a === '-rmdir') {
      return { command: 'find', verdict: 'deny', reasons: [`find ${a}：删除文件（不可恢复）`] };
    }
    if (a.startsWith('-exec')) {
      return {
        command: 'find',
        verdict: 'deny',
        reasons: [`find ${a}：对每个结果执行任意命令（脱壳 find 的危险模式）`],
      };
    }
    if (a.startsWith('-ok')) {
      return { command: 'find', verdict: 'deny', reasons: [`find ${a}：交互询问后执行任意命令`] };
    }
    if (a.startsWith('-fprint')) writeReason = `find ${a}：写出文件`;
  }
  const { args: consumed } = consumeFlags(args, FIND_FLAG_ARGS);
  const bad = consumed.map((t) => t.text).filter((p) => isOutOfJailPath(p));
  if (bad.length > 0) {
    return {
      command: 'find',
      verdict: 'ask',
      reasons: bad.map((p) => `${p} 疑似界外（工作区监狱以外）`),
    };
  }
  if (writeReason) {
    return { command: 'find', verdict: 'ask', reasons: [`${writeReason}，须审批`] };
  }
  return { command: 'find', verdict: 'read-only', reasons: [] };
}

function grepRule(tokens: RawToken[], ctx: Ctx): DispatchResult {
  const spec = WHITELIST['grep']!;
  const { args, targets } = consumeWhitelistArgs(tokens.slice(1), spec.flagArgs);
  const patternFromFile = args.some((t) => t.text === '-f' || t.text === '--file');
  // 模式：-f 来自文件时，所有位置参数都是文件；否则第一个位置参数是匹配模式
  const fileTargets = patternFromFile
    ? targets.map((t) => t.text)
    : targets.slice(1).map((t) => t.text);
  const bad = fileTargets.filter((p) => isOutOfJailPath(p));
  if (bad.length > 0) {
    return {
      command: 'grep',
      verdict: 'ask',
      reasons: bad.map((p) => `${p} 疑似界外（工作区监狱以外）`),
    };
  }
  if (fileTargets.length === 0 && !ctx.inputRedirect && !ctx.pipedFrom) {
    return {
      command: 'grep',
      verdict: 'ask',
      reasons: ['grep 无文件参数且不在管道下游：等待 stdin 会挂住常驻会话'],
    };
  }
  return { command: 'grep', verdict: 'read-only', reasons: [] };
}

/** 消费白名单命令参数：跳过 flag（及表内带参 flag 的下一 token）；返回位置参数（目标）。 */
function consumeWhitelistArgs(
  tokens: RawToken[],
  flagArgs: string[],
): { args: RawToken[]; targets: RawToken[] } {
  const kept: RawToken[] = [];
  const targets: RawToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === '--') {
      for (let j = i + 1; j < tokens.length; j++) targets.push(tokens[j]!);
      break;
    }
    if (t.text.startsWith('-') && t.text.length > 1) {
      if (flagArgs.includes(t.text)) i += 1; // flag 参数
      kept.push(t);
      continue;
    }
    targets.push(t);
  }
  return { args: kept, targets };
}
