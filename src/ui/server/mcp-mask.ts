/**
 * # ui/server/mcp-mask：/api/mcp 端点脱敏纯函数（GET 响应 args 中 Authorization 头掩码）
 *
 * 规则（任务书 A 档）：
 * - 遍历 args 数组；遇到 `--header` / `-H`（空格形，两元素）后**下一元素**（即
 *   header 值）若为 Authorization 头 → 掩码；参数尾部无值（flag 为末位）不掩。
 * - 单参数形（`--header=xxx` / `-H=xxx`）同样处理：`=` 后段即 header 值。
 * - 掩码形态（确定性，两种）：
 *     `Authorization: Bearer as_sk_*` 凭据 → 保留头名与该家前缀
 *     （`Authorization: Bearer as_sk_******`——as_sk_ 是供应商前缀，非密钥内容）；
 *     其余 Authorization 形态 → 整值 `[REDACTED]`；
 *     非 Authorization 头 → 原样。
 * - 纯函数：不改输入数组；非匹配参数原样保留。只用于 GET /api/mcp 响应展示层——
 *   POST 配置与内部连接（launcher spawn）仍用原始 args（掩码不落存储、不落配置）。
 */

/** 掩码一个 `--header` 值（原样非 Authorization → 原样；详见模块头）。 */
export function maskMcpHeaderValue(value: string): string {
  // Authorization: Bearer <cred>（大小写不敏感；保留原始头名前缀，只换凭据）
  const bearer = /^((?:[Aa]uthorization)\s*:\s*(?:[Bb]earer)\s+)(\S+)(.*)$/.exec(value);
  if (bearer !== null) {
    const credential = bearer[2]!;
    const masked = credential.startsWith('as_sk_') ? 'as_sk_******' : '[REDACTED]';
    return `${bearer[1]}${masked}${bearer[3] ?? ''}`;
  }
  // 其余 Authorization 头（Basic/自定义 scheme/无 scheme）→ 整值替换
  if (/^[Aa]uthorization\s*:/.test(value)) return '[REDACTED]';
  return value;
}

/**
 * 掩码 args 数组（`--header`/`-H`/`--header=`/`-H=` 四种形态；见模块头）。
 * 返回新数组；输入不被修改。
 */
export function maskMcpArgs(args: readonly string[]): string[] {
  const out = args.slice();
  for (let i = 0; i < out.length; i += 1) {
    const arg = out[i]!;
    if (arg === '--header' || arg === '-H') {
      // 空格形：flag 后下一元素即 header 值
      const value = out[i + 1];
      if (value !== undefined) out[i + 1] = maskMcpHeaderValue(value);
      continue;
    }
    const eqIndex = arg.indexOf('=');
    if (eqIndex >= 0 && (arg.startsWith('--header=') || arg.startsWith('-H='))) {
      // 单参数形：`=` 后段即 header 值
      out[i] = arg.slice(0, eqIndex + 1) + maskMcpHeaderValue(arg.slice(eqIndex + 1));
    }
  }
  return out;
}
