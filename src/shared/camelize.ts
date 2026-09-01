/**
 * # shared/camelize：camelize 纯函数
 *
 * 仅纯函数、无副作用；供各层复用。语义无歧义，覆盖空串/纯空白/无字母数字边界。
 */

/**
 * camelCase 化：按非字母数字连续段切分；第一段全小写，后续段首字母大写、
 * 其余小写；空串 / 纯空白 / 无字母数字 → ''。
 *
 * 实现为 ASCII 口径：切分依据 [^a-zA-Z0-9]+（如 "Hello, World!" →
 * "helloWorld"）；中文等 Unicode 字母不保留，属超出本次范围的后续考虑。
 */
export function camelize(s: string): string {
  const segments = s.split(/[^a-zA-Z0-9]+/).filter((seg) => seg !== '');
  return segments
    .map((seg, i) => {
      const lower = seg.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}
