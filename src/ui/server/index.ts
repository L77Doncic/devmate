/**
 * # ui/server：本地 HTTP + SSE 服务（接缝 S12；ADR-0007）
 *
 * 职责（与 core 同进程直调，UI 只是会话的一个视图）：
 * - 上行（POST JSON）：/api/chat（首消息建会话 + run 异步启动）、/api/approval
 *   （危险操作审批应答）、/api/interrupt（用户中断）、GET/POST /api/settings（apiKey 只回掩码）。
 * - 会话 CRUD：GET /api/sessions（列表：deps.sessionLister 注入的数据源——服务端不直接
 *   fs）、GET /api/sessions/:id（历史映射回协议帧，最近 500 **帧**，帧数口径 + 剧集边界
 *   对齐——帧组整组裁剪、孤儿结果保留 d5 语义）、POST /api/sessions
 *   （新建空/带首消息会话，不启动 run；空 body 按 text 缺省接受）、DELETE /api/sessions/:id
 *   （删文件 + 清理 broker/审批挂起/shell——deps.disposeSession 联动；活跃 run 409）。
 *   DELETE 与 POST /api/chat 的「检查+append」段按 per-session 串行化（withSessionGuard——
 *   DELETE×重开竞态：rm 不落在新 run 脚下）；**成功路径断环**——sessionGuards 对该 id
 *   的串行化链随删除清零（同 id 重建从全新链开始，避免已删会话承诺悬挂）。
 *   resume 仍走 POST /api/chat {sessionId}。
 * - id 校验一致：/api/stream 与 /api/interrupt 的 sessionId 同样过 assertValidSessionId
 *   （越界/逃逸字面量 → 400；不依赖 store 是否抛错兜底——与其它端点同口径）。
 * - 轻量化：SessionBroker 每会话帧缓存上限（5000 帧或 4MB，裁最旧——在线消费不受影响、
 *   协议不新增字段）；SSE 断开即清心跳定时器；空闲 shell 按 idleShellTtlMs +
 *   disposeIdleShells(now, activeRunSessions) 经注入调度器的 60s 节拍回收（close 取消；
 *   **活跃 run 会话跳过**——TTL 只判空闲，运行中 shell 绝不误杀）；DELETE 即释放。
 * - GET /api/stats：{rssMb, heapMb, sessions, activeShells, mcpServers, mcpTools}（单次内存采样；
 *   前端侧栏用；mcpServers=配置数、mcpTools=最近一次组装的 mcp 工具面大小——统计不连接）。
 * - GET /api/tools：{tools:[{name, description, parameters}]}（deps.tools.list() 原样映射——
 *   parameters 即 JsonSchema 不摘要，前端本地摘要；按 name 升序；未注入回退空清单；
 *   同表合并 MCP 工具（composeRunTools——mcp 连接失败 → 0 个 mcp 工具，非故障）；
 *   list() 抛错 → 501 {error}，前端 fetch 失败路径回退内置静态清单）。
 * - /api/skills 开关构造期以 deps.skillsRecord 播种（缺省 {} = 全开——重启禁用保持，
 *   持久化断环：CLI attach 注入旧快照）；/api/mcp 添加带尺寸限制（name ≤64、command ≤256、
 *   args ≤16 且每项 ≤128，超限 400 {error} 带原因）；GET /api/mcp 响应 args 脱敏
 *   （--header/-H 后 Authorization 头掩码——服务端内部连接仍用原始 args，见 mcp-mask.ts）。
 * - MCP 协议客户端（P2）：deps 的 McpLauncher 懒连接 + createMcpTools 工具面合并——
 *   每次 run 与 GET /api/tools 经 composeRunTools 重新组装（POST /api/mcp 开关即时生效）。
 * - 下行（GET /api/stream?sessionId=）：SSE 帧流（事件清单逐字见 emit.ts 的 SseEventData；
 *   每 30s / heartbeatMs 补 `: ping` 注释行保活）。
 * - 静态资源：GET / 与 staticRoot 下的文件（缺省 src/ui/web；S13 落 index.html 前
 *   回退内置占位页）。绑定 127.0.0.1（本机）。
 *
 * 直调形态（run 照单接，不修改 core）：run() 的四个依赖全被装饰注入——
 * store 观察器（追加事件 → broker；reasoning 事件只推尾部增量——去重基线见
 * pendingReasoning）、llm tee（text 增量 → assistant-delta、reasoning 增量 → reasoning、
 * end/error 快照 → assistant-done）、registry 观察器（执行结果 → tool-result）、
 * 以及服务端自己实现的 Approver（emitted tool-start + approval-request、阻塞到
 * POST /api/approval；run 的 signal（interrupt）到达时按无备注拒绝收尾）。
 * SessionBroker 全量缓冲（连入晚于 run 启动的客户端回放同序），审批未答即 run 悬停。
 * 注意：run 结束后流不关（心跳保活 + 回放缓冲）；前端单流模型（S13）按会话只连一次。
 *
 * 运行时接线：每次 run 从当前设置重建 llm（deps.createLlm；构造时固定已废弃）、
 * 会话工具面（deps.createSessionTools：每会话懒建 registry、shell 每会话独立实例）、
 * 摘要器（deps.createSummarizer）；POST /api/settings 应用后经 deps.persistSettings 落盘
 * （CLI 传 config.ts 的 saveConfig）；deps.dispose 在 close() 统一清理会话 shell。
 *
 * 失败一律 4xx + {error}（统一 JSON 形状；400 请求/413 过大/404 不存在/409 冲突）。
 * 5xx（harness 异常）同样 {error}。terminology：ToolCall/审批/用户中断均对 CONTEXT.md。
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConversationSummarizer } from '../../core/context/index.js';
import type {
  ApprovalDecision,
  Approver,
  LlmAdapter,
  RunOptions,
  RunResult,
  ToolDef,
  ToolRegistry,
} from '../../core/loop/index.js';
import { run } from '../../core/loop/index.js';
// 命令安全分类器（S10；本模块只读消费：run_command 的 ask/deny 直拒矩阵输入）
import { classify, type Verdict } from '../../core/tools/classify.js';
import type { WorkflowConfig } from '../../shared/workflow.js';
import { clampMaxParallel, DEFAULT_SUBAGENTS_ENABLED } from '../../shared/workflow.js';
import type { SkillsIndex } from '../../core/tools/skill.js';
import type {
  MethodologyEntry,
  MethodologyIndex,
  MethodologyMap,
} from '../../shared/methodology.js';
import { parseMethodologyMap } from '../../shared/methodology.js';
import { assertValidSessionId } from '../../core/session/base.js';
import { SessionExistsError, SessionNotFoundError } from '../../core/session/errors.js';
import type { SessionStore } from '../../core/session/index.js';
import type { ReasoningEffort, StreamSnapshot } from '../../shared/llm-types.js';
import type {
  EventKind,
  SessionEvent,
  SessionEventInput,
  ToolCall,
} from '../../shared/session-types.js';
import {
  deriveTitle,
  pingFrame,
  serializeEvent,
  sessionWorkspaceOf,
  type SseEventData,
} from './emit.js';
// /api/mcp GET 响应脱敏（Authorization 头掩码；纯函数，见模块头）
import { maskMcpArgs } from './mcp-mask.js';
// 掩码单一实现（≤12 字符全掩；>12 显首尾 4）：shared/masking 单一来源
// （层间倒置修复——service 不再向上（cli）依赖；cli/config 留 re-export）
import { maskApiKey } from '../../shared/masking.js';
// 装配入口（S14 CLI 从本模块单点导入：assembleDeps + createDevmateServer）
export { assembleDeps } from './deps.js';
export type { DevmateConfig } from './deps.js';
// 掩码单一实现的再导出（历史消费者路径兼容；实现只在 shared/masking）
export { maskApiKey };

// ---------------------------------------------------------------------------
// 公共接口（S14 CLI 依赖的形状；服务端构造注入全部依赖，测试用假）
// ---------------------------------------------------------------------------

/**
 * dsh 式权限预设（CTO 语义定案；settings 持久化，缺省 'workspace-write'）：
 * - read-only（仅读）：fs 读类与只读命令放行；fs 写/编辑与 ask/deny 级命令 → ask（弹窗兜底）；
 * - workspace-write（默认，自动（工作区写））：fs 全类放行；只读命令放行；ask 级 → ask；
 *   deny 级（rm -rf 等不可逆）→ 不弹窗直接拒绝（permission-denied 回注 = 普通工具失败，模型继续）；
 * - full-access（全访问）：全放行（含 deny 级——一次性风险确认门由前端负责，后端只记录
 *   permissionConfirmedAt，不做强制后端门）。
 */
export type PermissionPreset = 'read-only' | 'workspace-write' | 'full-access';

/** 预设枚举（settings 值校验的单一集合；GET 响应恒为一个枚举值）。 */
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  'read-only',
  'workspace-write',
  'full-access',
];

/** 缺省预设（CTO 定案：workspace-write——写文件不再弹窗；dsh web shipped 同缺省）。 */
export const DEFAULT_PERMISSION_PRESET: PermissionPreset = 'workspace-write';

/** 审批策略（deps 覆写接缝）：true = 该调用需要人工审批；缺省走权限预设矩阵（见 decidePermission）。 */
export type ApprovalPolicy = (call: ToolCall, sessionId: string) => boolean;

export interface UiSettings {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** 思考强度初值（缺省 'medium'；CLI 从存储注入或保持缺省）。 */
  reasoning?: ReasoningEffort;
  /** 上下文窗口覆盖初值（缺省 = 供应商 preset 估算；测试/假 deps 可不给）。 */
  windowTokens?: number;
  /** 权限预设初值（缺省 'workspace-write'——CTO 裁定；与 reasoning 同机制）。 */
  permission?: PermissionPreset;
  /** full-access 风险确认记录（epoch ms；前端二次确认后写入——纯记录、不强制）。 */
  permissionConfirmedAt?: number;
  /** 方法论前置门开关初值（R2-S1：缺省 true；false = 不注入 RunOptions.methodology）。 */
  methodFirst?: boolean;
}

export interface SettingsSnapshot {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 思考强度（仅当对应字段被本次 POST 触碰时携带——补丁语义；CLI mergeConfig 单点写）。 */
  reasoning?: ReasoningEffort;
  /** 上下文窗口覆盖（同 reasoning 的触碰语义）。 */
  windowTokens?: number;
  /** 权限预设（同触碰语义）。 */
  permission?: PermissionPreset;
  /** full-access 风险确认记录（同触碰语义）。 */
  permissionConfirmedAt?: number;
  /** 方法论前置门（同触碰语义；R2-S1）。 */
  methodFirst?: boolean;
}

/** 会话列表摘要（GET /api/sessions 的 sessions[] 元素）。 */
export interface SessionSummary {
  sessionId: string;
  /** 首条 user 事件文本前 40 字符（中文按字符）；无 user 事件（空会话）。 */
  title: string;
  /** 首事件时间戳；空文件回退文件 mtime。 */
  createdAtMs: number;
  /** 末事件时间戳；空文件回退文件 mtime。 */
  lastEventMs: number;
  /** assistant 事件数（协议外的步数粗略计；前端可选展示）。 */
  stepCount?: number;
  /** 会话数超限提示标记（服务端在 GET /api/sessions 注入：最旧 10 个空闲会话；只提示不自动删）。 */
  compact?: boolean;
  /**
   * 会话所属项目文件夹（A 档：首条 session-workspace meta 的 workspaceRoot；
   * 旧会话/无 meta → null——前端显示「未知项目」；lister 注入的数据源负责填充）。
   */
  workspaceRoot?: string | null;
}

/** 会话列表数据源（deps 注入：deps.ts 以 fs 目录扫描 + store 容错读取实现；服务端不直接接触 fs）。 */
export type SessionLister = () => Promise<SessionSummary[]>;

/** MCP 服务器配置记录（GET /api/mcp 与追加/开关共用的形状；P2 协议客户端前只存配置）。 */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

/** POST /api/mcp 名称长度上限（字符；超限 400 {error} 带原因）。 */
export const MCP_NAME_LIMIT = 64;
/** POST /api/mcp 命令长度上限（字符；超限 400 {error} 带原因）。 */
export const MCP_COMMAND_LIMIT = 256;
/** POST /api/mcp args 项数上限（超限 400 {error} 带原因）。 */
export const MCP_ARGS_LIMIT = 16;
/** POST /api/mcp 单个 args 项长度上限（字符；超限 400 {error} 带原因）。 */
export const MCP_ARG_LENGTH_LIMIT = 128;

/** 定时器句柄（服务端空闲清扫；close 统一取消）。 */
export interface TickHandle {
  cancel(): void;
}

/** 调度器注入形态（S13/CLI 对接方需要；测试注入同步/虚拟调度器，不真等 60s）。 */
export type TickScheduler = (handler: () => void, intervalMs: number) => TickHandle;

export interface DevmateServerDeps {
  /** 会话存储（唯一事实来源；run 经观察器直写）。 */
  store: SessionStore;
  /**
   * 工作区根（A 档：会话首建时写入 session-workspace meta 的 workspaceRoot；
   * 未注入 = 旧服务/假 deps → 不写 meta，详情/列表回退 null）。
   */
  workspaceRoot?: string;
  /** 工具注册表（defineRegistry 输出；见 deps.ts 的组装）。缺省 = 空注册表（GET /api/tools 空清单；服务端不自行装配）。 */
  tools?: ToolRegistry;
  /** LLM 接缝（真实为 wiredLlmAdapter；测试注入假流）。 */
  llm: LlmAdapter;
  /** 初始模型名（run 用当前 settings.model；无 settings 时回落本字段）。 */
  model: string;
  /** 初始设置；缺省 {model: deps.model}。 */
  settings?: UiSettings;
  /** 审批策略覆写（true = 弹窗）；缺省 = 权限预设矩阵（decidePermission × current.permission）。 */
  approvalPolicy?: ApprovalPolicy;
  /** run 透传覆写（maxSteps/windowTokens/pricing 等）；store/tools/llm/approver/signal/model 由其接管。 */
  runOptions?: Partial<RunOptions>;
  /** 会话工具工厂：每会话懒建注册表（shell 每会话独立实例）；缺省用 deps.tools（单例）。 */
  createSessionTools?: (sessionId: string) => ToolRegistry;
  /** 会话资源清理（常驻 shell 等）；createDevmateServer.close() 时调用。 */
  dispose?: () => Promise<void>;
  /** 每 run 从当前设置重建 LLM 接缝；缺省用 deps.llm（构造时固定）。 */
  createLlm?: (settings: { baseUrl: string; apiKey: string | undefined }) => LlmAdapter;
  /** 每 run 重建摘要器（同一 llm；settings.model 变更即生效）；缺省用 runOptions.summarizer。 */
  createSummarizer?: (llm: LlmAdapter, model: string) => ConversationSummarizer;
  /** 设置持久化回调（POST /api/settings 应用后调用；CLI 传 config.ts 的 saveConfig）。 */
  persistSettings?: (settings: SettingsSnapshot) => void | Promise<void>;
  /** 静态资源根；缺省 = 本模块相对路径的 ../web（src/ui/web；打包后 dist/ui/web 由 S14 处理）。 */
  staticRoot?: string;
  /** SSE 心跳间隔（ms；缺省 30_000，0 = 禁用）。 */
  heartbeatMs?: number;
  /** 会话列表数据源（缺省恒空表——真实实现由 assembleDeps 注入；服务端不直接 fs）。 */
  sessionLister?: SessionLister;
  /** GET /api/sessions 会话数上限（缺省 50）；超过 → 响应附加 {capped:true, hint} 并标记最旧 10 个空闲会话（不自动删）。 */
  sessionCap?: number;
  /** 会话删除联动（DELETE /api/sessions/:id）：删除持久化文件 + 释放该会话 shell 等资源（幂等）。 */
  disposeSession?: (sessionId: string) => Promise<void> | void;
  /** 空闲 shell 释放：服务端每 idleSweepMs 调 disposeIdleShells(Date.now(), activeRunSessions)；
   * 实现按 idleShellTtlMs 判超时且**跳过活跃 run 会话**（TTL 误杀修复——运行中 shell 不回收）。 */
  disposeIdleShells?: (now: number, activeSessionIds?: ReadonlySet<string>) => Promise<void> | void;
  /** 空闲 shell TTL（ms；缺省 600_000——deps 装配层消费，服务端仅透传形状）。 */
  idleShellTtlMs?: number;
  /** Skills 资产目录（缺省 resolve(process.cwd(),'dist/assets/skills')）；不存在/为空 → GET /api/skills 空列表。 */
  skillsDir?: string;
  /** Skills 开关持久化（~/.devmate/config.json 的 skills 节；CLI 注入 saveConfig 包装——无则仅内存）。 */
  saveSkillsConfig?: (skills: Record<string, boolean>) => void | Promise<void>;
  /** Skills 开关初值（socket 播种：旧开关经 CLI attach 注入，构造期种子；缺省 {} = 全开）。 */
  skillsRecord?: Record<string, boolean>;
  /** 工作流配置初值（缺省 {subagentsEnabled:true, maxParallel:2}；maxParallel 夹紧 1-4）。 */
  workflow?: { subagentsEnabled?: boolean; maxParallel?: number };
  /** 工作流配置持久化（CLI 注入 saveConfig 包装；无则仅内存）。 */
  saveWorkflow?: (workflow: {
    subagentsEnabled: boolean;
    maxParallel: number;
  }) => void | Promise<void>;
  /** 技能索引接缝（晚绑定回填）：服务端启动时从自身索引缓存组装 SkillsIndex 经此回填——use_skill 工具读；扫描单一来源仍是服务端（本模块 skillsCache）。 */
  attachSkillsIndex?: (index: SkillsIndex) => void;
  /** 方法论索引接缝（晚绑定回填；R2-S1）：服务端从自身缓存（元数据 × 运行时开关）组装经此回填——loop 前置门 route 与提示词路由节现读。 */
  attachMethodologyIndex?: (index: MethodologyIndex) => void;
  /** 工作流实时配置接缝（晚绑定回填）：workflowState 读取器经此回填——子代理池 config 闭包与提示词合成读取（POST /api/workflow 即时生效）。 */
  attachWorkflowConfig?: (current: () => WorkflowConfig) => void;
  /** 会话系统提示合成（assembleDeps 提供）：基础提示 + 技能清单节 + 子代理节；startRun 每次运行前合成（技能开关/workflow 变更即时生效）。 */
  composeSystemPrompt?: () => Promise<string>;
  /** MCP 服务器配置（配置层 + P2 协议客户端接线：启用的服务器经 deps 的 launcher 懒连接。 */
  mcpServers?: McpServerConfig[];
  /** MCP 配置持久化（CLI 注入；无则仅内存）。 */
  saveMcpConfig?: (servers: McpServerConfig[]) => void | Promise<void>;
  /** 每次 run 工具面合并（deps 实现：base + 新组装 MCP 工具——开关变更即时生效）；
   *  GET /api/tools 亦经此（同表）；未注入 → 原 registry（直读）。 */
  composeRunTools?: (base: ToolRegistry, sessionId: string) => Promise<ToolRegistry>;
  /** MCP 配置晚绑定（deps 的 launcher 现读服务端当前配置——POST /api/mcp 即时生效）。 */
  attachMcpConfig?: (current: () => readonly McpServerConfig[]) => void;
  /** MCP 工具数（最近一次组装的 mcp 工具面大小；stats 的 mcpTools；未注入默认 0）。 */
  mcpToolCount?: () => number | Promise<number>;
  /** 内存守卫：rss 采样器（字节；注入即安装——assembleDeps 装配默认 process.memoryUsage().rss）。 */
  memorySampler?: () => number | Promise<number>;
  /** 内存守卫采样节拍（ms；缺省 60_000；close 取消定时器）。 */
  memorySweepMs?: number;
  /** 内存泄压处置：释放全部**空闲** shell（跳过活跃 run 会话；缺省回退 disposeIdleShells(Infinity, active)）。 */
  disposeAllIdle?: (activeSessionIds?: ReadonlySet<string>) => Promise<void> | void;
  /** 排队子代理数（stats 的 queuedSubagents；未注入不出现——实际子代理池属 P2）。 */
  queuedSubagentCount?: () => number | Promise<number>;
  /** 空闲清扫节拍（ms；缺省 60_000；测试可注入调度器而不真等）。 */
  idleSweepMs?: number;
  /** 定时器调度接缝（缺省真实 setInterval 包装；测试注入同步/虚拟调度器）。 */
  scheduleTick?: TickScheduler;
  /** 常驻 shell 实例数（GET /api/stats 的 activeShells；缺省 0）。 */
  activeShellCount?: () => number | Promise<number>;
}

export interface ServerAddress {
  host: string;
  port: number;
}

export interface DevmateServer {
  /** 绑定 127.0.0.1（本机）；port 缺省 0（系统分配）。 */
  listen(port?: number): Promise<ServerAddress>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 会话实时上下文（每会话：broker + 事件配对簿 + 审批簿 + 活跃 run）
// ---------------------------------------------------------------------------

interface SessionCtx {
  readonly sessionId: string;
  readonly broker: SessionBroker;
  /** toolCallId → name（assistant-done/tool-start 时登记；供 store 观察器补 name）。 */
  readonly callNames: Map<string, string>;
  /** 已由 registry 观察器广播过 tool-result 的调用（store 观察器不重发）。 */
  readonly executed: Set<string>;
  /** 悬挂审批：toolCallId → settle。 */
  readonly pending: Map<string, (decision: ApprovalDecision) => void>;
  /**
   * 已推送的推理文本（当前 llm 周期；tee 的 reasoning 增量与存储 reasoning 事件的
   * 去重基线——存储落的是整轮推理全文（agent.ts 逐轮追加），只推「尚未推送的尾部」）。
   * 每次 teeLlm.chat 开始即清（新推理周期从头计）。
   */
  pendingReasoning: string;
  controller: AbortController | null;
  active: boolean;
}

/** 每会话事件帧缓存上限（帧数；与字节谓词先到先裁，裁最旧）。 */
export const BROKER_MAX_FRAMES = 5000;
/** 每会话事件帧缓存字节上限（JSON 序列化宽度近似；与帧数谓词先到先裁）。 */
export const BROKER_MAX_BYTES = 4 * 1024 * 1024;

/** 帧宽近似（推送时一次序列化成本；只用于裁剪谓词，非线上载荷）。 */
function frameWidth(frame: SseEventData): number {
  return JSON.stringify(frame).length;
}

/**
 * 每会话事件总线：缓冲（有上限）+ 多订阅（含后进回放）。
 * - 缓冲上限：帧数或字节谓词先到即裁最旧；在线（已连入）客户端实时消费不依赖缓冲，
 *   后连客户端只见最近窗口（协议字段不新增，裁剪只保证内存有界）。
 * - 裁剪用「绝对序号 head」语义：订阅游标永远读绝对位置，不因裁剪错位/重复。
 */
export class SessionBroker {
  /** 帧窗口（frames[0] 的绝对序号 = head；裁剪从最旧推进）。 */
  private readonly frames: SseEventData[] = [];
  private head = 0;
  private bytes = 0;
  private waiters: Array<() => void> = [];

  push(frame: SseEventData): void {
    this.frames.push(frame);
    this.bytes += frameWidth(frame);
    while (this.frames.length > BROKER_MAX_FRAMES || this.bytes > BROKER_MAX_BYTES) {
      const dropped = this.frames.shift();
      if (dropped === undefined) break;
      this.bytes -= frameWidth(dropped);
      this.head += 1;
    }
    this.wake();
  }

  /** 唤醒全部订阅者（无新帧时会让订阅循环再挂起；close 时用它与停止标记配合退出）。 */
  wake(): void {
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  /**
   * 清空缓冲窗（内存泄压：broker 清空——裁剪全部已缓冲帧并唤醒订阅者）。
   * 绝对序号延续（head 推进到窗体尾）：在线订阅游标不失效，清窗后的新帧照常
   * 按原序号投递；后进回放自然从空窗之后开始——「清窗保留在线帧」语义。
   */
  clear(): void {
    this.head += this.frames.length;
    this.frames.length = 0;
    this.bytes = 0;
    this.wake();
  }

  async *consume(): AsyncGenerator<SseEventData> {
    let cursor = this.head; // 后进回放：从当前窗口最旧帧开始
    for (;;) {
      // available 在循环内逐次重读：clear() 会把 head 推进到窗体尾（重编号）——
      // 在线订阅者游标小于 head 的空窗段按 undefined 跳过、不输出，随后照常接到
      // 新帧；若在外层缓存 available，清窗后游标永远追平旧值 → 在线订阅卡死。
      while (cursor < this.head + this.frames.length) {
        const frame = this.frames[cursor - this.head];
        cursor += 1;
        if (frame !== undefined) yield frame;
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// MemoryGuard（内存防线：rss 三档采样——警戒/停机/恢复）
// ---------------------------------------------------------------------------

/** 内存警戒线（MB）：超过 = 释放空闲 shell + broker 清窗 + 记 memoryGuard.tripped。 */
export const MEMORY_TRIP_ALERT_MB = 1.5 * 1024;
/** 内存停机线（MB）：超过 = 拒绝新 run 启动（409 memory-pressure）。 */
export const MEMORY_TRIP_HALT_MB = 2 * 1024;
/** 内存恢复线（MB）：低于 = 自动解锁（tripped 复位）。 */
export const MEMORY_TRIP_RECOVER_MB = 1.2 * 1024;

/** 停机档拒绝提示（409 回体的 message；error 字段固定 'memory-pressure' 供前端语义判定）。 */
export const MEMORY_PRESSURE_HINT =
  'memory-pressure：服务内存占用超过 2GB，已暂停新任务；内存恢复（<1.2GB）后自动解锁，请稍后重试或清理会话';

/** stats.memoryGuard 的形状（守卫状态快照；recovery 后 tripped:false、reason 清空、lastAt 保留历史）。 */
export interface MemoryGuardStatus {
  tripped: boolean;
  lastAt: number | null;
  reason: string | null;
}

/**
 * 内置守卫器：每采样节拍（缺省 60s）判档一次——
 * - ≥警戒线：上升沿执行一次泄压处置（onAlert：dispose 全部空闲 shell + 全会话 broker 清窗）
 *   + 记 tripped/lastAt/reason='memory-pressure'；新 run 仍允许；
 * - ≥停机线：追加 halted（拒绝新 run 启动；前次泄压处置已在警戒/停机上升沿执行）；
 * - <恢复线：自动解锁与复位（tripped:false / reason:null；lastAt 保留为历史）；
 * - 迟滞带（恢复线~警戒线之间）：保持当前档状态（停机锁不因短期波动提前解除）。
 * 采样失败（sampler 抛错）：保守不动（下次采样再判）。
 */
export class MemoryGuard {
  private trippedFlag = false;
  private haltedFlag = false;
  private lastAtMs: number | null = null;
  private reason: string | null = null;

  constructor(
    private readonly options: {
      /** rss 采样（字节）；测试注入可编程假采样。 */
      sampler: () => number | Promise<number>;
      /** 泄压处置（警戒上升沿执行一次；hang 风险由实现方保证幂等）。 */
      onAlert: () => void | Promise<void>;
    },
  ) {}

  /** 采样并判档（幂等：警戒档滞留期间不重复处置；异常采样静默跳过）。 */
  async check(): Promise<void> {
    let rssBytes: number;
    try {
      rssBytes = await this.options.sampler();
    } catch {
      return;
    }
    const mb = rssBytes / (1024 * 1024);
    if (mb >= MEMORY_TRIP_ALERT_MB) {
      if (!this.trippedFlag) {
        this.trippedFlag = true;
        this.lastAtMs = Date.now();
        this.reason = 'memory-pressure';
        await this.options.onAlert(); // 警戒/停机上升沿只处置一次
      }
      if (mb >= MEMORY_TRIP_HALT_MB) this.haltedFlag = true;
      return;
    }
    if (mb < MEMORY_TRIP_RECOVER_MB) {
      this.trippedFlag = false;
      this.haltedFlag = false;
      this.reason = null;
      return;
    }
    // 迟滞带（恢复线 ≤ mb < 警戒线）：保持当前状态
  }

  /** 停机档（≥2GB）为 true：拒绝新 run 启动。 */
  get runAllowed(): boolean {
    return !this.haltedFlag;
  }

  /** 状态快照（GET /api/stats 的 memoryGuard 节）。 */
  get status(): MemoryGuardStatus {
    return { tripped: this.trippedFlag, lastAt: this.lastAtMs, reason: this.reason };
  }
}

// ---------------------------------------------------------------------------
// run 依赖装饰（store 观察器 / llm tee / registry 观察器 / Approver 实现）
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 200;
/** tool-result 全量内容上限（字符；收集缓冲 64KB 内完整，超出截断留存）。 */
const TOOL_CONTENT_MAX = 64 * 1024;

function previewOf(content: string): string {
  if (content.length <= PREVIEW_MAX) return content;
  return `${content.slice(0, PREVIEW_MAX)}…`;
}

function toolContentOf(content: string): string {
  if (content.length <= TOOL_CONTENT_MAX) return content;
  return content.slice(0, TOOL_CONTENT_MAX);
}

/** 非执行路径的 tool 事件（畸形/拒绝/中断占位）：core 载荷是 {ok:false,error:{...}} JSON，解析给 UI。 */
function parseStoreToolOutcome(content: string): { ok: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: true };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: true };
  const record = parsed as { ok?: unknown; error?: unknown };
  if (typeof record.ok !== 'boolean') return { ok: true };
  if (record.ok) return { ok: true };
  const error = record.error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return { ok: false, error: message };
  }
  return { ok: false };
}

/**
 * 会话 event 事件 → 协议帧（compaction 披露；流内观察器与历史映射共用，合成规则同源）。
 * 只映射 payload.type === 'compaction'（上下文压缩记录）——其余 event 类型
 * （projection_changed / tool_truncated …）无协议帧，原样丢弃。
 * 字段规约与 src/ui/web/sessions.js 的 toProtocolEvent 一致（不崩、不误发）：
 * summary 非 string 缺失 → 空串（前端降级显示「上下文已压缩」）；tokensBefore/tokensAfter
 * 仅当为 number 时携带（映射前旧形状的字符串/缺失字段剔除）。
 */
function eventFrames(ev: SessionEvent): SseEventData[] {
  if (ev.kind !== 'event' || ev.payload.type !== 'compaction') return [];
  const data: Record<string, unknown> =
    typeof ev.payload.data === 'object' && ev.payload.data !== null ? ev.payload.data : {};
  const out: { summary: string; tokensBefore?: number; tokensAfter?: number } = {
    summary: typeof data.summary === 'string' ? data.summary : '',
  };
  if (typeof data.tokensBefore === 'number') out.tokensBefore = data.tokensBefore;
  if (typeof data.tokensAfter === 'number') out.tokensAfter = data.tokensAfter;
  return [{ event: 'compaction', data: out }];
}

// ---------------------------------------------------------------------------
// reasoning 帧（Wave 2：思考增量；在线流逐步推送 / 历史回放折叠单帧）
// ---------------------------------------------------------------------------

/**
 * 历史回放推理折叠帧的文本上限（字符；与 src/ui/web/format.js 的 THINK_TEXT_CAP 同值
 * 20k——前端展示侧既有护栏，服务端回放在源头先截）。
 */
export const REASONING_TEXT_CAP = 20_000;
/** 截断注记（与前端 thinkBodyText 的「…（截断）」标注同规：正文超出即附注）。 */
export const REASONING_TRUNCATED_MARK = '…（截断）';

/**
 * 增量推导：content（存储侧整轮推理全文）与 pushed（已推送量）同前缀时取尾部增量；
 * 未推过（pushed 空）→ 全文；两源漂移（前缀不匹配——防御，正常不可达）→ 全文兜底
 * （宁重复不少字；下一 llm 周期从头计，不累积污染）。
 */
export function reasoningDeltaOf(content: string, pushed: string): string {
  if (content.length >= pushed.length && content.startsWith(pushed)) {
    return content.slice(pushed.length);
  }
  return content.length > 0 ? content : '';
}

/** 回放折叠帧的正文：≤ 上限原样；超出截断 + 注记（前端再按 THINK_TEXT_CAP 兜底）。 */
export function reasoningFrameText(content: string): string {
  if (content.length <= REASONING_TEXT_CAP) return content;
  return content.slice(0, REASONING_TEXT_CAP) + REASONING_TRUNCATED_MARK;
}

function observeStore(inner: SessionStore, ctxFor: (id: string) => SessionCtx): SessionStore {
  return {
    create: (id) => inner.create(id),
    exists: (id) => inner.exists(id),
    fork: (fromId, newId) => inner.fork(fromId, newId),
    repairOrphaned: (id) => inner.repairOrphaned(id),
    events: (id) => inner.events(id),
    async append<K extends EventKind>(
      id: string,
      input: SessionEventInput<K>,
    ): Promise<SessionEvent<K>> {
      const saved = await inner.append(id, input);
      // SessionEvent 是 kind↔payload 的可判别联合；泛型实例不宜窄化，收宽后再判型
      const wide = saved as SessionEvent;
      const ctx = ctxFor(id);
      if (wide.kind === 'user') {
        ctx.broker.push({ event: 'session-user', data: { text: wide.payload.content } });
        return saved;
      }
      if (wide.kind === 'tool') {
        if (!ctx.executed.has(wide.payload.toolCallId)) {
          const outcome = parseStoreToolOutcome(wide.payload.content);
          ctx.broker.push({
            event: 'tool-result',
            data: {
              id: wide.payload.toolCallId,
              name: ctx.callNames.get(wide.payload.toolCallId) ?? 'unknown',
              ok: outcome.ok,
              contentPreview: previewOf(wide.payload.content),
              content: toolContentOf(wide.payload.content),
              ...(outcome.error !== undefined ? { error: outcome.error } : {}),
            },
          });
        }
      } else if (wide.kind === 'reasoning') {
        // 推理事件追加（agent 每次 runTurn 落整轮推理全文；tee 已在流内推过同一批增量）
        // ——只推「尚未推送的尾部增量」（观察器模式与 compaction 同源；增量对账见
        // ctx.pendingReasoning / reasoningDeltaOf）。
        const delta = reasoningDeltaOf(wide.payload.content, ctx.pendingReasoning);
        if (delta !== '') {
          ctx.pendingReasoning += delta;
          ctx.broker.push({ event: 'reasoning', data: { text: delta } });
        }
      } else if (wide.kind === 'event') {
        for (const frame of eventFrames(wide)) ctx.broker.push(frame);
      }
      return saved;
    },
  };
}

function observeRegistry(inner: ToolRegistry, ctx: SessionCtx): ToolRegistry {
  return {
    list: () => inner.list(),
    async execute(call: ToolCall) {
      const result = await inner.execute(call);
      ctx.executed.add(call.id);
      ctx.broker.push({
        event: 'tool-result',
        data: {
          id: call.id,
          name: call.name,
          ok: result.ok,
          contentPreview: previewOf(result.content),
          content: toolContentOf(result.content),
          ...(result.error !== undefined && result.error.message !== ''
            ? { error: result.error.message }
            : {}),
        },
      });
      return result;
    },
  };
}

function teeLlm(inner: LlmAdapter, ctx: SessionCtx): LlmAdapter {
  return {
    async *chat(request, signal) {
      // 新推理周期：去重基线清零（存储推测事件是整轮全文，对账只在本周期内）
      ctx.pendingReasoning = '';
      let content = '';
      let snapshot: StreamSnapshot | null = null;
      let done = false;
      const emitDone = (): void => {
        const toolCalls = (snapshot?.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        }));
        for (const call of toolCalls) ctx.callNames.set(call.id, call.name);
        ctx.broker.push({ event: 'assistant-done', data: { content, toolCalls } });
      };
      try {
        for await (const ev of inner.chat(request, signal)) {
          if (ev.type === 'text') {
            content += ev.text;
            ctx.broker.push({ event: 'assistant-delta', data: { text: ev.text } });
          } else if (ev.type === 'reasoning') {
            // 思考增量即时镜像（实时性：模型边思考边推送；前端就地累积）
            ctx.pendingReasoning += ev.text;
            ctx.broker.push({ event: 'reasoning', data: { text: ev.text } });
          } else if (ev.type === 'end' || ev.type === 'error') {
            snapshot = ev.snapshot;
          }
          yield ev;
          if (ev.type === 'end' || ev.type === 'error') {
            emitDone();
            done = true;
          }
        }
      } finally {
        // 消费者提前中断（成本中止等）：尽力广播已收部分
        if (!done) emitDone();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 权限预设判定矩阵（CTO 语义定案；纯函数——单元测试逐格覆盖，无需 IO）
// ---------------------------------------------------------------------------

/** fs 读类工具（read-only/workspace-write/full-access 三档均放行）。 */
const FS_READ_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep']);
/** fs 写/编辑工具（read-only → ask；workspace-write/full-access → 放行）。 */
const FS_WRITE_TOOLS = new Set(['write_file', 'edit_file']);
/** shell 工具（命令按 classify 三档裁定）。 */
const SHELL_TOOL = 'run_command';

/** 一次调用的矩阵类别（fs 读 / fs 写 / shell（含 classify 档位）/ 矩阵外普通工具）。 */
export type PermissionCallClass =
  | { kind: 'fs-read' }
  | { kind: 'fs-write' }
  | { kind: 'shell'; verdict: Verdict; reasons: readonly string[] }
  | { kind: 'tool' };

/** 调用 → 矩阵类别（run_command 的参数不可解析/无 command → 按未知命令 ask，不放行不明命令）。 */
export function classifyPermissionCall(call: ToolCall): PermissionCallClass {
  if (FS_WRITE_TOOLS.has(call.name)) return { kind: 'fs-write' };
  if (FS_READ_TOOLS.has(call.name)) return { kind: 'fs-read' };
  if (call.name === SHELL_TOOL) {
    const command = shellCommandOf(call.arguments);
    if (command !== undefined) {
      const classification = classify(command);
      return {
        kind: 'shell',
        verdict: classification.verdict,
        reasons: classification.reasons ?? [],
      };
    }
    return {
      kind: 'shell',
      verdict: 'ask',
      reasons: ['run_command 参数不可用：命令为空/无法解析'],
    };
  }
  // 矩阵外普通工具（use_skill/spawn_subagent/mcp_* 等）：dsh 口径——普通工具调用不产生
  // 审批请求（A3）；三档均放行（真正的文件效应已由监狱层在工具执行期实施）。
  return { kind: 'tool' };
}

/** run_command arguments JSON → command 字符串（畸形 → undefined；与 shell.ts 的解析口径一致）。 */
function shellCommandOf(rawArguments: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const command = (parsed as Record<string, unknown>)['command'];
  return typeof command === 'string' && command !== '' ? command : undefined;
}

/** 矩阵单格判定结果：'allow'（放行不弹窗）/ 'ask'（approval-request）/ deny（直拒回注）。 */
export type PermissionDecision = 'allow' | 'ask' | { deny: true; reason: string };

/**
 * 权限判定矩阵（CTO 语义定案，逐格）：
 * | 类别 \ 预设           | read-only | workspace-write（默认） | full-access |
 * | fs 读（read/list/glob/grep） | allow | allow | allow |
 * | fs 写/编辑（write_file/edit_file）| ask | allow | allow |
 * | shell classify=read-only | allow | allow | allow |
 * | shell classify=ask   | ask | ask | allow |
 * | shell classify=deny（rm -rf 等） | ask | deny（不弹窗直接拒） | allow |
 * | 矩阵外普通工具        | allow | allow | allow |
 * 说明：deny 直拒（permission-denied 回注）只在 workspace-write 档保留——DevMate 无沙箱
 * 执行层，这正是模型唯一可见的红色护栏；full-access = 用户经一次性风险确认后接受无障碍执行；
 * read-only 档 deny 级命令走 ask（无执行层拦不下，必须问询兜底）。
 */
export function decidePermission(permission: PermissionPreset, call: ToolCall): PermissionDecision {
  const cls = classifyPermissionCall(call);
  switch (cls.kind) {
    case 'fs-read':
    case 'tool':
      return 'allow';
    case 'fs-write':
      return permission === 'read-only' ? 'ask' : 'allow';
    case 'shell':
      switch (cls.verdict) {
        case 'read-only':
          return 'allow';
        case 'ask':
          return permission === 'full-access' ? 'allow' : 'ask';
        case 'deny':
          if (permission === 'read-only') return 'ask';
          if (permission === 'workspace-write') {
            return { deny: true, reason: permissionDeniedMessage(permission, cls.reasons) };
          }
          return 'allow';
      }
  }
}

/** deny 直拒的唯一拒因文案（dsh marker 风格 + classify 拒因；单一实现，测试逐字断言）。 */
export function permissionDeniedMessage(
  permission: PermissionPreset,
  reasons: readonly string[],
): string {
  const details = reasons.length > 0 ? `：${reasons.join('；')}` : '';
  return `[permission: 命令被安全策略拒绝 under ${permission} mode]${details}`;
}

/** approver 决策函数（依赖注入形态；decidePermission 的 sessionId 无关包装）。 */
export type PermissionDecider = (call: ToolCall) => PermissionDecision;

function makeApprover(ctx: SessionCtx, decide: PermissionDecider): Approver {
  return async (call: ToolCall): Promise<ApprovalDecision> => {
    ctx.callNames.set(call.id, call.name);
    ctx.broker.push({
      event: 'tool-start',
      data: { id: call.id, name: call.name, arguments: call.arguments },
    });
    const decision = decide(call);
    if (decision === 'allow') return 'allow';
    if (typeof decision === 'object') {
      // deny 路径：不产生 approval-request（纯工具节点）——权限拒绝 = 普通工具失败消息，
      // 回注 error.type='permission-denied'，模型继续（CTO 语义定案 #3/#6）
      return { deny: true, reason: decision.reason, errorType: 'permission-denied' };
    }
    ctx.broker.push({
      event: 'approval-request',
      data: { toolCallId: call.id, name: call.name, arguments: call.arguments },
    });
    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const settle = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        ctx.pending.delete(call.id);
        if (ctx.controller !== null) {
          ctx.controller.signal.removeEventListener('abort', onAbort);
        }
        resolve(decision);
      };
      const onAbort = (): void => settle({ deny: true });
      ctx.pending.set(call.id, settle);
      if (ctx.controller !== null) {
        if (ctx.controller.signal.aborted) {
          settle({ deny: true });
          return;
        }
        ctx.controller.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };
}

// ---------------------------------------------------------------------------
// 会话历史映射（GET /api/sessions/:id：事件流 → UI 协议帧）
// ---------------------------------------------------------------------------

/** 详情接口最多回放的协议帧数（按帧计——映射为协议帧后裁剪；实现与文档统一口径）。 */
const HISTORY_FRAME_LIMIT = 500;
/** 帧裁剪的事件级检索余量（尾部事件切片；0 帧事件不产生输出，帧预算窗口必然落在切片内）。 */
const HISTORY_SLICE_EVENTS = 720;

/**
 * 把持久化事件流映射回协议帧：user → session-user；assistant → assistant-done
 * （流式 delta 已不可再得——历史只落终态，哑式合并为 done；toolCalls 保真）+
 * 有结果的调用补 tool-start（approval 前置与 result 配对可还原）；tool → tool-result
 * （name 由 assistant 登记的 callNames 映射，缺失回退 unknown）；
 * event（type compaction）→ compaction 帧（其余 event 类型仍丢弃）；
 * reasoning → **折叠为一条** reasoning 帧（同一 assistant 预案的连续多条推理事件拼接为
 * 完整正文；≤ REASONING_TEXT_CAP 截断注记），按事件序置于其 assistant 之前；
 * system 不入协议帧。title 规则与列表一致（首条 user 文本前 40 字符 /（空会话））。
 *
 * 裁剪语义（audit 双一致）：按**帧数**计（≤HISTORY_FRAME_LIMIT 帧），并从尾部回退到
 * 帧级切点后做**剧集边界对齐**：
 * - 若切点落在某 assistant 帧组中段（残留无主 tool-start），把窗口起点整体推进到
 *   下一个完整剧集起点（该帧组整组丢弃——绝不输出悬空 tool-start/残缺帧组）；
 * - 孤儿 tool-result（其 assistant-done/声明被裁）保留：与在线流一致——name 按全局
 *   声明映射（无声明回退 unknown，d5 语义）。
 */
async function sessionDetailFrames(
  store: SessionStore,
  sessionId: string,
): Promise<{ title: string; workspaceRoot: string | null; frames: SseEventData[] }> {
  const callNames = new Map<string, string>();
  const resultIds = new Set<string>();
  let title: string | undefined;
  let workspaceRoot: string | null = null;
  const recent: SessionEvent[] = [];
  for await (const ev of store.events(sessionId)) {
    // A 档：首条 session-workspace meta（旧会话无 meta → null；畸形 data 不崩）
    if (workspaceRoot === null) workspaceRoot = sessionWorkspaceOf(ev);
    if (title === undefined && ev.kind === 'user') title = ev.payload.content;
    if (ev.kind === 'assistant') {
      for (const call of ev.payload.toolCalls) callNames.set(call.id, call.name);
    }
    if (ev.kind === 'tool') resultIds.add(ev.payload.toolCallId);
    recent.push(ev);
    if (recent.length > HISTORY_SLICE_EVENTS) recent.shift();
  }
  /** 事件 → 协议帧组（每组原子处理：整组保留或整组裁剪；合成规则与在线流相同）。 */
  const framesOf = (ev: SessionEvent): SseEventData[] => {
    switch (ev.kind) {
      case 'user':
        return [{ event: 'session-user', data: { text: ev.payload.content } }];
      case 'assistant': {
        const toolCalls = ev.payload.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        }));
        const group: SseEventData[] = [
          { event: 'assistant-done', data: { content: ev.payload.content, toolCalls } },
        ];
        for (const call of ev.payload.toolCalls) {
          // tool-start 只对有结果的调用发：悬空调用（无结果事件）不留未配对帧
          if (resultIds.has(call.id)) {
            group.push({
              event: 'tool-start',
              data: { id: call.id, name: call.name, arguments: call.arguments },
            });
          }
        }
        return group;
      }
      case 'tool': {
        const outcome = parseStoreToolOutcome(ev.payload.content);
        return [
          {
            event: 'tool-result',
            data: {
              id: ev.payload.toolCallId,
              name: callNames.get(ev.payload.toolCallId) ?? 'unknown',
              ok: outcome.ok,
              contentPreview: previewOf(ev.payload.content),
              content: toolContentOf(ev.payload.content),
              ...(outcome.error !== undefined ? { error: outcome.error } : {}),
            },
          },
        ];
      }
      case 'event':
        // compaction 披露帧（独立帧组：整组任一分帧，裁剪时原子；其余 event 类型无映射）
        return eventFrames(ev);
      default:
        return [];
    }
  };
  // 推理折叠扫描：连续 reasoning 事件缓冲入 pendingReasoning（同 assistant 预案——
  // agent 每轮至多一条，多条防御性拼接），下一个非推理事件前 flush 为一条折叠帧；
  // 尾部残存（会话止于推理事件）照常 flush（不丢审计内容，帧序=事件序）。
  const groups: SseEventData[][] = [];
  let pendingReasoning: string | null = null;
  const flushReasoning = (): void => {
    if (pendingReasoning !== null) {
      groups.push([{ event: 'reasoning', data: { text: reasoningFrameText(pendingReasoning) } }]);
      pendingReasoning = null;
    }
  };
  for (const ev of recent) {
    if (ev.kind === 'reasoning') {
      pendingReasoning = (pendingReasoning ?? '') + ev.payload.content;
      continue;
    }
    flushReasoning();
    groups.push(framesOf(ev));
  }
  flushReasoning();
  let total = 0;
  for (const group of groups) total += group.length;
  let window: SseEventData[][];
  if (total > HISTORY_FRAME_LIMIT) {
    // 帧级切点：从尾部回退，找到跨过预算的那个帧组（branch）——窗口 =
    // [branch 组尾部 keep 帧] + [其后全部完整组]（恰 ≤ HISTORY_FRAME_LIMIT 帧）。
    // keep == 0（切点恰在组边界）时 branch 组整体裁剪，窗口从 branch+1 起。
    let used = 0;
    let branch = groups.length;
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i]!;
      if (used + group.length > HISTORY_FRAME_LIMIT) {
        branch = i;
        break;
      }
      used += group.length;
    }
    const keep = HISTORY_FRAME_LIMIT - used;
    const trimmed: SseEventData[][] = [];
    if (keep > 0) trimmed.push(groups[branch]!.slice(groups[branch]!.length - keep));
    trimmed.push(...groups.slice(branch + 1));
    // 剧集边界对齐：窗口首帧若为「无主 tool-start」（所辖 assistant-done 与帧组前半被裁），
    // 整组推进出窗（起点 = 下一完整剧集首帧——绝不输出悬空 tool-start/残缺帧组）；
    // 孤儿 tool-result（done/声明被裁、只有结果段）保留：name 按全局声明映射（d5 语义）。
    const head = trimmed[0];
    if (head !== undefined && head[0] !== undefined && head[0].event === 'tool-start') {
      trimmed.shift();
    }
    window = trimmed;
  } else {
    window = groups;
  }
  return { title: deriveTitle(title), workspaceRoot, frames: window.flat() };
}

// ---------------------------------------------------------------------------
// Skills 资产索引（GET /api/skills：deps.skillsDir 的 <id>/SKILL.md frontmatter）
// ---------------------------------------------------------------------------

/** 技能目录的入口文件（frontmatter 携带 name/description）。 */
const SKILL_ENTRY = 'SKILL.md';

/** 索引缓存：打包资产静态不变——每实例构建一次，启动后恒定（POST 开关不触发重扫）。 */
interface SkillDescriptor {
  id: string;
  name: string;
  summary: string;
}

/** 解析 SKILL.md 头 frontmatter（`---` … `---`）：name / description 每字段一行；缩进续行忽略。 */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
  if (m === null) return {};
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv !== null && fields[kv[1]!] === undefined) fields[kv[1]!] = kv[2]!.trim();
  }
  return {
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
  };
}

/** description 首行 → summary（缺失 → ''，前端降级文案兜底）。 */
function descriptionFirstLine(description: string | undefined): string {
  if (description === undefined) return '';
  return (description.split('\n')[0] ?? '').trim();
}

/** 扫描 skillsDir：每个含 SKILL.md 的子目录 → 索引项；目录不存在/不可读 → 空列表。 */
async function scanSkillsIndex(skillsDir: string): Promise<SkillDescriptor[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // LICENSE-mattpocock-skills.txt 等聚合文件不进索引
    let content: string;
    try {
      content = await readFile(join(skillsDir, entry.name, SKILL_ENTRY), 'utf8');
    } catch {
      continue; // 无 SKILL.md 的目录跳过
    }
    const meta = parseSkillFrontmatter(content);
    skills.push({
      id: entry.name,
      name: meta.name ?? entry.name, // 缺失降级：name = id
      summary: descriptionFirstLine(meta.description),
    });
  }
  return skills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 缺省 skills 资产目录（dev 模式服务端在 dist 上跑——统一 dist 路径，静态 dev 可选）。 */
function defaultSkillsDir(): string {
  return resolve(process.cwd(), 'dist', 'assets', 'skills');
}

/**
 * 方法论元数据（dist/assets/skills/methodologies.json——copy-skills.mjs 构建时蒸馏的
 * 路由器表；单一来源，本层只读）。容错读：缺失/损坏/坏键 → 空表（parseMethodologyMap
 * 对缺失键不崩）；索引缓存（打包资产静态不变）。
 */
async function loadMethodologies(skillsDir: string): Promise<MethodologyMap> {
  try {
    const data = await readFile(join(skillsDir, 'methodologies.json'), 'utf8');
    return parseMethodologyMap(JSON.parse(data));
  } catch {
    return {};
  }
}

/**
 * 方法论索引构建（服务端缓存单源：meta × 运行时开关 → 路由优先级序）。
 * 排序：assets/skills-meta.json 键序优先（**路由优先级 = Meta 精编撰写序**——
 * tdd/diagnosing-bugs/code-review 靠前），未收录技能按 id 序兜底（确定性）。
 */
function methodologyEntriesFrom(
  index: readonly SkillDescriptor[],
  methodology: MethodologyMap,
  enabledOf: (id: string) => boolean,
): MethodologyEntry[] {
  const order = new Map<string, number>(Object.keys(methodology).map((id, i) => [id, i]));
  const entries = index.map((skill) => ({
    id: skill.id,
    methodology:
      methodology[skill.id] !== undefined ? methodology[skill.id]! : { type: 'reference' as const },
    enabled: enabledOf(skill.id),
  }));
  entries.sort((a, b) => {
    const oa = order.get(a.id) ?? Number.POSITIVE_INFINITY;
    const ob = order.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (oa !== ob) return oa - ob;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return entries;
}

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const JSON_BODY_LIMIT = 1_000_000;

/** GET /api/sessions 会话数上限（缺省；deps.sessionCap 可调）。 */
export const DEFAULT_SESSION_CAP = 50;
/** 超限时最多标记的最旧空闲会话数（压缩提示候选）。 */
export const COMPACT_CANDIDATE_LIMIT = 10;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readJson(
  req: IncomingMessage,
  options: { allowEmpty?: boolean } = {},
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > JSON_BODY_LIMIT) {
      throw new HttpError(413, 'request body too large');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    // POST /api/sessions 语义为 body{text?}：空 body = text 缺省（其余端点仍要求合法 JSON）
    if (options.allowEmpty === true) return {};
    throw new HttpError(400, 'request body must be valid JSON');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const DEFAULT_STATIC_ROOT = fileURLToPath(new URL('../web', import.meta.url));

/** 缺省工具注册表：deps.tools 未注入时使用（GET /api/tools 空清单；run 工具面为空——不自行装配）。 */
const emptyRegistry: ToolRegistry = {
  list: () => [],
  async execute(call) {
    return {
      ok: false,
      content: '',
      error: { type: 'missing-registry', message: `no tools registry for call ${call.name}` },
    };
  },
};

/** 工具清单排序：按 name 升序（确定性字典序；顺序稳定的纯比较）。 */
function byName(a: ToolDef, b: ToolDef): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

export function createDevmateServer(deps: DevmateServerDeps): DevmateServer {
  const ctxs = new Map<string, SessionCtx>();
  const ctxFor = (id: string): SessionCtx => {
    let ctx = ctxs.get(id);
    if (ctx === undefined) {
      ctx = {
        sessionId: id,
        broker: new SessionBroker(),
        callNames: new Map(),
        executed: new Set(),
        pending: new Map(),
        pendingReasoning: '',
        controller: null,
        active: false,
      };
      ctxs.set(id, ctx);
    }
    return ctx;
  };

  // per-session 串行化（promise 链）：DELETE 全文与 POST /api/chat 的「检查+append」段
  // 互斥——DELETE×重开竞态修复（慢 dispose 放大窗口中 rm 不再落在新 run 脚下）。
  const sessionGuards = new Map<string, Promise<unknown>>();
  function withSessionGuard<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionGuards.get(sessionId) ?? Promise.resolve();
    const guarded = previous.then(fn, fn); // 前序失败不阻断本序
    sessionGuards.set(
      sessionId,
      guarded.then(
        () => undefined,
        () => undefined,
      ),
    );
    return guarded;
  }

  // 审批决策：deps.approvalPolicy 覆写（测试/无头模式注入）?? 权限预设矩阵。
  // 矩阵经 current.permission 每次调用现读——POST /api/settings 后即时生效（与 reasoning 同机制）。
  const approvalPolicy = deps.approvalPolicy;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const observedStore = observeStore(deps.store, ctxFor);

  const emptyLister: SessionLister = async () => [];
  const sessionLister = deps.sessionLister ?? emptyLister;
  /** 活跃 run 会话（startRun 添加、run 终态/异常移除）；空闲回收对它们跳过——TTL 误杀修复。 */
  const activeRunSessions = new Set<string>();
  // 工具注册表懒读取：deps.tools（__fallback__ 兜底壳）只在真正需要时构造（幽灵实例修复）
  let registryToolsCache: ToolRegistry | undefined;
  const registryToolsOf = (): ToolRegistry => {
    if (registryToolsCache === undefined) registryToolsCache = deps.tools ?? emptyRegistry;
    return registryToolsCache;
  };
  // 空闲 shell 回收节拍（缺省 60s；测试注入调度器捕获 handler，不真等）
  const idleSweepMs = deps.idleSweepMs ?? 60_000;
  const scheduleTick = deps.scheduleTick ?? defaultTickScheduler;
  let idleTick: TickHandle | null = null;
  if (deps.disposeIdleShells !== undefined) {
    idleTick = scheduleTick(() => {
      void deps.disposeIdleShells?.(Date.now(), activeRunSessions);
    }, idleSweepMs);
  }

  // -- MemoryGuard（内存防线；注入 sampler 即安装；assembleDeps 默认装配真采样） --
  const memorySweepMs = deps.memorySweepMs ?? 60_000;
  /** 泄压处置：disposeAllIdle 优先，回退 disposeIdleShells(Infinity, active)——全部空闲 shell。 */
  const disposeAllIdle = async (): Promise<void> => {
    if (deps.disposeAllIdle !== undefined) {
      await deps.disposeAllIdle(activeRunSessions);
    } else if (deps.disposeIdleShells !== undefined) {
      await deps.disposeIdleShells(Number.POSITIVE_INFINITY, activeRunSessions);
    }
  };
  const guard =
    deps.memorySampler !== undefined
      ? new MemoryGuard({
          sampler: deps.memorySampler,
          onAlert: async () => {
            // 警戒上升沿：broker 清窗（保留在线订阅）+ 全员空闲 shell 释放
            for (const ctx of ctxs.values()) ctx.broker.clear();
            await disposeAllIdle();
          },
        })
      : null;
  let memoryTick: TickHandle | null = null;
  if (guard !== null) {
    memoryTick = scheduleTick(() => {
      void guard.check();
    }, memorySweepMs);
  }

  interface CurrentSettings {
    baseUrl: string;
    model: string;
    apiKey?: string;
    /** 思考强度（C 档；缺省 'medium'——CTO 裁定，不经 env/config 也恒有值）。 */
    reasoning: ReasoningEffort;
    /** 上下文窗口覆盖（C 档；未提供 = 未知（不传 runOptions，压缩不触发）。 */
    windowTokens?: number;
    /** 权限预设（权限预设定案：缺省 'workspace-write'；POST /api/settings 即时生效）。 */
    permission: PermissionPreset;
    /** full-access 风险确认记录（epoch ms；前端风险门后写入——纯记录、不强制）。 */
    permissionConfirmedAt?: number;
    /** 方法论前置门（R2-S1：缺省 true；false → 本 run 不注入门 = 从不拦截）。 */
    methodFirst: boolean;
  }
  const current: CurrentSettings = {
    baseUrl: deps.settings?.baseUrl ?? '',
    model: deps.settings?.model ?? deps.model,
    reasoning: deps.settings?.reasoning ?? 'medium',
    permission: deps.settings?.permission ?? DEFAULT_PERMISSION_PRESET,
    methodFirst: deps.settings?.methodFirst ?? true,
    ...(deps.settings?.apiKey !== undefined ? { apiKey: deps.settings.apiKey } : {}),
    ...(deps.settings?.windowTokens !== undefined
      ? { windowTokens: deps.settings.windowTokens }
      : {}),
    ...(deps.settings?.permissionConfirmedAt !== undefined
      ? { permissionConfirmedAt: deps.settings.permissionConfirmedAt }
      : {}),
  };

  function startRun(sessionId: string, text: string): void {
    const ctx = ctxFor(sessionId);
    const controller = new AbortController();
    ctx.controller = controller;
    activeRunSessions.add(sessionId); // TTL 判据覆盖：运行中 shell 不回收
    void (async () => {
      let result: RunResult;
      try {
        // 每次 run 从当前设置重建接线（llm / 摘要器 / 会话工具面）：
        // 设置变更（POST /api/settings）即时作用于后续 run。
        const llm =
          deps.createLlm !== undefined
            ? deps.createLlm({ baseUrl: current.baseUrl, apiKey: current.apiKey })
            : deps.llm;
        const runOptions: Partial<RunOptions> = { ...deps.runOptions };
        // C 档：设置侧思考强度 / 窗口覆盖每次 run 现读（POST /api/settings 即时生效）
        runOptions.reasoning = current.reasoning;
        if (current.windowTokens !== undefined) runOptions.windowTokens = current.windowTokens;
        // R2-S1：方法论前置门按开关传递——false → 删除 methodology 键（门不拦）；
        // true 时装配层已注入（gate 只含 route/状态观察，索引内容服务端现读）。
        if (current.methodFirst === false) delete runOptions.methodology;
        if (deps.createSummarizer !== undefined && runOptions.summarizer !== undefined) {
          runOptions.summarizer = deps.createSummarizer(llm, current.model);
        }
        if (deps.composeSystemPrompt !== undefined) {
          // 系统提示每次运行前合成（基础 + 技能清单节 + 子代理节）：技能开关/workflow
          // 配置变更（POST /api/skills|workflow）即时作用于后续 run（晚绑定回填已附接）。
          runOptions.systemPrompt = await deps.composeSystemPrompt();
        }
        const baseTools =
          deps.createSessionTools !== undefined
            ? deps.createSessionTools(sessionId)
            : registryToolsOf();
        // 每次 run 重建工具面：base（fs/shell/技能/子代理，会话缓存）+ 新组装 MCP
        // 工具（开关/追加变更即时生效；连接失败 → 0 个 mcp 工具，run 不因之失败）
        const tools =
          deps.composeRunTools !== undefined
            ? await deps.composeRunTools(baseTools, sessionId)
            : baseTools;
        result = await run(
          { sessionId, task: text },
          {
            ...runOptions,
            store: observedStore,
            tools: observeRegistry(tools, ctx),
            llm: teeLlm(llm, ctx),
            approver: makeApprover(ctx, (call) =>
              approvalPolicy !== undefined
                ? approvalPolicy(call, sessionId)
                  ? 'ask'
                  : 'allow'
                : decidePermission(current.permission, call),
            ),
            model: current.model,
            signal: controller.signal,
          },
        );
        ctx.broker.push({
          event: 'usage',
          data: { ...result.usage },
        });
        if (result.error !== undefined) {
          ctx.broker.push({ event: 'run-error', data: { message: result.error } });
        }
        ctx.broker.push({
          event: 'run-status',
          data: { status: result.status, steps: result.steps, durationMs: result.durationMs },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.broker.push({ event: 'run-error', data: { message } });
        ctx.broker.push({
          event: 'run-status',
          data: { status: 'fatal', steps: 0, durationMs: 0 },
        });
      } finally {
        activeRunSessions.delete(sessionId); // run 终态/异常：恢复空闲判据
        ctx.active = false;
        ctx.controller = null;
        const pending = [...ctx.pending.values()];
        ctx.pending.clear();
        for (const settle of pending) settle({ deny: true });
      }
    })();
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 内存防线停机档（≥2GB）：拒绝新 run 启动（已有 run 不受影响；恢复 <1.2GB 自动解锁）
    if (guard !== null && !guard.runAllowed) {
      sendJson(res, 409, { error: 'memory-pressure', message: MEMORY_PRESSURE_HINT });
      return;
    }
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const text = asString((body as Record<string, unknown>).text);
    if (text === undefined || text.trim() === '') {
      throw new HttpError(400, 'text is required (non-empty string)');
    }
    const supplied = asString((body as Record<string, unknown>).sessionId);
    const sessionId = supplied !== undefined && supplied !== '' ? supplied : `s-${randomUUID()}`;
    try {
      assertValidSessionId(sessionId);
    } catch {
      throw new HttpError(400, 'invalid session id');
    }

    const ctx = ctxFor(sessionId);
    if (ctx.active) {
      throw new HttpError(409, 'session has an active run');
    }
    ctx.active = true;
    await withSessionGuard(sessionId, async () => {
      // 「检查+append」段与 DELETE 的完整流程按会话串行化（并发删除不再落在 run 脚下）
      try {
        if (!(await deps.store.exists(sessionId))) {
          await deps.store.create(sessionId);
          // A 档：会话按项目文件夹分组——首建即落 workspace meta（旧会话/resume 无此事件）
          if (deps.workspaceRoot !== undefined) {
            await observedStore.append(sessionId, {
              kind: 'event',
              payload: {
                type: 'session-workspace',
                data: { workspaceRoot: deps.workspaceRoot },
              },
            });
          }
        }
        await observedStore.append(sessionId, { kind: 'user', payload: { content: text } });
      } catch (err) {
        ctx.active = false;
        if (err instanceof SessionExistsError || err instanceof SessionNotFoundError) {
          throw new HttpError(409, err.message);
        }
        throw err;
      }
    });
    startRun(sessionId, text);
    sendJson(res, 200, { sessionId });
  }

  async function handleApproval(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const record = body as Record<string, unknown>;
    const sessionId = asString(record.sessionId);
    const toolCallId = asString(record.toolCallId);
    if (sessionId === undefined || toolCallId === undefined) {
      throw new HttpError(400, 'sessionId and toolCallId are required');
    }
    if (typeof record.approve !== 'boolean') {
      throw new HttpError(400, 'approve must be a boolean');
    }
    const reason = asString(record.reason);
    const ctx = ctxs.get(sessionId);
    const settle = ctx?.pending.get(toolCallId);
    if (settle === undefined) {
      throw new HttpError(404, `no pending approval for toolCallId ${JSON.stringify(toolCallId)}`);
    }
    if (record.approve) {
      settle('allow');
    } else if (reason !== undefined && reason !== '') {
      settle({ deny: true, reason });
    } else {
      settle({ deny: true });
    }
    sendJson(res, 200, { ok: true });
  }

  async function handleInterrupt(res: ServerResponse, sessionId: string): Promise<void> {
    let exists: boolean;
    try {
      exists = await deps.store.exists(sessionId);
    } catch {
      throw new HttpError(400, 'invalid session id');
    }
    if (!exists) {
      throw new HttpError(404, `session not found: ${sessionId}`);
    }
    const ctx = ctxs.get(sessionId);
    if (ctx?.active !== true || ctx.controller === null) {
      throw new HttpError(409, 'session is not running');
    }
    ctx.controller.abort();
    sendJson(res, 200, { ok: true });
  }

  /** URL 单段解码（skills id / mcp 名等；%2F 等转义出子段视为非法请求）。 */
  function decodeSegment(raw: string): string {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, 'invalid segment');
    }
    if (
      decoded === '' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded === '.' ||
      decoded === '..'
    ) {
      throw new HttpError(400, 'invalid segment');
    }
    return decoded;
  }

  function decodeSessionId(raw: string): string {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, 'invalid session id');
    }
    try {
      assertValidSessionId(decoded);
    } catch {
      throw new HttpError(400, 'invalid session id');
    }
    return decoded;
  }

  async function sessionExists(sessionId: string): Promise<boolean> {
    try {
      return await deps.store.exists(sessionId);
    } catch {
      throw new HttpError(400, 'invalid session id');
    }
  }

  async function handleListSessions(res: ServerResponse): Promise<void> {
    const sessions = await sessionLister();
    const sorted = [...sessions].sort((a, b) => b.lastEventMs - a.lastEventMs);
    const cap = deps.sessionCap ?? DEFAULT_SESSION_CAP;
    if (sorted.length <= cap) {
      sendJson(res, 200, { sessions: sorted });
      return;
    }
    // 超限：压缩提示（只标记不自动删——删除仍走 DELETE /api/sessions/:id）
    const candidates = [...sorted]
      .filter((s) => !activeRunSessions.has(s.sessionId)) // 空闲 = 无活跃 run
      .sort((a, b) => a.lastEventMs - b.lastEventMs) // 最旧优先
      .slice(0, COMPACT_CANDIDATE_LIMIT);
    const candidateIds = new Set(candidates.map((s) => s.sessionId));
    const out = sorted.map((s) => (candidateIds.has(s.sessionId) ? { ...s, compact: true } : s));
    const hint =
      `会话数 ${sorted.length} 已超过上限 ${cap}；` +
      `建议删除 ${candidates.length} 个最旧空闲会话：${candidates.map((s) => s.sessionId).join('、')}`;
    sendJson(res, 200, { sessions: out, capped: true, hint });
  }

  async function handleSessionDetail(res: ServerResponse, rawId: string): Promise<void> {
    const sessionId = decodeSessionId(rawId);
    if (!(await sessionExists(sessionId))) {
      throw new HttpError(404, `session not found: ${sessionId}`);
    }
    const { title, workspaceRoot, frames } = await sessionDetailFrames(deps.store, sessionId);
    sendJson(res, 200, { sessionId, title, workspaceRoot, events: frames });
  }

  async function handleCreateSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // body{text?}：空 body（无 JSON）按 text 缺省接受（a 档修复）
    const body = await readJson(req, { allowEmpty: true });
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const rawText = (body as Record<string, unknown>).text;
    let text: string | undefined;
    if (rawText !== undefined) {
      if (typeof rawText !== 'string') {
        throw new HttpError(400, 'text must be a string');
      }
      text = rawText;
    }
    const sessionId = `s-${randomUUID()}`;
    ctxFor(sessionId);
    try {
      await deps.store.create(sessionId);
    } catch (err) {
      if (err instanceof SessionExistsError) {
        throw new HttpError(409, err.message);
      }
      throw err;
    }
    // A 档：首建即落 workspace meta（会话按项目文件夹分组；无注入 → 旧服务不落）
    if (deps.workspaceRoot !== undefined) {
      await observedStore.append(sessionId, {
        kind: 'event',
        payload: { type: 'session-workspace', data: { workspaceRoot: deps.workspaceRoot } },
      });
    }
    // 带首消息：只落首个 user 事件，不启动 run（首消息之后的交互仍走 POST /api/chat）
    if (text !== undefined && text !== '') {
      await observedStore.append(sessionId, { kind: 'user', payload: { content: text } });
    }
    sendJson(res, 200, { sessionId });
  }

  async function handleDeleteSession(res: ServerResponse, rawId: string): Promise<void> {
    const sessionId = decodeSessionId(rawId);
    // 全文按会话串行化（与 POST /api/chat 的「检查+append」段互斥——DELETE×重开竞态）
    await withSessionGuard(sessionId, async () => {
      if (!(await sessionExists(sessionId))) {
        throw new HttpError(404, `session not found: ${sessionId}`);
      }
      const ctx = ctxs.get(sessionId);
      if (ctx?.active === true) {
        throw new HttpError(409, 'session has an active run');
      }
      // 清 broker / 审批挂起：先清内存上下文（含流订阅 + 悬挂审批的收尾）
      ctxs.delete(sessionId);
      if (ctx !== undefined) {
        const pending = [...ctx.pending.values()];
        ctx.pending.clear();
        for (const settle of pending) settle({ deny: true });
      }
      // 会话文件 + 该会话 shell 等资源联动（deps 实现；幂等——重复 DELETE 全走 404）
      if (deps.disposeSession !== undefined) await deps.disposeSession(sessionId);
    });
    // 成功路径断环：删除后该 id 的 per-session 串行化链随之清零（失效的历史承诺不再
    // 悬挂——同 id 重建从全新链开始；404/409 失败路径不删除，链保留给后续重试）。
    sessionGuards.delete(sessionId);
    sendJson(res, 200, { ok: true });
  }

  // -- Skills（A1：资产索引 + 运行时开关；全文不下发） --
  const skillsDir = deps.skillsDir ?? defaultSkillsDir();
  let skillsCache: SkillDescriptor[] | null = null;
  // 开关构造期播种（deps.skillsRecord 注入的旧快照——重启禁用保持：持久化断环修复；
  // 未注入/缺失 id 缺省 true = 全开）；缺省空表。
  const skillsSwitches = new Map<string, boolean>(Object.entries(deps.skillsRecord ?? {}));
  const ensureSkillsIndex = async (): Promise<SkillDescriptor[]> => {
    if (skillsCache === null) skillsCache = await scanSkillsIndex(skillsDir);
    return skillsCache;
  };
  const skillsSnapshot = async (): Promise<Record<string, boolean>> => {
    const snapshot: Record<string, boolean> = {};
    for (const skill of await ensureSkillsIndex())
      snapshot[skill.id] = skillsSwitches.get(skill.id) ?? true;
    return snapshot;
  };

  async function handleSkills(res: ServerResponse): Promise<void> {
    const index = await ensureSkillsIndex();
    sendJson(res, 200, {
      skills: index.map((skill) => ({
        id: skill.id,
        name: skill.name,
        summary: skill.summary,
        enabled: skillsSwitches.get(skill.id) ?? true,
      })),
    });
  }

  async function handleSkillToggle(
    req: IncomingMessage,
    res: ServerResponse,
    rawId: string,
  ): Promise<void> {
    const id = decodeSegment(rawId);
    const index = await ensureSkillsIndex();
    if (!index.some((skill) => skill.id === id)) {
      throw new HttpError(404, `unknown skill: ${id}`);
    }
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const enabled = (body as Record<string, unknown>).enabled;
    if (typeof enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean');
    }
    skillsSwitches.set(id, enabled); // 运行时开关（默认 true；无持久化回调 → 仅内存）
    if (deps.saveSkillsConfig !== undefined) {
      await deps.saveSkillsConfig(await skillsSnapshot());
    }
    sendJson(res, 200, { ok: true });
  }

  // -- 工作流（A2）与 MCP（A3）：均为配置层（子代理/MCP 实际执行属 P2，端点上只有配置） --
  // maxParallel 夹紧 1-4（单一来源：shared/workflow 的 clampMaxParallel——三处副本已收敛）
  const workflowState = {
    subagentsEnabled: deps.workflow?.subagentsEnabled ?? DEFAULT_SUBAGENTS_ENABLED,
    maxParallel: clampMaxParallel(deps.workflow?.maxParallel),
  };
  const mcpServers: McpServerConfig[] = (deps.mcpServers ?? []).map((server) => ({
    ...server,
    args: [...server.args],
  }));
  // MCP 接线晚绑定：deps 的 launcher 自此现读本数组（POST /api/mcp 开关/追加/持久化后
  // 下次组装即时生效——mcp 工具面不缓存，每次 run 重建）。附接先于任何 run（listen 之后才有请求）。
  if (deps.attachMcpConfig !== undefined) deps.attachMcpConfig(() => mcpServers);

  // Workflow 工具面接缝回填（晚绑定）：SkillsIndex（索引缓存 + 运行开关的单一来源——
  // deps 装配层只持有引用适配，use_skill/提示词合成经此现读）与 workflowState 读取器
  // （池 config 闭包 + 子代理节合成现读——POST /api/workflow 后即时生效）。附接发生在
  // 服务端构造期，必然先于任何 run（run 只能由 listen 之后的请求触发）。
  if (deps.attachSkillsIndex !== undefined) {
    deps.attachSkillsIndex({
      async list() {
        return (await ensureSkillsIndex()).map((skill) => ({
          ...skill,
          enabled: skillsSwitches.get(skill.id) ?? true,
        }));
      },
      async content(id) {
        const index = await ensureSkillsIndex();
        if (!index.some((skill) => skill.id === id)) return null;
        try {
          return await readFile(join(skillsDir, id, SKILL_ENTRY), 'utf8');
        } catch {
          return null; // 读不到（文件缺失/内容不可读）→ null（工具按 not-found 收敛）
        }
      },
      async setEnabled(id, enabled) {
        const index = await ensureSkillsIndex();
        if (!index.some((skill) => skill.id === id)) return false;
        skillsSwitches.set(id, enabled);
        if (deps.saveSkillsConfig !== undefined) {
          await deps.saveSkillsConfig(await skillsSnapshot());
        }
        return true;
      },
    });
  }
  // 方法论索引（R2-S1）：元数据表（methodologies.json 动态读一次 + 缓存——打包资产静态）
  // × skillsSwitches（运行时开关现读）——前置门 route 与提示词路由节经晚绑定回填现读。
  let methodologyCache: MethodologyMap | null = null;
  const loadMethodologyMeta = async (): Promise<MethodologyMap> => {
    if (methodologyCache === null) methodologyCache = await loadMethodologies(skillsDir);
    return methodologyCache;
  };
  if (deps.attachMethodologyIndex !== undefined) {
    deps.attachMethodologyIndex({
      async list() {
        const index = await ensureSkillsIndex();
        const methodology = await loadMethodologyMeta();
        return methodologyEntriesFrom(index, methodology, (id) => skillsSwitches.get(id) ?? true);
      },
    });
  }

  if (deps.attachWorkflowConfig !== undefined) {
    deps.attachWorkflowConfig(() => ({
      subagentsEnabled: workflowState.subagentsEnabled,
      maxParallel: workflowState.maxParallel,
    }));
  }

  async function handleWorkflow(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      sendJson(res, 200, workflowState);
      return;
    }
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const record = body as Record<string, unknown>;
    const subagents = record.subagentsEnabled;
    const maxParallel = record.maxParallel;
    if (subagents !== undefined && typeof subagents !== 'boolean') {
      throw new HttpError(400, 'subagentsEnabled must be a boolean');
    }
    if (maxParallel !== undefined) {
      // 1-4 档位硬限（整数；数字 2.0 视为整数 2——Number.isInteger 语义）
      if (
        typeof maxParallel !== 'number' ||
        !Number.isInteger(maxParallel) ||
        maxParallel < 1 ||
        maxParallel > 4
      ) {
        throw new HttpError(400, 'maxParallel must be an integer in 1-4');
      }
    }
    if (subagents === undefined && maxParallel === undefined) {
      throw new HttpError(400, 'no workflow fields provided');
    }
    if (subagents !== undefined) workflowState.subagentsEnabled = subagents;
    if (maxParallel !== undefined) workflowState.maxParallel = maxParallel;
    if (deps.saveWorkflow !== undefined) await deps.saveWorkflow(workflowState);
    sendJson(res, 200, workflowState);
  }

  async function handleMcpList(res: ServerResponse): Promise<void> {
    // 展示层脱敏：--header/-H 后 Authorization 头的凭据掩码（服务端内部连接与 POST
    // 配置仍用原始 args——掩码只作用于 GET 响应呈报；无原始 token 残留见测试断言）。
    sendJson(res, 200, {
      servers: mcpServers.map((server) => ({
        ...server,
        args: maskMcpArgs(server.args),
      })),
    });
  }

  async function handleMcpAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const record = body as Record<string, unknown>;
    const name = asString(record.name);
    const command = asString(record.command);
    if (name === undefined || name === '')
      throw new HttpError(400, 'name is required (non-empty string)');
    if (command === undefined || command === '')
      throw new HttpError(400, 'command is required (non-empty string)');
    if (name.length > MCP_NAME_LIMIT)
      throw new HttpError(
        400,
        `name must be at most ${MCP_NAME_LIMIT} characters (received ${name.length})`,
      );
    if (command.length > MCP_COMMAND_LIMIT)
      throw new HttpError(
        400,
        `command must be at most ${MCP_COMMAND_LIMIT} characters (received ${command.length})`,
      );
    const rawArgs = record.args;
    let args: string[];
    if (rawArgs === undefined) {
      args = [];
    } else if (rawArgs instanceof Array && rawArgs.every((a) => typeof a === 'string')) {
      args = rawArgs;
    } else {
      throw new HttpError(400, 'args must be an array of strings');
    }
    if (args.length > MCP_ARGS_LIMIT)
      throw new HttpError(
        400,
        `args must have at most ${MCP_ARGS_LIMIT} items (received ${args.length})`,
      );
    const overlong = args.find((arg) => arg.length > MCP_ARG_LENGTH_LIMIT);
    if (overlong !== undefined)
      throw new HttpError(
        400,
        `each arg must be at most ${MCP_ARG_LENGTH_LIMIT} characters (received ${overlong.length})`,
      );
    if (mcpServers.some((server) => server.name === name)) {
      throw new HttpError(409, `mcp server already registered: ${name}`);
    }
    mcpServers.push({ name, command, args: [...args], enabled: true });
    if (deps.saveMcpConfig !== undefined) await deps.saveMcpConfig(mcpServers);
    sendJson(res, 200, { ok: true });
  }

  async function handleMcpToggle(
    req: IncomingMessage,
    res: ServerResponse,
    rawName: string,
  ): Promise<void> {
    const name = decodeSegment(rawName);
    const index = mcpServers.findIndex((server) => server.name === name);
    if (index < 0) {
      throw new HttpError(404, `unknown mcp server: ${name}`);
    }
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const enabled = (body as Record<string, unknown>).enabled;
    if (typeof enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean');
    }
    mcpServers[index] = { ...mcpServers[index]!, enabled };
    if (deps.saveMcpConfig !== undefined) await deps.saveMcpConfig(mcpServers);
    sendJson(res, 200, { ok: true });
  }

  async function handleTools(res: ServerResponse): Promise<void> {
    // 数据源 = 工具注册表 list()：name/description/parameters 原样返回（参数 Abstract 摘要由前端
    // 本地做：src/ui/web/sessions.js 的 toolParamNames——reduce 传输体积，服务端不做半套转换）。
    // 同表：经 composeRunTools 合并 MCP 工具（与 run 工具面同源——mcp 开关变更此处即反映；
    // mcp 连接失败 → 0 个 mcp 工具，不作为故障（501 只保留给基础注册表故障——择一理由同前）。
    let defs: readonly ToolDef[];
    try {
      const base = registryToolsOf();
      defs =
        deps.composeRunTools !== undefined
          ? (await deps.composeRunTools(base, '__fallback__')).list()
          : base.list();
    } catch (err) {
      // 择一（501 而非空列表）：5xx 与统一 {error} 形状一致；前端 refreshTools 的 fetch
      // 失败路径回退内置静态清单；空列表则与「合法空注册表」不可区分，掩盖服务端故障。
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(501, `tools registry unavailable: ${message}`);
    }
    const sorted = [...defs].sort(byName);
    sendJson(res, 200, { tools: sorted });
  }

  async function handleStats(res: ServerResponse): Promise<void> {
    // 单次采样（轻量化约束：不追踪历史水位，只给当前画面）
    const mem = process.memoryUsage();
    const sessions = (await sessionLister()).length;
    const activeShells = deps.activeShellCount !== undefined ? await deps.activeShellCount() : 0;
    const stats: Record<string, unknown> = {
      rssMb: mem.rss / (1024 * 1024),
      heapMb: mem.heapUsed / (1024 * 1024),
      sessions,
      activeShells,
      // MCP 视野：配置数（含禁用；配置层恒有）+ 工具数（最近一次组装的 mcp 工具面大小；
      // 组装失败/未组装过 = 0——统计不连接、不等待、不报错）
      mcpServers: mcpServers.length,
      mcpTools: deps.mcpToolCount !== undefined ? await deps.mcpToolCount() : 0,
    };
    // 子代理排队数（P2 子代理池注入后出现；未注入省略——不装空气字段）
    if (deps.queuedSubagentCount !== undefined)
      stats.queuedSubagents = await deps.queuedSubagentCount();
    // 守卫状态（memorySampler 注入 = 守卫已安装）
    if (guard !== null) stats.memoryGuard = guard.status;
    sendJson(res, 200, stats);
  }

  function settingsResponse(): {
    baseUrl: string;
    model: string;
    apiKey?: string;
    reasoning: ReasoningEffort;
    window?: number;
    permission: PermissionPreset;
    permissionConfirmedAt?: number;
    methodFirst: boolean;
  } {
    const response: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      reasoning: ReasoningEffort;
      window?: number;
      permission: PermissionPreset;
      permissionConfirmedAt?: number;
      methodFirst: boolean;
    } = {
      baseUrl: current.baseUrl,
      model: current.model,
      reasoning: current.reasoning, // C 档：缺省 'medium'
      permission: current.permission, // 权限预设定案：缺省 'workspace-write'
      methodFirst: current.methodFirst, // R2-S1：方法论前置门（缺省 true）
    };
    if (current.apiKey !== undefined) {
      const masked = maskApiKey(current.apiKey);
      if (masked !== undefined) response.apiKey = masked;
    }
    // C 档：窗口覆盖（预设估算在 deps 装配层播种；未知 → 不带键，前端回退内置估算）
    if (current.windowTokens !== undefined) response.window = current.windowTokens;
    // full-access 风险确认记录（无记录不带键——前端只在 full-access 且已确认时展示）
    if (current.permissionConfirmedAt !== undefined) {
      response.permissionConfirmedAt = current.permissionConfirmedAt;
    }
    return response;
  }

  async function handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      sendJson(res, 200, settingsResponse());
      return;
    }
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const record = body as Record<string, unknown>;
    const baseUrl = asString(record.baseUrl);
    if (record.baseUrl !== undefined && baseUrl === undefined) {
      throw new HttpError(400, 'baseUrl must be a string');
    }
    const model = asString(record.model);
    if (record.model !== undefined && model === undefined) {
      throw new HttpError(400, 'model must be a string');
    }
    const apiKey = record.apiKey;
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      throw new HttpError(400, 'apiKey must be a string');
    }
    const reasoning = record.reasoning;
    if (
      reasoning !== undefined &&
      reasoning !== 'off' &&
      reasoning !== 'low' &&
      reasoning !== 'medium' &&
      reasoning !== 'high'
    ) {
      throw new HttpError(400, 'reasoning must be one of off/low/medium/high');
    }
    const rawWindowTokens = record.windowTokens;
    let windowTokens: number | undefined;
    if (rawWindowTokens !== undefined) {
      if (
        typeof rawWindowTokens !== 'number' ||
        !Number.isInteger(rawWindowTokens) ||
        rawWindowTokens < 1
      ) {
        throw new HttpError(400, 'windowTokens must be a positive integer');
      }
      windowTokens = rawWindowTokens;
    }
    const rawPermission = record.permission;
    let permission: PermissionPreset | undefined;
    if (rawPermission !== undefined) {
      if (
        typeof rawPermission !== 'string' ||
        !(PERMISSION_PRESETS as readonly string[]).includes(rawPermission)
      ) {
        throw new HttpError(400, 'permission must be one of read-only/workspace-write/full-access');
      }
      permission = rawPermission as PermissionPreset;
    }
    const rawConfirmedAt = record.permissionConfirmedAt;
    let permissionConfirmedAt: number | undefined;
    if (rawConfirmedAt !== undefined) {
      if (
        typeof rawConfirmedAt !== 'number' ||
        !Number.isInteger(rawConfirmedAt) ||
        rawConfirmedAt < 0
      ) {
        throw new HttpError(400, 'permissionConfirmedAt must be a non-negative integer (epoch ms)');
      }
      permissionConfirmedAt = rawConfirmedAt;
    }
    const rawMethodFirst = record.methodFirst;
    if (rawMethodFirst !== undefined && typeof rawMethodFirst !== 'boolean') {
      throw new HttpError(400, 'methodFirst must be a boolean');
    }
    if (
      baseUrl === undefined &&
      model === undefined &&
      apiKey === undefined &&
      reasoning === undefined &&
      rawWindowTokens === undefined &&
      rawPermission === undefined &&
      rawConfirmedAt === undefined &&
      rawMethodFirst === undefined
    ) {
      throw new HttpError(400, 'no settings fields provided');
    }
    // 触碰语义：只有被本次 POST 触碰的字段随快照持久化（补丁合并写——未指字段保留现值）
    const touched: {
      reasoning?: boolean;
      windowTokens?: boolean;
      permission?: boolean;
      permissionConfirmedAt?: boolean;
      methodFirst?: boolean;
    } = {};
    if (baseUrl !== undefined) current.baseUrl = baseUrl;
    if (model !== undefined) current.model = model;
    if (apiKey !== undefined) {
      if (apiKey === '') {
        // apiKey:''（明文空串）= 显式删除密钥：同时清运行时与持久化（见下）
        delete current.apiKey;
      } else {
        current.apiKey = apiKey;
      }
    }
    if (reasoning !== undefined) {
      current.reasoning = reasoning;
      touched.reasoning = true;
    }
    if (windowTokens !== undefined) {
      current.windowTokens = windowTokens;
      touched.windowTokens = true;
    }
    if (permission !== undefined) {
      current.permission = permission;
      touched.permission = true;
      // full-access 风险确认记录：首次切到 full-access 时被动记录（前端负责确认 UI——
      // 后端只记录、不做强制门；显式 permissionConfirmedAt 优先，且不覆盖已有记录）
      if (
        permission === 'full-access' &&
        permissionConfirmedAt === undefined &&
        current.permissionConfirmedAt === undefined
      ) {
        current.permissionConfirmedAt = Date.now();
        touched.permissionConfirmedAt = true;
      }
    }
    if (permissionConfirmedAt !== undefined) {
      current.permissionConfirmedAt = permissionConfirmedAt;
      touched.permissionConfirmedAt = true;
    }
    if (rawMethodFirst !== undefined) {
      current.methodFirst = rawMethodFirst;
      touched.methodFirst = true;
    }
    if (deps.persistSettings !== undefined) {
      const snapshot: SettingsSnapshot = { baseUrl: current.baseUrl, model: current.model };
      if (current.apiKey !== undefined) snapshot.apiKey = current.apiKey;
      if (touched.reasoning === true) snapshot.reasoning = current.reasoning;
      if (touched.windowTokens === true) snapshot.windowTokens = current.windowTokens as number;
      if (touched.permission === true) snapshot.permission = current.permission;
      if (touched.permissionConfirmedAt === true) {
        snapshot.permissionConfirmedAt = current.permissionConfirmedAt as number;
      }
      if (touched.methodFirst === true) snapshot.methodFirst = current.methodFirst;
      await deps.persistSettings(snapshot);
    }
    sendJson(res, 200, settingsResponse());
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const root = deps.staticRoot ?? DEFAULT_STATIC_ROOT;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'invalid path');
    }
    let filePath: string;
    if (decoded === '/' || decoded === '') {
      filePath = join(root, 'index.html');
    } else {
      filePath = resolve(root, `.${decoded}`);
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        throw new HttpError(400, 'path escapes the static root');
      }
    }
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      if (decoded === '/' || decoded === '') {
        // S13 尚未放入 index.html 前的 MVP 占位页：浏览器打开仍是「本机 UI 在服务」
        const placeholder =
          '<!doctype html><html><head><meta charset="utf-8"><title>DevMate</title></head>' +
          '<body><h1>DevMate</h1><p>Local server is up. The native web UI (src/ui/web) ' +
          'will be served from this root once available.</p></body></html>';
        sendJsonContentType(res, 200, placeholder, 'text/html; charset=utf-8');
        return;
      }
      throw new HttpError(404, `no such file: ${pathname}`);
    }
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    sendJsonContentType(res, 200, content, type);
  }

  async function handleStream(res: ServerResponse, sessionId: string): Promise<void> {
    let exists: boolean;
    try {
      exists = await deps.store.exists(sessionId);
    } catch {
      throw new HttpError(400, 'invalid session id');
    }
    if (!exists) {
      throw new HttpError(404, `session not found: ${sessionId}`);
    }
    const ctx = ctxFor(sessionId);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    let stopped = false;
    const timer =
      heartbeatMs > 0
        ? setInterval(() => {
            if (!stopped && !res.writableEnded && !res.destroyed) {
              res.write(pingFrame());
            }
          }, heartbeatMs)
        : undefined;
    const cleanup = (): void => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      ctx.broker.wake();
    };
    res.on('close', cleanup);
    const it = ctx.broker.consume();
    void (async () => {
      try {
        for (;;) {
          if (stopped || res.writableEnded || res.destroyed) break;
          const { done, value } = await it.next();
          if (done) break;
          if (value !== undefined && !stopped && !res.writableEnded && !res.destroyed) {
            res.write(serializeEvent(value));
          }
        }
      } catch {
        // 客户端断开：正常结束
      }
    })();
  }

  // -- 生命周期（route 为函数声明向上提升，可被 createServer 回调引用） --
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        await route(req, res);
      } catch (err) {
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (err instanceof HttpError) {
          sendError(res, err.status, err.message);
          return;
        }
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'GET' && pathname === '/api/stream') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (sessionId === '') throw new HttpError(400, 'sessionId query parameter is required');
      // 与其它端点一致：格式非法（路径逃逸字面量/越界字符）→ 400（不依赖 store 抛错兜底）
      try {
        assertValidSessionId(sessionId);
      } catch {
        throw new HttpError(400, 'invalid session id');
      }
      return handleStream(res, sessionId);
    }
    if (method === 'POST' && pathname === '/api/chat') return handleChat(req, res);
    if (method === 'POST' && pathname === '/api/approval') return handleApproval(req, res);
    if (method === 'POST' && pathname === '/api/interrupt') {
      const body = (await readJson(req)) as Record<string, unknown>;
      const sessionId = asString(body.sessionId);
      if (sessionId === undefined) throw new HttpError(400, 'sessionId is required');
      // 与其它端点一致：格式非法（路径逃逸字面量/越界字符）→ 400（不依赖 store 抛错兜底）
      try {
        assertValidSessionId(sessionId);
      } catch {
        throw new HttpError(400, 'invalid session id');
      }
      return handleInterrupt(res, sessionId);
    }
    if (method === 'GET' && pathname === '/api/settings') return handleSettings(req, res);
    if (method === 'POST' && pathname === '/api/settings') return handleSettings(req, res);
    if (method === 'GET' && pathname === '/api/sessions') return handleListSessions(res);
    if (method === 'POST' && pathname === '/api/sessions') return handleCreateSession(req, res);
    if (pathname.startsWith('/api/sessions/')) {
      const rawId = pathname.slice('/api/sessions/'.length);
      if (rawId === '') throw new HttpError(404, 'not found');
      if (method === 'GET') return handleSessionDetail(res, rawId);
      if (method === 'DELETE') return handleDeleteSession(res, rawId);
      throw new HttpError(404, 'not found');
    }
    if (method === 'GET' && pathname === '/api/stats') return handleStats(res);
    if (method === 'GET' && pathname === '/api/tools') return handleTools(res);
    if (method === 'GET' && pathname === '/api/skills') return handleSkills(res);
    if (method === 'POST' && pathname.startsWith('/api/skills/')) {
      return handleSkillToggle(req, res, pathname.slice('/api/skills/'.length));
    }
    if ((method === 'GET' || method === 'POST') && pathname === '/api/workflow') {
      return handleWorkflow(req, res);
    }
    if (method === 'GET' && pathname === '/api/mcp') return handleMcpList(res);
    if (method === 'POST' && pathname === '/api/mcp') return handleMcpAdd(req, res);
    if (method === 'POST' && pathname.startsWith('/api/mcp/')) {
      return handleMcpToggle(req, res, pathname.slice('/api/mcp/'.length));
    }
    if (method === 'GET') return serveStatic(res, pathname);
    throw new HttpError(404, 'not found');
  }

  return {
    async listen(port = 0): Promise<ServerAddress> {
      return listenOnce(server, port);
    },
    async close(): Promise<void> {
      if (idleTick !== null) idleTick.cancel();
      if (memoryTick !== null) memoryTick.cancel();
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
      // 会话级资源清理（常驻 shell 等）：close 路径统一释放（幂等）
      if (deps.dispose !== undefined) await deps.dispose();
    },
  };
}

/** 缺省调度器：真实 setInterval 包装（空闲清扫节拍；close 经 cancel 清除）。 */
function defaultTickScheduler(handler: () => void, intervalMs: number): TickHandle {
  const timer = setInterval(handler, intervalMs);
  return { cancel: () => clearInterval(timer) };
}

/** 同步写静态响应（Buffer 或字符串，content-type 已定）。 */
function sendJsonContentType(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function listenOnce(server: Server, port: number): Promise<ServerAddress> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (address !== null && typeof address === 'object') {
        resolve({ host: address.address, port: address.port });
      } else {
        reject(new Error('server did not produce a TCP address'));
      }
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}
