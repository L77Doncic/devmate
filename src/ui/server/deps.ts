/**
 * # ui/server/deps：assembleDeps 一次性组装（供 S14 CLI；接缝 S12 接线档）
 *
 * 把真 engine 依赖装配为 createDevmateServer 的 DevmateServerDeps：
 * - 监狱 + 工具面：createJail（workspaceRoot 默认边界）→ createFsTools（六个文件工具）
 *   + createPersistentShell（run_command，常驻 Shell：S10）+ createSkillTool（use_skill）
 *   + createSubagentTool（spawn_subagent）→ defineRegistry 名称分发 → securedRegistry 脱敏；
 *   工具面共 9 个，按会话懒建（createSessionToolsFactory）：fs 工具与 use_skill/spawn_subagent
 *   共享一组（不消费 ctx），**shell 每会话一个 PersistentShell 实例**（契约本来就是
 *   ctx.sessionId 键控），依 deps.ts 上文档的 S10 契约真正落地 —— shell 实例按 sessionId
 *   缓存在 Map，dispose()（serve close 路径）统杀全部会话 shell；
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
 * - 系统提示合成：composeSystemPrompt（base + 技能清单节 + 子代理节，预算感知估计
 *   estimateTokens）→ deps.composeSystemPrompt 供 startRun 每次运行前合成（配置变更
 *   即时生效）；本装配另有子代理池（池级单例，成本护栏/队列/信号量在池内）。
 *
 * 真网络只发生在实际 chat 时（LlmClient 惰性连接）；本模块组装零网络往返。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';

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
import { deriveTitle, sessionWorkspaceOf } from './emit.js';
import type { DevmateServerDeps, McpServerConfig, SessionLister, SessionSummary } from './index.js';

export interface DevmateConfig {
  /** 工作区根：监狱默认边界（启动目录），同时是 run_command 初值 cwd。 */
  workspaceRoot: string;
  /** 会话目录；缺省 ~/.devmate/sessions（每会话一个 <id>.jsonl）。 */
  sessionsDir?: string | undefined;
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
}

/** 空闲 shell 回收的缺省 TTL（ms；10 分钟——期间不用的会话 shell 释放，懒重启重建）。 */
export const DEFAULT_IDLE_SHELL_TTL_MS = 600_000;

/** 会话工具工厂输出（assembleDeps 与 E2E 测试共用；shell 每会话独立实例）。 */
export interface SessionToolsFactory {
  /** 缺省会话的注册表（兼容单例形态；任意并发服务在有 createSessionTools 时不用它）。
   *  懒构建：首次访问才建 __fallback__ 壳（构造即建 = 未 spawn 也计数的幽灵实例）。 */
  tools: ToolRegistry;
  /** 按会话懒建注册表：同一 sessionId 恒返回同一对象（含同一 shell 实例）；每次调用刷新 lastUsedAt。 */
  createSessionTools(sessionId: string): ToolRegistry;
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
 * 会话工具面（fs 共享一组 + shell 每会话一实例 + use_skill/spawn_subagent 共享各一；
 * 返回注册表缓存工厂）。
 * 工具面共 9 个：6 文件工具 + run_command + use_skill + spawn_subagent——后两个是
 * Workflow 能力（技能懒加载 + 子代理隔离上下文），共享单例（无会话态：技能索引经
 * 晚绑定引用执行期现读、子代理池是池级单例），与 fs 工具同属「构造一次、各会话复用」。
 */
export function createSessionToolsFactory(options: {
  workspaceRoot: string;
  jail: Jail;
  toolTimeoutMs?: number;
  /** 空闲 shell TTL（ms；缺省 DEFAULT_IDLE_SHELL_TTL_MS）。 */
  idleShellTtlMs?: number;
  /** 测试注入：与 createPersistentShell 同契约的替换工厂（真实装配不传）。 */
  createShell?: (sessionId: string) => PersistentShell;
  /** 技能索引读取器（晚绑定：服务端 attach 回填前为 null → use_skill 执行期报 skill-index-unavailable）。 */
  skillsIndex?: () => SkillsIndex | null;
  /** 子代理池（池级单例；缺省 = 恒 disabled 的占位池——只保障工具面形状，真实装配必传）。 */
  subagentPool?: SubagentPool;
}): SessionToolsFactory {
  const idleShellTtlMs = options.idleShellTtlMs ?? DEFAULT_IDLE_SHELL_TTL_MS;
  // fs 工具共享一组：不消费 ctx（无会话态），无隔离漂移面
  const fsTools = createFsTools({ sessionId: 'fs-shared', jail: options.jail });
  // use_skill / spawn_subagent：无会话态共享一组（索引执行期现读、池级单例——开关即时生效）
  const skillTool = createSkillTool({ index: options.skillsIndex ?? (() => null) });
  const subagentTool = createSubagentTool({ pool: options.subagentPool ?? disabledPool() });
  const shells = new Map<string, PersistentShell>();
  const registries = new Map<string, ToolRegistry>();
  /** 会话 shell 最近使用时间（createSessionTools 与每次 execute 均刷新；空闲回收判据）。 */
  const lastUsedAt = new Map<string, number>();
  /** 在飞 execute 计数（执行中的 shell 兜底豁免：即使活跃集合未覆盖也不释放）。 */
  const executing = new Map<string, number>();
  const createShell = (sessionId: string): PersistentShell =>
    options.createShell !== undefined
      ? options.createShell(sessionId)
      : createPersistentShell({
          workspaceRoot: options.workspaceRoot,
          jail: options.jail,
          ...(options.toolTimeoutMs !== undefined ? { timeoutMs: options.toolTimeoutMs } : {}),
        });

  const forId = (sessionId: string): ToolRegistry => {
    let registry = registries.get(sessionId);
    if (registry === undefined) {
      let shell = shells.get(sessionId);
      if (shell === undefined) {
        shell = createShell(sessionId);
        shells.set(sessionId, shell);
      }
      const base = securedRegistry(
        defineRegistry([...fsTools, shell.tool, skillTool, subagentTool], { sessionId }),
      );
      // 包装 execute：① 在飞计数（执行中的 shell 绝不空闲回收）② 每次 execute 起止刷新
      // lastUsedAt（TTL 判据更精确——长 run 内多次工具调用不会触发误杀）
      registry = {
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
      registries.set(sessionId, registry);
    }
    // 每次使用会话工具（run 开始/继续）刷新：该会话 shell 视为活跃
    lastUsedAt.set(sessionId, Date.now());
    return registry;
  };

  const disposeSession = async (sessionId: string): Promise<void> => {
    lastUsedAt.delete(sessionId);
    const shell = shells.get(sessionId);
    if (shell === undefined) return;
    shells.delete(sessionId);
    registries.delete(sessionId);
    await shell.dispose();
  };

  let fallbackRegistry: ToolRegistry | undefined;
  return {
    // 懒构建：构造即建 __fallback__ 会留下「未 spawn 但计数」的幽灵实例（stats 启动为 0）
    get tools(): ToolRegistry {
      if (fallbackRegistry === undefined) fallbackRegistry = forId('__fallback__');
      return fallbackRegistry;
    },
    createSessionTools: forId,
    async dispose(): Promise<void> {
      const all = [...shells.values()];
      shells.clear();
      registries.clear();
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
// 系统提示词合成（base + 技能清单节 + 子代理节；预算感知）
// ---------------------------------------------------------------------------

/**
 * 基础系统提示（config.systemPrompt 未提供时的中文起草）：DevMate 是本地编程智能体
 * ——工作区边界 / 工具错误回注语义 / 审批流程（与 CONTEXT「危险操作审批」口径一致：
 * 带理由拒绝 → 模型继续；无理由拒绝 → 用户中止本轮）。
 */
export const DEV_BASE_SYSTEM_PROMPT = `你是 DevMate，一个运行在用户本机工作区里的编程智能体：用户给出一个编程任务，你自主读写文件、执行命令并反复思考，直至完成或就关键决策向用户提问。

工作区与安全边界：
- 文件与命令操作被限制在工作区边界内；越界访问会被拒绝并附拒因——这是正常结果，按拒因换用合法路径，不要强行绕开（可用 list_dir/glob 先探索合法路径）。
- 命令有超时与输出上限；输出被截断时不要凭想象补全中间内容，改用更小的目标操作。
- 一切认知以工具结果与用户消息为准：不编造文件内容、工具结果或事实。

工具与错误：
- 工具调用失败是普通消息而非异常：{ok:false, error:{type,message}} 表明该次调用未生效，按 message 与可用清单（available_tools/available_skills）调整后重试，或不再调用工具。
- 同一轮内多个工具并行执行，结果按调用顺序回注；有副作用依赖时按顺序串行使用。

审批流程：
- 部分危险操作需用户审批：被拒绝且带理由 → 按理由调整后继续；被拒绝无理由 → 表示用户中止本轮，不要再发起动作。用户随时可以中断，恢复后会从现场继续。`;

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
  /** 系统提示 token 预算；缺省 DEFAULT_SYSTEM_PROMPT_BUDGET_TOKENS。 */
  budgetTokens?: number;
}

/**
 * 合成系统提示：基础提示 + 技能清单节（enabled skills 一行一条，末尾「需要时
 * use_skill 加载全文」，懒加载语义）+ 子代理节（workflow.subagentsEnabled 时）。
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

  let composed = assembleSystemPrompt(base, skillLines, workflow);
  while (
    estimateTokens([{ role: 'system', content: composed }]).tokens > budgetTokens &&
    skillLines.length > 0
  ) {
    // 超出预算：从清单尾部逐行裁（清单 id 序确定性——每次结果可复现）
    skillLines = skillLines.slice(0, -1);
    composed = assembleSystemPrompt(base, skillLines, workflow);
  }
  return composed;
}

/** 三节装配：base \\n\\n 技能清单节（有 enabled 技能时）\\n\\n 子代理节（subagentsEnabled 时）。 */
function assembleSystemPrompt(
  base: string,
  skillLines: readonly string[],
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
  if (workflow.subagentsEnabled) {
    sections.push(
      `## 子代理\n对于可独立处理的子任务，可调用 spawn_subagent（并行上限 ${workflow.maxParallel}）` +
        `以隔离上下文；报告最多 4k 字符。`,
    );
  }
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

/** 一次性组装（自备依赖测试全部用假；这里只装真件、零网络往返）。 */
export async function assembleDeps(config: DevmateConfig): Promise<DevmateServerDeps> {
  const jail = await createJail({ workspaceRoot: config.workspaceRoot });
  const sessionsDir = config.sessionsDir ?? defaultSessionsDir();

  const store = new JsonlFileAdapter({ dir: sessionsDir });

  // Workflow 晚绑定接缝：服务端启动时经 attach 回填（读取器/索引实现）——技能开关与
  // 工作流配置（POST /api/skills|workflow）在服务端变更，工具/池/提示词合成经此现读。
  const skillsRef: { index: SkillsIndex | null } = { index: null };
  const workflowRef: { get: (() => WorkflowConfig) | null } = { get: null };
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

  const sessionTools = createSessionToolsFactory({
    workspaceRoot: config.workspaceRoot,
    jail,
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

  // 系统提示合成（startRun 每次运行前调用——技能开关/workflow 配置变更即时生效）：
  // base（config.systemPrompt ?? 中文起草）+ 技能清单节 + 子代理节，预算感知（见 composeSystemPrompt）。
  const compose = (): Promise<string> =>
    composeSystemPrompt({
      ...(config.systemPrompt !== undefined ? { basePrompt: config.systemPrompt } : {}),
      skills: () => skillsRef.index,
      workflow: () => (workflowRef.get !== null ? workflowRef.get() : initialWorkflow),
    });

  return {
    store,
    // A 档：会话首建的 workspaceRoot（服务端写入 session-workspace meta；分组语义单一来源）
    workspaceRoot: config.workspaceRoot,
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
    // 会话删除联动：删文件 + 释放该会话 shell（幂等；rm force 容忍半途消失）
    disposeSession: async (sessionId: string): Promise<void> => {
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
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      ...(config.windowTokens !== undefined
        ? { windowTokens: config.windowTokens }
        : { windowTokens: provider.contextWindowTokens }),
    },
    runOptions,
  };
}
