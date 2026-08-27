/**
 * # jail/normalize：平台感知路径规范化（纯函数层，无文件系统访问）
 *
 * 安全口径（与 test/jail/jail.test.ts e) 组一一对应）：
 * - 本层只做「确定字面落点」：把任意输入字符串化为平台规范的绝对路径，
 *   但不做任何文件系统访问与实际性判定；越界判定由 pathWithin 完成。
 * - posix：`\` 是普通字符（不是分隔符），所以 Windows 风格的 `C:\x`、
 *   `..\..\etc` 在 POSIX 上按字面当作单个文件名处理、不构成逃逸
 *   （跨平台行为：在 Windows 宿主上它们由 win32 分支按分隔语义解析——
 *   两条语义都被测试钉住，见 e) 组「跨平台标记」用例）。
 * - win32：盘符（C:\）、UNC（\\server\share）、大小写不敏感、`\` 与 `/`
 *   等价，全部在本层消化；盘符相对路径（C:foo）仅在基准为同一盘符时
 *   按基准目录解析（确定性），异盘符的盘符相对路径其真实 cwd 无法确定，
 *   保留原样——后续 containment 判定必不命中 → 保守拒绝。
 */
import * as path from 'node:path';

export type PathPlatform = 'posix' | 'win32';

/** 盘符相对路径：C:foo / C:（不是 C:\，也不是 C:/） */
const WIN32_DRIVE_REL = /^([A-Za-z]):(?:[^\\/]|$)/;
/** 盘符绝对路径：C:\ / C:/ */
const WIN32_DRIVE_ABS = /^([A-Za-z]):[\\/]/;

/**
 * 把 p 规范化成 base 语义下的绝对路径（平台原生分隔符）。
 * p 为空串按 '.' 处理（→ base）；base 必须已经是绝对路径（由 createJail 保证）。
 */
export function normalizePath(p: string, base: string, platform: PathPlatform): string {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  if (p.length === 0) p = '.';
  if (impl.isAbsolute(p)) return impl.normalize(p);
  if (platform === 'win32') {
    const m = WIN32_DRIVE_REL.exec(p);
    if (m !== null) {
      const baseNorm = impl.normalize(base);
      const bm = WIN32_DRIVE_ABS.exec(baseNorm);
      if (bm !== null && m[1]?.toLowerCase() === bm[1]?.toLowerCase()) {
        return impl.resolve(baseNorm, p.slice(2));
      }
      // 异盘符盘符相对：真实 cwd 未知 → 保留原样，containment 必失败（保守拒绝）
      return impl.normalize(p);
    }
  }
  return impl.resolve(impl.normalize(base), p);
}

/**
 * 字面包含判定：child 是否位于 root 之下（含 root 本身）。
 * 以「root + 分隔符」为边界做前缀比较，杜绝 /ws 前缀误命中 /ws2；
 * win32 大小写不敏感（对应 NTFS 默认语义）。
 */
export function pathWithin(child: string, root: string, platform: PathPlatform): boolean {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const c = impl.normalize(child);
  const r = impl.normalize(root);
  const cf = platform === 'win32' ? c.toLowerCase() : c;
  const rf = platform === 'win32' ? r.toLowerCase() : r;
  if (cf === rf) return true;
  return rf.endsWith(impl.sep) ? cf.startsWith(rf) : cf.startsWith(rf + impl.sep);
}
