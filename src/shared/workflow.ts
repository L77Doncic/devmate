/**
 * # shared/workflow：工作流配置单一来源（子代理开关 + 并行上限）
 *
 * 类型与常量（clampMaxParallel / 缺省值）只在此处定义；cli/server/deps 与子代理池
 * 一律经本模块引用——分散副本已全部删除（重复三处 → 单源）。
 * - WorkflowConfig：子代理池 config 闭包、服务端 workflowState、CLI 初值节的公共形状。
 * - clampMaxParallel：初值加载夹紧 1-4（floor 后夹紧；undefined → 2）。
 *   POST /api/workflow 的越界校验（400）在服务端端点另做——本函数只夹初值。
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
/** 并行上限下限（档位）。 */
export const MIN_MAX_PARALLEL = 1;
/** 并行上限上限（档位；与服务端 POST /api/workflow 校验口径一致）。 */
export const MAX_MAX_PARALLEL = 4;

/** maxParallel 初值夹紧 1-4（undefined → DEFAULT_MAX_PARALLEL；floor 后夹紧）。 */
export function clampMaxParallel(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PARALLEL;
  return Math.max(MIN_MAX_PARALLEL, Math.min(MAX_MAX_PARALLEL, Math.floor(value)));
}
