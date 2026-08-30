/**
 * # tools/redact：机密脱敏（接缝 S11；CONTEXT「机密脱敏」；ADR-0013 沙箱层）
 *
 * 口径：ADRs/研究 §8D 机密脱敏行 ——【一手要求】redact credentials and other secrets
 * from output before returning it to Claude；正则集【经验值】：只做常见凭据形态
 * （AKIA…、ghp_/gho_、sk-…、Bearer …、---BEGIN PRIVATE KEY---、Authorization: Basic），
 * 不追求穷尽。本模块是纯函数（无副作用、无共享可变状态），是 securedRegistry 的
 * 默认 redactor，也接受自定义配置（默认集 + 追加 / 同 type 覆盖；guard 判 false →
 * 该匹配原样保留不予打码——语义统一以 RedactPattern.guard 的注为准）。
 *
 * 设计选择与取舍：
 * 1. 标记 = `[REDACTED:<type>]`，带类型提示（模型可分辨被掩码的是哪类凭据）；稳定
 *    且自幂等——任何默认模式的替换产物都不会被自身或其它默认模式再次命中（含
 *    URL 模式对抗 `[` 的排除，见下）。
 * 2. 打码的是匹配到的整个 span（Authorization: Bearer x → Authorization: [REDACTED:bearer-token]）。
 * 3. URL 明码 `scheme://user:pass@host`：整段 user:pass（含用户名）全部替换——
 *    保守起见用户名也可能是 token（git remote 形态），且这样替换产物天然幂等
 *    （marker 含 `[`，URL 模式字符类排除 `[`，自身不会被二次命中）；记录取舍：
 *    仅用户名无冒号（https://user@host）不算明文凭据，不打码。
 * 4. Base64 判别（Basic `<token>` 形态）：不做「裸 base64 全文扫描」（误杀率不可接受），
 *    只在紧邻 Basic 一词时才判，且要求 token「可解码 + 解码含冒号 + 全字节可打印 ASCII」。
 *    取消除后残余误杀 ≈ 0；代价：非 ASCII 凭据（RFC 7617 之外）与原样 blob 型 secret
 *    不在覆盖内（经验值：常见凭据形态即可，不追求穷尽）。
 * 5. 性能：正则模式均为线性单遍 replace（无回溯嵌套），1MB 文本毫秒级（量级见测试）。
 * 6. 不打码（记录）：任务描述/系统提示不在本模块职责内——本模块只管「工具结果回注前」。
 */

export interface RedactPattern {
  /** 标记类型标签（`[REDACTED:<type>]` 中的 type；也是同 type 覆盖默认集的键）。 */
  type: string;
  /** 敏感 span 的整体匹配正则（建议自带 global，引擎会自动补齐）。 */
  regex: RegExp;
  /**
   * 可选：自定义判定（全匹配文本 → 是否打码）。返回 false 时原样保留——
   * 用于需要「可解码且形如 user:pass」这类超出正则表达力的判别（默认 basic-auth 用）。
   */
  guard?: (match: string) => boolean;
  /**
   * 可选：替换为来自捕获组的内容（groups = 正则捕获组，不含 match/offset/source）。
   * 缺省替换为 `[REDACTED:<type>]`。默认 URL 模式用它保留 scheme 与 @host。
   */
  replace?: (match: string, groups: readonly string[]) => string;
}

export interface RedactOptions {
  /** 追加/覆盖模式：与默认集同 type 的覆盖默认（保持原位置），新 type 追加在默认之后。 */
  patterns?: readonly RedactPattern[];
}

export function redactMarker(type: string): string {
  return `[REDACTED:${type}]`;
}

const DEFAULT_PATTERNS: readonly RedactPattern[] = [
  {
    // URL 明文凭据：scheme://user:pass@host（含 mysql:///postgres:// 等任意 scheme）。
    // 整段 user:pass 替换（保守：用户名也可能即 token）；保留 scheme/@host。
    // 字符类以裸 `[` 排除左方括号：脱敏标记以 `[` 开头，自身不被二次命中（幂等）。
    // 运行长度有界（scheme ≤ 63、user/pass 段各 ≤ 256——真实形态远短于此）：无界贪婪
    // 接 `://` 在「超长单字符运行」（base64/填充文本——100KB+ 同字符）上每起位全量消耗
    // 后逐位回退 = O(n²)（实测 100KB 5.7s；存储层脱敏（jsonl-file.ts）把它放大为每次
    // tool 落盘的常驻成本）。有界后最坏 O(n×63)——线性（「无回溯嵌套」承诺据此成立）。
    type: 'url-credentials',
    regex: /([a-zA-Z][a-zA-Z0-9+.-]{0,63}:\/\/)[^\s/:@[]{1,256}:[^\s/@[]{1,256}@/g,
    replace: (_match, groups) => `${groups[0] ?? ''}${redactMarker('url-credentials')}@`,
  },
  { type: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { type: 'openai-key', regex: /\bsk-[A-Za-z0-9-]{36,}\b/g },
  // 注意：bearer/basic 的 token 类包含 '='（base64 padding），故不收尾 \b——
  // trailing `\b` 会把最后一个 '=' 留在原地（`[REDACTED:…]=`）；最小长度 +
  // basic 的 guard 已保证不会吞掉不相干的相邻单词。
  { type: 'bearer-token', regex: /\bbearer[ \t]+[A-Za-z0-9._~+/=-]{16,}/gi },
  {
    type: 'basic-auth',
    regex: /\bbasic[ \t]+[A-Za-z0-9+/_=-]{8,}/gi,
    guard: (match) => {
      const token = match.split(/[ \t]+/, 2)[1] ?? '';
      return isBasicCredentialToken(token);
    },
  },
  {
    // PEM/PGP 私钥块（含内容行，非贪婪到第一个 END）。
    type: 'private-key',
    regex:
      /-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY[A-Z ]*-----/g,
  },
];

/**
 * 机密脱敏（纯函数）：对 text 按默认形态集（+ 可选自定义）逐模式打码。
 *
 * - 输出幂等：`redactSecrets(redactSecrets(t)) === redactSecrets(t)`（任何实现违反即 bug）。
 * - 稳定：同输入同输出（无随机、无状态）；失败也是普通内容的处理由调用方保证。
 */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
  let out = text;
  for (const pattern of effectivePatterns(options)) {
    out = applyPattern(out, pattern);
  }
  return out;
}

/** 默认集 + 自定义合并：同 type 覆盖（保位），新 type 追加。 */
function effectivePatterns(options: RedactOptions): RedactPattern[] {
  const extras = options.patterns ?? [];
  if (extras.length === 0) return [...DEFAULT_PATTERNS];
  const byType = new Map<string, RedactPattern>();
  for (const pattern of DEFAULT_PATTERNS) byType.set(pattern.type, pattern);
  const appended: RedactPattern[] = [];
  for (const pattern of extras) {
    if (byType.has(pattern.type)) byType.set(pattern.type, pattern);
    else appended.push(pattern);
  }
  return [...byType.values(), ...appended];
}

function applyPattern(text: string, pattern: RedactPattern): string {
  const regex = pattern.regex.global
    ? pattern.regex
    : new RegExp(pattern.regex.source, `${pattern.regex.flags}g`);
  return text.replace(regex, (...args) => {
    const match = args[0] as string;
    if (pattern.guard !== undefined && !pattern.guard(match)) return match;
    if (pattern.replace !== undefined) {
      const groups = args.slice(1, args.length - 2) as string[];
      return pattern.replace(match, groups);
    }
    return redactMarker(pattern.type);
  });
}

// ---------------------------------------------------------------------------
// Basic base64 判别（仅此一处：见模块头取舍 4）
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isBasicCredentialToken(token: string): boolean {
  if (token.length < 8) return false;
  // base64url 变体归一；尾部 padding 去掉后才做长度奇偶判别
  const compact = token.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (compact.length % 4 === 1) return false; // base64 长度均为 2/3/0 mod 4
  let decoded = '';
  let buffer = 0;
  let bits = 0;
  for (const ch of compact) {
    const value = B64_ALPHABET.indexOf(ch);
    if (value < 0) return false; // 不是 base64 字符（如含 '=' 于中部）
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  if (!decoded.includes(':')) return false; // 不是 user:pass 形态
  for (let i = 0; i < decoded.length; i += 1) {
    const code = decoded.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false; // 二进制 blob 不算 Basic 凭据（防误杀）
  }
  return true;
}
