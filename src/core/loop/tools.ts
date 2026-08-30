/**
 * # loop/tools：ToolRegistry 接缝实现 + 工具参数校验与错误回注载荷
 *
 * 本模块定义的接缝（Phase 3 在其上实现真实工具面，ADR-0008/0010）：
 * - defineRegistry(tools, ctx)：把 Tool[] 包装为 ToolRegistry（名称分发 + 异常归一）。
 * - validateToolCall：arguments 的 JSON 合法性 + 最小 JSON Schema 校验（子集：
 *   object/properties/required + 属性级 type/enum；未知键忽略）——畸形识别
 *   （E9/E11）与「畸形→回注」载荷构造直属本模块，与熔断计数成对（ADR-0006）。
 *   未知工具（E10）判型在 lookup 层（defineRegistry/主循环）先行，不进本验证。
 *
 * 回注载荷约定（research §4.4 / ADR-0006）：工具结果 content 恒为合法 JSON，
 * 顶层 {ok:false, error:{type, message, human_hint?, available_tools?, issues?,
 * arguments_head?, available_skills?}}；逐调用 ID 配对（API-SPEC §3.2），绝不出现
 * 落单 tool 消息；未知工具（E10）的唯一构造入口是 unknownToolResult（文案经
 * unknownToolMessage 单一来源）。errorContentJson 是本载荷的**单一构造实现**——
 * 各工具的错误回注（含技能 available_skills）一律经它构造，禁止手写形状。
 */
import type { ToolCall } from '../../shared/session-types.js';
import type { JsonSchema, ToolDef, ToolResult, ToolRegistry, Tool } from './types.js';

// ---------------------------------------------------------------------------
// 注册表接缝实现
// ---------------------------------------------------------------------------

function byName(tools: readonly Tool[]): Map<string, Tool> {
  const map = new Map<string, Tool>();
  for (const tool of tools) map.set(tool.name, tool);
  return map;
}

export function defineRegistry(tools: readonly Tool[], ctx: ToolExecutionContextArg): ToolRegistry {
  const index = byName(tools);
  return {
    list(): readonly ToolDef[] {
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? {},
      }));
    },
    async execute(call: ToolCall, running?: ToolExecutionContextArg): Promise<ToolResult> {
      const tool = index.get(call.name);
      if (tool === undefined) {
        return unknownToolResult(call.name, [...index.keys()]);
      }
      try {
        // 运行时上下文补丁（P2-3）：run 每次执行现传的 {signal} 覆盖构造期静态上下文——
        // 常驻 shell 的 waitForCompletion 由此听到中断信号（中断即杀命令树 + partial 回注）。
        return await tool.execute(call, running === undefined ? ctx : { ...ctx, ...running });
      } catch (err) {
        // 工具侧 throw 也归一为普通失败结果（失败是普通消息）
        return {
          ok: false,
          content: '',
          error: { type: 'tool-error', message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  };
}

export type ToolExecutionContextArg = Parameters<Tool['execute']>[1];

// ---------------------------------------------------------------------------
// 工具调用校验（E9 非法 JSON / E11 schema 违例、参数缺失）
// ---------------------------------------------------------------------------

export interface SchemaIssue {
  path: string;
  code: 'required' | 'type' | 'enum';
  expected?: string;
  actual?: string;
}

export type ToolCallValidation =
  | { ok: true; parsed: unknown }
  | {
      ok: false;
      type: 'invalid_tool_arguments' | 'invalid_arguments';
      message: string;
      /** 原始参数前段（invalid_tool_arguments 时；载荷键名照 research §4.4）。 */
      arguments_head?: string;
      issues?: SchemaIssue[];
    };

/**
 * 校验一次调用的参数（def 必须存在：未知工具在 lookup 层先判型，E10 不进本验证）。
 * 先 parse，最后按工具 schema 校验；只返回判定结果，不抛异常（畸形是普通轮次层错误，交给回注）。
 */
export function validateToolCall(def: ToolDef, rawArguments: string): ToolCallValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (err) {
    return {
      ok: false,
      type: 'invalid_tool_arguments',
      message: err instanceof Error ? err.message : String(err),
      arguments_head: rawArguments.slice(0, 500),
    };
  }
  const issues: SchemaIssue[] = [];
  checkAgainst(def.parameters ?? {}, parsed, '$', issues);
  if (issues.length > 0) {
    return {
      ok: false,
      type: 'invalid_arguments',
      message: `arguments do not match the schema of tool "${def.name}"`,
      issues,
    };
  }
  return { ok: true, parsed };
}

/** 最小 JSON Schema 子集校验（未知键忽略；无 schema 视为接受任意合法 JSON 对象）。 */
function checkAgainst(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): void {
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    issues.push({ path, code: 'type', expected: schema.type, actual: typeOf(value) });
  }
  if (schema.enum !== undefined && !schema.enum.some((item) => Object.is(item, value))) {
    issues.push({ path, code: 'enum', expected: 'one of the enum values', actual: typeOf(value) });
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) issues.push({ path: key, code: 'required' });
    }
    const properties = schema.properties ?? {};
    for (const key of Object.keys(properties)) {
      const sub = properties[key];
      if (sub === undefined || !(key in record)) continue;
      checkAgainst(sub, record[key], path === '$' ? key : `${path}.${key}`, issues);
    }
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return typeof value === expected;
  }
}

// ---------------------------------------------------------------------------
// 回注载荷构造（research §4.4：content 恒为合法 JSON，顶层 ok/error）
// ---------------------------------------------------------------------------

export interface ReinjectionError {
  type: string;
  message: string;
  human_hint?: string;
  available_tools?: string[];
  issues?: SchemaIssue[];
  /** 原始参数前段（载荷键名照研究 §4.4：snake_case arguments_head）。 */
  arguments_head?: string;
  /** 可用技能清单（use_skill 错误回注；键名沿用可用 id 清单语义）。 */
  available_skills?: string[];
}

/** 错误结果 → 工具消息 content（合法 JSON，顶层 ok/error；单一构造实现）。 */
export function errorContentJson(error: ReinjectionError): string {
  const body: Record<string, unknown> = {};
  if (error.human_hint !== undefined) body.human_hint = error.human_hint;
  if (error.available_tools !== undefined) body.available_tools = [...error.available_tools];
  if (error.issues !== undefined) body.issues = [...error.issues];
  if (error.arguments_head !== undefined) body.arguments_head = error.arguments_head;
  if (error.available_skills !== undefined) body.available_skills = [...error.available_skills];
  return JSON.stringify({
    ok: false,
    error: { type: error.type, message: error.message, ...body },
  });
}

export function invalidToolArgumentsResult(message: string, argumentsHead: string): ToolResult {
  return {
    ok: false,
    content: errorContentJson({
      type: 'invalid_tool_arguments',
      message,
      human_hint:
        'The tool arguments must be valid JSON matching the tool schema; fix them or do not call the tool.',
      arguments_head: argumentsHead,
    }),
    error: { type: 'invalid_tool_arguments', message },
  };
}

export function invalidArgumentsResult(defName: string, issues: SchemaIssue[]): ToolResult {
  const message = `arguments do not match the schema of tool "${defName}"`;
  return {
    ok: false,
    content: errorContentJson({
      type: 'invalid_arguments',
      message,
      human_hint:
        'Fix the parameters reported in the issues field and retry, or do not call the tool.',
      issues,
    }),
    error: { type: 'invalid_arguments', message },
  };
}

/** 未知工具单一文案（E10；附可用工具名单对收敛速度影响大：research §4.1）。 */
export function unknownToolMessage(name: string, available: readonly string[]): string {
  return `unknown tool "${name}"; available tools: [${available.join(', ')}]`;
}

/** 未知工具结果的唯一构造入口（content 与 error.message 同源同文案 + available_tools）。 */
export function unknownToolResult(name: string, available: readonly string[]): ToolResult {
  const message = unknownToolMessage(name, available);
  return {
    ok: false,
    content: errorContentJson({
      type: 'unknown_tool',
      message,
      human_hint: 'Use one of the available tools listed above, or finish without a tool call.',
      available_tools: [...available],
    }),
    error: { type: 'unknown_tool', message },
  };
}

/** 普通错误结果 → 工具消息 content（JSON 约定：ok:false + error）。 */
export function errorResultContent(result: ToolResult): string {
  return errorContentJson({
    type: result.error?.type ?? 'tool-error',
    message: result.error?.message ?? 'tool failed',
  });
}

/**
 * 方法论前置门回注（R2-S1）：替代执行的唯一构造入口——引导模型先 use_skill 加载
 * 命中的方法技能（复用 errorContentJson 单一实现；available_tools 带 use_skill 收敛抓手）。
 */
export function methodologyFirstResult(id: string): ToolResult {
  const message = `先加载方法：use_skill(${id})；加载技能全文后再执行本调用`;
  return {
    ok: false,
    content: errorContentJson({
      type: 'methodology-first',
      message,
      human_hint: `Call the use_skill tool with skill id "${id}" before any other tool call.`,
      available_tools: ['use_skill'],
    }),
    error: { type: 'methodology-first', message },
  };
}
