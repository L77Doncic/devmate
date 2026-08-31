/**
 * # shared/slug：slugify 纯函数
 *
 * 仅纯函数、无副作用；供各层复用。语义无歧义，覆盖空串/纯空白/无字母数字边界。
 */

/**
 * URL slug 化：小写；任何非字母数字连续段折叠为单个连字符；
 * 去除首尾连字符；空串 / 纯空白 / 无字母数字 → ''。
 *
 * 实现为 ASCII 口径：非字母数字连续段按 [^a-z0-9]+ 折叠（如 "Hello, World!" →
 * "hello-world"）；中文等 Unicode 字母不保留，属超出本次范围的后续考虑。
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
