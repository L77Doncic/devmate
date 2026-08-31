/**
 * # shared/strings：字符串纯函数
 *
 * 仅纯函数、无副作用；供各层复用（isBlank / capitalize 均为无歧义语义，
 * 覆盖空串与全空白边界）。实现单一，不在 ui 层重复镜像。
 */

/**
 * 是否为空白：空串（''）或全空白字符（空格/Tab/换行等）→ true；
 * 含任一非空白字符 → false。
 * 注：空串与全空白都归「空白」，便于配置/输入校验把 blank 当缺省。
 */
export function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** 首字母大写：首字符小写 → 大写，其余保持不变；空串原样返回。 */
export function capitalize(s: string): string {
  if (s === '') return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
