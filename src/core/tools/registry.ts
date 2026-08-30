/**
 * # tools/registry：安全注册装饰器（接缝 S11；CONTEXT「机密脱敏」「错误回注」「失败是普通消息」）
 *
 * 语义（与用户确认的口径）：
 * - Uniform：包住任何 ToolRegistry 后，无论文件工具还是 shell 工具，所有执行结果
 *   在回注前一律过 redactSecrets —— 本装饰器挂载点即「回注前的唯一咽喉」；
 * - 只做文本变换，不改 ToolResult 的 ok/error 结构：ok 值、error.type 原样；
 *   失败仍是普通结果（{ok:false,error:{type,message}}，message 打码），绝不抛异常；
 * - 错误与成功一视同仁：content（合法 JSON 载荷，含 message 文本）与 error.message
 *   均打码——错误信息里出现 token（含路径内嵌 token）不会由此泄露；
 * - registry.list() 原样透传（模型可见定义不变——脱敏不影响工具定义，也不该让
 *   模型看到「敏感标记」出现在定义里）。
 *
 * 已接受边界（双轴审查记录，低风险——不改行为）：以 \uXXXX 转义形态出现的凭据
 * （例如 JSON 序列化中的转义字符序列）不会被正则命中打码；本层对 content 与
 * error.message 的明文逐字符过 redactor，转义凭据按「未以明文形式出现」处理，
 * 与 redact 模块「只做常见凭据形态、不追求穷尽」的经验取舍一致。
 *
 * 位置：装饰 registry 的接线在 boot（S 后续），本模块只提供纯装饰器；
 * 自定义 redactor 供测试与配置注入（同一函数作用于 content 与 error.message）。
 */
import type { ToolCall } from '../../shared/session-types.js';
import type { ToolDef, ToolExecutionContext, ToolRegistry, ToolResult } from '../loop/types.js';
import { redactSecrets } from './redact.js';

export interface SecuredRegistryOptions {
  /** 脱敏函数（同一函数应用于 content 与 error.message）；缺省 redactSecrets。 */
  redactor?: (text: string) => string;
}

/** 把 registry 包成「执行结果回注前统一脱敏」的安全注册表（幂等：可再包一层）。 */
export function securedRegistry(
  registry: ToolRegistry,
  options: SecuredRegistryOptions = {},
): ToolRegistry {
  const redactor = options.redactor ?? redactSecrets;
  return {
    list(): readonly ToolDef[] {
      return registry.list();
    },
    async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      const result = await registry.execute(call, context);
      const content = redactor(result.content);
      if (result.error === undefined) {
        return { ok: result.ok, content };
      }
      // 错误对象仍是 {ok:false,error:{type,message}}：只打码 message，type 不动。
      return {
        ok: result.ok,
        content,
        error: { type: result.error.type, message: redactor(result.error.message) },
      };
    },
  };
}
