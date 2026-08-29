/**
 * # ui/server/deps：assembleDeps 一次性组装（供 S14 CLI；接缝 S12 接线档）
 *
 * 把真 engine 依赖装配为 createDevmateServer 的 DevmateServerDeps：
 * - 监狱 + 工具面：createJail（workspaceRoot 默认边界）→ createFsTools（六个文件工具）
 *   + createPersistentShell（run_command，常驻 Shell：S10）+ createSkillTool（use_skill）
 *   + createSubagentTool（spawn_subagent）→ defineRegistry 名称分发 → securedRegistry 脱敏；
 *   工具面共 9 个，按会话懒建（createSessionToolsFactory）：use_skill/spawn_subagent 共享一组
 *   （不消费 ctx），**fs 组 + 监狱 + shell 每会话按解析根一组**（多工作区 per-session 根：
 *   workspaceRootOf 读会话 meta（无 meta → 默认根），canonical 一次 realpath——jail 与
 *   shell 同源注入；未注入 = 单根形态用缺省根监狱）；shell 实例按 sessionId 缓存在 Map，
 *   dispose()（serve close 路径）统杀全部会话 shell；
 *   use_skill 的技能索引经**晚绑定引用**（attachSkillsIndex 回填，服务端索引缓存单源）
 *   执行期现读——开关变化即时生效；spawn_subagent 的池 config 闭包同样晚绑定
 *   （attachWorkflowConfig）——POST /api/workflow 后后续 spawn 即时生效；
 *   __fallback__ 兜底注册表**懒构建**（首次访问 tools 才建；构造零实例不计数）；
 *   空闲判据：lastUsedAt（createSessionTools 与每次 execute 都刷新）+ 在飞 execute 计数
 *   + 服务端注入的 activeRunSessions（disposeIdleShells 对活跃 run 会话跳过——TTL 误杀修复）；
 * - 会话：JsonlFileAdapter（缺省 ~/.devmate/sessions）；
 * - LLM：LlmClient（apiKey 直传）+ 供应商 preset（providerId/缺省 DeepSeek）→ wiredLlmAdapter
 *   （S6 传输层重试已含在其内）；**接线不再构造时固定**——createLlm 按
 *   {baseUrl, apiKey} 每次 run 重建（settingsRef 变更即生效；baseUrl 来自 preset 且可被设置覆盖）；
 * - 摘要器：与 run 同一 llm 的五段式摘要调用（buildSummaryPrompt → chat 纯文本 →
 *   extractSummaryContent）；makeSummarizer 导出供逐 run 重建（settings.model 生效）。
 * - 系统提示合成：composeSystemPrompt（base + 技能清单节 + 方法论路由节 + 子代理节 +
 *   任务分解节 + 收尾评审节，预算感知估计 estimateTokens）→ deps.composeSystemPrompt
 *   供 startRun 每次运行前合成（配置变更即时生效；methodFirst:false 经 includeMethodology
 *   排除路由节）；本装配另有子代理池（池级单例，成本护栏/队列/信号量在池内）。
 *
 * 真网络只发生在实际 chat 时（LlmClient 惰性连接）；本模块组装零网络往返。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir, realpath, rm, stat } from 'node:fs/promises';

import type { ConversationSummarizer, SummarizeRequest } from '../../core/context/index.js';
import { estimateTokens, extractSummaryContent } from '../../core/context/index.js';
import type { ReasoningEffort } from '../../shared/llm-types.js';
import { createJail } from '../../core/jail/index.js';
import type { Jail } from '../../core/jail/index.js';
import { LlmClient, getProviderPreset, defaultProviderPreset } from '../../core/llm/index.js';
import type { ProviderId, ProviderPreset } from '../../core/llm/index.js';
import { wiredLlmAdapter } from '../../core/loop/index.js';
import type { LlmAdapter, RunOptions, ToolRegistry } from '../../core/loop/index.js';
import { defineRegistry } from '../../core/loop/index.js';
import { unknownToolResult } from '../../core/loop/tools.js';
import { createSubagentPool } from '../../core/loop/subagent.js';
import type { SubagentPool, SubagentResult } from '../../core/loop/subagent.js';
import { clampMaxParallel, DEFAULT_SUBAGENTS_ENABLED } from '../../shared/workflow.js';
import type { WorkflowConfig } from '../../shared/workflow.js';
import { JsonlFileAdapter } from '../../core/session/index.js';
import type { SessionStore } from '../../core/session/index.js';
import { assertValidSessionId } from '../../core/session/base.js';
import type { ChatMessage } from '../../shared/llm-types.js';
import { createFsTools } from '../../core/tools/index.js';
import { createPersistentShell } from '../../core/tools/shell.js';
import type { PersistentShell } from '../../core/tools/shell.js';
import { securedRegistry } from '../../core/tools/registry.js';
import { createSkillTool } from '../../core/tools/skill.js';
import type { SkillInfo, SkillsIndex } from '../../core/tools/skill.js';
import { createSubagentTool } from '../../core/tools/subagent.js';
import { connectMcpServer, createMcpTools } from '../../core/mcp/index.js';
import type { McpClient, McpClientFactory } from '../../core/mcp/index.js';
import type { Tool } from '../../core/loop/types.js';
import type { MethodologyGate } from '../../core/loop/types.js';
import type {
  MethodologyEntry,
  MethodologyIndex,
  SkillMethodology,
} from '../../shared/methodology.js';
import { deriveTitle, sessionWorkspaceOf } from './emit.js';
import type {
  DevmateServerDeps,
  McpServerConfig,
  PermissionPreset,
  SessionLister,
  SessionSummary,
} from './index.js';

export interface DevmateConfig {
  /** 工作区根：监狱默认边界（启动目录），同时是 run_command 初值 cwd。 */
  workspaceRoot: string;
  /** 工作区注册表初值（多工作区；欠省 [workspaceRoot]。注册值 = canonical 形式，去重保序）。 */
  workspaces?: string[] | undefined;
  /** 会话目录；缺省 ~/.devmate/sessions（每会话一个 <id>.jsonl）。 */
  sessionsDir?: string | undefined;
  /** 用户技能目录；缺省 ~/.devmate/skills（懒建——首装时；**不入 StoredConfig**——CLI 无需改动）。 */
  userSkillsDir?: string | undefined;
  /** 供应商端点；缺省 = preset.baseUrl（LlmClient 惰性连接，组装不触网）。 */
  baseUrl?: string | undefined;
  /** 请求侧模型名（settings.model 初值；POST /api/settings 随时可换）。 */
  model: string;
  /** 供应商 API key（本地端点留空；只经掩码出 GET /api/settings）。 */
  apiKey?: string | undefined;
  /** 供应商 preset id；缺省 = 主默认 deepseek（ADR-0002）。 */
  providerId?: ProviderId | undefined;
  costLimitUsd?: number | undefined;
  maxSteps?: number | undefined;
  windowTokens?: number | undefined;
  /** 思考强度初值（缺省 'medium'——CTO 裁定；设置页可改，persist 走 settings）。 */
  reasoning?: ReasoningEffort | undefined;
  /** 权限预设初值（缺省 'workspace-write'——CTO 裁定；设置页可改，persist 走 settings）。 */
  permission?: PermissionPreset | undefined;
  /** full-access 风险确认记录（可选；前端风险门后写入——纯记录、不强制）。 */
  permissionConfirmedAt?: number | undefined;
  systemPrompt?: string | undefined;
  toolTimeoutMs?: number | undefined;
  /** 空闲 shell TTL（ms；缺省 DEFAULT_IDLE_SHELL_TTL_MS = 600_000）。 */
  idleShellTtlMs?: number | undefined;
  /** Skills 资产目录（缺省 resolve(process.cwd(), 'dist/assets/skills')；不存在 → 空列表）。 */
  skillsDir?: string | undefined;
  /** 工作流配置初值（缺省 {subagentsEnabled:true, maxParallel:2}；maxParallel 夹紧 1-4）。 */
  workflow?: { subagentsEnabled?: boolean; maxParallel?: number } | undefined;
  /** MCP 服务器配置初值（CLI 从 ~/.devmate/config.json 的 mcp 节注入；缺省空表）。 */
  mcpServers?: McpServerConfig[] | undefined;
  /** 测试接缝：替换 connectMcpServer 的连接实现（真实装配不传；假连接固定工具面）。 */
  mcpConnect?: ((spec: McpServerConfig) => Promise<McpClient | null>) | undefined;
  /** 方法论前置门（R2-S1）初值：缺省 true；false = 不注入 RunOptions.methodology（关掉前置门）。 */
  methodFirst?: boolean | undefined;
  /** 评审哨兵（R2-S2）初值：缺省 true；false = startRun 不注入 RunOptions.review（关掉哨兵）。 */
  reviewMode?: boolean | undefined;
}

/** 空闲 shell 回收的缺省 TTL（ms；10 分钟——期间不用的会话 shell 释放，懒重启重建）。 */
export const DEFAULT_IDLE_SHELL_TTL_MS = 600_000;

/** 会话工具工厂输出（assembleDeps 与 E2E 测试共用；shell 每会话独立实例）。 */
export interface SessionToolsFactory {
  /** 缺省会话的注册表（兼容单例形态；任意并发服务在有 createSessionTools 时不用它）。
   *  懒构建：首次访问才建 __fallback__ 壳（构造即建 = 未 spawn 也计数的幽灵实例）。
   *  兜底注册表恒绑定**缺省根**（资产=服务开始时的工作区根）——展示层工具面无会话态。 */
  tools: ToolRegistry;
  /** 按会话懒建注册表：同一 sessionId 恒返回同一对象（含同一 jail/shell/fs 组）；每次调用刷新 lastUsedAt。
   *  多工作区（注入 workspaceRootOf）时按会话解析根——jail 与 shell 同源（per 会话，
   *  S2 的 canonicalWorkspaceRoot 逻辑平移到会话级）；异步（根解析/监狱构造）。 */
  createSessionTools(sessionId: string): Promise<ToolRegistry>;
  /** 杀掉全部会话 shell（幂等）；serve close 路径经 deps.dispose 调用。 */
  dispose(): Promise<void>;
  /** 释放单个会话的 shell 与注册表缓存（幂等）；DELETE /api/sessions/:id 联动。 */
  disposeSession(sessionId: string): Promise<void>;
  /** 释放「非活跃且最近使用超过 idleShellTtlMs」的会话 shell（懒重启：下次使用即重建为干净 shell）。
   *  activeSessionIds = 活跃 run 会话（服务端维护；跳过 = TTL 不误杀运行中 shell）；未传视为空。 */
  disposeIdleShells(now: number, activeSessionIds?: ReadonlySet<string>): Promise<void>;
  /** 常驻 shell 实例数（GET /api/stats 的 activeShells；只含已构建未释放实例）。 */
  activeShellCount(): number;
}

/**
 * 会话工具面（多工作区 per-session 根：jail + fs 组 + shell 每会话按**解析根**构建；
 * use_skill/spawn_subagent 共享各一——无会话态：技能索引经晚绑定引用执行期现读、
 * 子代理池是池级单例）。
 * 工具面共 9 个：6 文件工具 + run_command + use_skill + spawn_subagent。
 * 根解析（workspaceRootOf 注入时）：每会话解一次（读 meta 或默认根，deps 实现按会话缓存）；
 * 解析根经 S2 小修同源化——会话根 canonical 一次 realpath，createJail(canonical)+
 * createPersistentShell(canonical)（字面 != canonical 时字面登记为别名根）；同一 canonical
 * 根的多会话共享监狱与 fs 组（边界同、无会话态）。未注入 workspaceRootOf = 单根形态：
 * 全部会话固定用 options.workspaceRoot 的既有监狱（构造期已建）——兼容回退。
 */
export function createSessionToolsFactory(options: {
  /** 缺省工作区根（canonical 形）；无 workspaceRootOf 注入时 = 全部会话根。 */
  workspaceRoot: string;
  /** 缺省根的监狱（构造期一次建好；无 workspaceRootOf 时的共用监狱 + 兜底注册表）。 */
  jail: Jail;
  toolTimeoutMs?: number;
  /** 空闲 shell TTL（ms；缺省 DEFAULT_IDLE_SHELL_TTL_MS）。 */
  idleShellTtlMs?: number;
  /**
   * 会话 shell 平台透传（真实装配不传 = createPersistentShell 宿主默认；
   * win32 宿主导航经 powershell→cmd→git-bash 探测）。posix = bash 契约，
   * win32 宿主上经 PATH 解析 Git Bash 的 bash.exe 真跑（同 test/shell-tools 口径）。
   */
  shellPlatform?: 'posix' | 'win32';
  /** 测试注入：与 createPersistentShell 同契约的替换工厂（真实装配不传；收到解析后的会话根与监狱）。 */
  createShell?: (sessionId: string, workspaceRoot: string, jail: Jail) => PersistentShell;
  /**
   * 会话根解析（多工作区）：返回该会话的根（读会话 meta 的 workspaceRoot，无 meta →
   * 缺省根；deps 装配实现按会话缓存）。未注入 = 单根形态（全部会话用 options.workspaceRoot）。
   */
  workspaceRootOf?: (sessionId: string) => Promise<string>;
  /** 技能索引读取器（晚绑定：服务端 attach 回填前为 null → use_skill 执行期报 skill-index-unavailable）。 */
  skillsIndex?: () => SkillsIndex | null;
  /** 子代理池（池级单例；缺省 = 恒 disabled 的占位池——只保障工具面形状，真实装配必传）。 */
  subagentPool?: SubagentPool;
}): SessionToolsFactory {
  const idleShellTtlMs = options.idleShellTtlMs ?? DEFAULT_IDLE_SHELL_TTL_MS;
  // use_skill / spawn_subagent：无会话态共享一组（索引执行期现读、池级单例——开关即时生效）
  const skillTool = createSkillTool({ index: options.skillsIndex ?? (() => null) });
  const subagentTool = createSubagentTool({ pool: options.subagentPool ?? disabledPool() });
  const shells = new Map<string, PersistentShell>();
  const sessionBuilds = new Map<string, Promise<ToolRegistry>>();
  /** 持久会话根 → 监狱 + shell 初值 cwd（canonical；多次构建共享——同一根多会话同监狱）。 */
  const rootBuilds = new Map<string, Promise<SessionBuild>>();
  /** 会话 shell 最近使用时间（createSessionTools 与每次 execute 均刷新；空闲回收判据）。 */
  const lastUsedAt = new Map<string, number>();
  /** 在飞 execute 计数（执行中的 shell 兜底豁免：即使活跃集合未覆盖也不释放）。 */
  const executing = new Map<string, number>();

  const makeShell = (sessionId: string, root: string, jail: Jail): PersistentShell =>
    options.createShell !== undefined
      ? options.createShell(sessionId, root, jail)
      : createPersistentShell({
          workspaceRoot: root,
          jail,
          ...(options.toolTimeoutMs !== undefined ? { timeoutMs: options.toolTimeoutMs } : {}),
          ...(options.shellPlatform !== undefined ? { platform: options.shellPlatform } : {}),
        });

  const makeRegistry = (sessionId: string, jail: Jail, root: string): ToolRegistry => {
    // fs 工具 per 会话（jail 构造期闭包绑定——会话根不同监狱不同，不能跨会话共享）
    const fsTools = createFsTools({ sessionId, jail });
    let shell = shells.get(sessionId);
    if (shell === undefined) {
      shell = makeShell(sessionId, root, jail);
      shells.set(sessionId, shell);
    }
    const base = securedRegistry(
      defineRegistry([...fsTools, shell.tool, skillTool, subagentTool], { sessionId }),
    );
    // 包装 execute：① 在飞计数（执行中的 shell 绝不空闲回收）② 每次 execute 起止刷新
    // lastUsedAt（TTL 判据更精确——长 run 内多次工具调用不会触发误杀）
    return {
      list: () => base.list(),
      async execute(call) {
        executing.set(sessionId, (executing.get(sessionId) ?? 0) + 1);
        try {
          return await base.execute(call);
        } finally {
          const next = (executing.get(sessionId) ?? 1) - 1;
          if (next <= 0) executing.delete(sessionId);
          else executing.set(sessionId, next);
          lastUsedAt.set(sessionId, Date.now());
        }
      },
    };
  };

  const buildForRoot = (rootLiteral: string): Promise<SessionBuild> => {
    const cached = rootBuilds.get(rootLiteral);
    if (cached !== undefined) return cached;
    const built = (async (): Promise<SessionBuild> => {
      // 缺省根（装配期已按 canonical 建过监狱）直接复用——S2 拼写一致（字面别名已登记）
      if (rootLiteral === options.workspaceRoot) {
        return { jail: options.jail, root: options.workspaceRoot };
      }
      // S2 小修的 per-session 版：canonical 一次解析，jail 与 shell 同源；字面 != canonical
      // 时把字面登记为额外别名根（模型按调用方视角给字面路径不再「字面越界」）
      const canonical = await realpath(rootLiteral);
      const jail = await createJail({
        workspaceRoot: canonical,
        ...(rootLiteral !== canonical ? { extraRoots: [rootLiteral] } : {}),
      });
      return { jail, root: canonical };
    })();
    rootBuilds.set(rootLiteral, built);
    return built;
  };

  const forId = (sessionId: string): Promise<ToolRegistry> => {
    // 每次使用会话工具（run 开始/继续）刷新：该会话 shell 视为活跃
    lastUsedAt.set(sessionId, Date.now());
    const existing = sessionBuilds.get(sessionId);
    if (existing !== undefined) return existing;
    const built = (async (): Promise<ToolRegistry> => {
      // 会话根解析：workspaceRootOf（meta 或默认根；deps 实现按会话缓存）或缺省根——
      // jail 与 shell 同源（解析后的会话根，非固定全局根）
      const rootLiteral =
        options.workspaceRootOf !== undefined
          ? await options.workspaceRootOf(sessionId)
          : options.workspaceRoot;
      const { jail, root } = await buildForRoot(rootLiteral);
      return makeRegistry(sessionId, jail, root);
    })();
    // 构建失败（根不可解析等）：不让失败承诺污染缓存——下次调用重建（与 execute 无关）
    built.catch(() => {
      if (sessionBuilds.get(sessionId) === built) sessionBuilds.delete(sessionId);
    });
    sessionBuilds.set(sessionId, built);
    return built;
  };

  const disposeSession = async (sessionId: string): Promise<void> => {
    lastUsedAt.delete(sessionId);
    sessionBuilds.delete(sessionId);
    const shell = shells.get(sessionId);
    if (shell === undefined) return;
    shells.delete(sessionId);
    await shell.dispose();
  };

  let fallbackRegistry: ToolRegistry | undefined;
  return {
    // 懒构建：构造即建 __fallback__ 会留下「未 spawn 但计数」的幽灵实例（stats 启动为 0）；
    // 兜底注册表绑定缺省根监狱（不做 per-session 解析——展示层工具面）
    get tools(): ToolRegistry {
      if (fallbackRegistry === undefined) {
        fallbackRegistry = makeRegistry('__fallback__', options.jail, options.workspaceRoot);
        lastUsedAt.set('__fallback__', Date.now());
      }
      return fallbackRegistry;
    },
    createSessionTools: forId,
    async dispose(): Promise<void> {
      const all = [...shells.values()];
      shells.clear();
      sessionBuilds.clear();
      lastUsedAt.clear();
      executing.clear();
      for (const shell of all) await shell.dispose();
    },
    disposeSession,
    async disposeIdleShells(now: number, activeSessionIds?: ReadonlySet<string>): Promise<void> {
      const victims = [...lastUsedAt.entries()]
        .filter(([sessionId, usedAt]) => {
          // 活跃 run 会话：绝不回收（TTL 判据只覆盖 run 启动时刻，审批等待/900s 超时
          // 都可能超过 idleShellTtlMs——运行中的 shell 被 tick 杀掉 = 误杀）
          if (activeSessionIds !== undefined && activeSessionIds.has(sessionId)) return false;
          // 在飞 execute 兜底豁免（与活跃集合双保险）
          if ((executing.get(sessionId) ?? 0) > 0) return false;
          return now - usedAt > idleShellTtlMs;
        })
        .map(([sessionId]) => sessionId);
      for (const sessionId of victims) await disposeSession(sessionId);
    },
    activeShellCount: () => shells.size,
  };
}

/** per-根构建结果：监狱（canonical 边界，含字面别名）+ shell 初值 cwd（canonical）。 */
interface SessionBuild {
  jail: Jail;
  root: string;
}

/**
 * 会话列表数据源（deps 注入给服务端；fs 目录扫描只出现在本装配层——服务端不直接 fs）。
 * <dir>/<id>.jsonl 逐个扫描；标题 = 首条 user 事件前 40 字符（deriveTitle；中文按字符）或
 * （空会话）；createdAtMs/lastEventMs 来自事件 ts，空文件回退 mtime；单会话读取失败跳过
 * 不拖垮整表（容错读与 JsonlFileAdapter 同口径）。
 */
export function makeSessionLister(options: { store: SessionStore; dir: string }): SessionLister {
  return async (): Promise<SessionSummary[]> => {
    let names: string[];
    try {
      names = await readdir(options.dir);
    } catch {
      return [];
    }
    const summaries: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      try {
        assertValidSessionId(sessionId);
      } catch {
        continue; // 非会话命名的文件（临时/垃圾）不进列表
      }
      let statMs = 0;
      try {
        statMs = (await stat(join(options.dir, name))).mtimeMs;
      } catch {
        continue; // 读取中途被删：跳过
      }
      let firstUser: string | undefined;
      let createdAtMs = 0;
      let lastEventMs = 0;
      let stepCount = 0;
      // A 档：会话所属项目文件夹（首条 session-workspace meta；旧会话/畸形 → null）
      let workspaceRoot: string | null = null;
      try {
        for await (const ev of options.store.events(sessionId)) {
          if (workspaceRoot === null) workspaceRoot = sessionWorkspaceOf(ev);
          if (createdAtMs === 0) createdAtMs = ev.ts;
          lastEventMs = ev.ts;
          if (ev.kind === 'user' && firstUser === undefined) firstUser = ev.payload.content;
          if (ev.kind === 'assistant') stepCount += 1;
        }
      } catch {
        continue;
      }
      summaries.push({
        sessionId,
        title: deriveTitle(firstUser),
        createdAtMs: createdAtMs !== 0 ? createdAtMs : statMs,
        lastEventMs: lastEventMs !== 0 ? lastEventMs : statMs,
        stepCount,
        workspaceRoot,
      });
    }
    return summaries;
  };
}

/** 与 run 同一 llm 的摘要器：五段式指令 → 纯文本回包 → <summary> 抽取。 */
export function makeSummarizer(llm: LlmAdapter, model: string): ConversationSummarizer {
  return async (request: SummarizeRequest): Promise<string> => {
    const messages: ChatMessage[] = [
      { role: 'system', content: request.prompt },
      ...request.messages,
    ];
    let raw = '';
    for await (const ev of llm.chat({ model, messages })) {
      if (ev.type === 'text') raw += ev.text;
    }
    return extractSummaryContent(raw);
  };
}

// ---------------------------------------------------------------------------
// MCP 接线（McpLauncher + 工具面合并；契约见 core/mcp/registry.ts 头注接线节）
// ---------------------------------------------------------------------------

/**
 * MCP 启动器（registry.ts 头注的 McpLauncher 接线实现）：
 * - `clients()` 按**当前配置**（晚绑定 getter——服务端 POST /api/mcp 开关/追加即时生效）
 *   构建 name → 工厂的 Map：enabled=false → 工厂返回 null（registry 不产生工具）；
 *   已从配置消失/被禁用的服务器 → 其已连客户端被关闭移除（不残留子进程）。
 * - 懒连接（registry 首次枚举/execute 期调用工厂）：相同 name 复用同一已连客户端
 *   （一次一个子进程；连接失败/服务器死亡按 registry 的负缓存重连语义处理）。
 *   同时在飞连接去重（并发组装共享一次连接尝试）。
 * - `assemble()`：创建本面 MCP 工具（createMcpTools）并记录工具数（stats 的 mcpTools）。
 * - `dispose()`：关闭全部已连客户端与在飞连接的收尾；幂等；任何错误不 throw。
 */
export class McpLauncher {
  /** name → 已下发且仍存活的客户端（跨组装复用；dispose 关闭；同一 name 永远同一 spec）。 */
  private readonly live = new Map<string, McpClient>();
  /** name → 在飞连接尝试（并发组装去重；一次一个连接过程）。 */
  private readonly inFlight = new Map<string, Promise<McpClient | null>>();
  private disposed = false;
  /** 最近一次 assemble 的 mcp 工具数（stats 的 mcpTools；未组装过 = 0）。 */
  private lastToolCount = 0;

  constructor(
    private readonly options: {
      /** 当前 MCP 配置读取器（晚绑定；assembleDeps 以 attachMcpConfig 回填服务端实况）。 */
      configs: () => readonly McpServerConfig[];
      /** 连接实现（缺省 connectMcpServer；测试注入假连接）。 */
      connect?: (spec: McpServerConfig) => Promise<McpClient | null>;
    },
  ) {}

  /** 当前配置快照（name 主键：同名后写覆盖——同一 name 永远同一 spec）。 */
  currentServers(): McpServerConfig[] {
    const byName = new Map<string, McpServerConfig>();
    for (const spec of this.options.configs()) byName.set(spec.name, spec);
    return [...byName.values()];
  }

  /** name → 客户端工厂（enabled=false → null；registry 名称分发 map）。 */
  clients(): Map<string, McpClientFactory> {
    const servers = this.currentServers();
    const enabledNames = new Set(servers.filter((s) => s.enabled).map((s) => s.name));
    // 已关闭/已删除的服务器：摘除并关闭其连接（尽力而为的异步收尾；不阻塞本面构建）
    for (const [name, client] of this.live) {
      if (!enabledNames.has(name)) {
        this.live.delete(name);
        void safeCloseClient(client);
      }
    }
    const map = new Map<string, McpClientFactory>();
    for (const spec of servers) {
      map.set(spec.name, () => this.clientFor(spec));
    }
    return map;
  }

  /** 组装一次 MCP 工具面（连接失败 → 0 工具；createMcpTools 永不 throw）。 */
  async assemble(): Promise<Tool[]> {
    if (this.disposed) return [];
    const tools = await createMcpTools({ clients: this.clients() });
    this.lastToolCount = tools.length;
    return tools;
  }

  /** 最近一次组装的 mcp 工具数（GET /api/stats 的 mcpTools）。 */
  toolCount(): number {
    return this.lastToolCount;
  }

  /** 关闭全部客户端（含在飞连接收尾）；幂等；任何错误不 throw。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const all = [...this.live.values()];
    this.live.clear();
    for (const client of all) await safeCloseClient(client);
    // 在飞连接：等待出炉后收尾（不残留子进程——tryConnect 见 disposed 即关闭并返回 null）
    const pending = [...this.inFlight.values()];
    for (const attempt of pending) {
      const client = await attempt.catch(() => null);
      await safeCloseClient(client);
    }
  }

  /** 单台服务器的工厂实现：disabled/disposed → null；复用活着连接；否则连接一次。 */
  private async clientFor(spec: McpServerConfig): Promise<McpClient | null> {
    if (this.disposed || !spec.enabled) return null;
    const live = this.live.get(spec.name);
    if (live !== undefined && !live.isDead()) return live;
    const pending = this.inFlight.get(spec.name);
    if (pending !== undefined) return pending;
    const attempt = this.tryConnect(spec);
    this.inFlight.set(spec.name, attempt);
    try {
      return await attempt;
    } finally {
      this.inFlight.delete(spec.name);
    }
  }

  /** 连接并登记；失败/连接期间被禁用或 disposed → null（registry 据此负缓存重试）。 */
  private async tryConnect(spec: McpServerConfig): Promise<McpClient | null> {
    let client: McpClient | null = null;
    try {
      client =
        this.options.connect !== undefined
          ? await this.options.connect(spec)
          : await connectMcpServer(spec);
    } catch {
      client = null; // 连接失败不 throw：registry 负缓存生效
    }
    if (client === null) return null;
    const stillEnabled = this.currentServers().some((s) => s.name === spec.name && s.enabled);
    if (this.disposed || !stillEnabled) {
      await safeCloseClient(client);
      return null;
    }
    this.live.set(spec.name, client);
    return client;
  }
}

/** 关闭客户端（不 throw；close 本身幂等——transport close 共享一次收尾）。 */
async function safeCloseClient(client: McpClient | null): Promise<void> {
  if (client === null) return;
  try {
    await client.close();
  } catch {
    // 尽力而为：close 失败不炸工具面/关闭路径
  }
}

/**
 * 合并 MCP 工具面：基础注册表（fs/shell/use_skill/spawn_subagent）+ mcp 工具（追加在后，
 * 同表——list 全量给模型与 GET /api/tools）；execute 按名分发（mcp 前缀 `mcp_*` 无冲突）；
 * 未知工具按 full list 回注；整体再经 securedRegistry 脱敏（base 路径幂等）。
 * mcp 为 0 时返回 base 本身（观察者/脱敏装饰环零扰动）。
 */
export function mergeMcpTools(
  base: ToolRegistry,
  mcpTools: readonly Tool[],
  sessionId: string,
): ToolRegistry {
  if (mcpTools.length === 0) return base;
  const mcpRegistry = defineRegistry(mcpTools, { sessionId });
  const baseNames = new Set(base.list().map((d) => d.name));
  const mcpNames = new Set(mcpTools.map((t) => t.name));
  const merged: ToolRegistry = {
    list: () => [
      ...base.list(),
      ...mcpTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? {},
      })),
    ],
    async execute(call) {
      if (mcpNames.has(call.name)) return mcpRegistry.execute(call);
      if (baseNames.has(call.name)) return base.execute(call);
      return unknownToolResult(call.name, [...baseNames, ...mcpNames]);
    },
  };
  return securedRegistry(merged);
}

// ---------------------------------------------------------------------------
// 方法论语义版（R2-S1：keyword 命中路由 + 前置门装配）
// ---------------------------------------------------------------------------

/** 路由条目（语义版）：id + 触发词集合（meta.trigger 按 / 拆）。entries 顺序 = 优先级。 */
export interface MethodologyRouteEntry {
  id: string;
  triggers: readonly string[];
}

/** 触发词拆分（meta.trigger：`修复 bug/新增功能` → ['修复 bug','新增功能']；trim/去空）。 */
export function splitMethodologyTriggers(trigger: string | undefined): string[] {
  if (trigger === undefined || trigger === '') return [];
  return trigger
    .split('/')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/**
 * 纯匹配（单元测试面）：任务文本大小写与空白无关地扫触发词——
 * 归一化（去全部空白 + lowercase）后任一触发词为子串即命中；多命中按 entries
 * 顺序先得先回（**优先级 = 数组顺序**）；无命中 → null。
 */
export function matchMethodologyTask(
  task: string,
  entries: readonly MethodologyRouteEntry[],
): string | null {
  const normalizedTask = task.toLowerCase().replace(/\s+/g, '');
  for (const entry of entries) {
    for (const trigger of entry.triggers) {
      const normalizedTrigger = trigger.toLowerCase().replace(/\s+/g, '');
      if (normalizedTrigger !== '' && normalizedTask.includes(normalizedTrigger)) return entry.id;
    }
  }
  return null;
}

/** 前置门的缺省容器（过程级；同一服务端实例跨 run 共享——加载状态跨 run 保持）。 */
export interface MethodologyLoadedStore {
  of(sessionId: string): Set<string>;
}

/**
 * 前置门装配（语义版）：route 从晚绑定 MethodologyIndex 现读（开关变化即时生效；
 * 索引未回填 → 不命中），匹配用 matchMethodologyTask 关键词命中（纯函数）。
 * isLoaded/markLoaded 是纯状态查询（观察器由主循环在对 use_skill 成功执行时调用）。
 */
export function createMethodologyGate(options: {
  index: () => MethodologyIndex | null;
  loaded?: MethodologyLoadedStore;
}): MethodologyGate {
  const loaded: MethodologyLoadedStore =
    options.loaded ??
    (() => {
      const sessions = new Map<string, Set<string>>();
      const store: MethodologyLoadedStore = {
        of(sessionId) {
          let set = sessions.get(sessionId);
          if (set === undefined) {
            set = new Set();
            sessions.set(sessionId, set);
          }
          return set;
        },
      };
      return store;
    })();
  return {
    async route(task): Promise<string | null> {
      const index = options.index();
      if (index === null) return null;
      let entries: readonly MethodologyEntry[];
      try {
        entries = await index.list();
      } catch {
        return null; // 索引读取故障 → 不路由（门安静关闭，不干扰 run）
      }
      const table: MethodologyRouteEntry[] = entries
        .filter(
          (
            entry,
          ): entry is MethodologyEntry & { methodology: SkillMethodology & { trigger: string } } =>
            entry.enabled &&
            entry.methodology.type === 'method' &&
            typeof entry.methodology.trigger === 'string' &&
            entry.methodology.trigger !== '',
        )
        .map((entry) => ({
          id: entry.id,
          triggers: splitMethodologyTriggers(entry.methodology.trigger),
        }));
      return matchMethodologyTask(task, table);
    },
    isLoaded(sessionId, id) {
      return loaded.of(sessionId).has(id);
    },
    markLoaded(sessionId, id) {
      loaded.of(sessionId).add(id);
    },
  };
}

// ---------------------------------------------------------------------------
// 系统提示词合成（base + 技能清单节 + 方法论路由节 + 子代理节；预算感知）
// ---------------------------------------------------------------------------

/**
 * 基础系统提示（config.systemPrompt 未提供时的中文起草；writing-for-agents 重写定稿）。
 * 锚定词（正文与注释重复使用，锚定行为主题）：
 * - 「界内」＝行为边界：操作都在工作区之内，越界（含重定向写入界外）先被拒、按拒因换
 *   界内路径——边界说「换路径」，不是「找绕过」。
 * - 「小步闭环」＝每一步 查证 → 执行 → 回注 → 验证，完成判据可检查（重读/diff/针对性测试）。
 * - 「失败是普通消息」＝错误回注自愈：失败与拒绝都是信息而非事故（与熔断成对，CONTEXT 规则）。
 * - 「报告口径」＝终止条件由环境裁定并报告（报告口径），模型只负责自然结束。
 * 单一真源纪律：不列工具清单（工具面与错误回注的可用清单由环境注入）、不抄参数默认值
 * （超时/截断/预算数值归工具说明与 composeSystemPrompt 的预算裁剪），本基座只讲使用策略。
 * 预算：base 估算 ≤ 1800 tokens（裁剪链只裁技能清单，base 永不裁——安全与行为规则优先，
 * 见 composeSystemPrompt；上限 4096 归那里的预算常量）。
 */
export const DEV_BASE_SYSTEM_PROMPT = `你是 DevMate，一个运行在用户本机工作区里的编程智能体：用户给出一个编程任务，你自主读写文件、执行命令并反复思考，直至完成或就关键决策向用户提问。工作方式三个锚：界内动、小步闭环、失败是普通消息。

## 如何工作
每轮一个小步闭环：查证 → 执行 → 回注 → 验证。
- 查证先于动手：现状以工具结果为准——先读文件、列目录、搜关键字，改动前先确认对象当前的样子；一轮一个小目标。
- 执行一次只动一处：文件改一处、命令跑一个目标；同轮多工具并行、结果按序回注，有依赖就等前一个回注再继续。
- 每个结果必读：成功读内容，失败读回注的 type/message——按它建议的下一步调整，或结束工具调用。
- 每次修改有可检查的验证：重读改动处、跑针对性测试或构建、有版本控制时先看自己的 git diff 确认改动在预期范围。

## 边界与安全
- 界内是行为边界：文件与命令操作都在界内进行；越界访问（含命令重定向写入界外）会被拒绝并附拒因——按拒因换界内路径；路径是否可行先问边界，不凭想象找路。
- 命令跑在常驻 shell：cwd、环境与后台进程在命令间保持；会话是非交互的，命令要能自己完成——交互程序（vim/less/密码提示）缺 stdin 输入只会挂到超时，改用非交互用法或后台进程；命令超时即被杀、已捕获输出照常回注，需要长时间先申请加时（上限以工具说明为准）；超时后的下一次调用从全新会话开始（cwd 回到工作区根）。
- 输出可能被截断：只见头尾与省略标记时，只按可见内容继续——把目标改小（更窄的查询、更小的改写）再看，中间部分不以想象补全。
- 用户随时可中断：中断后环境从现场继续，效果未知的调用会如实标记，你按标记重新探测即可。
- 陈述有据：一切内容来自工具结果与用户消息，证据不足时先补查询再下结论。

## 错误回注与审批
- 失败是普通消息：{ok:false, error:{type,message}} 表示该次调用未生效——它是信息而非事故；按 message 与其中附带的可用清单（工具/技能）调整后重试，或结束工具调用。
- 一次失败调整一次，仍失败就换路径：同一处再失败就改换更小目标或另一条路；同类失败连续命中是环境的熔断信号——环境替你收手并向用户报告原因。
- 审批出现时：带理由拒绝 → 拒因作普通消息，按它调整继续；无理由拒绝 → 用户中止本轮，本轮不再发起动作。

## 终止条件
- 你的自然结束：任务完成、或需要用户决策时——以一条不带工具调用的回复结束本轮（报告口径下的自然结束）。
- 预算、步数、墙钟与熔断由环境裁定：命中即收尾、并按报告口径向用户报告原因——你只管把任务做小步闭环到验证通过，不必自己停表、也无须绕护栏。
- 收尾回复与报告一并呈现：任务未完成而结束时，写明已完成、未完成与下一步。`;

/** 系统提示合成预算（token；技能清单按序合并，超预算从清单尾部裁减——base 永不裁）。 */
export const DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS = 4096;

/** 技能清单一行（`- <name>（<summary>）`；id 与 name 不同时附 id——use_skill 按 id 加载）。 */
export function skillListLine(entry: SkillInfo): string {
  const line = `${entry.name}（${entry.summary === '' ? '无摘要' : entry.summary}）`;
  return entry.id === entry.name ? line : `${line} [id=${entry.id}]`;
}

export interface ComposeSystemPromptOptions {
  /** 基础系统提示；缺省 DEV_BASE_SYSTEM_PROMPT（中文起草）。 */
  basePrompt?: string;
  /** 技能索引读取器（晚绑定；null = 未回填 → 本节省略）。 */
  skills: () => SkillsIndex | null;
  /** 工作流实时配置读取器（改 workflow 配置后再次合成即生效）。 */
  workflow: () => WorkflowConfig;
  /** 方法论索引读取器（R2-S1；null = 未注入 → 本节省略——老装配/纯测试路径）。 */
  methodologies?: (() => MethodologyIndex | null) | undefined;
  /** 方法论路由节开关（R2-S1：缺省 true；methodFirst:false → 本节省略——节随门同关）。 */
  includeMethodology?: boolean | undefined;
  /** 系统提示 token 预算；缺省 DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS。 */
  budgetTokens?: number;
}

/**
 * 合成系统提示：基础提示 + 技能清单节（enabled skills 一行一条，末尾「需要时
 * use_skill 加载全文」，懒加载语义）+ 方法论路由节（R2-S1：method 型技能一行一条
 * `<trigger> → <id>` + 三行规则；≤ METHODOLOGY_SECTION_TOKEN_BUDGET，超出删 trigger
 * 最长的行）+ 子代理节（workflow.subagentsEnabled 时）。
 * 预算感知：以 estimateTokens（复用核心估算器，system 角色按散文口径）计量合成结果，
 * 超预算逐行裁技能清单尾部（保 base——base 是安全与行为规则，优先于技能列表）。
 */
export async function composeSystemPrompt(options: ComposeSystemPromptOptions): Promise<string> {
  const base = options.basePrompt ?? DEV_BASE_SYSTEM_PROMPT;
  const workflow = options.workflow();
  const budgetTokens = options.budgetTokens ?? DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS;

  let skillLines: string[] = [];
  const index = options.skills();
  if (index !== null) {
    const list = await index.list();
    skillLines = list.filter((skill) => skill.enabled).map(skillListLine);
  }

  let routeLines: string[] = [];
  const includeMethodology = options.includeMethodology ?? true;
  const methodology =
    options.methodologies === undefined || !includeMethodology ? null : options.methodologies();
  if (methodology !== null) {
    let entries: readonly MethodologyEntry[] = [];
    try {
      entries = await methodology.list();
    } catch {
      entries = [];
    }
    routeLines = entries
      .filter(
        (entry) =>
          entry.enabled &&
          entry.methodology.type === 'method' &&
          entry.methodology.trigger !== undefined &&
          entry.methodology.trigger !== '',
      )
      .map((entry) => `- ${entry.methodology.trigger} → ${entry.id}`);
  }

  let composed = assembleSystemPrompt(base, skillLines, routeLines, workflow);
  while (
    estimateTokens([{ role: 'system', content: composed }]).tokens > budgetTokens &&
    skillLines.length > 0
  ) {
    // 超出预算：从清单尾部逐行裁（清单 id 序确定性——每次结果可复现）
    skillLines = skillLines.slice(0, -1);
    composed = assembleSystemPrompt(base, skillLines, routeLines, workflow);
  }
  return composed;
}

/** 方法论路由节字符串（节内独立预算：≤ METHODOLOGY_SECTION_TOKEN_BUDGET 时全量，
 *  超出从 trigger 最长的行开始裁——裁剪策略契约；供 compose 与单测共用）。
 *  确定性：长度并列时删第一个出现的最长行；其余行相对顺序不变——同输入必同输出。 */
export function methodologyRouteSection(routeLines: readonly string[]): string {
  let lines = [...routeLines];
  const build = (ls: readonly string[]): string =>
    ls.length === 0 ? '' : ['## 方法论路由', ...ls, ...METHODOLOGY_ROUTE_RULES].join('\n');
  while (
    lines.length > 0 &&
    estimateTokens([{ role: 'system', content: build(lines) }]).tokens >
      METHODOLOGY_SECTION_TOKEN_BUDGET
  ) {
    let longest = 0;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]!.length > lines[longest]!.length) longest = i;
    }
    lines = [...lines.slice(0, longest), ...lines.slice(longest + 1)];
  }
  return build(lines);
}

/** 路由节内 token 预算（≤350；超出删 trigger 最长的行——裁剪策略见 methodologyRouteSection）。 */
export const METHODOLOGY_SECTION_TOKEN_BUDGET = 350;

/** 路由节固定规则三行（亮牌 / 先加载 / 收尾判据）。 */
const METHODOLOGY_ROUTE_RULES = [
  '规则：',
  '- 第一步先亮牌：首条回复首行以 `方法线：<id>` 开头（报告口径）。',
  '- 触发命中时，首个工具调用前先 use_skill 加载该技能全文；组内含 use_skill(<id>) 即放行。',
  '- 收尾按该技能的 done 判据逐条陈述完成情况（与报告口径一致）。',
];

/**
 * 「## 任务分解」节（R2-S2：并行/直连/评审三原则；固定小节——合成期并入，估算 ≤150 tokens）。
 * 并行上限 2 与子代理节上限（workflow.maxParallel）择一原则——按提示词层常量固定。
 */
export const TASK_DECOMPOSITION_SECTION = `## 任务分解
- 并行原则：独立的事实探索、互不依赖的子任务可并行 spawn_subagent（上限 2）。
- 直连原则：短链与依赖链顺序直连，一次一步小步闭环，不拆过小。
- 评审原则：见「收尾评审」节。`;

/**
 * 「## 收尾评审」节（R2-S2：独立审查前置规则；固定小节——合成期并入，估算 ≤120 tokens）。
 * 规则一句带四拍（实质变更才需要 → 审查子代理视角 → 先修复或说明 → 报告附注）。
 */
export const REVIEW_SENTINEL_SECTION = `## 收尾评审
实质变更任务（改文件、命令、MCP、子代理）收尾前，除非用户明确说跳过：spawn_subagent 独立审查一次（prompt 含 review 或「审查」），列缺陷与放行理由（≤400 字），先修复或说明再收尾；报告附「独立审查：有/无（原因）」。`;

/** 多节装配：base \\n\\n 技能清单节（有 enabled 技能时）\\n\\n 方法论路由节（method 型命中表时）
 * \\n\\n 子代理节（subagentsEnabled 时）\\n\\n 任务分解节（常驻）\\n\\n 收尾评审节（常驻）。
 * 路由节自身已按 METHODOLOGY_SECTION_TOKEN_BUDGET 裁剪过（超预算删 trigger 最长的行；
 * routeLines 为空 → 整节省略）；任务分解/收尾评审为固定小节（预算裁剪链之外）。 */
function assembleSystemPrompt(
  base: string,
  skillLines: readonly string[],
  routeLines: readonly string[],
  workflow: WorkflowConfig,
): string {
  const sections: string[] = [base.trim()];
  if (skillLines.length > 0) {
    sections.push(
      [
        '## 可用技能',
        ...skillLines.map((line) => `- ${line}`),
        '需要时用 use_skill 加载全文。',
      ].join('\n'),
    );
  }
  const routeSection = methodologyRouteSection(routeLines);
  if (routeSection !== '') sections.push(routeSection);
  if (workflow.subagentsEnabled) {
    sections.push(
      `## 子代理\n对于可独立处理的子任务，可调用 spawn_subagent（并行上限 ${workflow.maxParallel}）` +
        `以隔离上下文；报告最多 4k 字符。`,
    );
  }
  // R2-S2 固定小节（任务分解 + 收尾评审——与 workflow 开关无关：规则是提示词层常驻）
  sections.push(TASK_DECOMPOSITION_SECTION);
  sections.push(REVIEW_SENTINEL_SECTION);
  return sections.join('\n\n');
}

/**
 * 恒 disabled 的占位池（createSessionToolsFactory 未注入真实池时的形状兜底）：
 * spawn 立即 'subagents-disabled'（绝不触网）——真实装配（assembleDeps）必传真池。
 */
function disabledPool(): SubagentPool {
  const disabled: SubagentResult = {
    ok: false,
    report: '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    estimated: false,
    durationMs: 0,
    error: 'subagents-disabled',
  };
  return {
    spawn: () => Promise.resolve(disabled),
    stats: () => ({
      enabled: false,
      maxParallel: 0,
      active: 0,
      queued: 0,
      completed: 0,
      rejected: 0,
    }),
    dispose: () => {},
  };
}

function defaultSessionsDir(): string {
  return join(homedir(), '.devmate', 'sessions');
}

/** 缺省用户技能目录（~/.devmate/skills；与 sessions 同族——CLI 无需配置即可用）。 */
export function defaultUserSkillsDir(): string {
  return join(homedir(), '.devmate', 'skills');
}

/** 去重保序（工作区注册表：首次出现顺序保留；重复值只留首见）。 */
export function dedupeKeepOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 一次性组装（自备依赖测试全部用假；这里只装真件、零网络往返）。 */
export async function assembleDeps(config: DevmateConfig): Promise<DevmateServerDeps> {
  // S2 小修：工作区根一致化——装配时一次 realpath 解析出 canonical 根，jail 与 shell
  // 初值 cwd 同源注入（软链/大小写拼写差异下 read 放行与 run_command pwd 判定统一；
  // 会话 meta（deps.workspaceRoot）仍用调用方字面拼写——展示层归属面不因规范化漂移）。
  // 字面拼写保留：canonical != 原字面（软链工作区）时，把原字面登记为额外别名根——
  // jail 双端判定对「字面端」与「真实端」都命中边界（与边界根本身即软链的历史语义一致：
  // 模型按调用方视角给字面路径也不再被「字面越界」拦截）。
  const canonicalWorkspaceRoot = await realpath(config.workspaceRoot);
  const jail = await createJail({
    workspaceRoot: canonicalWorkspaceRoot,
    ...(config.workspaceRoot !== canonicalWorkspaceRoot
      ? { extraRoots: [config.workspaceRoot] }
      : {}),
  });
  const sessionsDir = config.sessionsDir ?? defaultSessionsDir();

  const store = new JsonlFileAdapter({ dir: sessionsDir });

  // Workflow 晚绑定接缝：服务端启动时经 attach 回填（读取器/索引实现）——技能开关与
  // 工作流配置（POST /api/skills|workflow）在服务端变更，工具/池/提示词合成经此现读。
  const skillsRef: { index: SkillsIndex | null } = { index: null };
  const workflowRef: { get: (() => WorkflowConfig) | null } = { get: null };
  // 方法论索引晚绑定（R2-S1）：服务端 attachMethodologyIndex 回填（元数据 × 运行时开关的
  // 单源在服务端缓存）；前置门 route 与提示词路由节经此现读——开关变化即时生效。
  const methodologyRef: { index: MethodologyIndex | null } = { index: null };
  const methodologyGate = createMethodologyGate({ index: () => methodologyRef.index });
  const initialWorkflow: WorkflowConfig = {
    subagentsEnabled: config.workflow?.subagentsEnabled ?? DEFAULT_SUBAGENTS_ENABLED,
    maxParallel: clampMaxParallel(config.workflow?.maxParallel),
  };

  const provider =
    config.providerId !== undefined
      ? getProviderPreset(config.providerId)
      : defaultProviderPreset();
  // 每次 run 从当前设置重建（baseUrl/apiKey 由 settingsRef 决定；preset 行为参数不变）
  const createLlm = (settings: { baseUrl: string; apiKey: string | undefined }): LlmAdapter => {
    const wiredProvider: ProviderPreset = { ...provider, baseUrl: settings.baseUrl };
    const client = new LlmClient(settings.apiKey !== undefined ? { apiKey: settings.apiKey } : {});
    return wiredLlmAdapter({ provider: wiredProvider, client });
  };
  const initialLlm = createLlm({
    baseUrl: config.baseUrl ?? provider.baseUrl,
    apiKey: config.apiKey,
  });

  // 子代理池：池级单例；config 闭包现读 workflowRef（服务端 attach 后 = 实时配置，
  // 未 attach 回退配置初值）——改 /api/workflow 后后续 spawn 即时生效（动态读取语义）。
  const subagentPool = createSubagentPool({
    llm: initialLlm,
    model: config.model,
    config: () => (workflowRef.get !== null ? workflowRef.get() : initialWorkflow),
  });

  // 会话根解析（多工作区 per-session）：读会话 meta 的 workspaceRoot（session-workspace
  // 事件）；无 meta（旧会话/未建 → 迁移）→ 缺省根（config.workspaceRoot 字面——展示层拼写
  // 不因规范化漂移）；按会话缓存（meta 只写一次，缓存即会话生命周期语义）。
  // workspaceRootOf 经 factory 的 per-session 构建消费：jail 与 shell 同源（S2 平移到
  // 会话级——解析根的 canonical 一次 realpath，字面别名登记，见 createSessionToolsFactory）。
  const sessionRootCache = new Map<string, Promise<string>>();
  const workspaceRootOf = (sessionId: string): Promise<string> => {
    let cached = sessionRootCache.get(sessionId);
    if (cached === undefined) {
      cached = (async () => {
        try {
          for await (const ev of store.events(sessionId)) {
            const root = sessionWorkspaceOf(ev);
            if (root !== null) return root;
          }
        } catch {
          // 会话不存在/读取失败 → 缺省根（fail-closed：无 meta = 历史会话语义）
        }
        return config.workspaceRoot;
      })();
      sessionRootCache.set(sessionId, cached);
    }
    return cached;
  };

  const sessionTools = createSessionToolsFactory({
    workspaceRoot: canonicalWorkspaceRoot,
    jail,
    workspaceRootOf,
    ...(config.toolTimeoutMs !== undefined ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
    ...(config.idleShellTtlMs !== undefined ? { idleShellTtlMs: config.idleShellTtlMs } : {}),
    // use_skill 索引晚绑定 + spawn_subagent 池单例（工具面共 9 个）
    skillsIndex: () => skillsRef.index,
    subagentPool,
  });

  // MCP 接线：launcher（registry.ts 头注契约；真实装配真连接 connectMcpServer；
  // config.mcpConnect 替换实现仅供测试——假连接固定 mcp 工具面、零网络）。
  // mcpConfigRef 晚绑定：服务端启动后经 attachMcpConfig 回填自身 mcpServers 实况
  // ——POST /api/mcp 开关/追加对后续组装即时生效。
  const mcpConfigRef: { get: (() => readonly McpServerConfig[]) | null } = { get: null };
  const mcpLauncher = new McpLauncher({
    configs: () => (mcpConfigRef.get !== null ? mcpConfigRef.get() : (config.mcpServers ?? [])),
    connect: (spec) =>
      config.mcpConnect !== undefined ? config.mcpConnect(spec) : connectMcpServer(spec),
  });

  const runOptions: Partial<RunOptions> = {
    summarizer: makeSummarizer(initialLlm, config.model),
  };
  if (config.costLimitUsd !== undefined) runOptions.costLimitUsd = config.costLimitUsd;
  if (config.maxSteps !== undefined) runOptions.maxSteps = config.maxSteps;
  if (config.windowTokens !== undefined) runOptions.windowTokens = config.windowTokens;
  if (config.systemPrompt !== undefined) runOptions.systemPrompt = config.systemPrompt;
  if (config.toolTimeoutMs !== undefined) runOptions.toolTimeoutMs = config.toolTimeoutMs;
  // 方法论前置门（R2-S1）：缺省开启（config.methodFirst !== false 才注入）；
  // 运行中关闭经 startRun 按 current.methodFirst 丢弃（methodology=undefined → 门不拦）。
  if (config.methodFirst !== false) runOptions.methodology = methodologyGate;

  // 系统提示合成（startRun 每次运行前调用——技能开关/workflow 配置变更即时生效）：
  // base（config.systemPrompt ?? 中文起草）+ 技能清单节 + 方法论路由节 + 子代理节 +
  // 任务分解节 + 收尾评审节，预算感知（见 composeSystemPrompt）。
  // includeMethodology 由 startRun 按 current.methodFirst 传递（false → 路由节排除）。
  const compose = (opts?: { includeMethodology?: boolean }): Promise<string> =>
    composeSystemPrompt({
      ...(config.systemPrompt !== undefined ? { basePrompt: config.systemPrompt } : {}),
      skills: () => skillsRef.index,
      methodologies: () => methodologyRef.index,
      workflow: () => (workflowRef.get !== null ? workflowRef.get() : initialWorkflow),
      ...(opts?.includeMethodology !== undefined
        ? { includeMethodology: opts.includeMethodology }
        : {}),
    });

  return {
    store,
    // A 档：会话首建的 workspaceRoot（服务端写入 session-workspace meta；分组语义单一来源）
    workspaceRoot: config.workspaceRoot,
    // 工作区注册表（多工作区；欠省 [默认根]；去重保序——服务端 POST/DELETE /api/workspaces 增删）
    workspaces: dedupeKeepOrder(config.workspaces ?? [config.workspaceRoot]),
    // 懒构建（getter）：组装不预建 __fallback__ 壳；服务端实际需要时（GET /api/tools 等）才建
    get tools(): ToolRegistry {
      return sessionTools.tools;
    },
    createSessionTools: sessionTools.createSessionTools,
    // MCP 配置初值转发（服务端构造期克隆为自己数组；launcher 经 attachMcpConfig 现读它）
    mcpServers: (config.mcpServers ?? []).map((server) => ({
      ...server,
      args: [...server.args],
    })),
    // MCP 工具面合并（每次调用重新组装——开关变更即时生效；见 mergeMcpTools）
    composeRunTools: async (base: ToolRegistry, sessionId: string): Promise<ToolRegistry> =>
      mergeMcpTools(base, await mcpLauncher.assemble(), sessionId),
    // stats 的 mcpTools（最近一次组装的 mcp 工具数；未组装过 0）
    mcpToolCount: () => mcpLauncher.toolCount(),
    // MCP 配置晚绑定回填（服务端构造期调用；launcher 配置经此现读——POST 即时生效）
    attachMcpConfig: (current: () => readonly McpServerConfig[]) => {
      mcpConfigRef.get = current;
    },
    // 关闭路径：mcp 连接先收（kill 子进程），池先收（拒绝新任务 + 取消队列），
    // 再释放会话 shell（幂等）
    dispose: async () => {
      await mcpLauncher.dispose();
      subagentPool.dispose();
      await sessionTools.dispose();
    },
    // 会话删除联动：删文件 + 释放该会话 shell + 清会话根缓存（幂等；rm force 容忍半途消失）
    disposeSession: async (sessionId: string): Promise<void> => {
      sessionRootCache.delete(sessionId);
      await sessionTools.disposeSession(sessionId);
      await rm(join(sessionsDir, `${sessionId}.jsonl`), { force: true });
    },
    // 空闲 shell 回收（服务端每 60s 节拍调用；判据在工厂的 idleShellTtlMs；
    // 活跃 run 会话集合由服务端维护并传入——跳过 = 运行中 shell 不被误杀）
    disposeIdleShells: async (
      now: number,
      activeSessionIds?: ReadonlySet<string>,
    ): Promise<void> => {
      await sessionTools.disposeIdleShells(now, activeSessionIds);
    },
    idleShellTtlMs: config.idleShellTtlMs ?? DEFAULT_IDLE_SHELL_TTL_MS,
    // 内存防线（built-in）：真 rss 采样 + 全员空闲 shell 释放（跳过活跃 run 会话；
    // 服务端守卫每分钟采样判档——警戒/停机/恢复阈值见 index.ts 的 MemoryGuard）
    memorySampler: () => process.memoryUsage().rss,
    disposeAllIdle: async (activeSessionIds?: ReadonlySet<string>): Promise<void> => {
      await sessionTools.disposeIdleShells(Number.POSITIVE_INFINITY, activeSessionIds);
    },
    // skills 打包资产（dist/assets/skills；scripts/copy-skills.mjs 构建时复制）
    skillsDir: config.skillsDir ?? resolve(process.cwd(), 'dist', 'assets', 'skills'),
    // 用户技能目录（缺省 ~/.devmate/skills；安装生效于该目录——CLI 配置不经 StoredConfig）
    userSkillsDir: config.userSkillsDir ?? defaultUserSkillsDir(),
    sessionLister: makeSessionLister({ store, dir: sessionsDir }),
    activeShellCount: () => sessionTools.activeShellCount(),
    // stats 的 queuedSubagents（池注入后出现；即池 stats 的排队数）
    queuedSubagentCount: () => subagentPool.stats().queued,
    // Workflow 晚绑定回填（服务端构造期调用；索引单源是服务端缓存——deps 组装的是引用适配）
    attachSkillsIndex: (index: SkillsIndex) => {
      skillsRef.index = index;
    },
    attachWorkflowConfig: (current: () => WorkflowConfig) => {
      workflowRef.get = current;
    },
    // 方法论索引晚绑定回填（R2-S1：服务端从自身缓存构建——前置门与路由节现读）
    attachMethodologyIndex: (index: MethodologyIndex) => {
      methodologyRef.index = index;
    },
    composeSystemPrompt: compose,
    llm: initialLlm,
    createLlm,
    createSummarizer: makeSummarizer,
    model: config.model,
    settings: {
      baseUrl: config.baseUrl ?? provider.baseUrl,
      model: config.model,
      // C 档：思考强度初值（缺省 'medium'）+ 窗口覆盖（缺省 = preset 估算——见 presets
      // contextWindowTokens 的「估算，可在设置覆盖」注释；GET /api/settings 的 window）
      reasoning: config.reasoning ?? 'medium',
      // 权限预设定案：缺省 'workspace-write'（与 index 的 DEFAULT_PERMISSION_PRESET 同值——
      // 语义单一来源在该常量与矩阵，此处仅装配初始值）
      permission: config.permission ?? 'workspace-write',
      // 方法论前置门初值（R2-S1：缺省开；POST /api/settings 运行时可关）
      methodFirst: config.methodFirst ?? true,
      // 评审哨兵初值（R2-S2：缺省开；POST /api/settings 运行时可关——false = 不注入 gate）
      reviewMode: config.reviewMode ?? true,
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      ...(config.windowTokens !== undefined
        ? { windowTokens: config.windowTokens }
        : { windowTokens: provider.contextWindowTokens }),
      ...(config.permissionConfirmedAt !== undefined
        ? { permissionConfirmedAt: config.permissionConfirmedAt }
        : {}),
    },
    runOptions,
  };
}
