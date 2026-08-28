/**
 * # shared/masking：密钥掩码回读单一来源（层间倒置修复）
 *
 * maskApiKey 只用于展示（GET /api/settings 掩码回读），完整密钥仅进程内传递；
 * 单一实现住本 shared 层——ui/server 与 cli/config 都从这里引用
 * （cli/config.ts 保留 re-export 兼顾既有 import 面；UI-FE 有独立函数级实现镜像，
 * 属并行线，不为它改）。
 */

/** 掩码回读：长度 > 12 保留首尾各 4 位，否则全掩码；配合只读展示，不泄完整密钥。 */
export function maskApiKey(apiKey: string | undefined): string | undefined {
  if (apiKey === undefined) return undefined;
  if (apiKey.length <= 12) return '****';
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}
