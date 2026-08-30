/**
 * # shared/workflow：工作流配置单一来源（子代理开关 + 并行上限）
 *
 * 类型与常量（clampMaxParallel / 缺省值）只在此处定义；cli/server/deps 与子代理池
 * 一律经本模块引用——分散副本已全部删除（重复三处 → 单源）。
 * - WorkflowConfig：子代理池 config 闭包、服务端 workflowState、CLI 初值节的公共形状。
 * - maxParallel 语义（subagent 无上限）：
 *   0 = 无上限（池不设并发限制——任务一经提交即并执行）；1-8 = 显式并发数；
 *   归一（clampMaxParallel：初值加载用）：负 → 0、非整 → floor、>8 → 8、NaN → 缺省 2。
 *   POST /api/workflow 的越界校验（<0 / >8 / 非整 → 400）在服务端端点另做——本函数只夹初值。
 */

/** 工作流配置（池读取源；缺省 true/2 由调用方配置）。 */
export interface WorkflowConfig {
  subagentsEnabled: boolean;
  maxParallel: number;
}

/** 子代理开关缺省值。 */
export const DEFAULT_SUBAGENTS_ENABLED = true;
/** 并行上限缺省值（clampMaxParallel(undefined) 的结果）。 */
export const DEFAULT_MAX_PARALLEL = 2;
/** 并行上限下限（档位；0 = 无上限（按需派遣）——设置 UI 步进 0..8）。 */
export const MIN_MAX_PARALLEL = 0;
/** 并行上限上限（档位；与服务端 POST /api/workflow 校验口径一致：>8 → 400）。 */
export const MAX_MAX_PARALLEL = 8;
/** 0 档（无上限）的人类可读文案（提示词子代理节共用；「无上限（按需派遣）」的 UI
 *  扩展标签归前端 extensions.js——浏览器不 import 本 TS 模块，镜像纪律见 README-UI.md）。 */
export const MAX_PARALLEL_UNLIMITED_LABEL = '无上限';

/** maxParallel 初值夹紧 0-8（undefined → DEFAULT_MAX_PARALLEL；负 → 0；floor 后夹紧；
 *  非有限（NaN/±Infinity）→ 缺省 DEFAULT_MAX_PARALLEL）。 */
export function clampMaxParallel(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PARALLEL;
  if (Number.isNaN(value)) return DEFAULT_MAX_PARALLEL;
  return Math.max(MIN_MAX_PARALLEL, Math.min(MAX_MAX_PARALLEL, Math.floor(value)));
}

/** 并行上限的展示文案（提示词/日志）：0 → 「无上限」；1-8 → 数字原样。 */
export function maxParallelCapText(maxParallel: number): string {
  if (maxParallel === 0) return MAX_PARALLEL_UNLIMITED_LABEL;
  return String(maxParallel);
}
