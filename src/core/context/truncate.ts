/**
 * # context/truncate：第 0 层——生成期工具输出截断（报告 §2.3 一手模板）
 *
 * 单条输出长度 >= maxChars 即按「头 half + 尾 half + 显式 elide 标记 + 收窄建议」重写；
 * 低于阈值原样返回。头尾保序是关键（文件列表开头与 grep 结果末尾最有信息量）。
 * 为什么客户端做：服务端不截断工具结果，超限请求直接被拒（§2.3 一手原话）。
 * maxChars 为可选参数（缺省 MAX_OUTPUT_CHARS = 10000，行为不变）；头尾各取 half
 * （10000 → 5000/5000；子代理报告传入 4000 → 2000/2000；技能全文传入 8000 → 4000/4000）
 * ——截断面板是
 * 生成期截断纪律的**单一来源**，子代理报告与技能全文截断都复用本函数，禁止手写头截断。
 * 注：mini-swe-agent 上游模板已于研究后演进为 <output_head>/<elided_chars>/<output_tail> 分节
 * 形式；本实现按研究报告逐字核实的旧模板（"--- N characters elided ---"）落地并固定为常量。
 * 标记串的「§8 A-1 < omitted N chars > vs §2.3 一手模板」冲突已由 CTO 裁定：
 * 以一手模板为准（A-1 表为转述变体），记录见 CONTEXT.md「术语裁决记录」第 9 条。
 * 另：内容疑似二进制/不可打印（NUL 字节或不可打印占比过高）时整体替换为占位符标记
 * （二进制内容截断头尾无意义——头尾同样不可读）。
 */
import { MAX_OUTPUT_CHARS } from './constants.js';

/** 收窄建议行动指引（逐字，报告 §2.3 一手模板前两行）。 */
export const OUTPUT_TOO_LONG_ADVICE =
  'The output of your last command was too long.\n' +
  'Please try a different command that produces less output.\n';

/** 显式省略标记（逐字格式："--- N characters elided ---"；模板与口径见 CONTEXT.md 术语裁决记录第 9 条）。 */
export function elideMarker(elided: number): string {
  return `--- ${elided} characters elided ---`;
}

/** 二进制/非文本输出的占位符标记（明示内容未展示，模型可按原文重跑）。 */
export const BINARY_OUTPUT_PLACEHOLDER =
  'The output of your last command did not contain printable text (binary or non-text content). ' +
  'The content is not shown here; please use a command that produces readable text output.';

/** 采样段长度（不可打印占比在首段判定；NUL 全量扫描）。 */
const BINARY_SAMPLE_CHARS = 1024;
/** 采样段中不可打印字符占比高于此值即判为非文本。 */
const BINARY_NONPRINTABLE_RATIO = 0.1;

/**
 * 二进制/非文本判定：内容含 NUL 字节（任意位置）→ true；
 * 否则对首段采样统计不可打印字符（C0/C1 控制字符，\t\n\r 除外；U+FFFD 替换符），
 * 占比 > 10% → true。
 */
export function isLikelyBinary(content: string): boolean {
  let nonPrintable = 0;
  let checked = 0;
  for (const ch of content) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x00) {
      return true; // NUL：二进制证据，任意位置命中即判
    }
    if (checked < BINARY_SAMPLE_CHARS) {
      checked += 1;
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        nonPrintable += 1;
      } else if ((code >= 0x7f && code <= 0x9f) || code === 0xfffd) {
        nonPrintable += 1;
      }
    }
  }
  return checked > 0 && nonPrintable / checked > BINARY_NONPRINTABLE_RATIO;
}

/**
 * 截断单条工具输出（生成期截断面板单一来源）；疑似二进制内容整体替换为
 * BINARY_OUTPUT_PLACEHOLDER 占位符标记；低于阈值（length < maxChars）原样返回
 * （与 mini-swe 模板条件一致）。头尾各留一半（半额切片），中间为显式 elide 标记 +
 * 收窄建议。返回新的字符串，不改动入参。
 *
 * @param maxChars 截断阈值（字符）；缺省 MAX_OUTPUT_CHARS（10_000，行为不变）。
 */
export function truncateToolOutput(content: string, maxChars: number = MAX_OUTPUT_CHARS): string {
  if (isLikelyBinary(content)) {
    return BINARY_OUTPUT_PLACEHOLDER;
  }
  if (content.length < maxChars) {
    return content;
  }
  const headChars = Math.floor(maxChars / 2);
  const tailChars = maxChars - headChars;
  const elided = content.length - headChars - tailChars;
  return (
    OUTPUT_TOO_LONG_ADVICE +
    content.slice(0, headChars) +
    '\n\n' +
    elideMarker(elided) +
    '\n\n' +
    content.slice(-tailChars)
  );
}
