/**
 * # jail：工作区监狱（接缝 S9；安全审计重点模块）
 *
 * 层级口径（CONTEXT「工作区监狱」/「沙箱」/ ADR-0013 三层互补）：
 * - 本模块是「监狱」——模型行为约束层，管「模型放不放行」；判定结果
 *   由文件工具/执行器（S7/S8）在动作执行前询问并遵行。
 * - 它**不是沙箱**：OS 级隔离（容器/VM、网络禁用、资源限制）是第 3 层，
 *   无人值守时唯一真正可靠的防线。提示注入能骗过本模块的判定本身，
 *   因此本模块永远不作执行侧的唯一防线（ADR-0013 后果条款）。
 *
 * 判定语义（1–7 与测试矩阵 a–i 一一对应）：
 * 1. 默认边界 = workspaceRoot（启动目录）；extraRoots 显式登记才加入边界。
 * 2. 符号链接两端同检：allow 须「字面端」与「真实端」都命中边界集合；
 *    deny 任一命中即拦（union 语义：两端可分别落在不同已登记根上——
 *    根内软链指向已登记的 extraRoot 放行，指向未登记路径一律拦）。
 * 3. 重定向目标按写入检：checkRedirect(src, dst) = src 按读 + dst 按写
 *    （`>` 与 `>>` 在监狱层同语义；shell 层解析引号/空白由 S10 负责，
 *    本模块接收解引号后的字面路径）。
 * 4. 未知起点（不存在路径）不静默放行：
 *    - 读：要求解析端**已存在**，否则拒绝（不存在就读不到，fail-closed）；
 *    - 写：沿符号链接链与祖先链做确定性解析——resolveLanding 求出真实
 *      落点后按边界判定（断链到界内 → 放行创建；断链/解析越界 → 拦）。
 * 5. 路径规范化：`..`、绝对路径、重复分隔符、尾部分隔符在 normalize 层
 *    消化；解析后仍出界 → deny（字面端）或被符号链接带出界 → deny（真实端）。
 * 6. 平台差异在 normalize 层处理：posix 上 `\` 是字面字符（Windows 风格
 *    注入串不构成逃逸，已测试钉住）；win32 上盘符/UNC/大小写不敏感/`\`=`/`
 *    由 win32 分支消化。win32 分支只在 Windows 宿主启用（构造器强制）。
 * 7. 裸文件名/相对路径一律相对 workspaceRoot 解析（而非进程 cwd）——
 *    exec 层若以其它 cwd 运行，须自行转绝对路径后再询问本模块。
 *
 * 保守拒绝集（h/i 组）：EACCES/EPERM/非法路径（NUL）→ 无法解析即拒绝；
 * 解析失败（ELOOP）→ 拒绝；构造期边界根不可解析 → 抛错（fail-closed）。
 *
 * TOCTOU 局限（文档化，不试图消除）：每次 checkPath 是调用时刻文件系统
 * 的**单快照**（不跨调用缓存、不加锁）；判定与执行之间文件系统仍可被
 * 替换（换根/改名），本模块无法阻止——监狱是决策关卡不是执行容器，
 * 执行侧防竞态由第 3 层沙箱负责（ADR-0013）。test i 组钉住快照语义。
 *
 * 接口说明：checkPath/checkRedirect 为 async —— realpath 走 node:fs/promises
 * （允许模块集：node:path / node:fs/promises / node:url），且工具执行层
 * （S7/S8）本身是异步的；判定结果 {JailDecision} 的形状不因异步而变。
 */
import * as path from 'node:path';

import type { PlatformPath } from 'node:path';

import { normalizePath, pathWithin } from './normalize.js';
import type { PathPlatform } from './normalize.js';
import { defaultJailFs, resolveLanding } from './resolve.js';
import type { JailFs } from './resolve.js';

export type { PathPlatform } from './normalize.js';
export { normalizePath, pathWithin } from './normalize.js';
export { defaultJailFs } from './resolve.js';
export type { JailFs } from './resolve.js';

export type JailMode = 'read' | 'write';

/** 一次判定结论：allowed=false 时 reason 必给出（回注给模型，CONTEXT「错误回注」）。 */
export interface JailDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * 工作区监狱接口（类型放在本模块；S7/S8 从 src/core/jail/index.js import）。
 * 一次构造 = 一次边界固定：workspaceRoot 为默认边界，extraRoots 为显式登记边界。
 */
export interface Jail {
  readonly workspaceRoot: string;
  readonly extraRoots: readonly string[];
  /** 判定路径 p 在给定模式下是否放行（相对 p 按 workspaceRoot 解析）。 */
  checkPath(p: string, mode: JailMode): Promise<JailDecision>;
  /** 重定向判定：src 按读、dst 按写入检；任一被拦即拦（deny 任一命中即拦）。 */
  checkRedirect(src: string, dst: string): Promise<JailDecision>;
}

export interface JailOptions {
  /** 默认边界（启动目录），必须是绝对路径；不可解析 → 拒绝构造。 */
  workspaceRoot: string;
  /** 额外显式登记边界；每个根必须存在且可 realpath（fail-closed）。 */
  extraRoots?: readonly string[];
  /** 平台语义；默认按当前宿主。win32 只允许在 Windows 宿主启用。 */
  platform?: PathPlatform;
  /** 文件系统注入（安全测试接口）；缺省 node:fs/promises 包装。 */
  fs?: JailFs;
}

interface RootEntry {
  /** 字面别名集合：给定路径与其 realpath 两种写法都算命中（软链边界根）。 */
  lexForms: readonly string[];
  /** 真实边界（realpath(root)），真实端比较用。 */
  real: string;
}

function deny(reason: string): JailDecision {
  return { allowed: false, reason };
}

function codeHint(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'unknown';
  }
  return 'unknown';
}

export async function createJail(options: JailOptions): Promise<Jail> {
  const platform: PathPlatform =
    options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  if (platform === 'win32' && process.platform !== 'win32') {
    throw new Error(
      'jail: platform=win32 只允许在 Windows 宿主启用（win32 语义的纯函数测试请直接使用 normalizePath/pathWithin）',
    );
  }
  const fs = options.fs ?? defaultJailFs();
  const impl: PlatformPath = platform === 'win32' ? path.win32 : path.posix;

  const sources = [options.workspaceRoot, ...(options.extraRoots ?? [])];
  const roots: RootEntry[] = [];
  for (const source of sources) {
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error('jail: 边界根必须是绝对路径（fail-closed）');
    }
    // 先按原始输入判绝对：resolve() 会把相对串垫上进程 cwd，绝不能把
    // 相对路径「意外绝对化」后当作边界（fail-closed）。
    if (!impl.isAbsolute(source)) {
      throw new Error(`jail: 边界根必须是绝对路径: ${source}`);
    }
    const lex = normalizePath(source, source, platform);
    if (!impl.isAbsolute(lex)) {
      throw new Error(`jail: 边界根必须是绝对路径: ${source}`);
    }
    let real: string;
    try {
      real = await fs.realpath(lex);
    } catch (err) {
      throw new Error(`jail: 边界根无法解析（fail-closed）: ${source}（${codeHint(err)}）`);
    }
    roots.push({ lexForms: dedupe([lex, real]), real });
  }
  if (roots.length === 0) {
    throw new Error('jail: workspaceRoot 不能为空（fail-closed）');
  }

  const lexForms = roots.flatMap((r) => r.lexForms);
  const wsLex = roots[0]!.lexForms[0]!;

  const checkPath = async (p: string, mode: JailMode): Promise<JailDecision> => {
    const lex = normalizePath(p, wsLex, platform);
    if (!lexForms.some((lf) => pathWithin(lex, lf, platform))) {
      // P2-9 文案净化：不再用「按字面越界/已登记边界」内部语 —— 换成用户可懂的
      // 「路径越界（不在工作区内）」；含原路径，下一动作自明（用工作区内路径）。
      return deny(`路径越界：${lex} 不在工作区边界内（只允许访问工作区目录下的文件）`);
    }
    const landing = await resolveLanding(lex, fs, impl);
    if (!landing.ok) {
      return deny(`真实落点无法解析（${landing.why}），保守拒绝：${lex}`);
    }
    if (mode === 'read' && !landing.existed) {
      return deny(`读目标解析到不存在的路径：${landing.real}（读要求已存在）`);
    }
    if (!roots.some((r) => pathWithin(landing.real, r.real, platform))) {
      return deny(`越界：字面在界内但解析后落在 ${landing.real}（符号链接/前缀逃逸）`);
    }
    return { allowed: true };
  };

  const checkRedirect = async (src: string, dst: string): Promise<JailDecision> => {
    const srcD = await checkPath(src, 'read');
    if (!srcD.allowed) return srcD;
    const dstD = await checkPath(dst, 'write');
    if (!dstD.allowed) return dstD;
    return { allowed: true };
  };

  return {
    workspaceRoot: options.workspaceRoot,
    extraRoots: Object.freeze([...(options.extraRoots ?? [])]),
    checkPath,
    checkRedirect,
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
