/**
 * # ui/server：本地 HTTP + SSE 服务（接缝 S12；ADR-0007）
 *
 * 职责（与 core 同进程直调，UI 只是会话的一个视图）：
 * - 上行（POST JSON）：/api/chat（首消息建会话 + run 异步启动）、/api/approval
 *   （危险操作审批应答）、/api/interrupt（用户中断）、GET/POST /api/settings（apiKey 只回掩码；
 *   window 取窗：用户覆盖 > 网关 /models 探测 > preset 估算，GET 附 windowDetail 注来源）。
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
 * - 用户技能安装（P 档）：POST /api/skills/install {source}——本地（绝对 SKILL.md 或含
 *   SKILL.md 的目录 → 整目录复制到 <userSkillsDir>/<id>；id = frontmatter name 的 slug（严格
 *   [a-z0-9-]）；无 name/相对路径 → invalid-source）与 URL（仅 https://raw.githubusercontent.com/
 *   <owner>/<repo>/<branch>/<path...>.md——host 白名单强制、逐段校验拒绝 .. / %2e / %2f、
 *   无查询串、重定向不跟随（redirect:'manual'）、读流计数 ≤512KB、UTF-8 文本无 NUL）；
 *   已存在 → 409 skill-exists（幂等不覆盖）；成功 {ok:true,id,origin:'user'}；错误统一
 *   {error:{type,message}}（invalid-source 400/unsupported-host 400/too-large 413/
 *   skill-exists 409/fetch-failed 502/write-failed 500）。大文件/抓取经 deps.fetch（缺省全局
 *   fetch；测试 mock——禁止外部网络）。**全文绝不下发**：GET /api/skills 只有元数据。
 * - 多工作区（注册表 + 会话级根）：GET/POST /api/workspaces（缺省表 = [workspaceRoot]；
 *   POST 校验 绝对/存在/目录/realpath 归一/可读 → 注册 canonical + saveWorkspaces 持久化，
 *   重复注册幂等）、DELETE /api/workspaces/:encodedRoot（默认根不可删 400；未注册 404；
 *   会话仍指向已删根 → 允许——会话文件保留）、GET /api/workspaces/browse?path=（只读
 *   目录列表 {base, dirs}：缺省 os.homedir()、字节序排序、深层错误 → {dirs:[]}、纯展示）。
 *   会话根：POST /api/sessions|chat 首建的 workspaceRoot 须 ∈ 注册表（400
 *   workspace-not-registered；resume 忽略参数；缺省 deps.workspaceRoot）——落 session-workspace
 *   meta；per-session 工具面根解析（deps.workspaceRootOf）后 jail/shell 同源（见 deps.ts）。
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
import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConversationSummarizer } from '../../core/context/index.js';
import type {
  ApprovalDecision,
  Approver,
  LlmAdapter,
  ReviewGate,
  RunOptions,
  RunResult,
  RunStats,
  ToolDef,
  ToolRegistry,
  ToolResult,
} from '../../core/loop/index.js';
import {
  DEFAULT_MAX_TOKENS,
  hasReviewRun,
  hasSubstantiveWork,
  run,
} from '../../core/loop/index.js';
// 命令安全分类器（S10；本模块只读消费：run_command 的 read-only/ask/deny 三判级矩阵输入）
import { classify, type Verdict } from '../../core/tools/classify.js';
import type { WorkflowConfig } from '../../shared/workflow.js';
import { clampMaxParallel, DEFAULT_SUBAGENTS_ENABLED } from '../../shared/workflow.js';
import { friendlyProviderError } from './localize.js';
import type { SkillsIndex } from '../../core/tools/skill.js';
import type {
  MethodologyEntry,
  MethodologyIndex,
  MethodologyMap,
  SkillMethodology,
} from '../../shared/methodology.js';
import { parseMethodologyMap, parseSkillMethodologyValue } from '../../shared/methodology.js';
import { assertValidSessionId } from '../../core/session/base.js';
import { SessionExistsError, SessionNotFoundError } from '../../core/session/errors.js';
import type { SessionStore } from '../../core/session/index.js';
import {
  clampLimits,
  providerPresetOfBaseUrl,
  sanitizeProviderModel,
} from '../../core/llm/index.js';
import type { DiscoverWindowResult } from '../../core/llm/index.js';
import type { ReasoningEffort, StreamSnapshot } from '../../shared/llm-types.js';
import type {
  EventKind,
  SessionEvent,
  SessionEventInput,
  ToolCall,
  UserImage,
} from '../../shared/session-types.js';
import {
  SESSION_CORRUPTED_TITLE,
  deriveTitle,
  pingFrame,
  serializeEvent,
  sessionWorkspaceOf,
  type SseEventData,
} from './emit.js';
// /api/mcp GET 响应脱敏（Authorization 头掩码；纯函数，见模块头）
import { maskMcpArgs } from './mcp-mask.js';
// 内容寻址附件存储（ADR-0015 dsh 管线落地：POST /api/attachments 上传 / raw 读回 /
// 会话限额 / DELETE 引用扫描联动）
import {
  AttachmentStore,
  ATTACH_LIMITS,
  AttachmentStoreError,
  isAttachmentRef,
} from './attachments.js';
import type { AttachmentUploadInput } from './attachments.js';
// 掩码单一实现（≤12 字符全掩；>12 显首尾 4）：shared/masking 单一来源
// （层间倒置修复——service 不再向上（cli）依赖；cli/config 留 re-export）
import { maskApiKey } from '../../shared/masking.js';
// 装配入口（S14 CLI 从本模块单点导入：assembleDeps + createDevmateServer）
export { assembleDeps, dedupeKeepOrder, isCorruptedSession } from './deps.js';
import { dedupeKeepOrder, isCorruptedSession } from './deps.js';
export type { DevmateConfig } from './deps.js';
// 掩码单一实现的再导出（历史消费者路径兼容；实现只在 shared/masking）
export { maskApiKey };

// ---------------------------------------------------------------------------
// 公共接口（S14 CLI 依赖的形状；服务端构造注入全部依赖，测试用假）
// ---------------------------------------------------------------------------

/**
 * dsh 式权限预设（CTO 语义定案 → 全同 dsh 实测；settings 持久化，缺省 'workspace-write'）：
 * - read-only（仅读）：fs 读类与只读命令放行；fs 写/编辑与 ask/deny 级命令 → ask（弹窗兜底）；
 * - workspace-write（默认，自动（工作区写））：fs 全类放行；命令（含 classify ask/deny 级——
 *   rm -rf 等破坏性）全放行零弹窗（dsh 实测语义；DevMate 无 OS 沙箱强制层，选档即接受风险，
 *   风险声明由前端文案承担——见权限描述「命令直接执行（含破坏性），请确认在信任的工作区」）；
 * - full-access（全访问）：全放行（一次性风险确认门由前端负责，后端只记录
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
  /**
   * 窗口覆盖是否**用户显式**设定（三源取窗优先级：用户覆盖 > 网关探测 > preset；
   * assembleDeps 按 config.windowTokens 是否给定播种——服务端据此把 preset 胚与
   * 用户覆盖区分开，探测结果只在无显式覆盖时胜出）。 */
  windowTokensExplicit?: boolean;
  /** 请求侧输入上限初值（A 档；缺省不播种 = 未设（不发送/厂商默认））。 */
  maxInputTokens?: number;
  /** 请求侧输出上限初值（A 档；缺省不播种 = 未设（DEFAULT_MAX_TOKENS 估价/不发送））。 */
  maxOutputTokens?: number;
  /** 权限预设初值（缺省 'workspace-write'——CTO 裁定；与 reasoning 同机制）。 */
  permission?: PermissionPreset;
  /** full-access 风险确认记录（epoch ms；前端二次确认后写入——纯记录、不强制）。 */
  permissionConfirmedAt?: number;
  /** 方法论前置门开关初值（R2-S1：缺省 true；false = 不注入 RunOptions.methodology）。 */
  methodFirst?: boolean;
  /** 评审哨兵开关初值（R2-S2：缺省 true；false = 不注入 RunOptions.review——哨兵关闭）。 */
  reviewMode?: boolean;
  /** 装配期模型名是否被净化（A 档：config.model 带 `[N]m/k` 尾标——deps 读取层剥离；
   *  服务端据此在 GET 挂 modelSanitized=true，前端提示「已自动校正」一次；用户重存后清位）。 */
  modelWasSanitized?: boolean;
}

export interface SettingsSnapshot {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 思考强度（仅当对应字段被本次 POST 触碰时携带——补丁语义；CLI mergeConfig 单点写）。 */
  reasoning?: ReasoningEffort;
  /** 上下文窗口覆盖（同 reasoning 的触碰语义）。 */
  windowTokens?: number;
  /** 请求侧输入上限（A 档；同触碰语义——未触碰不携带，CLI 透传不覆盖）。 */
  maxInputTokens?: number;
  /** 请求侧输出上限（A 档；同触碰语义）。 */
  maxOutputTokens?: number;
  /** 权限预设（同触碰语义）。 */
  permission?: PermissionPreset;
  /** full-access 风险确认记录（同触碰语义）。 */
  permissionConfirmedAt?: number;
  /** 方法论前置门（同触碰语义；R2-S1）。 */
  methodFirst?: boolean;
  /** 评审哨兵（同触碰语义；R2-S2）。 */
  reviewMode?: boolean;
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
   * 全损坏会话标记（VT-8）：文件不可解析行占比 > SESSION_CORRUPTION_RATIO → true——
   * 列表项按「（会话损坏）」标题 + 本标记展示，不冒充「（空会话）」（正常崩溃的
   * 「完整行+截断尾行」远超阈值下——不误标）。
   */
  corrupted?: boolean;
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
  /**
   * 工作区注册表初值（多工作区；欠省 [workspaceRoot]；去重保序）。
   * 服务端在 POST/DELETE /api/workspaces 上增删（POST 校验后存储 canonical 形式；
   * 默认根不可删）。会话根参数须 ∈ 本表，否则 400 workspace-not-registered。
   */
  workspaces?: string[];
  /** 工作区注册表持久化回调（POST/DELETE /api/workspaces 变更后调用——全量快照；
   *  CLI 传 config.ts 的 mergeConfig 包装；无则仅内存）。 */
  saveWorkspaces?: (roots: string[]) => void | Promise<void>;
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
  /** 会话工具工厂：每会话懒建注册表（shell 每会话独立实例；多工作区时 jail/fs 按会话根）；
   *  异步（per-session 根解析/监狱构造——工厂契约）；缺省用 deps.tools（单例）。 */
  createSessionTools?: (sessionId: string) => ToolRegistry | Promise<ToolRegistry>;
  /** 会话资源清理（常驻 shell 等）；createDevmateServer.close() 时调用。 */
  dispose?: () => Promise<void>;
  /** 每 run 从当前设置重建 LLM 接缝；缺省用 deps.llm（构造时固定）。 */
  createLlm?: (settings: { baseUrl: string; apiKey: string | undefined }) => LlmAdapter;
  /** 每 run 重建摘要器（同一 llm；settings.model 变更即生效）；缺省用 runOptions.summarizer。 */
  createSummarizer?: (llm: LlmAdapter, model: string) => ConversationSummarizer;
  /**
   * 网关窗口探测结果读取器（三源取窗 · 网关层；assembleDeps 后台探测后回填——
   * 未探测/未完成/关闭 → null；缺省 undefined = 不探测，按「覆盖 > preset」兜底）。
   */
  windowDiscovered?: () => DiscoverWindowResult | null;
  /** 设置变更重探（POST /api/settings 触碰 baseUrl/apiKey/model 后服务端调用；未注入 → 不重探）。 */
  probeWindow?: (params: {
    baseUrl: string;
    apiKey: string | undefined;
    model: string;
  }) => Promise<DiscoverWindowResult>;
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
  /**
   * 内容寻址附件存储（ADR-0015；dsh 管线落地）。缺省 = 按 attachmentsDir 自建
   * （未注入时的兜底——真实装配 assembleDeps 恒注入 <sessionsDir>/attachments 的实例）。
   */
  attachments?: AttachmentStore;
  /** 附件目录（仅 attachments 未注入时用于自建；缺省 ~/.devmate/sessions/attachments）。 */
  attachmentsDir?: string;
  /** 空闲 shell 释放：服务端每 idleSweepMs 调 disposeIdleShells(Date.now(), activeRunSessions)；
   * 实现按 idleShellTtlMs 判超时且**跳过活跃 run 会话**（TTL 误杀修复——运行中 shell 不回收）。 */
  disposeIdleShells?: (now: number, activeSessionIds?: ReadonlySet<string>) => Promise<void> | void;
  /** 空闲 shell TTL（ms；缺省 600_000——deps 装配层消费，服务端仅透传形状）。 */
  idleShellTtlMs?: number;
  /** Skills 资产目录（缺省 resolve(process.cwd(),'dist/assets/skills')）；不存在/为空 → GET /api/skills 空列表。 */
  skillsDir?: string;
  /** 用户技能目录（缺省 ~/.devmate/skills；懒建——首装时；不入 StoredConfig——CLI 无需改动）。 */
  userSkillsDir?: string;
  /** URL 安装的抓取实现（缺省全局 fetch；测试注入 mock——禁止外部网络；不跟随重定向）。 */
  fetch?: typeof globalThis.fetch;
  /** Skills 开关持久化（~/.devmate/config.json 的 skills 节；CLI 注入 saveConfig 包装——无则仅内存）。 */
  saveSkillsConfig?: (skills: Record<string, boolean>) => void | Promise<void>;
  /** Skills 开关初值（socket 播种：旧开关经 CLI attach 注入，构造期种子；缺省 {} = 全开）。 */
  skillsRecord?: Record<string, boolean>;
  /** 工作流配置初值（缺省 {subagentsEnabled:true, maxParallel:2}；maxParallel 归一 0-8——0 = 无上限）。 */
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
  /** 会话系统提示合成（assembleDeps 提供）：基础提示 + 技能清单节 + 路由节 + 子代理节 +
   * 任务分解节 + 收尾评审节；startRun 每次运行前合成（技能开关/workflow 变更即时生效；
   * includeMethodology:false = 路由节排除——methodFirst:false 时由 startRun 传）。 */
  composeSystemPrompt?: (opts?: { includeMethodology?: boolean }) => Promise<string>;
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
  /** 评审哨兵（R2-S2）会话级记帐：实质变更工具计数 + 成功审查 spawn 的 prompt + 一次性注入 flag
   * （跨 run 保持——session 级；语义纯函数见 loop/types 的 hasSubstantiveWork/hasReviewRun）。 */
  readonly reviewStats: {
    counts: Record<string, number>;
    subagentPrompts: string[];
    flagged: boolean;
  };
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
        ctx.broker.push({
          event: 'session-user',
          // meta.system=true（评审哨兵注入的系统样式用户消息）→ system:true（前端浅色 chip）
          data: {
            text: wide.payload.content,
            ...(wide.meta?.system === true ? { system: true } : {}),
            // 多模态（ADR-0015）：images 与存储 payload 同形（dataURL 图，回放直接渲染）
            ...(wide.payload.images !== undefined && wide.payload.images.length > 0
              ? { images: wide.payload.images }
              : {}),
          },
        });
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

/** 评审哨兵记帐（R2-S2）：观察器只见真执行（被审批拒绝/未触达工具层不计——「执行过」语义）；
 * 成功的 spawn_subagent 顺便记 prompt（审查判定数据源；参数解析失败=畸形调用不落 prompt）。 */
function recordReviewStats(ctx: SessionCtx, call: ToolCall, result: ToolResult): void {
  const stats = ctx.reviewStats;
  stats.counts[call.name] = (stats.counts[call.name] ?? 0) + 1;
  if (result.ok && call.name === 'spawn_subagent') {
    let prompt = '';
    try {
      const parsed: unknown = JSON.parse(call.arguments);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const raw = (parsed as Record<string, unknown>).prompt;
        if (typeof raw === 'string') prompt = raw;
      }
    } catch {
      // 参数不可解析：不算审查 prompt（畸形调用按普通失败，语义不变）
    }
    if (prompt !== '') stats.subagentPrompts.push(prompt);
  }
}

function observeRegistry(inner: ToolRegistry, ctx: SessionCtx): ToolRegistry {
  return {
    list: () => inner.list(),
    async execute(call: ToolCall) {
      const result = await inner.execute(call);
      recordReviewStats(ctx, call, result);
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
        // reasons：classify 拒因（原 deny 直拒文案消费方已随 deny 路径删除；保留以供
        // 未来弹窗/提示表述引用，并维持 classifyPermissionCall 形状稳定）
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

/** 矩阵单格判定结果：'allow'（放行不弹窗）/ 'ask'（approval-request）。deny 直拒路径已删除。 */
export type PermissionDecision = 'allow' | 'ask';

/**
 * 权限判定矩阵（CTO 定案 → 全同 dsh 语义，逐格）：
 * | 类别 \ 预设            | read-only | workspace-write（默认） | full-access |
 * | fs 读（read/list/glob/grep） | allow | allow | allow |
 * | fs 写/编辑（write_file/edit_file）| ask | allow | allow |
 * | shell classify=read-only | allow | allow | allow |
 * | shell classify=ask（未知命令等） | ask | allow | allow |
 * | shell classify=deny（rm -rf 等） | ask | allow | allow |
 * | 矩阵外普通工具         | allow | allow | allow |
 * 语义要点（= dsh 实测零弹窗对照）：approval-request 只在 read-only 档产生（fs 写/编辑与
 * ask/deny 级命令——问询兜底）；workspace-write（默认）与 full-access 档命令全放行直接执行
 * （含破坏性——DevMate 无 OS 沙箱强制层，选档即接受；风险声明由前端权限描述承担）。
 * classify 三判级仍整体消费：read-only 档按「只读放行 / ask 与 deny 一律 ask」判定；
 * workspace/full 档不采用 ask/deny 语义（只读命令除外——三档均放行）。
 * deny 直拒（permissionDeniedMessage / errorType='permission-denied' 回注）路径已删除：
 * loop 侧的类型与回注形态保留兼容（不再触发）。
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
      // classify 三判级整体消费；ask/deny 语义只在 read-only 档生效，workspace/full 忽略
      if (cls.verdict === 'read-only') return 'allow';
      return permission === 'read-only' ? 'ask' : 'allow';
  }
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
    // ask 路径：approval-request（唯一审批面）。deny 直拒路径已删除（权限矩阵无 deny 项；
    // errorType='permission-denied' 不再产生——loop 类型保留兼容，见 core/loop/types.ts）。
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
        return [
          {
            event: 'session-user',
            // meta.system=true（评审哨兵）→ system:true（与在线流观察器同规）；
            // images 与存储 payload 同形（ADR-0015：历史回放渲染图像卡）
            data: {
              text: ev.payload.content,
              ...(ev.meta?.system === true ? { system: true } : {}),
              ...(ev.payload.images !== undefined && ev.payload.images.length > 0
                ? { images: ev.payload.images }
                : {}),
            },
          },
        ];
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
// + 技能注入全文（content(id)：SKILL.md + 同目录文本资产；bundled/user 两条来源
// 共用本段实现——索引合并（ensureSkillsIndex）与内容组装单源，见 composeSkillContent）。
// ---------------------------------------------------------------------------

/** 技能目录的入口文件（frontmatter 携带 name/description；用户技能可带 methodology 块行）。 */
const SKILL_ENTRY = 'SKILL.md';

/** 注入的文本资产白名单扩展名（SKILL.md 入口文件除外——单列；目录递归收集）。 */
const SKILL_ASSET_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.py', '.js', '.sh']);

/**
 * 技能注入载荷（SKILL.md + 文本资产）总上限（字符；超限按**排序前缀**截断——资产按
 * 相对路径名序排于 SKILL.md 之后，截断自然落在资产尾部；末尾附截断注记）。
 */
export const SKILL_PAYLOAD_LIMIT_CHARS = 20_000;
/** 载荷截断注记（超限时附在末尾——与 reasoning 显示层「…（截断）」同规；语义=资产被截断）。 */
export const SKILL_PAYLOAD_TRUNCATED_MARK = '…（资产截断）';

/** 技能来源（GET /api/skills 的 origin；缺省 bundled）。 */
export type SkillOrigin = 'bundled' | 'user';

/**
 * 索引行：打包资产静态不变——每实例构建一次，启动后恒定（POST 开关不触发重扫）；
 * 用户目录行由扫描（mtime 签名懒读 + install 显式失效）动态维护。
 */
interface SkillDescriptor {
  id: string;
  name: string;
  summary: string;
  /** 来源（安装/合并语义：user 同名覆盖 bundled——list 单条、位置不动、descriptor 顶替）。 */
  origin: SkillOrigin;
  /** frontmatter 的 methodology 块（仅用户技能可能带；bundled 从 methodologies.json 进）。 */
  methodology?: SkillMethodology;
}

/** 解析 SKILL.md 头 frontmatter（`---` … `---`）：name / description / methodology 每字段一行；缩进续行忽略。 */
function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
  methodology?: SkillMethodology;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
  if (m === null) return {};
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv !== null && fields[kv[1]!] === undefined) fields[kv[1]!] = kv[2]!.trim();
  }
  const methodology = parseSkillMethodologyValue(fields['methodology']);
  return {
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(methodology !== null ? { methodology } : {}),
  };
}

/** description 首行 → summary（缺失 → ''，前端降级文案兜底）。 */
function descriptionFirstLine(description: string | undefined): string {
  if (description === undefined) return '';
  return (description.split('\n')[0] ?? '').trim();
}

/** 扫描技能目录：每个含 SKILL.md 的子目录 → 索引项；目录不存在/不可读 → 空列表。 */
async function scanSkillsIndex(skillsDir: string, origin: SkillOrigin): Promise<SkillDescriptor[]> {
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
      origin,
      ...(meta.methodology !== undefined ? { methodology: meta.methodology } : {}),
    });
  }
  return skills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 递归收集到的文本资产（rel = 相对技能目录的路径；注入节头 `## <file:rel>`）。 */
interface SkillAsset {
  rel: string;
  content: string;
}

/**
 * 递归收集技能目录的文本资产（白名单扩展名；入口 SKILL.md 除外；符号链接/特殊文件
 * 按不可注入跳过——不穿透目录边界）。二进制/未知扩展名与不可注入项的名字汇入
 * skipped（合成注记一行——让 agent 知道存在但不可用）；子目录/文件读失败静默跳过
 * （content() 容错契约：单资产失败不影响其余注入）。相对路径统一 posix 分隔符
 * （win 下 join 出 `\` ——注入节头按 `/` 呈现，与安装/索引口径一致）。
 */
async function collectSkillAssets(
  dir: string,
  prefix: string,
  assets: SkillAsset[],
  skipped: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录不可读：跳过（不崩）
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectSkillAssets(join(dir, entry.name), rel, assets, skipped);
      continue;
    }
    if (!entry.isFile()) {
      skipped.push(rel); // 符号链接/特殊文件：不可注入（避免穿透技能目录边界）
      continue;
    }
    if (entry.name === SKILL_ENTRY) continue; // 入口文件除外（正文在前，单列）
    if (!SKILL_ASSET_EXTENSIONS.has(extname(entry.name))) {
      skipped.push(rel);
      continue;
    }
    try {
      assets.push({ rel, content: await readFile(join(dir, entry.name), 'utf8') });
    } catch {
      // 读失败：按不存在处理（不注入不注记）
    }
  }
}

/**
 * 技能注入全文（content(id) 的组装单源；bundled/user 同一实现——同 API）：
 * SKILL.md 在前（原样）→ 文本资产按相对路径**名序**逐个追加节头 `## <file:rel>` + 内容
 * → 二进制/未知扩展名跳过并合成一行注记「有 N 个二进制资产未注入：<names…>」（一行——
 * 仅作存在性提示，内容永不注入）→ 总载荷 ≤ SKILL_PAYLOAD_LIMIT_CHARS 原样，超出按
 * 排序前缀截断 + 末尾附截断注记（描述语义：资产被截断）。SKILL.md 缺失/读失败 → null
 * （与旧 content(id) 同判型——use_skill 按 not-found 收敛）。
 * 单文件技能（目录仅 SKILL.md）→ 返回 SKILL.md 原样（无资产无注记——行为不变）。
 */
export async function composeSkillContent(skillDir: string): Promise<string | null> {
  let body: string;
  try {
    body = await readFile(join(skillDir, SKILL_ENTRY), 'utf8');
  } catch {
    return null;
  }
  const assets: SkillAsset[] = [];
  const skipped: string[] = [];
  await collectSkillAssets(skillDir, '', assets, skipped);
  assets.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  skipped.sort();
  for (const asset of assets) {
    body += `\n\n## <file:${asset.rel}>\n${asset.content}`;
  }
  if (skipped.length > 0) {
    body += `\n\n有 ${skipped.length} 个二进制资产未注入：${skipped.join(', ')}`;
  }
  if (body.length > SKILL_PAYLOAD_LIMIT_CHARS) {
    body = body.slice(0, SKILL_PAYLOAD_LIMIT_CHARS) + SKILL_PAYLOAD_TRUNCATED_MARK;
  }
  return body;
}

/** 缺省 skills 资产目录（dev 模式服务端在 dist 上跑——统一 dist 路径，静态 dev 可选）。 */
function defaultSkillsDir(): string {
  return resolve(process.cwd(), 'dist', 'assets', 'skills');
}

/** 缺省用户技能目录（~/.devmate/skills；懒建——首装时；不入 StoredConfig——CLI 无需改动）。 */
function defaultUserSkillsDir(): string {
  return join(homedir(), '.devmate', 'skills');
}

/**
 * 缺省附件目录（~/.devmate/sessions/attachments；deps 未注入 AttachmentStore 时的兜底——
 * 真实装配（assembleDeps）恒注入 <sessionsDir>/attachments 的 store，用户会话根随之）。
 */
function defaultAttachmentsDir(): string {
  return join(homedir(), '.devmate', 'sessions', 'attachments');
}

/** 用户技能 id 的合法域（slug 化后严格 [a-z0-9-]——防路径逃逸的判定根：id 即目录名）。 */
const USER_SKILL_ID_RE = /^[a-z0-9-]+$/;

/** github raw 白名单 host（URL 安装唯一允许的源——SSRF 面收敛为 raw.githubusercontent.com）。 */
export const RAW_GITHUB_HOST = 'raw.githubusercontent.com';

/** URL 安装的流大小上限（字节；读流计数，超限 → 413 too-large）。 */
export const SKILL_INSTALL_MAX_BYTES = 512 * 1024;

/** URL 安装的抓取超时（ms；网络错/超时 → 502 fetch-failed）。 */
export const SKILL_FETCH_TIMEOUT_MS = 15_000;

/** 安装失败的错误类型（响应 {error:{type,message}} 的 type；状态映射：invalid-source/unsupported-host 400、skill-exists 409、too-large 413、fetch-failed 502、write-failed 500）。 */
export type SkillInstallErrorType =
  | 'invalid-source'
  | 'unsupported-host'
  | 'fetch-failed'
  | 'too-large'
  | 'skill-exists'
  | 'write-failed';

/**
 * frontmatter name → 技能 id（slug 化：小写、非 [a-z0-9] 折叠为 '-'、首尾 '-' 修剪；
 * 结果可为空串——调用方按 invalid-source 收敛）。严格 [a-z0-9-] 是防路径逃逸的根：
 * id 直接构成 <userSkillsDir>/<id>/，域外字符一律不被清洗进路径（`..`/`/` 全部折叠掉）。
 */
export function slugifySkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 合法 github raw 源 URL 的解析结果（构成段全部逐段校验过）。 */
export interface RawGithubRef {
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
}

/**
 * 白名单 raw 源 URL 校验（纯函数；矩阵见 test/ui-server/skills-install）：
 * - 仅 https；host 严格 raw.githubusercontent.com（host 白名单强制——其余 host 由
 *   调用方按 unsupported-host 收敛）；
 * - 无查询串/无片段（查询注入面整体关闭：query/hash 属于「查询串 abuse」→ 非法）；
 * - 路径 = owner/repo/branch/<path...>.md（≥4 段、末段 .md 尾、无尾斜杠）；
 * - 逐段校验：拒绝 `..`（含 . 段）、%2e（大小写，编码点逃逸）、%2f（分支/路径注入）、
 *   %5c、字面反斜杠与空白/控制字符——段边界不可被编码绕过；
 * - URL 构造器点段归一化对账：`..` / `%2e..` 会被解析器吃掉（fetch/服务器等价归一）——
 *   原始路径 != 标准化 pathname 即非法（归一化本身即逃逸信号）。
 * 非法 → null。
 */
export function parseRawGithubUrl(raw: string): RawGithubRef | null {
  // 空白/控制字符（含 NUL）：URL 构造会静默编码，一律拒绝
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) <= 0x20) return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== RAW_GITHUB_HOST) return null;
  // 端口/用户信息一律拒绝（白名单 host 唯一形态：仅 host+path，其余都可能是注入面）
  if (url.port !== '' || url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const rest = raw.slice('https://'.length);
  const firstSlash = rest.indexOf('/');
  if (firstSlash === -1) return null;
  const rawPath = rest.slice(firstSlash);
  if (rawPath === '' || rawPath.endsWith('/')) return null;
  if (rawPath !== url.pathname) return null; // 点段被构造器归一化 → 逃逸信号
  const segments = rawPath.slice(1).split('/');
  if (segments.length < 4) return null;
  const filePath = segments.slice(3).join('/');
  if (!filePath.endsWith('.md')) return null;
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.includes('..')) return null;
    const lower = segment.toLowerCase();
    if (lower.includes('%2e') || lower.includes('%2f') || lower.includes('%5c')) return null;
    if (segment.includes('\\')) return null;
  }
  return { owner: segments[0]!, repo: segments[1]!, branch: segments[2]!, filePath };
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
    readonly code?: string,
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
  options: { allowEmpty?: boolean; limit?: number } = {},
): Promise<unknown> {
  const limit = options.limit ?? JSON_BODY_LIMIT;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
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

// ---------------------------------------------------------------------------
// 多模态图片（ADR-0015 · dsh 管线落地）：/api/chat 上行 images 校验（纯函数）。
// 形状 = session payload 的 UserImage——**ref 形**（内容寻址附件引用 sha256/<sha>.<ext>，
// 图片字节在 <sessionsDir>/attachments/；事件/上行 slim——dataURL 不进会话文件）或
// **url 形**（旧 dataURL 直存——向后兼容旧客户端；读侧直通）。宽高由客户端测量传入，
// 服务端只校验正整数（token 估算面）。限额（dsh 三数）：20 图/消息（413 超限先行——
// 有别于形状非法 400）；单图 20MiB/会话累计 200MiB 由 POST /api/attachments 强制。
// 与前端上限镜像（src/ui/web/attachments.js 的 ATTACH_LIMITS——浏览器零构建
// 不能 import .ts，展示层只读镜像，权威来源见 ADR-0015）。
// ---------------------------------------------------------------------------

/** 旧 url 形单图 dataURL 字符上限（旧协议 5MiB 文件 ≈ 6.99MiB base64 + 前缀 ≈ 7MiB；
 *  新协议走 /api/attachments 的 20MiB 字节上限——本值只约束 legacy 直通）。 */
const MAX_LEGACY_IMAGE_DATAURL_CHARS = 8 * 1024 * 1024;

/**
 * 解析并校验 images 字段（缺省 undefined → 无图）；形状非法 → 400；数量超限（>20）→ 413
 * （dsh 上限；「超限 413 带原因码」——先于形状校验吞掉大请求）。
 * 只在「图片消息」存在时校验 —— text 恒可为空（图消息的纯图形态）。
 */
function parseChatImages(images: unknown): UserImage[] | undefined {
  if (images === undefined) return undefined;
  if (!Array.isArray(images)) throw new HttpError(400, 'images must be an array');
  if (images.length === 0) return undefined;
  if (images.length > ATTACH_LIMITS.maxCount) {
    throw new HttpError(
      413,
      `images must have at most ${ATTACH_LIMITS.maxCount} entries (image-count-limit)`,
    );
  }
  const out: UserImage[] = [];
  for (const img of images) {
    if (typeof img !== 'object' || img === null) {
      throw new HttpError(400, 'images entries must be objects {ref|url,width?,height?}');
    }
    const entry = img as Record<string, unknown>;
    const ref = entry.ref;
    const url = entry.url;
    let image: UserImage;
    if (isAttachmentRef(ref)) {
      image = { ref };
    } else if (
      typeof url === 'string' &&
      url.startsWith('data:image/') &&
      url.length <= MAX_LEGACY_IMAGE_DATAURL_CHARS
    ) {
      image = { url };
    } else {
      throw new HttpError(400, 'images entries must be sha256 refs or data:image/... dataURLs');
    }
    for (const dim of ['width', 'height'] as const) {
      const value = entry[dim];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new HttpError(400, `images.${dim} must be a positive integer`);
      }
      image[dim] = value;
    }
    out.push(image);
  }
  return out;
}

/** 错误码提取（fs 错误的 code 字段；非 fs 错误 → 'unknown'）。 */
function errorCodeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'unknown';
  }
  return 'unknown';
}

/**
 * DELETE /api/workspaces/:encodedRoot 的单段解码（根含 `/`：%2F 转义进段；
 * 解码结果必须是绝对路径——否则 400 统一 {error}）。
 */
function decodeWorkspaceRoot(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'invalid workspace root');
  }
  if (decoded === '' || !isAbsolute(decoded)) {
    throw new HttpError(400, 'invalid workspace root');
  }
  return decoded;
}

/**
 * browse 基数标准化（纯函数）：缺省 os.homedir()；相对路径按 homedir 解析；
 * normalize 消化 `..`/重复分隔符（traversal 无逃逸面——本接口只读展示，不写任何文件）。
 */
export function normalizeBrowseBase(raw: string | null, home: string = homedir()): string {
  if (raw === null || raw === '') return home;
  return normalize(isAbsolute(raw) ? raw : join(home, raw));
}

/**
 * 工作区根的 canonical 形（VT-5）：存在 → realpath（消尾斜杠/软链解析——与注册表
 * POST /api/workspaces 的存储口径一致）；不存在 → normalize（消尾斜杠/重复分隔符）。
 * 会话根参数与注册表条目都经本函数归一后比较：`/tmp/x/` 与 `/tmp/x` 等效
 * （UI browse 返回带尾斜杠路径时，已注册目录可以正常建会话——字面匹配误拒修复）。
 */
export async function canonicalizeWorkspaceRoot(raw: string): Promise<string> {
  try {
    return await realpath(raw);
  } catch {
    return normalize(raw);
  }
}

/**
 * 注册表成员判定（VT-5）：候选根 canonical 化后与注册表逐条比较；存量条目若非
 * canonical 形（旧 config 字面值）也回退朗读一遍（两端同口径）。
 */
export async function workspaceRegisteredIn(
  roots: readonly string[],
  raw: string,
): Promise<boolean> {
  const canonical = await canonicalizeWorkspaceRoot(raw);
  for (const entry of roots) {
    if (entry === canonical) return true;
    if ((await canonicalizeWorkspaceRoot(entry)) === canonical) return true;
  }
  return false;
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
        reviewStats: { counts: {}, subagentPrompts: [], flagged: false },
      };
      ctxs.set(id, ctx);
    }
    return ctx;
  };

  // 内容寻址附件存储（ADR-0015）：deps 注入优先（真实装配 = assembleDeps 的
  // <sessionsDir>/attachments）；否则按 attachmentsDir（未注入的兜底）。
  const attachmentStore =
    deps.attachments ?? new AttachmentStore(deps.attachmentsDir ?? defaultAttachmentsDir());

  // 附件 ref → dataURL 展开接缝（ADR-0015 请求时展开：读文件 + dataURL 组装；
  // ref 缺失 → null = 该图降级文本提示，绝不 400）——注入 runOptions 进投影层。
  const attachmentResolver = (ref: string): Promise<string | null> => attachmentStore.resolve(ref);

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
  // -- 工作区注册表（多工作区 dsh 语义）--
  // 初值 = deps.workspaces ?? [deps.workspaceRoot]（欠省默认根；去重保序）。注册表是
  // 会话根参数的合法域（POST /api/sessions|chat 首建的 workspaceRoot 须 ∈ 本表，否则
  // 400 workspace-not-registered）；POST 校验后登记 canonical 形式；默认根不可删。
  const workspaces: string[] = dedupeKeepOrder(
    deps.workspaces ?? (deps.workspaceRoot !== undefined ? [deps.workspaceRoot] : []),
  );

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
    /** 请求侧输入上限（A 档；未提供 = 不发送/厂商默认）。注意：**存的是钳后值**（S 档）。 */
    maxInputTokens?: number;
    /** 请求侧输出上限（A 档；未提供 = runOptions.maxTokens 缺省（DEFAULT_MAX_TOKENS 估价/不发送））。注意：存的是钳后值（S 档）。 */
    maxOutputTokens?: number;
    /** S 档钳制标记（运行时态；GET 经 clamped 键回执——「已按 <model> 上限钳制为 N」）。 */
    maxInputTokensClamped?: boolean;
    maxOutputTokensClamped?: boolean;
    /** 权限预设（权限预设定案：缺省 'workspace-write'；POST /api/settings 即时生效）。 */
    permission: PermissionPreset;
    /** full-access 风险确认记录（epoch ms；前端风险门后写入——纯记录、不强制）。 */
    permissionConfirmedAt?: number;
    /** 方法论前置门（R2-S1：缺省 true；false → 本 run 不注入门 = 从不拦截）。 */
    methodFirst: boolean;
    /** 评审哨兵（R2-S2：缺省 true；false → 本 run 不注入 review gate = 哨兵关闭）。 */
    reviewMode: boolean;
  }
  /** 读取时模型名是否被净化（存量 config 带 `[N]m/k` 尾标的历史残留）——进 GET 的
   * modelSanitized 键（前端据此提示「模型名已自动校正」——不静默）；用户重新保存后清位。 */
  let modelSanitizedOnRead = false;
  {
    // 双口径：deps 读取层（assembleDeps 见 config.model 尾标）已剥 — modelWasSanitized；
    // 服务端直构（种子仍带尾标）→ 本地再判一次。
    const rawSeedModel = deps.settings?.model ?? deps.model;
    modelSanitizedOnRead =
      deps.settings?.modelWasSanitized === true ||
      sanitizeProviderModel(rawSeedModel) !== rawSeedModel;
  }
  const current: CurrentSettings = {
    baseUrl: deps.settings?.baseUrl ?? '',
    // 模型名净化（全链根除 2026-08-30 用户实测残留）：settings 种子即净化——
    // 存量 config 里的 `[N]m/k` UI 标记后缀在读取/回显时净化显示（POST 再存净化值回写）；
    // run/摘要器/网关重探消费的都是净化名（适配层发送侧同样再净化——幂等）。
    model: sanitizeProviderModel(deps.settings?.model ?? deps.model),
    reasoning: deps.settings?.reasoning ?? 'medium',
    permission: deps.settings?.permission ?? DEFAULT_PERMISSION_PRESET,
    methodFirst: deps.settings?.methodFirst ?? true,
    reviewMode: deps.settings?.reviewMode ?? true,
    ...(deps.settings?.apiKey !== undefined ? { apiKey: deps.settings.apiKey } : {}),
    ...(deps.settings?.windowTokens !== undefined
      ? { windowTokens: deps.settings.windowTokens }
      : {}),
    ...(deps.settings?.maxInputTokens !== undefined
      ? { maxInputTokens: deps.settings.maxInputTokens }
      : {}),
    ...(deps.settings?.maxOutputTokens !== undefined
      ? { maxOutputTokens: deps.settings.maxOutputTokens }
      : {}),
    ...(deps.settings?.permissionConfirmedAt !== undefined
      ? { permissionConfirmedAt: deps.settings.permissionConfirmedAt }
      : {}),
  };
  /**
   * 窗口是否用户显式覆盖（三源取窗）。初值 = deps.settings.windowTokensExplicit
   * （assembleDeps 按 config.windowTokens 是否存在播种——preset 胚不算显式）；
   * POST /api/settings 触碰 windowTokens 后恒 true（显式设置即锁定，探测不再顶替）。
   */
  let explicitWindowTokens = deps.settings?.windowTokensExplicit === true;

  /**
   * E7 上限学习（ADR-0016 L2）：运行时「超限报错 → 压缩重试」链从 400 message 免费解析的
   * 供应商上限（0 token 计费的「真值探测」）。
   *
   * 生命周期（VT2-1 修正：learned = run-scoped——只对「产生该错误的 run」的后续轮注记/
   * 钳制：实例全局槽仅为「本 run 内」，产生学习的 run 结束即清除，新 run 恒从空开始，
   * 不做跨 run 粘滞）。语义（a 条）：learned 只降不抬，但**用户显式 windowTokens 是
   * 最高权威**——显式覆盖时不得被 learned min 钳制/顶替（only 无显式时 min 生效）；
   * 参与窗口预算钳制（min）与 GET /api/settings 的 windowDetail 注记（「由错误学习」）。
   * provider 变更（settings POST）仍即清空（旧供应商真值对新端点无意义）。
   */
  let learnedLimitCaps: { windowCap?: number; outputCap?: number; evidence?: string } = {};
  /** 槽值归属的 run（runId 计数器）；仅归属 run 结束时清除槽——并发 run 不互相误清/串用。 */
  let learnedCapsOwnerRun: number | undefined;
  let runSequence = 0;

  /** 评审哨兵门（R2-S2）语义版装配：hasSubstantiveWork/hasReviewRun 由 ctx 观察器记帐的
   * RunStats 判定（纯函数 loop/types）；flag 为会话级一次性（注入即置位——护栏即一次）。 */
  function reviewGateFor(ctx: SessionCtx): ReviewGate {
    const statsOf = (): RunStats => ({
      counts: ctx.reviewStats.counts,
      subagentPrompts: ctx.reviewStats.subagentPrompts,
    });
    return {
      hasSubstantiveWork: () => hasSubstantiveWork(statsOf()),
      hasReviewRun: () => hasReviewRun(statsOf()),
      isFlagged: () => ctx.reviewStats.flagged,
      markFlagged: () => {
        ctx.reviewStats.flagged = true;
      },
      // P2-10 评审静默：池未启用（subagents-disabled）→ 哨兵静默跳过（loop 层裁决）——
      // 不再指示模型触发必然失败的子代理尝试；UI 侧至多一行提示
      subagentAvailable: () => workflowState.subagentsEnabled,
    };
  }

  function startRun(sessionId: string, text: string, images?: UserImage[]): void {
    const runToken = ++runSequence; // run 身份（learned 槽归属：run-scoped，VT2-1）
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
        // C 档：设置侧思考强度 / 三源窗口（覆盖 > 网关探测 > preset）每次 run 现读
        runOptions.reasoning = current.reasoning;
        // 窗口预算（ADR-0016）：三源取窗 > E7 学习钳（min——「由错误学习」真值只降不抬）
        // > INPUT=预算上限钳（用户设了 maxInputTokens → 窗口预算钳于它：INPUT 双语义——
        // DashScope wire 载体 + 预算上限；README 有注明）。
        let windowBudget = effectiveWindow().window;
        // E7 学习钳（min——「由错误学习」真值只降不抬）。VT2-1 语义：
        // - learned 为 run-scoped（本 run 内学习才可能驻留——run 结束即清，见 finally）；
        // - 用户显式 windowTokens 是最高权威：显式时跳过（learned 绝不钳制/顶替用户值）。
        if (!explicitWindowTokens && learnedLimitCaps.windowCap !== undefined) {
          windowBudget =
            windowBudget === undefined
              ? learnedLimitCaps.windowCap
              : Math.min(windowBudget, learnedLimitCaps.windowCap);
        }
        if (current.maxInputTokens !== undefined) {
          windowBudget =
            windowBudget === undefined
              ? current.maxInputTokens
              : Math.min(windowBudget, current.maxInputTokens);
        }
        if (windowBudget !== undefined) runOptions.windowTokens = windowBudget;
        // A 档：输入/输出上限——每次 run 现读（POST /api/settings 即时生效）；
        // 未设置 → 回到缺省（输出：闸门 A 按 DEFAULT_MAX_TOKENS 估价且请求不发送 max_tokens；
        // 输入：不发送/厂商默认）。S 档：current 存的是钳后值（POST 已钳）；
        // E7 学习钳（min）作为最后一道（供应商变更/更小上限的运行时真值）。
        if (current.maxOutputTokens !== undefined) {
          runOptions.maxTokens =
            learnedLimitCaps.outputCap !== undefined
              ? Math.min(current.maxOutputTokens, learnedLimitCaps.outputCap)
              : current.maxOutputTokens;
        } else {
          delete runOptions.maxTokens;
        }
        if (current.maxInputTokens !== undefined) {
          runOptions.maxInputTokens = current.maxInputTokens;
        } else {
          delete runOptions.maxInputTokens;
        }
        // E7 自愈链学习回调（L2）：核心循环从 400 message 免费学到上限 →
        // 记入 learnedLimitCaps（windowDetail「由错误学习」/ 后续轮钳制）；记录归属
        // runToken（run-scoped，VT2-1——本 run 结束即清除，见 finally）。
        runOptions.onLimitsError = async (learning) => {
          if (learning.kind === 'context-exceeded' && learning.hintMax !== undefined) {
            learnedLimitCaps = {
              ...learnedLimitCaps,
              windowCap: learning.hintMax,
              evidence: learning.message,
            };
            learnedCapsOwnerRun = runToken;
          } else if (learning.kind === 'output-limit' && learning.hintMax !== undefined) {
            learnedLimitCaps = {
              ...learnedLimitCaps,
              outputCap: learning.hintMax,
              evidence: learning.message,
            };
            learnedCapsOwnerRun = runToken;
          }
        };
        // R2-S1：方法论前置门按开关传递——false → 删除 methodology 键（门不拦）；
        // true 时装配层已注入（gate 只含 route/状态观察，索引内容服务端现读）。
        if (current.methodFirst === false) delete runOptions.methodology;
        // R2-S2：评审哨兵按开关传递——false → 删除 review 键（哨兵从不注入）；
        // true = 语义版 gate（RunStats 数据源 = 本会话观察器记帐）。
        if (current.reviewMode === false) {
          delete runOptions.review;
        } else {
          runOptions.review = reviewGateFor(ctx);
        }
        if (deps.createSummarizer !== undefined && runOptions.summarizer !== undefined) {
          runOptions.summarizer = deps.createSummarizer(llm, current.model);
        }
        // 附件 ref 展开（ADR-0015）：服务端 resolver（读附件文件 + dataURL 组装）——
        // 每次 run 注入（与 llm 同频重建；缺失 ref → 投影层降级文本提示）
        runOptions.attachResolver = attachmentResolver;
        if (deps.composeSystemPrompt !== undefined) {
          // 系统提示每次运行前合成（基础 + 技能清单节 + 路由节 + 子代理节 + 任务分解节 +
          // 收尾评审节）：技能开关/workflow 配置变更即时作用（晚绑定回填已附接）；
          // methodFirst:false → 路由节排除（与门同关——提示词与行为一致）。
          runOptions.systemPrompt = await deps.composeSystemPrompt(
            current.methodFirst === false ? { includeMethodology: false } : undefined,
          );
        }
        const baseTools =
          deps.createSessionTools !== undefined
            ? await deps.createSessionTools(sessionId)
            : registryToolsOf();
        // 每次 run 重建工具面：base（fs/shell/技能/子代理，会话缓存）+ 新组装 MCP
        // 工具（开关/追加变更即时生效；连接失败 → 0 个 mcp 工具，run 不因之失败）
        const tools =
          deps.composeRunTools !== undefined
            ? await deps.composeRunTools(baseTools, sessionId)
            : baseTools;
        result = await run(
          {
            sessionId,
            task: text,
            ...(images !== undefined && images.length > 0 ? { images } : {}),
          },
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
          // P2-8 报错本地化：供应商裸英文（图片被拒/认证/限流/网络）→ 中文一行 + 指引
          ctx.broker.push({
            event: 'run-error',
            data: { message: friendlyProviderError(result.error) ?? result.error },
          });
        }
        ctx.broker.push({
          event: 'run-status',
          data: { status: result.status, steps: result.steps, durationMs: result.durationMs },
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // P2-8 报错本地化：供应商裸英文 → 中文一行 + 指引（未命中模式保留原文）
        const message = friendlyProviderError(raw) ?? raw;
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
        // run-scoped 学习（VT2-1）：产生本 run 的学习只随本 run 生命周期存活——
        // run 结束即清（新 run 恒从空开始；跨 run 无粘滞）。归属判定：并发 run
        // 互不误清（只清自己写入的槽）。
        if (learnedCapsOwnerRun === runToken) {
          learnedLimitCaps = {};
          learnedCapsOwnerRun = undefined;
        }
      }
    })();
  }

  // -------------------------------------------------------------------------
  // 内容寻址附件（ADR-0015 · dsh 管线落地）：POST /api/attachments 上传 +
  // GET /api/attachments/<ref> 读回（同源展示面）
  // -------------------------------------------------------------------------

  /**
   * POST /api/attachments：{sessionId, dataUrl, width?, height?}（dataURL 形）或
   * {sessionId, data, mediaType, width?, height?}（纯 base64+类型形——两种都兼容）。
   * → {ref:"sha256/<sha>.<ext>", width?, height?}（宽高由客户端测量传入；服务端只校验
   * 正整数——token 估算面）。限额（dsh 三数；超 413 带原因码）：单图 ≤20MiB →
   * attach-too-large；单会话累计 ≤200MiB → attach-session-quota。sessionId 必填
   * （单会话累计记账键；与 /api/chat 的会话同键——客户端在首条消息前即生成）。
   */
  async function handleAttachmentsUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, { limit: ATTACH_LIMITS.maxUploadBodyBytes });
    if (typeof body !== 'object' || body === null) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const record = body as Record<string, unknown>;
    const sessionId = asString(record.sessionId);
    if (sessionId === undefined || sessionId === '') {
      throw new HttpError(400, 'sessionId is required (attachment accounting key)');
    }
    try {
      assertValidSessionId(sessionId);
    } catch {
      throw new HttpError(400, 'invalid session id');
    }
    const input: AttachmentUploadInput = { sessionId };
    const dataUrl = asString(record.dataUrl);
    const data = asString(record.data);
    const mediaType = asString(record.mediaType);
    if (dataUrl !== undefined) input.dataUrl = dataUrl;
    if (data !== undefined) input.data = data;
    if (mediaType !== undefined) input.mediaType = mediaType;
    for (const dim of ['width', 'height'] as const) {
      const value = record[dim];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new HttpError(400, `${dim} must be a positive integer`);
      }
      input[dim] = value;
    }
    if (
      input.dataUrl === undefined &&
      (input.data === undefined || input.mediaType === undefined)
    ) {
      throw new HttpError(
        400,
        'body must be {sessionId, dataUrl, ...} or {sessionId, data, mediaType, ...}',
      );
    }
    try {
      const attached = await attachmentStore.receive(input);
      sendJson(res, 200, attached);
    } catch (err) {
      if (err instanceof AttachmentStoreError) {
        // 413 带原因码（code）：超限的错误形状与 4xx 形状校验并行（{error, code}）
        sendJson(res, err.status, { error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  }

  /** GET /api/attachments/<ref>（ref = sha256/<sha>.<ext>）：原始图像字节——UI 侧
   *  渲染 img.src = /api/attachments/<ref>（ref 事件/帧的展示面；旧 dataURL 事件不经此面）。
   *  内容寻址：sha256 恒等 → immutable 永久缓存。缺失/非法 → 404。 */
  async function handleAttachmentsRaw(res: ServerResponse, rawRef: string): Promise<void> {
    if (!isAttachmentRef(rawRef)) throw new HttpError(404, 'attachment not found');
    const file = await attachmentStore.raw(rawRef);
    if (file === null) throw new HttpError(404, 'attachment not found');
    res.writeHead(200, {
      'content-type': file.mediaType,
      'content-length': file.bytes.length,
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(file.bytes);
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
    // 多模态（ADR-0015）：纯文本仍必须非空；带 images 的图消息允许空文本
    // （纯图形态：用户只附一张图 + 默认文案由前端保证——服务端只验证形状）。
    const images = parseChatImages((body as Record<string, unknown>).images);
    if (
      (text === undefined || text.trim() === '') &&
      (images === undefined || images.length === 0)
    ) {
      throw new HttpError(400, 'text is required (non-empty string) or images must be provided');
    }
    const supplied = asString((body as Record<string, unknown>).sessionId);
    const sessionId = supplied !== undefined && supplied !== '' ? supplied : `s-${randomUUID()}`;
    try {
      assertValidSessionId(sessionId);
    } catch {
      throw new HttpError(400, 'invalid session id');
    }
    // 会话根参数（多工作区）：首建时消费（须 ∈ 注册表）；resume（会话已存在）忽略——见守卫内
    const rawRoot = (body as Record<string, unknown>).workspaceRoot;
    if (rawRoot !== undefined && typeof rawRoot !== 'string') {
      throw new HttpError(400, 'workspaceRoot must be a string');
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
          // VT-4 修复：workspaceRoot 注册表校验置于会话文件创建**之前**——未注册根
          // 400 workspace-not-registered 且零持久副作用（不残留空会话文件/列表项）。
          // 多工作区：workspaceRoot 参数只作用于首建（resume 忽略）；缺省 = 默认根。
          // VT-5：注册表与参数都经 canonical 化比较（`/tmp/x/` ≡ `/tmp/x`——UI browse
          // 返回带尾斜杠路径也能为已注册目录建会话）；meta 落 canonical 形。
          let root = deps.workspaceRoot;
          if (rawRoot !== undefined && rawRoot !== '') {
            if (!(await workspaceRegisteredIn(workspaces, rawRoot))) {
              throw new HttpError(400, 'workspace-not-registered');
            }
            root = await canonicalizeWorkspaceRoot(rawRoot);
          }
          await deps.store.create(sessionId);
          // A 档：会话按项目文件夹分组——首建即落 workspace meta（旧会话/resume 无此事件）
          if (root !== undefined) {
            await observedStore.append(sessionId, {
              kind: 'event',
              payload: { type: 'session-workspace', data: { workspaceRoot: root } },
            });
          }
        }
        await observedStore.append(sessionId, {
          kind: 'user',
          payload: {
            content: text ?? '',
            ...(images !== undefined && images.length > 0 ? { images } : {}),
          },
        });
      } catch (err) {
        ctx.active = false;
        if (err instanceof SessionExistsError || err instanceof SessionNotFoundError) {
          throw new HttpError(409, err.message);
        }
        throw err;
      }
    });
    startRun(sessionId, text ?? '', images);
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
    // VT-8：全损坏（不可解析行 > 阈值）→ 标题「（会话损坏）」+ corrupted 标记——
    // 与列表同口径（坏行被逐行跳过而 events 空时，不再冒充「（空会话）」）。
    const corrupted = await isCorruptedSession(deps.store, sessionId);
    const { title, workspaceRoot, frames } = await sessionDetailFrames(deps.store, sessionId);
    sendJson(res, 200, {
      sessionId,
      title: corrupted ? SESSION_CORRUPTED_TITLE : title,
      workspaceRoot,
      events: frames,
      ...(corrupted ? { corrupted: true } : {}),
    });
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
    // 多工作区：workspaceRoot 参数（须 ∈ 注册表——未注册 400 workspace-not-registered；
    // POST /api/sessions 恒为新建，参数必然消费）；缺省 = deps.workspaceRoot（默认根）
    // VT-5：注册表与参数均按 canonical 化比较（`/tmp/x/` ≡ `/tmp/x`——字面匹配误拒修复）；
    // meta 落 canonical 形（与注册表存储口径一致）。
    const rawRoot = (body as Record<string, unknown>).workspaceRoot;
    if (rawRoot !== undefined && typeof rawRoot !== 'string') {
      throw new HttpError(400, 'workspaceRoot must be a string');
    }
    let root = deps.workspaceRoot;
    if (rawRoot !== undefined && rawRoot !== '') {
      if (!(await workspaceRegisteredIn(workspaces, rawRoot))) {
        throw new HttpError(400, 'workspace-not-registered');
      }
      root = await canonicalizeWorkspaceRoot(rawRoot);
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
    if (root !== undefined) {
      await observedStore.append(sessionId, {
        kind: 'event',
        payload: { type: 'session-workspace', data: { workspaceRoot: root } },
      });
    }
    // 带首消息：只落首个 user 事件，不启动 run（首消息之后的交互仍走 POST /api/chat）
    if (text !== undefined && text !== '') {
      await observedStore.append(sessionId, { kind: 'user', payload: { content: text } });
    }
    sendJson(res, 200, { sessionId });
  }

  // -- 工作区注册表（GET/POST /api/workspaces、DELETE /api/workspaces/:root、browse） --

  async function handleWorkspacesList(res: ServerResponse): Promise<void> {
    sendJson(res, 200, { roots: [...workspaces] });
  }

  async function handleWorkspacesAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const path = asString((body as Record<string, unknown>).path);
    if (path === undefined || path === '') {
      throw new HttpError(400, 'path is required (non-empty string)');
    }
    if (!isAbsolute(path)) {
      throw new HttpError(400, 'workspace path must be absolute');
    }
    // b) 路径校验：存在 + isDirectory；realpath 归一；目录不可读 → 400 带原因（示错闭环）
    try {
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw new HttpError(400, 'workspace path must be a directory');
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `workspace path is not accessible: ${errorCodeOf(err)}`);
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (err) {
      throw new HttpError(400, `workspace path is not accessible: ${errorCodeOf(err)}`);
    }
    try {
      await readdir(canonical); // 目录不存在可读性（EACCES 等）→ 400 带原因
    } catch (err) {
      throw new HttpError(400, `workspace directory is not readable: ${errorCodeOf(err)}`);
    }
    // a) 注册（canonical 归一 + 去重保序）+ 持久化（无 saveWorkspaces 回调 → 仅内存；
    // 重复注册幂等——注册表未变不触发持久化）
    if (!workspaces.includes(canonical)) {
      workspaces.push(canonical);
      if (deps.saveWorkspaces !== undefined) await deps.saveWorkspaces([...workspaces]);
    }
    sendJson(res, 200, { roots: [...workspaces] });
  }

  async function handleWorkspacesDelete(res: ServerResponse, raw: string): Promise<void> {
    const root = decodeWorkspaceRoot(raw);
    // 当前默认根不可删（字面或 canonical 同目录均拦——软链默认根经 canonical 写法也受保护）
    if (await isDefaultWorkspaceRoot(root)) {
      throw new HttpError(400, 'cannot delete the default workspace root');
    }
    const idx = workspaces.indexOf(root);
    if (idx < 0) {
      throw new HttpError(404, `workspace not registered: ${root}`);
    }
    workspaces.splice(idx, 1);
    // remove + persist；仍有会话指向它 → 允许（会话文件保留——展示层归属不因此漂移）
    if (deps.saveWorkspaces !== undefined) await deps.saveWorkspaces([...workspaces]);
    sendJson(res, 200, { roots: [...workspaces] });
  }

  async function handleWorkspaceBrowse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // path 缺省 os.homedir()；路径标准化（relative 按 homedir 解析、.. 折叠）——纯展示：
    // 只读目录列表（readdir withFileTypes 仅目录 + 字节序排序），任何写入路径都不经过这里
    const path = new URL(req.url ?? '/', `http://${HOST}`).searchParams.get('path');
    const base = normalizeBrowseBase(path);
    let entries: Dirent[];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      // 深层错误（不存在/不可读/非目录）→ 空列表（best-effort 展示，不 4xx）
      sendJson(res, 200, { base, dirs: [] });
      return;
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => ({ name: entry.name, path: join(base, entry.name) }));
    sendJson(res, 200, { base, dirs });
  }

  /** 默认根判定（字面相等或 realpath 同目录——软链默认根的 canonical 写法不可删）。 */
  async function isDefaultWorkspaceRoot(root: string): Promise<boolean> {
    if (deps.workspaceRoot === undefined) return false;
    if (root === deps.workspaceRoot) return true;
    try {
      return (await realpath(root)) === (await realpath(deps.workspaceRoot));
    } catch {
      return false;
    }
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
      // 附件引用扫描联动删除（ADR-0015）：本会话 manifest 引用的附件文件仅在
      // 无其它会话引用时删除（内容寻址共享——同字节一文件；幂等）
      await attachmentStore.deleteSession(sessionId);
    });
    // 成功路径断环：删除后该 id 的 per-session 串行化链随之清零（失效的历史承诺不再
    // 悬挂——同 id 重建从全新链开始；404/409 失败路径不删除，链保留给后续重试）。
    sessionGuards.delete(sessionId);
    sendJson(res, 200, { ok: true });
  }

  // -- Skills（A1：资产索引 + 运行时开关 + 用户技能安装；全文不下发） --
  const skillsDir = deps.skillsDir ?? defaultSkillsDir();
  const userSkillsDir = deps.userSkillsDir ?? defaultUserSkillsDir();
  let skillsCache: SkillDescriptor[] | null = null;
  /**
   * 用户技能索引缓存（懒读 + 即时失效双路径——「不动服务器进程可感知」）：
   * - 惰性重扫：目录 mtime+size 签名（外部直写/删除目录 → 下次读取自然重扫）；
   * - 显式失效：install 成功路径清空缓存（写内容不改变父目录 mtime——非新目录的
   *   覆盖/新增文件靠显式失效兜底）。
   */
  let userSkillsCache: { sig: string; entries: SkillDescriptor[] } | null = null;
  // 开关构造期播种（deps.skillsRecord 注入的旧快照——重启禁用保持：持久化断环修复；
  // 未注入/缺失 id 缺省 true = 全开）；缺省空表。一张表覆盖 bundled 与 user（键 = id 通用）。
  const skillsSwitches = new Map<string, boolean>(Object.entries(deps.skillsRecord ?? {}));
  const ensureBundledSkillsIndex = async (): Promise<SkillDescriptor[]> => {
    if (skillsCache === null) skillsCache = await scanSkillsIndex(skillsDir, 'bundled');
    return skillsCache;
  };
  const ensureUserSkillsIndex = async (): Promise<SkillDescriptor[]> => {
    let sig = 'missing';
    try {
      const info = await stat(userSkillsDir);
      sig = `${info.mtimeMs}:${info.size}`;
    } catch {
      // 目录不存在（未装过任何用户技能）→ 空列表；创建后 mtime 签名变化自然重扫
    }
    if (userSkillsCache !== null && userSkillsCache.sig === sig) return userSkillsCache.entries;
    const entries = await scanSkillsIndex(userSkillsDir, 'user');
    userSkillsCache = { sig, entries };
    return entries;
  };
  /**
   * 合并索引：bundled（id 序）在前 + pure user（id 序）按首见序追加；同名 id 用户覆盖
   * ——Map.set 顶替 descriptor、保留 bundled 位置（列表单条、GET origin='user'；
   * 内容/方法论路由表项一并顶替——见 content 与 loadMethodologyMeta）。
   */
  const ensureSkillsIndex = async (): Promise<SkillDescriptor[]> => {
    const [bundled, user] = await Promise.all([
      ensureBundledSkillsIndex(),
      ensureUserSkillsIndex(),
    ]);
    const byId = new Map<string, SkillDescriptor>();
    for (const skill of bundled) byId.set(skill.id, skill);
    for (const skill of user) byId.set(skill.id, skill);
    return [...byId.values()];
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
        origin: skill.origin,
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

  // -- 用户技能安装（P 档：POST /api/skills/install；错误统一 {error:{type,message}}） --

  /** 安装失败（错误形状与 4xx/5xx 状态由类型单一映射；见 handleSkillInstall 的 catch）。 */
  class SkillInstallError extends Error {
    constructor(
      readonly type: SkillInstallErrorType,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  /**
   * 从内容提取技能 id：frontmatter name 的 slug 化（严格 [a-z0-9-]——防路径逃逸的判定根，
   * 直接在 <userSkillsDir>/<id>/ 落地：id 不合法即拒绝，绝不把域外字符清洗进路径）。
   * 无 name / slug 为空 → invalid-source。
   */
  function skillIdFromContent(content: string): string {
    const meta = parseSkillFrontmatter(content);
    const name = meta.name;
    if (name === undefined || name === '') {
      throw new SkillInstallError('invalid-source', 400, 'SKILL.md frontmatter has no name');
    }
    const id = slugifySkillName(name);
    if (!USER_SKILL_ID_RE.test(id)) {
      throw new SkillInstallError(
        'invalid-source',
        400,
        `skill name yields invalid id: ${JSON.stringify(name)}`,
      );
    }
    return id;
  }

  /** 已存在 → 409 skill-exists（幂等不覆盖；目录或占名文件都视为已存在）。 */
  async function assertNotInstalled(id: string): Promise<void> {
    try {
      await stat(join(userSkillsDir, id));
      throw new SkillInstallError('skill-exists', 409, `skill already installed: ${id}`);
    } catch (err) {
      if (err instanceof SkillInstallError) throw err;
      // ENOENT（未装）→ 放行
    }
  }

  /** 本地安装：绝对 SKILL.md（基名=SKILL.md）或含 SKILL.md 的目录 → 整目录复制。 */
  async function installFromLocal(source: string): Promise<string> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(source);
    } catch {
      throw new SkillInstallError('invalid-source', 400, `local source not accessible: ${source}`);
    }
    let skillDir: string;
    if (info.isDirectory()) {
      try {
        if (!(await stat(join(source, SKILL_ENTRY))).isFile()) {
          throw new SkillInstallError('invalid-source', 400, 'SKILL.md is not a file');
        }
      } catch (err) {
        if (err instanceof SkillInstallError) throw err;
        throw new SkillInstallError('invalid-source', 400, 'directory contains no SKILL.md');
      }
      skillDir = source;
    } else {
      if (basename(source) !== SKILL_ENTRY) {
        throw new SkillInstallError('invalid-source', 400, 'local file must be named SKILL.md');
      }
      skillDir = dirname(source);
    }
    let content: string;
    try {
      content = await readFile(join(skillDir, SKILL_ENTRY), 'utf8');
    } catch {
      throw new SkillInstallError('invalid-source', 400, 'SKILL.md is not readable');
    }
    if (content.includes('\u0000')) {
      // 写入前 sanitize（与 URL 同规）：仅文本（UTF-8）、拒含 NUL 的字符串
      throw new SkillInstallError('invalid-source', 400, 'content contains NUL bytes');
    }
    const id = skillIdFromContent(content);
    await assertNotInstalled(id);
    const dest = join(userSkillsDir, id);
    try {
      await mkdir(userSkillsDir, { recursive: true }); // 目录懒建（首装时）
      await cp(skillDir, dest, { recursive: true });
    } catch (err) {
      throw new SkillInstallError('write-failed', 500, `write failed: ${errorCodeOf(err)}`);
    }
    userSkillsCache = null; // 显式失效：向后的 list()/content() 立即反映（无需重启）
    return id;
  }

  /** URL 安装错误类型的属性映射：URL 可解析且 host 非白名单 → unsupported-host；其余 → invalid-source。 */
  function installUrlErrorType(source: string): SkillInstallErrorType {
    try {
      const url = new URL(source);
      if (url.protocol === 'https:' && url.hostname !== RAW_GITHUB_HOST) return 'unsupported-host';
      return 'invalid-source';
    } catch {
      return 'invalid-source';
    }
  }

  /** URL 正文读取：读流计数（≤ SKILL_INSTALL_MAX_BYTES）+ UTF-8 严格解码（仅文本）+ 拒 NUL。 */
  async function readBoundedUtf8(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;
    let invalidUtf8 = false;
    for (;;) {
      let chunk: Uint8Array;
      try {
        const { done, value } = await reader.read();
        if (done) break;
        chunk = value;
      } catch {
        throw new SkillInstallError('fetch-failed', 502, 'response stream interrupted');
      }
      bytes += chunk.byteLength;
      if (bytes > SKILL_INSTALL_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SkillInstallError(
          'too-large',
          413,
          `content exceeds ${SKILL_INSTALL_MAX_BYTES} bytes`,
        );
      }
      try {
        text += decoder.decode(chunk, { stream: true });
      } catch {
        invalidUtf8 = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!invalidUtf8) {
      try {
        text += decoder.decode();
      } catch {
        invalidUtf8 = true;
      }
    }
    if (invalidUtf8) {
      throw new SkillInstallError('invalid-source', 400, 'content is not valid UTF-8 text');
    }
    if (text.includes('\u0000')) {
      throw new SkillInstallError('invalid-source', 400, 'content contains NUL bytes');
    }
    return text;
  }

  /** URL 安装：白名单校验 → 注入 fetch（不跟随重定向、超时）→ 读流 → 落地 <id>/SKILL.md。 */
  async function installFromUrl(source: string): Promise<string> {
    const parsed = parseRawGithubUrl(source);
    if (parsed === null) {
      throw new SkillInstallError(installUrlErrorType(source), 400, 'invalid source URL');
    }
    const fetcher = deps.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetcher(source, {
        redirect: 'manual', // 重定向不跟随：3xx 一律 fetch-failed（非 200）
        // 真实抓取才挂超时（fallback fetch）；测试注入 mock 时避免挂真实定时器
        ...(deps.fetch === undefined
          ? { signal: AbortSignal.timeout(SKILL_FETCH_TIMEOUT_MS) }
          : {}),
      });
    } catch {
      throw new SkillInstallError(
        'fetch-failed',
        502,
        'fetch failed (network error, redirect or timeout)',
      );
    }
    if (response.status !== 200) {
      throw new SkillInstallError('fetch-failed', 502, `fetch returned status ${response.status}`);
    }
    if (response.body === null) {
      throw new SkillInstallError('fetch-failed', 502, 'response body is empty');
    }
    const text = await readBoundedUtf8(response);
    const id = skillIdFromContent(text);
    await assertNotInstalled(id);
    const dest = join(userSkillsDir, id);
    try {
      await mkdir(dest, { recursive: true }); // 目录懒建（首装时；含 userSkillsDir 本体）
      await writeFile(join(dest, SKILL_ENTRY), text);
    } catch (err) {
      throw new SkillInstallError('write-failed', 500, `write failed: ${errorCodeOf(err)}`);
    }
    userSkillsCache = null; // 显式失效：向后的 list()/content() 立即反映（无需重启）
    return id;
  }

  /** install 全链串行化（409 检查与写入的 TOCTOU 窗口关闭——同 id 并发装仅首装成功）。 */
  let installGuard: Promise<unknown> = Promise.resolve();
  async function handleSkillInstall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJson(req);
      if (typeof body !== 'object' || body === null) {
        throw new SkillInstallError('invalid-source', 400, 'request body must be a JSON object');
      }
      const source = asString((body as Record<string, unknown>).source);
      if (source === undefined || source === '') {
        throw new SkillInstallError('invalid-source', 400, 'source is required (non-empty string)');
      }
      const run = async (): Promise<string> => {
        if (/^https?:\/\//i.test(source)) return installFromUrl(source);
        if (isAbsolute(source)) return installFromLocal(source);
        throw new SkillInstallError('invalid-source', 400, 'local source must be an absolute path');
      };
      const chained = installGuard.then(run, run);
      installGuard = chained.then(
        () => undefined,
        () => undefined,
      );
      const id = await chained;
      sendJson(res, 200, { ok: true, id, origin: 'user' });
    } catch (err) {
      if (err instanceof SkillInstallError) {
        sendJson(res, err.status, { error: { type: err.type, message: err.message } });
        return;
      }
      throw err;
    }
  }

  // -- 工作流（A2）与 MCP（A3）：均为配置层（子代理/MCP 实际执行属 P2，端点上只有配置） --
  // maxParallel 归一到 0-8（0 = 无上限；单一来源：shared/workflow 的 clampMaxParallel）
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
        // 内容优先级 user > bundled（同名 id 用户覆盖——用户目录存在即读用户文件；
        // 仅 bundled 命中才读资产，被用户覆盖的 bundled 内容不再可达）。
        // 载荷组装（SKILL.md + 同目录文本资产 ≤20k）在 composeSkillContent 单源实现——
        // bundled 与 user 两来源同一 API，节头/排序/截断口径一致。
        const user = await ensureUserSkillsIndex();
        const userHit = user.some((skill) => skill.id === id);
        const bundled = await ensureBundledSkillsIndex();
        if (!userHit && !bundled.some((skill) => skill.id === id)) return null;
        return composeSkillContent(join(userHit ? userSkillsDir : skillsDir, id));
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
  // 方法论索引（R2-S1）：元数据表 = methodologies.json（dynamic 读一次 + 缓存——打包资产
  // 静态）⊕ 用户技能 frontmatter 的 methodology 块（组合：bundled 键序在前——路由优先级；
  // 同名 id 用户覆盖——顶替路由表项并保留 bundled 位置，与索引合并同规（「注明」即
  // origin/user 语义与位置不变可见））× skillsSwitches（运行时开关现读）——
  // 前置门 route 与提示词路由节经晚绑定回填现读。
  let methodologyCache: MethodologyMap | null = null;
  const loadMethodologyMeta = async (): Promise<MethodologyMap> => {
    if (methodologyCache === null) methodologyCache = await loadMethodologies(skillsDir);
    const user = await ensureUserSkillsIndex();
    if (user.every((skill) => skill.methodology === undefined)) return methodologyCache;
    const combined: MethodologyMap = { ...methodologyCache };
    for (const skill of user) {
      if (skill.methodology !== undefined) combined[skill.id] = skill.methodology;
    }
    return combined;
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
      // 0-8 档位硬限（整数；数字 2.0 视为整数 2——Number.isInteger 语义）。
      // 0 = 无上限（允许）；<0 / >8 / 非整 → 400（与 clampMaxParallel 的初值归一解耦：
      // 初值坏值静默归一，POST 显式写入严格校验）。
      if (
        typeof maxParallel !== 'number' ||
        !Number.isInteger(maxParallel) ||
        maxParallel < 0 ||
        maxParallel > 8
      ) {
        throw new HttpError(400, 'maxParallel must be an integer in 0-8');
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

  /**
   * 上下文窗口取窗（三源）：用户显式覆盖 > 网关探测（source:'gateway'）> preset 估算。
   * 探测读取器现读（后台完成前 → null——回退 preset 胚）；detail 注明来源，进
   * GET /api/settings 的 windowDetail；探测失败静默（不惊扰 stats）。
   * 模型名尾标注解析层已取消（2026-08-30 用户裁定）：窗口来源仅三源；模型名
   * `[N]m`/`[N]k` 全链净化（本层 current.model 恒净化名——网关探测按净化名匹配，
   * preset 胚与探测 detail 不变）。
   */
  function effectiveWindow(): { window?: number; detail?: string } {
    if (explicitWindowTokens && current.windowTokens !== undefined) {
      // VT2-1：用户显式 windowTokens 是最高权威——不回学习钳、不被学习注记。
      return { window: current.windowTokens, detail: '用户显式覆盖（settings.windowTokens）' };
    }
    const discovered = deps.windowDiscovered !== undefined ? deps.windowDiscovered() : null;
    if (discovered !== null && discovered.window !== null) {
      return withLearnedCap(
        discovered.window,
        `网关 /models 探测：${discovered.detail ?? '未知来源'}`,
      );
    }
    // E7 学习源（L2）：运行时超限报错 message 明示的窗口——证据密度高于 preset 估算
    //（供应商自证），此时它作为取窗来源本身（无其它源时）。VT2-1：为 run-scoped——
    // 只在「产生该错误的 run」期间驻留（run 结束即清）；显式 windowTokens 分支先行
    // 返回，学习源永不到达（用户权威 > learned，a 条）。
    if (learnedLimitCaps.windowCap !== undefined) {
      return {
        window: learnedLimitCaps.windowCap,
        detail: `由错误学习：${learnedLimitCaps.windowCap}（运行时超限报错 message 解析）`,
      };
    }
    if (current.windowTokens !== undefined) {
      return withLearnedCap(current.windowTokens, '供应商 preset 估算（可在设置覆盖）');
    }
    return {};
  }

  /** E7 学习钳（min）：非用户显式来源（网关探测 / preset 估算）出值后按「由错误学习」
   *  真值钳制（只降不抬；钳到则注记来源）。显式 windowTokens 不经过本函数——
   *  用户权威 > learned（VT2-1 a 条）。 */
  function withLearnedCap(window: number, detail: string): { window: number; detail: string } {
    if (learnedLimitCaps.windowCap !== undefined && learnedLimitCaps.windowCap < window) {
      return {
        window: learnedLimitCaps.windowCap,
        detail: `${detail}；由错误学习：${learnedLimitCaps.windowCap}（超限报错 message 解析）`,
      };
    }
    return { window, detail };
  }

  /**
   * 供应商预设输入上限缺省值（B 档 GET 回填）：按 baseUrl 归一匹配五家 preset；
   * 无匹配（自建网关/第三方端点）→ 主默认 preset。常量取 preset 的
   * contextWindowTokens（估算；说明语见 windowDetail 来源标注——「估算，可在设置覆盖」）。
   */
  function inputTokensPresetOf(baseUrl: string): number {
    return providerPresetOfBaseUrl(baseUrl).contextWindowTokens;
  }

  function settingsResponse(): {
    baseUrl: string;
    model: string;
    apiKey?: string;
    reasoning: ReasoningEffort;
    window?: number;
    windowDetail?: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxInputTokensDefault?: boolean;
    maxOutputTokensDefault?: boolean;
    maxInputTokensClamped?: boolean;
    maxOutputTokensClamped?: boolean;
    modelSanitized?: boolean;
    permission: PermissionPreset;
    permissionConfirmedAt?: number;
    methodFirst: boolean;
    reviewMode: boolean;
  } {
    const response: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      reasoning: ReasoningEffort;
      window?: number;
      windowDetail?: string;
      maxInputTokens: number;
      maxOutputTokens: number;
      maxInputTokensDefault?: boolean;
      maxOutputTokensDefault?: boolean;
      maxInputTokensClamped?: boolean;
      maxOutputTokensClamped?: boolean;
      modelSanitized?: boolean;
      permission: PermissionPreset;
      permissionConfirmedAt?: number;
      methodFirst: boolean;
      reviewMode: boolean;
    } = {
      baseUrl: current.baseUrl,
      model: current.model,
      reasoning: current.reasoning, // C 档：缺省 'medium'
      permission: current.permission, // 权限预设定案：缺省 'workspace-write'
      methodFirst: current.methodFirst, // R2-S1：方法论前置门（缺省 true）
      reviewMode: current.reviewMode, // R2-S2：评审哨兵（缺省 true）
      // A/B 档：输入/输出上限——**恒回显**（必填口径）。存量缺失 → 回填缺省并挂
      // `*Default` 提示键（前端据此提示「已用默认，请修改保存」——不静默；用户保存后
      // 缺省值升格为存量，下次 GET 不再带 Default 键）。
      // 缺省口径：maxOutputTokens = DEFAULT_MAX_TOKENS（8192）；maxInputTokens =
      // 供应商 preset（按当前 baseUrl 匹配；白名单发送仅 DashScope/Qwen）。
      maxInputTokens: current.maxInputTokens ?? inputTokensPresetOf(current.baseUrl),
      maxOutputTokens: current.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      ...(current.maxInputTokens === undefined ? { maxInputTokensDefault: true } : {}),
      ...(current.maxOutputTokens === undefined ? { maxOutputTokensDefault: true } : {}),
      // S 档钳制标记（ADR-0016）：POST 时被钳制（> 供应商上限/窗口）→ 回执 clamped 键；
      // 与 Default 键同族——前端提示「已按 <model> 上限钳制为 N」。仅当被钳制才挂；
      // 未钳制/未触达 → 无键（与 Default 语义一致：缺席 = 无需提示）。
      ...(current.maxInputTokensClamped === true ? { maxInputTokensClamped: true } : {}),
      ...(current.maxOutputTokensClamped === true ? { maxOutputTokensClamped: true } : {}),
      // A 档：存量模型名尾标在读取时被剥离（净化显示）→ 告知前端「已自动校正」一次
      ...(modelSanitizedOnRead ? { modelSanitized: true } : {}),
    };
    if (current.apiKey !== undefined) {
      const masked = maskApiKey(current.apiKey);
      if (masked !== undefined) response.apiKey = masked;
    }
    // 窗口（取窗：用户覆盖 > 网关探测 > preset > 由错误学习；无任何源 → 不带键，前端回退内置估算）
    const windowSource = effectiveWindow();
    if (windowSource.window !== undefined) response.window = windowSource.window;
    if (windowSource.detail !== undefined) response.windowDetail = windowSource.detail;
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
    // A/B 档：输入/输出上限——**必填**（用户强制）：POST 缺任一 → 400
    // code=max-input-output-required；非严格正整数 → 400 code=invalid。
    // 应用语义仍是「触碰」：携带即为当前值（前端恒带；缺省回填值随保存升格为存量）。
    const rawMaxInputTokens = record.maxInputTokens;
    let maxInputTokens: number | undefined;
    if (rawMaxInputTokens !== undefined) {
      if (
        typeof rawMaxInputTokens !== 'number' ||
        !Number.isInteger(rawMaxInputTokens) ||
        rawMaxInputTokens < 1
      ) {
        throw new HttpError(400, 'maxInputTokens must be a positive integer', 'invalid');
      }
      maxInputTokens = rawMaxInputTokens;
    }
    const rawMaxOutputTokens = record.maxOutputTokens;
    let maxOutputTokens: number | undefined;
    if (rawMaxOutputTokens !== undefined) {
      if (
        typeof rawMaxOutputTokens !== 'number' ||
        !Number.isInteger(rawMaxOutputTokens) ||
        rawMaxOutputTokens < 1
      ) {
        throw new HttpError(400, 'maxOutputTokens must be a positive integer', 'invalid');
      }
      maxOutputTokens = rawMaxOutputTokens;
    }
    if (rawMaxInputTokens === undefined || rawMaxOutputTokens === undefined) {
      throw new HttpError(
        400,
        'maxInputTokens and maxOutputTokens are required (positive integers)',
        'max-input-output-required',
      );
    }
    // S 档钳制（ADR-0016）：按当前 baseUrl 匹配 preset——输出 > 供应商上限（有据）→ 钳到
    // 上限 + clampedMaxOutput；输入 > 供应商窗口 → 钳到窗口 + clampedMaxInput；
    // 供应商无上限（无据/模型各异）→ 不钳（运行时「超限报错 → 钳制重试」链兜底）。
    // 契约：**钳制值 = 持久化值**（存的是钳后值——保存即生效；GET 经 clamped 键回执）。
    // 注：provider 以 baseUrl 变更**后**为准（patch 语义——baseUrl 与应用在同一 POST；
    // 下方 application 段先应用 baseUrl，钳制用解析后的 current.baseUrl）。
    let clampedMaxInputOnPost = false;
    let clampedMaxOutputOnPost = false;
    {
      const provider = providerPresetOfBaseUrl(baseUrl ?? current.baseUrl);
      const clamped = clampLimits(
        {
          ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        },
        provider,
      );
      maxInputTokens = clamped.maxInputTokens;
      maxOutputTokens = clamped.maxOutputTokens;
      clampedMaxInputOnPost = clamped.clampedMaxInput;
      clampedMaxOutputOnPost = clamped.clampedMaxOutput;
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
    const rawReviewMode = record.reviewMode;
    if (rawReviewMode !== undefined && typeof rawReviewMode !== 'boolean') {
      throw new HttpError(400, 'reviewMode must be a boolean');
    }
    if (
      baseUrl === undefined &&
      model === undefined &&
      apiKey === undefined &&
      reasoning === undefined &&
      rawWindowTokens === undefined &&
      rawMaxInputTokens === undefined &&
      rawMaxOutputTokens === undefined &&
      rawPermission === undefined &&
      rawConfirmedAt === undefined &&
      rawMethodFirst === undefined &&
      rawReviewMode === undefined
    ) {
      throw new HttpError(400, 'no settings fields provided');
    }
    // 触碰语义：只有被本次 POST 触碰的字段随快照持久化（补丁合并写——未指字段保留现值）
    const touched: {
      reasoning?: boolean;
      windowTokens?: boolean;
      maxInputTokens?: boolean;
      maxOutputTokens?: boolean;
      permission?: boolean;
      permissionConfirmedAt?: boolean;
      methodFirst?: boolean;
      reviewMode?: boolean;
    } = {};
    // 端点/模型/密钥变更 → E7 上限学习清空（旧供应商「由错误学习」的真值对新端点无意义；
    // 端点未变（纯上限/补丁类 POST）→ 学习保留——它是该供应商的稳定真值；
    // 归属 run 一并解除（槽已空——即使正在 run 中的学习也会随后按新端点语义重新记录）。
    if (baseUrl !== undefined || model !== undefined || apiKey !== undefined) {
      learnedLimitCaps = {};
      learnedCapsOwnerRun = undefined;
    }
    if (baseUrl !== undefined) current.baseUrl = baseUrl;
    // 模型名保存即净化（用户实测残留根除）：POST 的 `[N]m/k` 尾标剥离后才应用/持久化/
    // 重探——config 持久化与 GET/下次 run 消费且恒净化名。本编辑器值已换新（用户重新
    // 保存），存量净化位清除（提示语义只针对「历史残留」读取；新保存静默净化）。
    if (model !== undefined) {
      current.model = sanitizeProviderModel(model);
      modelSanitizedOnRead = false;
    }
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
      explicitWindowTokens = true; // 显式设置即锁定（三源取窗：覆盖最高——探测不再顶替）
      touched.windowTokens = true;
    }
    if (maxInputTokens !== undefined) {
      current.maxInputTokens = maxInputTokens;
      current.maxInputTokensClamped = clampedMaxInputOnPost; // 触碰即更新标记（未钳 → 清位）
      touched.maxInputTokens = true;
    }
    if (maxOutputTokens !== undefined) {
      current.maxOutputTokens = maxOutputTokens;
      current.maxOutputTokensClamped = clampedMaxOutputOnPost;
      touched.maxOutputTokens = true;
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
    if (rawReviewMode !== undefined) {
      current.reviewMode = rawReviewMode;
      touched.reviewMode = true;
    }
    if (deps.persistSettings !== undefined) {
      const snapshot: SettingsSnapshot = { baseUrl: current.baseUrl, model: current.model };
      if (current.apiKey !== undefined) snapshot.apiKey = current.apiKey;
      if (touched.reasoning === true) snapshot.reasoning = current.reasoning;
      if (touched.windowTokens === true) snapshot.windowTokens = current.windowTokens as number;
      if (touched.maxInputTokens === true) {
        snapshot.maxInputTokens = current.maxInputTokens as number;
      }
      if (touched.maxOutputTokens === true) {
        snapshot.maxOutputTokens = current.maxOutputTokens as number;
      }
      if (touched.permission === true) snapshot.permission = current.permission;
      if (touched.permissionConfirmedAt === true) {
        snapshot.permissionConfirmedAt = current.permissionConfirmedAt as number;
      }
      if (touched.methodFirst === true) snapshot.methodFirst = current.methodFirst;
      if (touched.reviewMode === true) snapshot.reviewMode = current.reviewMode;
      await deps.persistSettings(snapshot);
    }
    // 网关源重探：baseUrl/apiKey/model 变更后以新端点后台重探（不阻塞响应；
    // 失败静默回退 preset/覆盖；未注入 probeWindow（关闭/测试 deps）→ 不探索）
    if (
      deps.probeWindow !== undefined &&
      (baseUrl !== undefined || model !== undefined || apiKey !== undefined)
    ) {
      void deps
        .probeWindow({ baseUrl: current.baseUrl, apiKey: current.apiKey, model: current.model })
        .catch(() => {
          // 静默：探测失败 → windowDiscovered 保持旧值/回退 preset（不惊扰）
        });
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
          // 错误码（code）只在声明时携带（如 max-input-output-required/invalid——
          // POST /api/settings 的 INPUT/OUTPUT 必填校验）；无码 → 既有 {error} 形状不变
          sendJson(
            res,
            err.status,
            err.code !== undefined
              ? { error: err.message, code: err.code }
              : { error: err.message },
          );
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
    if (method === 'POST' && pathname === '/api/attachments') {
      return handleAttachmentsUpload(req, res);
    }
    if (method === 'GET' && pathname.startsWith('/api/attachments/')) {
      return handleAttachmentsRaw(res, pathname.slice('/api/attachments/'.length));
    }
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
    if (method === 'GET' && pathname === '/api/workspaces') return handleWorkspacesList(res);
    if (method === 'POST' && pathname === '/api/workspaces') return handleWorkspacesAdd(req, res);
    if (method === 'GET' && pathname === '/api/workspaces/browse') {
      return handleWorkspaceBrowse(req, res);
    }
    if (method === 'DELETE' && pathname.startsWith('/api/workspaces/')) {
      return handleWorkspacesDelete(res, pathname.slice('/api/workspaces/'.length));
    }
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
    // 安装端点先于 toggle 匹配（字面 'install' 专属；id='install' 的技能仍可经
    // SkillsIndex.setEnabled 或 GET/其它路径管理——路由字面前置，约定俗成）。
    if (method === 'POST' && pathname === '/api/skills/install') {
      return handleSkillInstall(req, res);
    }
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
