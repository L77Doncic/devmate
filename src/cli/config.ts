/**
 * # cli/config：本地配置（~/.devmate/config.json）+ 环境变量覆盖
 *
 * 三源合并优先级：环境变量（DEV_MATE_BASE_URL / DEV_MATE_MODEL / DEV_MATE_API_KEY）>
 * 配置文件 > 供应商 preset 默认（主默认 DeepSeek，ADR-0002）。
 * - apiKey 可缺省：Web UI 设置页填写后经 saveConfig 落盘；
 * - 权限纪律：config 文件 0600、.devmate 目录 0700（密钥永不入仓库，配置只住主目录）；
 * - 掩码回读：maskApiKey 只用于展示，完整密钥仅进程内传递（单一实现已迁至
 *   shared/masking 层间倒置修复——本模块只 re-export 保持既有 import 面）；
 * - 三节扩展：skills（开关表）/ workflow（子代理+并行上限）/ mcp（配置清单）——
 *   全部经 mergeConfig 单点合并写（各部分只改自己的键，既有键保留；merge 语义），
 *   初值经 loadStoredConfig 读取（缺失 → {}，损坏 → ConfigError）。
 *
 * 类型命名（重名修复）：本模块的生效配置类型为 **CliConfig**（CLI 侧）：三源合并结果
 * {baseUrl, model, apiKey?, maxSteps?}——与 S12 引擎侧
 * ui/server/deps 的 **DevmateConfig**（workspaceRoot/model/… 装配输入）**两型区分**，
 * 各自保持原名不动，避免跨层同名的路径歧义。
 * Token 护栏（2026-08-31 定调）不入 config.json：对话级 per-session，经 POST /api/chat
 * 的 maxRunTokens 字段透传（存量 config.json 里的死键 costLimitUsd 原样保留、不再读用）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultProviderPreset } from '../core/llm/presets.js';
import { sanitizeProviderModel } from '../core/llm/provider-adapter.js';
import { maskApiKey } from '../shared/masking.js';
import type { ReasoningEffort } from '../shared/llm-types.js';
import type { PermissionPreset } from '../ui/server/index.js';

export const CONFIG_DIR_NAME = '.devmate';
export const CONFIG_FILE_NAME = 'config.json';

export const ENV_BASE_URL = 'DEV_MATE_BASE_URL';
export const ENV_MODEL = 'DEV_MATE_MODEL';
export const ENV_API_KEY = 'DEV_MATE_API_KEY';

/** 配置文件的可写形状（字段可缺省；缺省字段回落默认或 env）。 */
export interface StoredConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  maxSteps?: number;
  /** 思考强度（C 档：settings reasoning 持久化；缺省 'medium'——服务端兜底）。 */
  reasoning?: ReasoningEffort;
  /** 上下文窗口覆盖（C 档：settings windowTokens 持久化；缺省 = 供应商 preset 估算）。 */
  windowTokens?: number;
  /** 请求侧输入上限（A/B 档：settings maxInputTokens 持久化——**必填**口径以
   *  settings POST 为准；此处可缺省（缺省回填供应商 preset，见服务端 GET）。
   *  只对白名单供应商生效（DashScope/Qwen），见 deepseek-vision.md §8。 */
  maxInputTokens?: number;
  /** 请求侧输出上限（A/B 档：settings maxOutputTokens 持久化——**必填**口径以
   *  settings POST 为准；此处可缺省（缺省回填 DEFAULT_MAX_TOKENS=8192）。 */
  maxOutputTokens?: number;
  /** 权限预设（settings permission 持久化；缺省 'workspace-write'——服务端兜底）。 */
  permission?: PermissionPreset;
  /** full-access 风险确认记录（epoch ms；前端风险门后写入——纯记录、不强制）。 */
  permissionConfirmedAt?: number;
  /** 方法论前置门开关（R2-S1：settings methodFirst 持久化；缺省 true——服务端兜底）。 */
  methodFirst?: boolean;
  /** 评审哨兵开关（R2-S2：settings reviewMode 持久化；缺省 true——服务端兜底）。 */
  reviewMode?: boolean;
  /** Skills 运行时开关（id → enabled；缺省空表 = 全开）。 */
  skills?: Record<string, boolean>;
  /** 工作流配置（子代理开关/并行上限；缺省 true/2；maxParallel 消费时归一 0-8——0 = 无上限）。 */
  workflow?: StoredWorkflowConfig;
  /** MCP 服务器配置清单（配置层；P2 协议客户端接入前只存配置）。 */
  mcp?: StoredMcpServer[];
  /** 工作区注册表（多工作区：canonical 根清单；整节替换——以服务端快照为准，同 mcp）。 */
  workspaces?: string[];
}

/** 工作流配置节（字段可缺省；服务端断言 maxParallel 整数 0-8——0 = 无上限，CLI 初值加载归一）。 */
export interface StoredWorkflowConfig {
  subagentsEnabled?: boolean;
  maxParallel?: number;
}

/** MCP 配置记录（与服务端 McpServerConfig 同形状：name/command/args/enabled）。 */
export interface StoredMcpServer {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

/** mergeConfig 补丁形状（每个键可显式 undefined = 删除该键；见 mergeStored）。 */
export type StoredConfigPatch = { [K in keyof StoredConfig]?: StoredConfig[K] | undefined };

/** 三源合并后的生效配置（CLI 侧；与 S12 引擎 DevmateConfig 两型区分）。 */
export interface CliConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxSteps?: number;
  /** 请求侧输入/输出上限（A 档；读回自配置，未配置缺省=不发送/厂商默认）。 */
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

/** 配置损坏（JSON 解析失败）时抛出，调用方负责向用户呈现中文错误。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 主目录 → ~/.devmate/config.json 绝对路径。 */
export function configFilePath(homeDir: string): string {
  return join(homeDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/** 读配置：env 空串视为未设置；文件损坏抛 ConfigError。 */
export function loadConfig(configPath: string, env: Record<string, string | undefined>): CliConfig {
  const stored = readStored(configPath);
  const preset = defaultProviderPreset();

  const cfg: CliConfig = {
    baseUrl: env[ENV_BASE_URL] || stored.baseUrl || preset.baseUrl,
    // 模型名净化（全链根除 2026-08-30 用户实测残留）：env/config 里的 `[N]m/k` UI 标记
    // 后缀在读取即剥离——banner/引擎/设置初值全链恒净化名（服务端 POST 亦净化，双保险）。
    model: sanitizeProviderModel(env[ENV_MODEL] || stored.model || preset.defaultModel),
  };
  const apiKey = env[ENV_API_KEY] || stored.apiKey;
  if (apiKey !== undefined) cfg.apiKey = apiKey;
  if (stored.maxSteps !== undefined) cfg.maxSteps = stored.maxSteps;
  // A 档：输入/输出上限读回（未配置缺省 = 不发送（请求默认）——与引擎口径一致）
  if (stored.maxInputTokens !== undefined) cfg.maxInputTokens = stored.maxInputTokens;
  if (stored.maxOutputTokens !== undefined) cfg.maxOutputTokens = stored.maxOutputTokens;
  return cfg;
}

/** 写配置：自建 .devmate 目录（0700）、文件 0600；已存在文件权限也被纠正。 */
export function saveConfig(configPath: string, stored: StoredConfig): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: 'w' });
  chmodSync(configPath, 0o600);
}

/** 读配置原文（可写形状）：文件缺失 → {}；损坏抛 ConfigError（settings/web 初值加载用）。 */
export function loadStoredConfig(configPath: string): StoredConfig {
  return readStored(configPath);
}

/**
 * 合并写（单点）：读 → mergeStored → saveConfig。
 * persistSettings 与 skills/workflow/mcp 三个落盘回调共用本函数——各部分只改自己的键，
 * 文件既有键全保留（merge 语义）；损坏文件抛 ConfigError（读路径先跑）。
 */
export function mergeConfig(configPath: string, patch: StoredConfigPatch): void {
  saveConfig(configPath, mergeStored(readStored(configPath), patch));
}

/**
 * 纯合并（注入 configPath 的单点实现；单测直测）：
 * - 顶层键 patch 优先；patch 显式 undefined = 删除该键（POST /api/settings apiKey:'' 的清空语义）；
 * - skills/workflow 节内深合（既有键保留，冲突键 patch 优先）；
 * - mcp/workspaces 清单以服务端全量快照为准——整节替换（按名合并会让已删根/服务器复活）。
 */
export function mergeStored(stored: StoredConfig, patch: StoredConfigPatch): StoredConfig {
  const raw: Record<string, unknown> = { ...stored, ...patch };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) out[key] = value;
  }
  if (patch.skills !== undefined) out.skills = { ...stored.skills, ...patch.skills };
  if (patch.workflow !== undefined) out.workflow = { ...stored.workflow, ...patch.workflow };
  if (patch.mcp !== undefined) out.mcp = patch.mcp;
  if (patch.workspaces !== undefined) out.workspaces = patch.workspaces;
  return out as StoredConfig;
}

/** 掩码回读（单一实现 re-export：shared/masking 层间倒置修复；行为不变）。 */
export { maskApiKey };

function readStored(configPath: string): StoredConfig {
  if (!existsSync(configPath)) return {};
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new ConfigError(`配置读取失败：${configPath}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError(`配置格式错误（应为 JSON 对象）：${configPath}`);
    }
    return parsed as StoredConfig;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`配置解析失败（可能损坏）：${configPath}`);
  }
}
