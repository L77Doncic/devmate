/**
 * # jail/resolve：真实落点解析层（符号链接链 + 断链处理）
 *
 * resolveLanding 回答「这个字面路径，写会写到哪、读会读哪」：沿符号链接
 * 链逐段解析，直到一个确定性真实绝对路径，或一个 fail-closed 的理由。
 *
 * 规则：
 * - 优先 realpath（内核一次解析全部已存在组件）；成功即「已存在」
 *   （existed: true），真实位置就是解析结果。
 * - failed with ENOENT/ENOTDIR 时区分两种情形：
 *   a) 当前组件是符号链接（lstat 可见，断链也可见）→ 读链接目标，把
 *      目标按「链接所在的真实父目录」重新入栈（父目录自身可能经过软链，
 *      必须用真实父目录拼相对目标，否则两级软链会算错——对应测试 c 组
 *      的两级链/根内软链指向根外用例）；
 *   b) 组件确实不存在 → 真实落点 = 最近已存在祖先的真实位置 + 剩余字面
 *      段（existed: false）；对「写」而言这就是将来创建落点，对「读」
 *      而言不存在→由调用方保守拒绝。
 * - ELOOP（链环/超链）→ 'loop'；其余错误（EACCES/EPERM/非法参数——
 *   含 NUL 字节）→ 'unreadable'：无法确定即保守拒绝。
 * - 跟随步数预算 40（与内核 ELOOP 上限同量级），超出判 'loop'。
 *
 * fs 注入（JailFs）为安全测试接口：默认包装 node:fs/promises；测试可
 * 注入可抛 EACCES/可模拟竞态快照的假实现（test/jail/jail.test.ts h/i 组）。
 */
import * as fsp from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

export interface JailFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(path: string): Promise<string>;
}

/** 真实 fs 适配层（唯一允许的默认实现；零 npm 依赖）。 */
export function defaultJailFs(): JailFs {
  return {
    realpath: (p) => fsp.realpath(p),
    lstat: (p) => fsp.lstat(p),
    readlink: (p) => fsp.readlink(p),
  };
}

export type Landing =
  | { ok: true; real: string; existed: boolean }
  | { ok: false; why: 'missing' | 'unreadable' | 'loop' };

const MAX_SYMLINK_FOLLOWS = 40;

function errnoOf(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

type LstatKind = 'symlink' | 'plain' | 'missing' | 'unreadable';

async function lstatKind(fs: JailFs, p: string): Promise<LstatKind> {
  try {
    const st = await fs.lstat(p);
    return st.isSymbolicLink() ? 'symlink' : 'plain';
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'unreadable';
  }
}

export async function resolveLanding(p: string, fs: JailFs, impl: PlatformPath): Promise<Landing> {
  let cur = p;
  let remaining = MAX_SYMLINK_FOLLOWS;
  while (remaining > 0) {
    remaining -= 1;
    try {
      const real = await fs.realpath(cur);
      return { ok: true, real, existed: true };
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'ELOOP') return { ok: false, why: 'loop' };
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ok: false, why: 'unreadable' };
    }
    const kind = await lstatKind(fs, cur);
    if (kind === 'unreadable') return { ok: false, why: 'unreadable' };
    if (kind === 'symlink') {
      let target: string;
      try {
        target = await fs.readlink(cur);
      } catch {
        return { ok: false, why: 'unreadable' };
      }
      // 相对目标的基准为「链接的真实父目录」（父链可能自身是软链）
      const parent = impl.dirname(cur);
      const parentLanding = await resolveLanding(parent, fs, impl);
      if (!parentLanding.ok) return parentLanding;
      cur = impl.isAbsolute(target)
        ? impl.normalize(target)
        : impl.join(parentLanding.real, target);
      continue;
    }
    // 组件不存在（或父链断在非目录上）：真实落点 = 祖先真实位置 + 剩余字面段
    const parent = impl.dirname(cur);
    const name = impl.basename(cur);
    if (parent === cur) return { ok: false, why: 'missing' };
    const parentLanding = await resolveLanding(parent, fs, impl);
    if (!parentLanding.ok) return parentLanding;
    return { ok: true, real: impl.join(parentLanding.real, name), existed: false };
  }
  return { ok: false, why: 'loop' };
}
