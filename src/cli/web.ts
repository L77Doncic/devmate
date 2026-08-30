/**
 * # cli/web：`devmate-cli web` 参数解析与启动编排
 *
 * 命令形态：`devmate-cli web [--port N] [--workspace <path>] [--no-open]`。
 * - 不提供 host：固定绑定 127.0.0.1（ADR-0007 同进程 local server）；
 * - 本机浏览器打开：darwin `open` / win32 `cmd /c start ""` / linux `xdg-open || x-www-browser`
 *   （选定后追加 URL 为末位参数；其不依赖 shell 注入，避免引号/空格路径问题）；
 * - Ctrl-C 优雅关闭：关闭 server（S12 server.close() 同时负责 shell dispose）+ 退出 0。
 * - 设置链路：把 config.ts 的 saveConfig 系（saveConfig / mergeConfig）注入
 *   createDevmateServer 依赖（POST /api/settings 落盘回 ~/.devmate/config.json；
 *   boot 时 loadConfig → settingsRef 初值）。
 * - attach 模式（新增）：createDevmateServer 时叠加三个落盘回调（saveSkillsConfig /
 *   saveWorkflow / saveMcpConfig → mergeConfig 单点合并写各自节、文件既有键保留）与
 *   三节初值（workflow 初值归一 0-8——0 = 无上限、skillsRecord 缺省 {}、mcpServers 缺省 []——
 *   读 config.json 相应节；缺回调/缺初值 → 服务端仅内存/自有缺省）。
 *
 * ServerModule 接缝：S12（src/ui/server/）已落地——`assembleDeps(config)`→Promise<deps>
 * （deps.ts，真引擎组装）、`createDevmateServer(deps)`→DevmateServer（index.ts，
 * listen(port?)→Promise<ServerAddress>）。CLI 单测经 RunWebIo.loadServerModule 注入假模块，
 * 生产接线在 index.ts（动态 import，随 S12 持续迭代不炸编译）。
 */
import { loadConfig, loadStoredConfig, mergeConfig } from './config.js';
import type { CliConfig, StoredConfig, StoredMcpServer, StoredWorkflowConfig } from './config.js';
import { sanitizeProviderModel } from '../core/llm/provider-adapter.js';
import { clampMaxParallel } from '../shared/workflow.js';
import type { ReasoningEffort } from '../shared/llm-types.js';
import type { PermissionPreset } from '../ui/server/index.js';

/**
 * S12 接缝形状（任务书契约与 S12 实际接口的差异说明：S12 的 `createDevmateServer(deps)`、
 * `listen(port?) → Promise<ServerAddress>`、`deps.assembleDeps(config) → Promise<DevmateServerDeps>`
 * 均已落地，见 src/ui/server/index.ts 与 deps.ts；本处按实际接口声明，避免对 S12 内部
 * 类型的静态依赖（devmate 侧只消费 listen 返回值中的 port）。
 */
export interface DevmateServer {
  /** 绑定 127.0.0.1；port=0 时系统分配。 */
  listen(port?: number): Promise<ServerAddress>;
  close(): Promise<void>;
}

export interface ServerAddress {
  host: string;
  port: number;
}

/** S12 接缝：server 模块须暴露的两个工厂。 */
export interface ServerModule {
  assembleDeps(config: ServerConfig): Promise<unknown>;
  createDevmateServer(deps: unknown): DevmateServer;
}

/**
 * 任务书 config 形状：交付给 assembleDeps 的引擎配置（S12 DevmateConfig 的超集字段
 * providerId/sessionsDir/systemPrompt/toolTimeoutMs 由 S12 缺省处理）。设置读回
 * （B 档）：reasoning / permission / windowTokens 三键自 ~/.devmate/config.json
 * 读回注入——assembleDeps 的 settings 初值随之播种（缺省不进文件 → 缺省字段不传，
 * assembleDeps 回落 'medium'/'workspace-write'/供应商 preset 估算）。
 */
export interface ServerConfig {
  workspaceRoot: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxSteps?: number;
  costLimitUsd?: number;
  /** 思考强度持久值（config.json settings 写路径的读回键；缺省 'medium'）。 */
  reasoning?: ReasoningEffort;
  /** 权限预设持久值（读回键；缺省 'workspace-write'）。 */
  permission?: PermissionPreset;
  /** 上下文窗口覆盖持久值（读回键；缺省 = 供应商 preset 估算）。 */
  windowTokens?: number;
  /** 请求侧输入上限（A 档读回键；缺省不发送/厂商默认）。 */
  maxInputTokens?: number;
  /** 请求侧输出上限（A 档读回键；缺省 = DEFAULT_MAX_TOKENS 估价/不发送）。 */
  maxOutputTokens?: number;
  /** 方法论前置门持久值（R2-S1 读回键；缺省 true）。 */
  methodFirst?: boolean;
  /** 评审哨兵持久值（R2-S2 读回键；缺省 true）。 */
  reviewMode?: boolean;
  /** 存量 config.model 带 `[N]m/k` 尾标（loadConfig 读取即净化）——传给装配层；
   *  服务端 GET 据此挂 modelSanitized=true（前端提示「模型名已自动校正」一次）。 */
  modelWasSanitized?: boolean;
}

/** web 子命令生效参数。 */
export interface WebArgs {
  port: number;
  workspace: string;
  noOpen: boolean;
}

/** 参数解析结果（校验失败收集全部错误，一次报清）。 */
export type WebParseResult = { ok: true; args: WebArgs } | { ok: false; errors: string[] };

/** runWeb 全部外部触点（测试注入假实现；生产由 index.ts 用 node 实现填实）。 */
export interface RunWebIo {
  cwd: string;
  env: Record<string, string | undefined>;
  configPath: string;
  platform: string;
  isDir: (p: string) => boolean;
  findOnPath: (cmd: string) => boolean;
  /** 由 runWeb 解析好打开命令后调用；URL 由生产接线追加为末位参数。 */
  openBrowser: (url: string, cmd: string, args: string[]) => void;
  loadServerModule: () => Promise<ServerModule>;
  println: (line: string) => void;
  printErr: (line: string) => void;
  /** Ctrl-C 回调（可异步：生产接线在 close 后显式 exit，保证常驻 shell 随进程消亡）。 */
  setSignalHandler: (cb: () => void | Promise<void>) => void;
}

/** 解析 `web` 参数（纯函数；存在性校验经 isDir 注入）。 */
export function parseWebArgs(
  argv: string[],
  env: { cwd: string; isDir: (p: string) => boolean },
): WebParseResult {
  const errors: string[] = [];
  let port = 0;
  let workspace = env.cwd;
  let noOpen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === '--no-open') {
      noOpen = true;
    } else if (token === '--port') {
      const value = argv[i + 1];
      if (value === undefined) {
        errors.push('--port 需要 1-65535 的整数（缺值；0 表示自动分配，省略--port 即可）');
        continue;
      }
      // 值不管合法与否都消费掉，避免它随后被当作未知位置参数重复报错。
      i += 1;
      if (/^\d+$/.test(value) === false || Number(value) < 1 || Number(value) > 65535) {
        errors.push(`--port 需要 1-65535 的整数，收到：${value}`);
        continue;
      }
      port = Number(value);
    } else if (token === '--workspace') {
      const value = argv[i + 1];
      if (value === undefined) {
        errors.push('--workspace 指定目录（缺值）');
        continue;
      }
      i += 1;
      if (env.isDir(value) === false) {
        errors.push(`--workspace 指定目录不存在或不可访问：${value}`);
        continue;
      }
      workspace = value;
    } else if (token.startsWith('-')) {
      errors.push(`未知选项：${token}（web 支持 --port / --workspace / --no-open）`);
    } else {
      errors.push(`未知参数：${token}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, args: { port, workspace, noOpen } };
}

/** 平台打开命令选择（纯函数；Linux 走 PATH 探测注入）。URL 由调用方追加为末位参数。 */
export function detectPlatformCmd(
  platform: string,
  findOnPath: (cmd: string) => boolean = () => false,
): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  if (platform === 'linux') {
    if (findOnPath('xdg-open')) return { cmd: 'xdg-open', args: [] };
    if (findOnPath('x-www-browser')) return { cmd: 'x-www-browser', args: [] };
    return null;
  }
  return null;
}

/** 中文启动横幅：本地地址 / 端口 / 工作区 / 模型 / Ctrl-C 提示（PORT 为 listen 返回值）。 */
export function renderBanner(info: { port: number; workspace: string; model: string }): string {
  return [
    'DevMate 本地 Web UI 已启动',
    `  地址   http://127.0.0.1:${info.port}/`,
    `  端口   ${info.port}`,
    `  工作区 ${info.workspace}`,
    `  模型   ${info.model}`,
    '按 Ctrl-C 优雅退出（关闭 server 与常驻 shell）',
  ].join('\n');
}

/**
 * attach 模式注入：deps 保持对象时叠加落盘回调/初值（deps 非对象（测试假件/字符串等）
 * 则原样透传——接缝只保证 unknown 形状不被破坏）。
 */
function attachDeps(deps: unknown, attach: Record<string, unknown>): unknown {
  if (deps !== null && typeof deps === 'object') {
    return { ...(deps as Record<string, unknown>), ...attach };
  }
  return deps;
}

/**
 * maxParallel 初值归一 0-8（单一来源：shared/workflow 的 clampMaxParallel——三处副本
 * 已收敛到该模块；undefined → 2；负 → 0；>8 → 8；floor 后夹紧；0 = 无上限）。
 * 只作用于**初值加载**；服务端已在 POST /api/workflow 校验越界 → 400（CLI 落盘透传不归一）。
 */

/** 任务书 config 形状的组装（exactOptionalPropertyTypes：缺省字段不落 undefined）。 */
export function buildServerConfig(config: {
  workspaceRoot: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxSteps?: number;
  costLimitUsd?: number;
  reasoning?: ReasoningEffort;
  permission?: PermissionPreset;
  windowTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  methodFirst?: boolean;
  reviewMode?: boolean;
  modelWasSanitized?: boolean;
}): ServerConfig {
  const out: ServerConfig = {
    workspaceRoot: config.workspaceRoot,
    baseUrl: config.baseUrl,
    model: config.model,
  };
  if (config.apiKey !== undefined) out.apiKey = config.apiKey;
  if (config.maxSteps !== undefined) out.maxSteps = config.maxSteps;
  if (config.costLimitUsd !== undefined) out.costLimitUsd = config.costLimitUsd;
  if (config.reasoning !== undefined) out.reasoning = config.reasoning;
  if (config.permission !== undefined) out.permission = config.permission;
  if (config.windowTokens !== undefined) out.windowTokens = config.windowTokens;
  if (config.maxInputTokens !== undefined) out.maxInputTokens = config.maxInputTokens;
  if (config.maxOutputTokens !== undefined) out.maxOutputTokens = config.maxOutputTokens;
  if (config.methodFirst !== undefined) out.methodFirst = config.methodFirst;
  if (config.reviewMode !== undefined) out.reviewMode = config.reviewMode;
  if (config.modelWasSanitized !== undefined) out.modelWasSanitized = config.modelWasSanitized;
  return out;
}

/**
 * 启动编排：解析 → 装配（assembleDeps）→ listen → banner → 开浏览器 → 待命信号。
 * 任何一步失败：printErr + 返回 1；成功：注册 Ctrl-C 关闭后返回 0。
 */
export async function runWeb(args: string[], io: RunWebIo): Promise<number> {
  const parsed = parseWebArgs(args, { cwd: io.cwd, isDir: io.isDir });
  if (!parsed.ok) {
    for (const err of parsed.errors) io.printErr(`参数错误：${err}`);
    return 1;
  }
  const webArgs = parsed.args;

  let config: CliConfig;
  let stored: StoredConfig;
  try {
    config = loadConfig(io.configPath, io.env);
    // 三节初值：读配置原文（缺失 → {}；损坏 JSON 由上面的 loadConfig 先抛 ConfigError）
    stored = loadStoredConfig(io.configPath);
  } catch (err) {
    io.printErr(err instanceof Error ? `配置读取失败：${err.message}` : '配置读取失败');
    return 1;
  }

  let module: ServerModule;
  try {
    module = await io.loadServerModule();
  } catch (err) {
    io.printErr(
      err instanceof Error
        ? `web 模式依赖的 server 模块加载失败：${err.message}`
        : 'server 模块加载失败',
    );
    return 1;
  }

  const serverConfig = buildServerConfig({
    workspaceRoot: webArgs.workspace,
    baseUrl: config.baseUrl,
    model: config.model,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
    ...(config.costLimitUsd !== undefined ? { costLimitUsd: config.costLimitUsd } : {}),
    // B 档设置读回：{permission, reasoning, windowTokens, methodFirst, reviewMode} 自 config.json
    // 同键读回（persistSettings 写出的键；缺省不写 → 缺省字段不传，assembleDeps 回落各自缺省）
    ...(stored.reasoning !== undefined ? { reasoning: stored.reasoning } : {}),
    ...(stored.permission !== undefined ? { permission: stored.permission } : {}),
    ...(stored.windowTokens !== undefined ? { windowTokens: stored.windowTokens } : {}),
    ...(stored.maxInputTokens !== undefined ? { maxInputTokens: stored.maxInputTokens } : {}),
    ...(stored.maxOutputTokens !== undefined ? { maxOutputTokens: stored.maxOutputTokens } : {}),
    ...(stored.methodFirst !== undefined ? { methodFirst: stored.methodFirst } : {}),
    ...(stored.reviewMode !== undefined ? { reviewMode: stored.reviewMode } : {}),
    // A 档：存量 config 的模型名带 `[N]m/k` 尾标 → loadConfig 读取即净化——留痕给
    // 服务端（GET modelSanitized=true → 前端提示「已自动校正」一次，不静默）
    ...(stored.model !== undefined && sanitizeProviderModel(stored.model) !== stored.model
      ? { modelWasSanitized: true }
      : {}),
  });
  let deps: unknown;
  try {
    deps = await module.assembleDeps(serverConfig);
  } catch (err) {
    io.printErr(err instanceof Error ? `引擎依赖装配失败：${err.message}` : '引擎依赖装配失败');
    return 1;
  }
  // 设置持久化：POST /api/settings 落盘（mergeConfig 单点合并写——只覆盖 settings 键，
  // maxSteps/costLimitUsd/skills/workflow/mcp 等既有键全保留；patch 显式 apiKey:undefined
  // = 删除该键；reasoning/windowTokens/permission/permissionConfirmedAt/methodFirst/reviewMode
  // 只在快照携带时写——服务端补丁语义本来就在触碰时才携带）。saveConfig 0600 写
  // io.configPath 由 mergeConfig 负责（目录/模式纠正）。
  const persistSettings = (s: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    reasoning?: ReasoningEffort;
    windowTokens?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    permission?: PermissionPreset;
    permissionConfirmedAt?: number;
    methodFirst?: boolean;
    reviewMode?: boolean;
  }): void => {
    mergeConfig(io.configPath, {
      baseUrl: s.baseUrl,
      model: s.model,
      apiKey: s.apiKey,
      ...(s.reasoning !== undefined ? { reasoning: s.reasoning } : {}),
      ...(s.windowTokens !== undefined ? { windowTokens: s.windowTokens } : {}),
      ...(s.maxInputTokens !== undefined ? { maxInputTokens: s.maxInputTokens } : {}),
      ...(s.maxOutputTokens !== undefined ? { maxOutputTokens: s.maxOutputTokens } : {}),
      ...(s.permission !== undefined ? { permission: s.permission } : {}),
      ...(s.permissionConfirmedAt !== undefined
        ? { permissionConfirmedAt: s.permissionConfirmedAt }
        : {}),
      ...(s.methodFirst !== undefined ? { methodFirst: s.methodFirst } : {}),
      ...(s.reviewMode !== undefined ? { reviewMode: s.reviewMode } : {}),
    });
  };
  // 三节初值加载（读 config.json 相应节；缺省：skillsRecord {} = 全开、workflow true/2、
  // mcpServers []）；workflow 初值归一 0-8（负 → 0、>8 → 8、非整 floor；0 = 无上限；
  // 运行时越界由服务端 POST 400，此处只归一初值——clampMaxParallel 单一来源）。
  const skillsRecord: Record<string, boolean> =
    stored.skills !== undefined && typeof stored.skills === 'object' && stored.skills !== null
      ? { ...stored.skills }
      : {};
  const workflowInitial: StoredWorkflowConfig = {
    subagentsEnabled: stored.workflow?.subagentsEnabled ?? true,
    maxParallel: clampMaxParallel(stored.workflow?.maxParallel),
  };
  const mcpServersInitial: StoredMcpServer[] = Array.isArray(stored.mcp) ? stored.mcp : [];
  const saveSkillsConfig = (skills: Record<string, boolean>): void => {
    mergeConfig(io.configPath, { skills });
  };
  const saveWorkflow = (workflow: StoredWorkflowConfig): void => {
    mergeConfig(io.configPath, { workflow });
  };
  const saveMcpConfig = (servers: StoredMcpServer[]): void => {
    mergeConfig(io.configPath, { mcp: servers });
  };
  // 工作区注册表（多工作区）：初值读回 config.json 的 workspaces 节（缺省 [workspace——
  // 服务端默认根恒在）；saveWorkspaces 经 mergeConfig 整节替换落盘（以服务端快照为准）。
  const workspacesInitial: string[] = Array.isArray(stored.workspaces)
    ? stored.workspaces
    : [webArgs.workspace];
  const saveWorkspaces = (roots: string[]): void => {
    mergeConfig(io.configPath, { workspaces: roots });
  };
  const server = module.createDevmateServer(
    attachDeps(deps, {
      persistSettings,
      saveSkillsConfig,
      saveWorkflow,
      saveMcpConfig,
      saveWorkspaces,
      workflow: workflowInitial,
      mcpServers: mcpServersInitial,
      workspaces: workspacesInitial,
      // 服务端当前只持久化 skills 开关（开关表初值缺省 {} = 全开；无初值注入缝——
      // attach 模式下本键透传不影响现有行为，服务端接缝扩展后即生效）。
      skillsRecord,
    }),
  );

  let port: number;
  try {
    const address = await server.listen(webArgs.port);
    port = address.port;
  } catch (err) {
    io.printErr(
      err instanceof Error ? `本地 server 启动失败：${err.message}` : '本地 server 启动失败',
    );
    return 1;
  }

  io.println(renderBanner({ port, workspace: webArgs.workspace, model: config.model }));

  const url = `http://127.0.0.1:${port}/`;
  if (!webArgs.noOpen) {
    const openCmd = detectPlatformCmd(io.platform, io.findOnPath);
    if (openCmd === null) {
      io.printErr(
        '未找到可用浏览器打开命令（linux 需 xdg-open 或 x-www-browser），请手动打开上面的地址',
      );
    } else {
      io.openBrowser(url, openCmd.cmd, openCmd.args);
    }
  }

  io.setSignalHandler(async () => {
    await server.close();
  });
  return 0;
}
