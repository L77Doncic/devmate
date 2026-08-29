/**
 * # app.js — DevMate 对话窗口浏览器入口（ES Module，零依赖零构建）
 *
 * 分层：本文件只做「DOM 装配 + 网络编排」；一切状态先归入 messages.js 状态机，
 * 一切文本渲染经 markdown.js（textContent-only，无 innerHTML）。
 * 网络编排放 api.js（fetchJson/HttpError/isStatus/backswitch）、流消费经 sse.js
 * （fetch + ReadableStream + 行缓冲）、单流收尾裁决经 streams.js（createStreamGate）。
 *
 * 单流模型（对接服务端 SessionBroker 全量缓冲）：会话的 /api/stream 唯一且长活 ——
 * ensureStream(sessionId) 每会话只开一次（首条消息 / 历史恢复 / 切换会话时接入，
 * run 的事件连入后才到达或由回放补序）；run 结束后流不关（服务端心跳保活）。
 * 发送门禁与停止按钮统一由 runActive 驱动（run-status 8 终态事件后置 false，
 * 终态表单一源 = format.js RUN_STATUS_SEMANTICS）。
 *
 * 侧边栏（S13/S14，仅对话区 —— 工具/MCP/插件的侧栏区已删，入口只存在于设置页）：
 * - 会话列表 GET /api/sessions；恢复 = GET /api/sessions/:id（协议形状 events ≤500）
 *   → **单流协调时序（与代码顺序一致）**：1) 关旧流 broker（abort）→ 2) store.reset +
 *     回放历史 → 3) 旧 run 视状态 POST /api/interrupt（backswitch，best-effort）
 *     → 4) UI 收口（选中态/列表/统计/「已恢复」toast）→ 5) ensureStream(新会话)。
 *     UI 收口必须先于 ensureStream：流长活（run 结束不关、心跳保活，仅切会话/出错才闭），
 *     await 在其后排序即把提示与刷新推迟到流关闭 —— 恢复/新建提示永不显示。
 * - 会话按**工作区**分组（dsh WorkspaceBrowser）：组 = 注册根（ProjectRowItem 组头
 *   34px：folder↔hover chevron + basename/meta + kebab/＋）+ SessionNodeItem 32px 行；
 *   未注册根/无根会话 = 尾组「未知项目」（无操作菜单）；归组纯逻辑 = workspaces.js
 *   groupSessionsByRegisteredWorkspaces（可单测）。组折叠 per-workspace 持久化。
 * - ＋新建 = dsh WorkspacePickFlow 菜单（工作区列表 + 勾选当前 + 添加工作区…）；
 *   目录选择弹窗 = dsh ui-directory-picker-browse 形态；移除工作区 = 确认 modal →
 *   DELETE /api/workspaces/:root（默认根禁用项；400 回授校正默认根启发）。
 * - /api/sessions、/api/stats、/api/workspaces 未实现时逐项容错（列表不可用说明/
 *   占位符 + 会话根并集伪注册根 —— 组仍可见；端点就绪即自然点亮；无内层重试风暴）。
 * - 侧栏无「供应商」区块（用户裁定：协议开放任意 OpenAI 兼容端点，无需列预设）。
 * - 侧栏折叠（宽屏手动收放）：默认展开；持久化键 devdev.sidebarCollapsed 仅字面量
 *   'true' 服从（损坏/未定义 → 展开）—— 逻辑在 sidebar.js（纯函数可单测）。
 *
 * 安全纪律：
 * - 全文无 innerHTML / outerHTML / insertAdjacentHTML：内容一律 createElement + textContent。
 * - 用户与模型文本均经 markdown.js / 纯 textContent 路径；链接 href 过 safeHref 白名单。
 * - 只发同源请求；apiKey 只在 saveSettingsForm 读值瞬间存在，POST 后立即丢弃。
 */
import { createMessageStore, createReplayGuard, msgKind } from './messages.js';
import { consumeSSE } from './sse.js';
import { markdownToDOM } from './markdown.js';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  saveReasoning,
  savePermission,
  saveMethodFirst,
  REASONING_VALUES,
  REASONING_LABELS,
  REASONING_DEFAULT,
  METHODFIRST_DEFAULT,
  normalizeMethodFirst,
  REVIEWMODE_DEFAULT,
  normalizeReviewMode,
  saveReviewMode,
} from './settings.js';
import {
  PERMISSION_VALUES,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_DEFAULT,
  permissionLabel,
  permissionGlyph,
  normalizePermission,
  shouldConfirmRisk,
  RISK_CONFIRM_TITLE,
  RISK_CONFIRM_TEXT,
} from './permissions.js';
import { bannerFromApproval } from './approval-banner.js';
import {
  SUBAGENT_DEFAULTS,
  SUBAGENT_LOCAL_NOTE,
  SUBAGENT_SYNC_FAILED_TOAST,
  SKILLS_DEGRADED_NOTE,
  MCP_DEGRADED_NOTE,
  MCP_SIDEBAR_EMPTY_NOTE,
  MCP_BADGE_ENABLED,
  MCP_BADGE_DISABLED,
  loadWorkflowPref,
  saveSubagentPref,
  syncWorkflowPref,
  normalizeParallel,
  normalizeSkillsList,
  normalizeMcpServers,
  splitMcpArgs,
  SKILL_INSTALL_BUSY,
  SKILL_INSTALL_EMPTY_SOURCE,
  SKILL_INSTALL_URL_PLACEHOLDER,
  SKILL_INSTALL_PATH_PLACEHOLDER,
  SKILL_INSTALL_HELP_URL,
  SKILL_INSTALL_HELP_PATH,
  normalizeSkillSource,
  skillInstallErrorText,
  installSkill,
} from './extensions.js';
import { iconSvg } from './icons.js'; // 线描图标单一来源（d 串 + createElementNS，永不 innerHTML）
import { loadThemeKey, saveThemeKey, applyTheme } from './theme.js';
import {
  loadSidebarState,
  saveSidebarState,
  resolveSidebarCollapsed,
  SIDEBAR_WIDTH,
  BUILD_VERSION,
} from './sidebar.js';
import { SESSION_MENU_ITEMS, menuItemById, menuPosition } from './menu.js';
import {
  COMMANDS,
  commandFor,
  commandArgValid,
  matchCommands,
  parseCommandLine,
  themeArgLabel,
} from './commands.js';
import {
  meterRatio,
  meterTier,
  meterPercentText,
  meterTooltip,
  meterAriaLabel,
  meterCircumference,
} from './meter.js';
import { fetchJson, isStatus, backswitch } from './api.js';
import { createStreamGate } from './streams.js';
import {
  normalizeSessionList,
  sortSessionList,
  sessionDisplayTitle,
  normalizeSessionDetail,
  normalizeStats,
  formatStatsLine,
} from './sessions.js';
import {
  WS_DEGRADED_NOTE,
  WS_EMPTY_NOTE,
  WS_MENU_ITEMS,
  isAbsolutePath,
  normalizeWorkspaceRoots,
  dedupeKeepOrder,
  workspaceName,
  workspacePathMeta,
  workspaceMenuOrder,
  pickDefaultRoot,
  groupSessionsByRegisteredWorkspaces,
  workspaceOfSession,
  createBrowseState,
  normalizeBrowse,
  browseNavigate,
  browseUp,
  browseLoaded,
  browseSelect,
  browseCanCommit,
  breadcrumbSegments,
  loadWorkspaceCollapse,
  saveWorkspaceCollapse,
  workspaceErrorInfo,
} from './workspaces.js';
import {
  statusLabel,
  statusTone,
  runStatusLine,
  formatArguments,
  toolSummaryLine,
  compactionLine,
  compactionSummary,
  composerStatsLine,
  elapsedText,
  shortId,
  truncate,
  timeAgo,
  TERMINAL_STATUSES,
  // 词表单一源：阶段词/连接态/工具卡标签都在 format.js（防漂移测试见 test/ui-web）。
  RUN_STAGE_WORDS,
  CONN_VISIBLE,
  TOOL_STATE_LABEL,
  formatTokens,
  formatCostUsd,
  // Wave 2 消息行 chrome / ToolRow 变体（纯逻辑全部在 format.js，可单测）
  formatMessageClock,
  ranForCaption,
  CLIPBOARD_FEEDBACK_MS,
  messageCopyText,
  thinkSummary,
  thinkBodyText,
  classifyTool,
  TOOL_VARIANT_TITLES,
  toolSummaryArgs,
  buildDiffLines,
  buildReadBlock,
  buildSearchLines,
  parseToolArguments,
  BLOCK_MAX_CHARS,
  // R2-S1：方法线小牌文本（run-strip「方法线 tdd」；提取纯逻辑 = messages.js 侧）
  methodologyBadgeText,
} from './format.js';

// ============================================================== 常量

const LS_SESSION = 'devmate.ui.sessionId';
// 侧栏折叠持久化键与读写纪律在 sidebar.js（键 = devdev.sidebarCollapsed；
// 仅字面量 'true' 服从，损坏/未定义 → 展开 —— 读取风险修复）。
// 侧栏仅「对话」区（会话按 workspaceRoot 分组）；工具/MCP/插件侧栏区已删
// （工具清单与 MCP 的入口只存在于设置页），服务端失败时各自在设置页降级。

// 词表（TOOL_STATE_LABEL / CONN_VISIBLE / RUN_STAGE_WORDS）单一权威源在 format.js：
// 工具卡 7 态、连接 6 态、运行阶段词均从那里导入；本文件不再自带中文硬编码镜像。

// ============================================================== 模块级状态

const store = createMessageStore();
/** 历史回放去重守卫（messages.js）：恢复会话（GET 先行）后接流时，SessionBroker
 *  后进回放会把同序事务帧再投一遍 —— 守卫逐段丢弃（见 createReplayGuard 头注释）。 */
const replayGuard = createReplayGuard();
/** 单流闸门（streams.js）：记录「当前流」，收尾裁决「引用相等才 endStream」——
 *  旧流 finally 晚到不搅动新流（切会话竞态修复）。 */
const streamGate = createStreamGate({ onFinished: () => store.endStream() });
const ui = {
  settingsReady: false,
  settings: {
    baseUrl: DEFAULT_SETTINGS.baseUrl,
    model: DEFAULT_SETTINGS.model,
    keyConfigured: true,
    apiKeyMasked: '',
    // C 档：思考强度（缺省 'medium'）与上下文窗口覆盖（缺省 null = 估算模式）
    reasoning: REASONING_DEFAULT,
    windowTokens: null,
    // 权限预设（缺省 workspace-write）与 full-access 风险确认记录（GET 返回才非 null）
    permission: PERMISSION_DEFAULT,
    permissionConfirmedAt: null,
    // R2-S1：方法论前置门开关（缺省 true；GET /api/settings 权威回显，见设置页常规区）
    methodFirst: METHODFIRST_DEFAULT,
    // R2-S2：收尾评审哨兵开关（缺省 true；GET /api/settings 权威回显，见设置页常规区）
    reviewMode: REVIEWMODE_DEFAULT,
  },
  sessionId: null,
  // 内嵌审批卡：currentApproval = 当前呈现项（快照 approvals[0] 的视图模型）；
  // deciding = 应答已点、POST 在途（双纽防双发，dsh「应答后 disabled」同语义）
  currentApproval: null,
  approvalDeciding: false,
  // 访问模式 chip：菜单开关 + 防抖 300ms 提交（同思考强度纪律）+ 风险确认门态
  permMenuOpen: false,
  permissionSyncPending: null,
  permissionSyncTimer: 0,
  riskConfirmOpen: false,
  riskConfirmTarget: null,
  toastTimer: 0,
  rafPending: false,
  dirtyItems: new Set(),
  rendered: new Map(), // store item id → DOM node
  lastSnap: null,
  // 运行中耗时秒表（仅 runActive 时存在；终态/失败即清）
  clockTimer: 0,
  // S13：主题/侧栏（dsh 语义：preference 持久化 + narrowExpanded 窄屏运行时覆盖；
  // sidebarSettled = 折叠动画已 settle（rail 布局生效）；sessionItems = 侧栏列表缓存）
  theme: 'system',
  sidebarCollapsed: false,
  narrowExpanded: false,
  sidebarSettled: false,
  sessionsLoaded: false,
  sessionItems: [],
  pendingDelete: null,
  confirmOpen: false,
  foldEl: null,
  // S14：多工作区（dsh WorkspaceBrowser / WorkspacePickFlow 语义）——
  // workspaces = 注册根（注册序）；wsDefaultRoot = 默认根（roots[0] 启发 +
  // DELETE 400 'cannot delete the default workspace root' 回授校正）；
  // wsCollapsed = per-workspace 折叠映射；wsLoaded = 注册表端点本会话曾成功过
  wsLoaded: false,
  workspaces: [],
  wsDefaultRoot: null,
  wsCollapsed: {},
  wsNewMenuOpen: false,
  wsPickerOpen: false,
  skillInstalling: false, // 技能安装在途（按钮态 + 重入护栏）
  wsPickerState: null, // 目录浏览状态机（workspaces.js 纯逻辑）
  wsPickerBrowseFailed: false,
  wsPickerFetchSeq: 0, // 浏览拉取序列号（乱序响应收敛：只认最新一发）
  wsErrorOpen: false,
  wsErrorText: '',
  wsRemoveOpen: false,
  wsRemoveTarget: null,
  // 设置页扩展区：Subagent 工作流偏好（source: 'server' = 与 /api/workflow 同步；
  // 'local' = 服务端不可达，降级仅本地，旁注「未同步（仅本地）」。defaults 见 extensions.js）
  subagent: { ...SUBAGENT_DEFAULTS },
  subagentSource: 'local',
  // 工作流同步（防抖 300ms，change 即提交无队列）：pending 合并最近一次字段 patch
  subagentSyncPending: null,
  subagentSyncTimer: 0,
  // 思考强度同步（点击即 POST，防抖 300ms；失败回滚重读 + toast）：
  // pending = 待提交档位（null = 无挂起）
  reasoningSyncPending: null,
  reasoningSyncTimer: 0,
  // R2-S1：方法论先行开关同步（change 即防抖 300ms POST /api/settings；失败回滚重读 + toast）
  methodFirstSyncPending: null,
  methodFirstSyncTimer: 0,
  // R2-S2：收尾评审开关同步（change 即防抖 300ms POST /api/settings；失败回滚重读 + toast）
  reviewModeSyncPending: null,
  reviewModeSyncTimer: 0,
  // 「/」命令下拉（commands.js 纯逻辑；DOM 装配与键盘走这里）
  cmdMenuOpen: false,
  cmdHighlight: 0, // 下拉当前高亮项（键盘循环用）
  cmdTimer: 0, // 防抖 150ms 句柄
  groupSeq: 0, // 分组组头 body-id 序号（唯一）
};

// ============================================================== DOM 引用

const el = {
  shell: document.getElementById('shell'),
  sidebar: document.getElementById('sidebar'),
  logoRow: document.getElementById('logo-row'),
  btnSidebarToggle: document.getElementById('btn-sidebar-toggle'),
  btnBrand: document.getElementById('btn-brand'),
  btnNewSession: document.getElementById('btn-new-session'),
  buildVersion: document.getElementById('build-version'),
  newSessionLabel: document.querySelector('#btn-new-session .newSessionLabel'),
  regionArea: document.querySelector('#sidebar .regionArea'),
  treeBody: document.getElementById('tree-body'),
  sideList: document.getElementById('side-list'),
  wsGroups: document.getElementById('ws-groups'),
  sessionsEmpty: document.getElementById('sessions-empty'),
  sessionsUnavailable: document.getElementById('sessions-unavailable'),
  rowMenu: document.getElementById('row-menu'),
  // S14 多工作区：＋新建菜单 / 添加工作区 / 目录弹窗 / 错误对话框 / 移除确认
  wsNewMenu: document.getElementById('ws-new-menu'),
  btnAddWorkspace: document.getElementById('btn-add-workspace'),
  wsPicker: document.getElementById('ws-picker'),
  wsPickerScrim: document.getElementById('ws-picker-scrim'),
  wsCrumbs: document.getElementById('ws-crumbs'),
  wsDirs: document.getElementById('ws-dirs'),
  wsManualInput: document.getElementById('ws-manual-input'),
  btnWsPickerClose: document.getElementById('btn-ws-picker-close'),
  btnWsPickerCancel: document.getElementById('btn-ws-picker-cancel'),
  btnWsPickerSelect: document.getElementById('btn-ws-picker-select'),
  wsError: document.getElementById('ws-error'),
  wsErrorScrim: document.getElementById('ws-error-scrim'),
  wsErrorText: document.getElementById('ws-error-text'),
  btnWsErrorCancel: document.getElementById('btn-ws-error-cancel'),
  btnWsErrorRetry: document.getElementById('btn-ws-error-retry'),
  wsRemoveConfirm: document.getElementById('ws-remove-confirm'),
  wsRemoveScrim: document.getElementById('ws-remove-scrim'),
  wsRemoveText: document.getElementById('ws-remove-text'),
  btnWsRemoveOk: document.getElementById('btn-ws-remove-ok'),
  btnWsRemoveCancel: document.getElementById('btn-ws-remove-cancel'),
  btnEmptyAddWorkspace: document.getElementById('btn-empty-add-workspace'),
  statsLine: document.getElementById('stats-line'),
  confirm: document.getElementById('confirm'),
  confirmScrim: document.getElementById('confirm-scrim'),
  confirmText: document.getElementById('confirm-text'),
  btnConfirmOk: document.getElementById('btn-confirm-ok'),
  btnConfirmCancel: document.getElementById('btn-confirm-cancel'),
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty'),
  input: document.getElementById('input'),
  send: document.getElementById('btn-send'),
  stop: document.getElementById('btn-stop'),
  conn: document.getElementById('conn'),
  connLabel: document.getElementById('conn-label'),
  composerStats: document.getElementById('composer-stats'),
  composerStatsText: document.getElementById('composer-stats-text'),
  runStrip: document.getElementById('run-strip'),
  sessionTitle: document.getElementById('session-title'),
  sessionId: document.getElementById('session-id'),
  toast: document.getElementById('toast'),
  // 内嵌审批卡（dsh ApprovalPanel 本地形态：composer 上方 dock）
  approvalDock: document.getElementById('approval-dock'),
  approvalHeadline: document.getElementById('approval-headline'),
  approvalCommand: document.getElementById('approval-command'),
  btnBannerApprove: document.getElementById('btn-banner-approve'),
  btnBannerDeny: document.getElementById('btn-banner-deny'),
  // PermissionSelect 访问模式 chip + 菜单（dsh Menu 表面）
  permChip: document.getElementById('perm-chip'),
  permGlyph: document.getElementById('perm-glyph'),
  permLabel: document.getElementById('perm-label'),
  permMenu: document.getElementById('perm-menu'),
  // 全部访问风险确认门（复用删除确认 modal 视觉）
  riskConfirm: document.getElementById('risk-confirm'),
  riskScrim: document.getElementById('risk-scrim'),
  riskTitle: document.getElementById('risk-confirm-title'),
  riskText: document.getElementById('risk-confirm-text'),
  btnRiskOk: document.getElementById('btn-risk-ok'),
  btnRiskCancel: document.getElementById('btn-risk-cancel'),
  // 命令（/）下拉 + 面板
  cmdMenu: document.getElementById('cmd-menu'),
  cmdPanel: document.getElementById('cmd-panel'),
  cmdPanelTitle: document.getElementById('cmd-panel-title'),
  cmdPanelBody: document.getElementById('cmd-panel-body'),
  cmdPanelClose: document.getElementById('cmd-panel-close'),
  // 思考强度分段 pill（选项由 app.js 从 settings.js 常量装配）
  reasoningSeg: document.getElementById('reasoning-seg'),
  // 上下文窗口占用环
  meterRow: document.getElementById('meter-row'),
  meter: document.getElementById('meter'),
  meterFill: document.querySelector('#meter .meter-fill'),
  meterText: document.getElementById('meter-text'),
  btnSettings: document.getElementById('btn-settings'),
  drawer: document.getElementById('settings'),
  drawerScrim: document.getElementById('settings-scrim'),
  setBaseUrl: document.getElementById('set-baseurl'),
  setModel: document.getElementById('set-model'),
  setKey: document.getElementById('set-key'),
  setWorkspace: document.getElementById('set-workspace'),
  keyState: document.getElementById('key-state'),
  settingsStatus: document.getElementById('settings-status'),
  btnSettingsCancel: document.getElementById('btn-settings-cancel'),
  step1: document.getElementById('step-1'),
  themeInputs: [...document.querySelectorAll('input[name="theme"]')],
  // 设置页扩展区（Skills / MCP / Subagent）—— 动态行全部走 data-* 事件委托
  setSubagentEnabled: document.getElementById('set-subagent-enabled'),
  setSubagentParallel: document.getElementById('set-subagent-parallel'),
  setSubagentNote: document.getElementById('set-subagent-note'),
  // R2-S1 方法论先行开关（常规区卡片；change 委托 data-methodfirst-field）
  setMethodfirstEnabled: document.getElementById('set-methodfirst-enabled'),
  // R2-S2 收尾评审开关（常规区卡片；change 委托 data-reviewmode-field）
  setReviewmodeEnabled: document.getElementById('set-reviewmode-enabled'),
  skillsList: document.getElementById('skills-list'),
  skillsNote: document.getElementById('skills-note'),
  // 技能安装表单（URL / 本地路径 单选 + 安装 / 重新扫描）
  skillInstallSource: document.getElementById('skill-install-source'),
  skillInstallHelp: document.getElementById('skill-install-help'),
  skillInstallNote: document.getElementById('skill-install-note'),
  btnSkillInstall: document.getElementById('btn-skill-install'),
  btnSkillRescan: document.getElementById('btn-skill-rescan'),
  skillSrcInputs: [...document.querySelectorAll('input[name="skill-install-src"]')],
  mcpList: document.getElementById('mcp-list'),
  mcpNote: document.getElementById('mcp-note'),
  mcpAddName: document.getElementById('mcp-add-name'),
  mcpAddCommand: document.getElementById('mcp-add-command'),
  mcpAddArgs: document.getElementById('mcp-add-args'),
  mcpAddNote: document.getElementById('mcp-add-note'),
};

// ============================================================== 网络

// fetchJson / HttpError / isStatus / backswitch 均在 api.js（纯逻辑，可注入 fetchImpl 单测）。

function toast(text, tone = '') {
  el.toast.textContent = text;
  el.toast.className = 'toast' + (tone ? ` ${tone}` : '');
  el.toast.hidden = false;
  window.clearTimeout(ui.toastTimer);
  ui.toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 2400);
}

// ============================================================== 主题（S13-A）

function systemPrefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true; // 旧浏览器：媒体查询不可用时按深色（与默认 CSS 一致）
  }
}

/** 主题三种取值（system/dark/light）只写两处：html[data-theme] + meta 同步 */
function setTheme(value) {
  ui.theme = saveThemeKey(localStorage, value);
  applyTheme(document, ui.theme, systemPrefersDark());
  syncThemeRadios();
}

function syncThemeRadios() {
  for (const input of el.themeInputs) {
    input.checked = input.value === ui.theme;
  }
}

function wireTheme() {
  for (const input of el.themeInputs) {
    input.addEventListener('change', () => {
      if (input.checked) setTheme(input.value);
    });
  }
  // 跟随系统态：OS 深浅切换即时同步 meta（颜色取值本身纯 CSS 完成，无需 JS 干预）
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', () => {
      if (ui.theme === 'system') applyTheme(document, 'system', systemPrefersDark());
    });
  } catch {
    // 忽略：无 matchMedia 时系统跟随退化为纯 CSS 分支
  }
}

// ============================================================== 侧边栏（dsh SidebarRoot 复刻）

/**
 * 折叠 = slide + crossfade（照抄 dsh SidebarRoot 的几何与相位）：
 * - 折叠：track 300ms 滑向 56px；wide 内容**冻结在最宽宽度**（inline width）
 *   并就地淡出（.fading > *，150ms）；150ms settle 后卸载 wide 内容、应用
 *   rail 布局（.settled）、rail 四控从原轨右缘 49px 偏移 150ms 进场（.railIn
 *   —— 仅活折叠；冷渲染直入 rail 无动画）；
 * - 展开：track 滑回 260px（content 立即 260 固定，剪裁而非回流），wide 内容
 *   重挂载（.wide 200ms 淡回）。
 * - quietBars：指针在栏外时滚动条 transparent（栏位保留 → 显隐零回流）；
 *   离开后 2s 延隐藏（dsh SCROLLBAR_LINGER_MS），回栏即消隐计时。
 */

const COLLAPSE_SETTLE_MS = 150; // 与 .fading 150ms 淡出同步
const SCROLLBAR_LINGER_MS = 2000; // 指针离开侧栏后滚动条停留时长

const narrowMq =
  typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 899px)') : null;
const isNarrow = () => (narrowMq ? narrowMq.matches : false);

/** 当前是否折叠：窄屏自动折叠（dsh AppFrame 约定）+ narrowExpanded 运行时覆盖。 */
function effectiveCollapsed() {
  return resolveSidebarCollapsed(ui.sidebarCollapsed, isNarrow(), ui.narrowExpanded);
}

// 相位状态（syncSidebarUi 唯一收口；局部变量不进 ui —— 单相位机）
let sidebarSettleTimer = 0;
/** 曾经处于 wide（活折叠才有 railIn 入场动画；冷折叠渲染静态）。 */
let sidebarEverWide = false;
/** settle 后暂存的 wide-only 节点（brand / label / treeBody），展开时重挂载。 */
const sidebarShelf = { brand: null, label: null, tree: null };

function unmountWide() {
  // 注意：ChildNode.remove() 返回 undefined —— 先存引用再摘除（重挂载靠 shelf）
  if (el.btnBrand.isConnected) {
    sidebarShelf.brand = el.btnBrand;
    el.btnBrand.remove();
  }
  if (el.newSessionLabel.isConnected) {
    sidebarShelf.label = el.newSessionLabel;
    el.newSessionLabel.remove();
  }
  if (el.treeBody.isConnected) {
    sidebarShelf.tree = el.treeBody;
    el.treeBody.remove();
  }
}

function mountWide() {
  if (sidebarShelf.brand && !el.btnBrand.isConnected) {
    el.logoRow.insertBefore(sidebarShelf.brand, el.btnSidebarToggle);
    sidebarShelf.brand = null;
  }
  if (sidebarShelf.label && !el.newSessionLabel.isConnected) {
    el.btnNewSession.appendChild(sidebarShelf.label);
    sidebarShelf.label = null;
  }
  if (sidebarShelf.tree && !el.treeBody.isConnected) {
    el.regionArea.appendChild(sidebarShelf.tree);
    sidebarShelf.tree = null;
  }
}

/** 相位收口：class / inline 宽度 / wide 挂载 / toggle aria（调用点：toggle、settle、boot）。 */
function syncSidebarUi() {
  const collapsed = effectiveCollapsed();
  const settled = collapsed && ui.sidebarSettled;
  el.shell.classList.toggle('sidebar-collapsed', collapsed);
  el.sidebar.classList.toggle('settled', settled);
  el.sidebar.classList.toggle('fading', collapsed && !ui.sidebarSettled);
  el.sidebar.classList.toggle('railIn', settled && sidebarEverWide);
  // wide（展开、或折叠未 settle）：内容冻结在展开宽 —— 轨道剪裁而非内容回流
  if (!settled) el.sidebar.style.width = `${SIDEBAR_WIDTH}px`;
  else el.sidebar.style.removeProperty('width');
  if (settled) unmountWide();
  else mountWide();
  el.btnSidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? '打开侧边栏' : '收起侧边栏';
  el.btnSidebarToggle.setAttribute('aria-label', label);
  el.btnSidebarToggle.title = label;
}

/** settle 调度：折叠 150ms 后切 rail 布局；展开即时（wide 重挂载开淡入）。 */
function scheduleSidebarSettle() {
  window.clearTimeout(sidebarSettleTimer);
  sidebarSettleTimer = 0;
  const collapsed = effectiveCollapsed();
  if (!collapsed) {
    ui.sidebarSettled = false;
    sidebarEverWide = true;
    syncSidebarUi();
    return;
  }
  sidebarSettleTimer = window.setTimeout(() => {
    sidebarSettleTimer = 0;
    ui.sidebarSettled = true;
    syncSidebarUi();
  }, COLLAPSE_SETTLE_MS);
}

function toggleSidebar() {
  if (isNarrow()) {
    // 窄屏：运行时展开覆盖（dsh narrow toggles 语义）；不落盘
    ui.narrowExpanded = !ui.narrowExpanded;
  } else {
    ui.sidebarCollapsed = !ui.sidebarCollapsed; // collapsed = rail 56（非 0 宽）
    saveSidebarState(localStorage, ui.sidebarCollapsed);
  }
  scheduleSidebarSettle();
}

// quietBars：栏内指针跟随（dsh SidebarRoot 同构 —— 盒几何而非 DOM 包含判定，
// 指针离开窗口不再发 move 时由元素自身 pointerleave 兜底；2s 延隐藏）

let sidebarPointerInside = false;
let sidebarLingerTimer = 0;

function armLinger() {
  if (sidebarLingerTimer !== 0) return;
  sidebarLingerTimer = window.setTimeout(() => {
    sidebarLingerTimer = 0;
    setSidebarPointerInside(false);
  }, SCROLLBAR_LINGER_MS);
}

function cancelLinger() {
  window.clearTimeout(sidebarLingerTimer);
  sidebarLingerTimer = 0;
}

function setSidebarPointerInside(inside) {
  sidebarPointerInside = inside;
  el.sidebar.classList.toggle('quietBars', !inside);
}

function wireQuietBars() {
  el.sidebar.addEventListener('pointerenter', () => {
    cancelLinger();
    setSidebarPointerInside(true);
  });
  el.sidebar.addEventListener('pointerleave', () => {
    armLinger();
  });
  document.addEventListener('pointermove', (event) => {
    if (!sidebarPointerInside) return;
    const rect = el.sidebar.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX < rect.right &&
      event.clientY >= rect.top &&
      event.clientY < rect.bottom;
    if (inside) cancelLinger();
    else armLinger();
  });
}

// ---- 行菜单（kebab → dsh Menu：纯逻辑见 menu.js；DOM 装配与开关在此） ----

let menuTarget = null; // 菜单当前指向：{type:'session', sessionId} | {type:'workspace', root, disabled}

/**
 * 行菜单装配（kebab → dsh Menu）：条目表按目标类型取单一来源
 * （会话行 = SESSION_MENU_ITEMS；工作区组头 = WS_MENU_ITEMS —— 默认根项 disabled）。
 */
function buildRowMenu() {
  el.rowMenu.replaceChildren();
  const target = menuTarget;
  const items = target?.type === 'workspace' ? WS_MENU_ITEMS : SESSION_MENU_ITEMS;
  const source = target?.type === 'workspace' ? WS_MENU_ITEMS : SESSION_MENU_ITEMS;
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rowMenuItem' + (item.danger ? ' danger' : '');
    btn.dataset.menuId = item.id;
    btn.setAttribute('role', 'menuitem');
    btn.disabled = Boolean(target?.type === 'workspace' && target.disabled);
    const icon = iconSvg('trash', { size: 16, className: 'rowMenuItemIcon' });
    const label = document.createElement('span');
    label.textContent = item.label;
    btn.append(icon, label);
    btn.addEventListener('click', () => {
      const action = menuItemById(source, item.id);
      // 先取目标（closeRowMenu 会清 menuTarget —— 顺序是钉点：不得反转）
      const sessionTarget = menuTarget;
      closeRowMenu();
      // 白名单匹配：未知 id 不落入任何 else
      if (action === null) return;
      if (
        sessionTarget?.type === 'session' &&
        action.id === 'delete' &&
        sessionTarget.sessionId !== null
      ) {
        const s = ui.sessionItems.find(
          (candidate) => candidate.sessionId === sessionTarget.sessionId,
        );
        if (s) requestDeleteSession(s);
      } else if (
        sessionTarget?.type === 'workspace' &&
        !sessionTarget.disabled &&
        action.id === 'remove'
      ) {
        requestRemoveWorkspace(sessionTarget.root);
      }
    });
    el.rowMenu.appendChild(btn);
  }
}

function openRowMenu(anchorButton, target) {
  menuTarget = target;
  // 行的 menuOpen 钉住 hover 显隐（dsh menuOpen 语义：菜单开着行保持 hover 面）
  const row = anchorButton.closest('li.sessionRow, .wsGroupHead');
  if (row) row.classList.add('menuOpen');
  el.rowMenu.hidden = false;
  buildRowMenu();
  const size = { width: el.rowMenu.offsetWidth, height: el.rowMenu.offsetHeight };
  const rect = anchorButton.getBoundingClientRect();
  const sbRect = el.sidebar.getBoundingClientRect();
  // 锚 rect（视口系）→ 侧栏局部系；钳制视口 = 侧栏盒（菜单 absolute 于侧栏内，
  // 恒在栏界内 → 永不裁切 —— dsh portal 语义的本地等价）
  const anchor = {
    left: rect.left - sbRect.left,
    top: rect.top - sbRect.top,
    width: rect.width,
    height: rect.height,
  };
  const viewport = { width: sbRect.width - 2, height: sbRect.height };
  const pos = menuPosition(anchor, size, viewport);
  el.rowMenu.style.left = `${pos.left}px`;
  el.rowMenu.style.top = `${pos.top}px`;
}

function closeRowMenu() {
  if (el.rowMenu.hidden) return;
  el.rowMenu.hidden = true;
  menuTarget = null;
  for (const row of el.sidebar.querySelectorAll('li.sessionRow.menuOpen, .wsGroupHead.menuOpen')) {
    row.classList.remove('menuOpen');
  }
}

function wireRowMenu() {
  // 外部点击关闭（菜单自身点击不关闭 —— item handler 处理；kebab 换行/关闭由其
  // 自身监听负责 —— 此处不得抢先 close，否则 openRowMenu 后立即被击穿）。
  // Escape 亦关闭。
  document.addEventListener('click', (event) => {
    if (el.rowMenu.hidden) return;
    if (!(event.target instanceof Node) || el.rowMenu.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('[data-kebab]')) return;
    closeRowMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.rowMenu.hidden) closeRowMenu();
  });
  // dsh Menu closeOnPointerLeave 语义：指针离开菜单即关
  el.rowMenu.addEventListener('pointerleave', () => {
    closeRowMenu();
  });
  // 列表滚动/轨道滑动期间关闭（锚已漂移；dsh portaled 菜单会重锚 —— 关更稳）
  window.addEventListener(
    'scroll',
    () => {
      if (!el.rowMenu.hidden) closeRowMenu();
    },
    true,
  );
}

// ---- 会话列表 · 工作区组（dsh WorkspaceBrowser：注册根 → ProjectRowItem 组头 +
//      SessionNodeItem 行；未注册根/未知会话 = 尾组；纯逻辑见 workspaces.js） ----

async function refreshSessionList(silent = false) {
  let list = null;
  try {
    list = normalizeSessionList(await fetchJson('/api/sessions'));
  } catch {
    list = null;
  }
  if (list === null) {
    if (!ui.sessionsLoaded && !silent) {
      // 端点缺失/异常：显示不可用说明（保留既有列表不清空；静默刷新失败不打扰）
      el.wsGroups.replaceChildren();
      el.sessionsEmpty.hidden = true;
      el.sessionsUnavailable.hidden = false;
    }
    return;
  }
  ui.sessionsLoaded = true;
  el.sessionsUnavailable.hidden = true;
  renderSessionList(list);
}

/**
 * 注册表端点不可达时的诚实降级：以会话自身 workspaceRoot 并集作伪注册根
 * （组仍可见、组头照常按 basename 命名 —— 仅「移除工作区」不提供，因未注册）。
 */
function effectiveWorkspaceRoots() {
  if (ui.workspaces.length > 0) return ui.workspaces;
  return dedupeKeepOrder(
    ui.sessionItems.map((s) => s.workspaceRoot).filter((r) => typeof r === 'string' && r !== ''),
  );
}

function renderSessionList(list) {
  const sorted = sortSessionList(list);
  ui.sessionItems = sorted;
  const groups = groupSessionsByRegisteredWorkspaces(sorted, effectiveWorkspaceRoots());
  el.wsGroups.replaceChildren();
  el.sessionsEmpty.textContent = WS_EMPTY_NOTE;
  el.sessionsEmpty.hidden = groups.length > 0;
  for (const group of groups) el.wsGroups.appendChild(buildWorkspaceGroup(group));
}

/** 当前会话所属工作区根（菜单「勾选当前」用；null = 无/未注册）。 */
function currentSessionRoot() {
  if (!ui.sessionId) return null;
  const s = ui.sessionItems.find((candidate) => candidate.sessionId === ui.sessionId);
  return s === undefined ? null : workspaceOfSession(effectiveWorkspaceRoots(), s);
}

/**
 * folder slot 对（展开/悬停互换；dsh ProjectRowItem: folder ↔ hover chevron）。
 * 字形即 icons.js 一笔画描边轮廓（<16px 实心疙瘩> 修复 = 由 filled 叠块 → stroke 线形）。
 */
function buildFolderSlot(variant, active) {
  const slot = document.createElement('span');
  slot.className = 'slot folder ' + variant + (active ? ' folderActive' : '');
  slot.setAttribute('aria-hidden', 'true');
  const svg = iconSvg(variant === 'folderOpen' ? 'folderOpen' : 'folderClosed', { size: 16 });
  if (svg) slot.appendChild(svg);
  return slot;
}

/** chevron slot（hover 显露；arrow rotate 90° = 展开；dsh 150ms 过渡）。 */
function buildChevronSlot() {
  const chev = document.createElement('span');
  chev.className = 'slot chevron';
  chev.setAttribute('aria-hidden', 'true');
  const chevSvg = iconSvg('chevronRight', { size: 16, className: 'arrow' });
  if (chevSvg) chev.appendChild(chevSvg);
  return chev;
}

/**
 * index.html 静态图标槽（`<svg data-icon-glyph="…">`：头部「添加工作区」/空态
 * 「选择工作区…」）→ 以 icons.js 一笔画描边图标替换 —— 单一 d 串来源，
 * 静态标记只留占位（永不 inline 手写 path 以免两处漂移）。
 */
function mountStaticIconGlyphs() {
  for (const slot of document.querySelectorAll('svg[data-icon-glyph]')) {
    const name = slot.dataset.iconGlyph ?? '';
    const size = Number(slot.dataset.iconSize) || 16;
    const svg = iconSvg(name, { size });
    if (!svg) continue;
    const cls = slot.getAttribute('class');
    if (cls) svg.setAttribute('class', cls);
    slot.replaceWith(svg);
  }
}

/**
 * 工作区组（dsh WorkspaceBrowser .groupSection）：组头 = ProjectRowItem（folder slot ↔
 * hover chevron 互换、34px、title = 根 basename + meta 小字路径）+ 会话行。
 * - 组折叠 per-workspace（持久化 devmate.ui.wsCollapsed；默认展开）；
 * - 组头 kebab（移除工作区；默认根禁用）+ 组内 ＋（新建会话于该组）——
 *   仅 registered 组提供（「未知项目」无操作项 —— dsh ungrouped 语义）。
 * 点击走 wsGroups 委托收口；键盘（Enter/Space）在组头自身监听。
 */
function buildWorkspaceGroup(group) {
  const section = document.createElement('section');
  section.className = 'groupSection wsGroup';
  section.dataset.wsRoot = group.workspaceRoot ?? '';
  section.setAttribute('role', 'treeitem');
  section.setAttribute('aria-expanded', String(!ui.wsCollapsed[group.workspaceRoot ?? '']));

  const rootKey = group.workspaceRoot ?? '';
  const expanded = !ui.wsCollapsed[rootKey];
  const head = document.createElement('div');
  head.className = 'projectRow wsGroupHead';
  head.dataset.wsRoot = rootKey;
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', String(expanded));
  const bodyId = `ws-body-${String(ui.groupSeq++)}`;
  head.setAttribute('aria-controls', bodyId);
  head.title = group.workspaceRoot ?? group.label;

  const active = expanded && group.registered && group.workspaceRoot === currentSessionRoot();
  for (const variant of ['folderOpen', 'folderClose']) {
    head.appendChild(buildFolderSlot(variant, active));
  }
  head.appendChild(buildChevronSlot());

  const text = document.createElement('span');
  text.className = 'projectText';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = group.label;
  text.appendChild(title);
  if (group.workspaceRoot !== null) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = workspacePathMeta(group.workspaceRoot, null);
    meta.title = group.workspaceRoot;
    text.appendChild(meta);
  }
  head.appendChild(text);

  // rowActions（dsh ProjectRowItem：kebab + 组内新建 ＋—— 仅 hover 显露）
  if (group.registered && group.workspaceRoot !== null) {
    const actions = document.createElement('span');
    actions.className = 'rowActions';
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'rowIconButton';
    plus.dataset.wsPlus = group.workspaceRoot;
    plus.setAttribute('aria-label', `新建会话：${group.label}`);
    plus.title = `新建会话：${group.label}`;
    plus.appendChild(iconSvg('plus', { size: 16 }));
    const kebab = document.createElement('button');
    kebab.type = 'button';
    kebab.className = 'rowIconButton';
    kebab.dataset.wsKebab = group.workspaceRoot;
    kebab.disabled = group.workspaceRoot === ui.wsDefaultRoot;
    kebab.setAttribute('aria-label', `工作区操作：${group.label}`);
    kebab.title =
      group.workspaceRoot === ui.wsDefaultRoot
        ? '默认工作区不可移除'
        : `工作区操作：${group.label}`;
    kebab.appendChild(iconSvg('kebab', { size: 16 }));
    actions.append(plus, kebab);
    head.appendChild(actions);
  }

  const body = document.createElement('ul');
  body.className = 'rowList groupList';
  body.id = bodyId;
  body.hidden = !expanded;
  for (const s of group.sessions) body.appendChild(buildSessionItem(s));
  section.append(head, body);

  head.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleWsGroup(head);
    }
  });
  return section;
}

/** 组头折叠切换（aria-expanded 级联本体 hidden；per-workspace 持久化）。 */
function toggleWsGroup(head) {
  const root = head.dataset.wsRoot ?? '';
  const expanded = head.getAttribute('aria-expanded') === 'true';
  head.setAttribute('aria-expanded', String(!expanded));
  const body = document.getElementById(head.getAttribute('aria-controls') ?? '');
  if (body) body.hidden = expanded;
  // 折叠映射持久化（默认展开 = 无记录；写入即记住）—— 只写本组，不整表重放
  ui.wsCollapsed = { ...ui.wsCollapsed, [root]: expanded };
  saveWorkspaceCollapse(localStorage, ui.wsCollapsed);
}

/** 当前会话变化（恢复/新建/删除当前）后的选中态即时同步：缓存重渲染（不进网络）。 */
function refreshSessionSelection() {
  if (!ui.sessionsLoaded) return;
  renderSessionList(ui.sessionItems);
}

/** 侧栏条目 = 会话（Session），不是「对话」视图 —— 侧栏区块标题「对话」为产品措辞
 *  （用户指定保留），条目点击恢复的是会话（GET /api/sessions/:id）；术语见 CONTEXT.md。 */
function buildSessionItem(s) {
  const li = document.createElement('li');
  li.className = 'sessionRow' + (s.sessionId === ui.sessionId ? ' selected' : '');
  li.dataset.sessionId = s.sessionId;
  const titleText = sessionDisplayTitle(s, shortId);
  li.title = titleText;

  // slot（16px 状态槽）：当前会话 = 状态点（dsh StateDot 同族），其余空槽
  const slot = document.createElement('span');
  slot.className = 'slot';
  if (s.sessionId === ui.sessionId) {
    const dot = document.createElement('span');
    dot.className = 'statusDot';
    dot.setAttribute('aria-hidden', 'true');
    slot.appendChild(dot);
  }
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = titleText;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = s.updatedAt ? timeAgo(s.updatedAt) : '';
  // rowActions：kebab → Menu（删除）；hover 显露、time 让位（CSS）
  const actions = document.createElement('span');
  actions.className = 'rowActions';
  const kebab = document.createElement('button');
  kebab.type = 'button';
  kebab.className = 'rowIconButton';
  kebab.dataset.kebab = '';
  kebab.setAttribute('aria-label', `会话操作：${titleText}`);
  kebab.appendChild(iconSvg('kebab', { size: 16 }));
  actions.appendChild(kebab);
  li.append(slot, title, time, actions);
  return li;
}

// ============================================================== 多工作区（S14：dsh WorkspaceBrowser / WorkspacePickFlow）

/**
 * 注册表重读：GET /api/workspaces → 注册根 + 默认根启发（roots[0]）；
 * 失败 → wsLoaded=false 但**保留最后已知表**（会话仍在跑时端点瞬断不捣乱）——
 * 组渲染随 effectiveWorkspaceRoots 降级为会话根并集。成功后重渲染组。
 */
async function refreshWorkspaces() {
  try {
    const roots = normalizeWorkspaceRoots(await fetchJson('/api/workspaces'));
    ui.workspaces = roots;
    ui.wsDefaultRoot = pickDefaultRoot(roots);
    ui.wsLoaded = true;
  } catch {
    ui.wsLoaded = false;
  }
  refreshSessionSelection();
  void refreshSessionList(true);
}

// ---- ＋新建 菜单（dsh WorkspacePickFlow：锚于「＋新建」按钮 —— 工作区列表 +
//      勾选当前 + 分隔 + 底部钉置「添加工作区…」；默认根项在下） ----

/** 菜单装载（打开时重建 —— 菜单随数据变化即时一致）。 */
function buildWsNewMenu() {
  el.wsNewMenu.replaceChildren();
  const loaded = ui.wsLoaded || ui.workspaces.length > 0;
  const currentRoot = currentSessionRoot();
  if (ui.wsLoaded && ui.workspaces.length === 0) {
    const note = document.createElement('div');
    note.className = 'wsMenuNote';
    note.textContent = '暂无可用工作区：先添加一个。';
    el.wsNewMenu.appendChild(note);
  }
  const items = workspaceMenuOrder(ui.workspaces, ui.wsDefaultRoot);
  for (const root of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wsMenuItem';
    btn.dataset.wsRoot = root;
    btn.setAttribute('role', 'menuitem');
    const icon = document.createElement('span');
    icon.className = 'wsMenuItemIcon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(iconSvg('folderClosed', { size: 16 }));
    const label = document.createElement('span');
    label.className = 'wsMenuItemLabel';
    label.textContent = workspaceName(root);
    label.title = root;
    const meta = document.createElement('span');
    meta.className = 'wsMenuItemMeta';
    meta.textContent = workspacePathMeta(root, null);
    btn.append(icon, label, meta);
    if (root === currentRoot) {
      const check = document.createElement('span');
      check.className = 'wsMenuItemCheck';
      check.setAttribute('aria-hidden', 'true');
      check.appendChild(iconSvg('check', { size: 16 }));
      btn.appendChild(check);
      btn.setAttribute('aria-checked', 'true');
    } else {
      btn.setAttribute('aria-checked', 'false');
    }
    btn.addEventListener('click', () => {
      const targetRoot = root;
      closeWsNewMenu();
      void newSession(targetRoot);
    });
    el.wsNewMenu.appendChild(btn);
  }
  if (!loaded && items.length === 0) {
    const note = document.createElement('div');
    note.className = 'wsMenuNote';
    note.textContent = WS_DEGRADED_NOTE + ' 新建会话将使用默认工作区。';
    el.wsNewMenu.appendChild(note);
  }
  // 分隔 + 底部钉置「添加工作区…」（dsh Menu footer：恒可见的侧边选项）
  const sep = document.createElement('div');
  sep.className = 'wsMenuSeparator';
  sep.setAttribute('aria-hidden', 'true');
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'wsMenuItem';
  addBtn.dataset.wsMenuAdd = '';
  addBtn.setAttribute('role', 'menuitem');
  const addIcon = document.createElement('span');
  addIcon.className = 'wsMenuItemIcon';
  addIcon.setAttribute('aria-hidden', 'true');
  addIcon.appendChild(iconSvg('plus', { size: 16 }));
  const addLabel = document.createElement('span');
  addLabel.className = 'wsMenuItemLabel';
  addLabel.textContent = '添加工作区…';
  addBtn.append(addIcon, addLabel);
  addBtn.addEventListener('click', () => {
    closeWsNewMenu();
    openWsPicker();
  });
  el.wsNewMenu.append(sep, addBtn);
}

/** 菜单开关（固定定位、视口钳制 —— dsh Menu portal 语义的本地等价；
 *  —— 侧栏 rail 折叠态下按钮在 56px 轨上，fixed 定位逃出 overflow 剪裁）。 */
function toggleWsNewMenu(force) {
  const open = force !== undefined ? force : !ui.wsNewMenuOpen;
  if (open) {
    buildWsNewMenu();
    el.wsNewMenu.hidden = false;
    const size = { width: el.wsNewMenu.offsetWidth, height: el.wsNewMenu.offsetHeight };
    const rect = el.btnNewSession.getBoundingClientRect();
    const pos = menuPosition(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      size,
      { width: window.innerWidth, height: window.innerHeight },
    );
    el.wsNewMenu.style.left = `${pos.left}px`;
    el.wsNewMenu.style.top = `${pos.top}px`;
    ui.wsNewMenuOpen = true;
  } else {
    el.wsNewMenu.hidden = true;
    ui.wsNewMenuOpen = false;
  }
}

function closeWsNewMenu() {
  toggleWsNewMenu(false);
}

/** ---- 目录选择弹窗（dsh ui-directory-picker-browse 形态） ---- */

async function openWsPicker() {
  if (ui.wsPickerOpen) return;
  ui.wsPickerOpen = true;
  // 状态沿用上次浏览落点（错误重试路径）：全新打开 = createBrowseState→home
  if (ui.wsPickerState === null) ui.wsPickerState = createBrowseState('');
  ui.wsPickerBrowseFailed = false;
  el.wsManualInput.value = '';
  el.wsPickerScrim.hidden = false;
  el.wsPicker.hidden = false;
  renderWsPicker();
  await wsPickerFetch(null);
  el.btnWsPickerCancel.focus();
}

function closeWsPicker() {
  if (!ui.wsPickerOpen) return;
  ui.wsPickerOpen = false;
  ui.wsPickerBrowseFailed = false;
  el.wsPicker.hidden = true;
  el.wsPickerScrim.hidden = true;
}

/** 当前级目录拉取（path=null 时无参 = homedir；失败容错：空表 + 说明行）。
 *  乱序收敛：序号递增，过期响应（非最新一发）丢弃 —— 快速连点/连回车不串级。 */
async function wsPickerFetch(path) {
  const seq = ++ui.wsPickerFetchSeq;
  const query = typeof path === 'string' && path !== '' ? `?path=${encodeURIComponent(path)}` : '';
  let res = null;
  try {
    res = normalizeBrowse(await fetchJson(`/api/workspaces/browse${query}`));
  } catch {
    res = null;
  }
  if (seq !== ui.wsPickerFetchSeq) return;
  ui.wsPickerBrowseFailed = res === null;
  ui.wsPickerState = browseLoaded(
    ui.wsPickerState,
    res ?? { base: typeof path === 'string' ? path : ui.wsPickerState.base, dirs: [] },
  );
  renderWsPicker();
}

/** 进级（目录行进级/面包屑）：browseNavigate 置在途 → 渲染 → 拉取新级。 */
async function wsPickerEnter(path) {
  const next = browseNavigate(ui.wsPickerState, path);
  if (next === ui.wsPickerState) return;
  ui.wsPickerState = next;
  renderWsPicker();
  await wsPickerFetch(path);
}

/** 回退上级（`..` 行）：browseUp 仅弹栈（根 base 不逃逸）。 */
async function wsPickerGoUp() {
  const next = browseUp(ui.wsPickerState);
  if (next === ui.wsPickerState) return;
  ui.wsPickerState = next;
  renderWsPicker();
  await wsPickerFetch(next.base);
}

/** 面包屑分段：略去末段（当前级）；先弹栈至目标前缀，非前缀才走进级。 */
async function wsPickerGoBreadcrumb(path) {
  if (path === ui.wsPickerState.base) return;
  let state = ui.wsPickerState;
  let guard = 0;
  while (state.base !== path && state.stack.length > 0 && guard++ < 64) state = browseUp(state);
  if (state.base !== path) state = browseNavigate(state, path);
  ui.wsPickerState = state;
  renderWsPicker();
  await wsPickerFetch(state.base);
}

/** 选中当前级目录（行点击；selected 清空/切换由状态机裁决）。 */
function wsPickerSelect(path) {
  ui.wsPickerState = browseSelect(ui.wsPickerState, path);
  renderWsPicker();
}

/** 手动路径输入（回车）：绝对路径校验 → 进入该级并**自动选中该目录**（便于直接
 *  「选择此文件夹」）；未命中/非法 → 错误对话框兜底。 */
async function wsPickerManualEnter() {
  const value = el.wsManualInput.value.trim();
  if (value === '') return;
  if (!isAbsolutePath(value)) {
    await openWsError('路径无效：必须是绝对目录路径。');
    return;
  }
  const state = ui.wsPickerState;
  const next = browseNavigate(state, value);
  if (next === state) {
    // 同路径/无变化：直接落点 base（「在此级选中即注册」）
    ui.wsPickerState = browseSelect(state, value);
    renderWsPicker();
    return;
  }
  ui.wsPickerState = browseSelect(next, value);
  renderWsPicker();
  await wsPickerFetch(value);
}

function renderWsPicker() {
  const state = ui.wsPickerState;
  // 路径条（面包屑：分段可点，末段当前级不可点）
  el.wsCrumbs.replaceChildren();
  const crumbs = breadcrumbSegments(state.base);
  crumbs.forEach((segment, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-crumb' + (index === 0 ? ' root' : '');
    btn.textContent = segment.name;
    btn.title = segment.path;
    if (index === crumbs.length - 1) {
      btn.disabled = true;
      btn.classList.add('current');
      btn.setAttribute('aria-current', 'location');
      btn.style.cursor = 'default';
    } else {
      btn.addEventListener('click', () => {
        void wsPickerGoBreadcrumb(segment.path);
      });
    }
    el.wsCrumbs.appendChild(btn);
  });
  if (crumbs.length === 0) el.wsCrumbs.textContent = '（路径不可用）';

  // 目录行（`..` 恒首行；行点击选中，双击/回车进级）
  el.wsDirs.replaceChildren();
  if (state.stack.length > 0) {
    const up = document.createElement('li');
    up.className = 'ws-picker-dir up';
    up.tabIndex = 0;
    up.setAttribute('role', 'button');
    const icon = document.createElement('span');
    icon.className = 'ws-dirIcon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(iconSvg('upDir', { size: 16 }));
    const name = document.createElement('span');
    name.className = 'ws-dirName';
    name.textContent = '..';
    up.append(icon, name);
    up.addEventListener('click', () => {
      void wsPickerGoUp();
    });
    up.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void wsPickerGoUp();
      }
    });
    el.wsDirs.appendChild(up);
  }
  for (const dir of state.dirs) {
    const li = document.createElement('li');
    li.className = 'ws-picker-dir' + (state.selected === dir.path ? ' selected' : '');
    li.dataset.dirPath = dir.path;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const icon = document.createElement('span');
    icon.className = 'ws-dirIcon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(iconSvg('folderClosed', { size: 16 }));
    const name = document.createElement('span');
    name.className = 'ws-dirName';
    name.textContent = dir.name;
    name.title = dir.path;
    li.append(icon, name);
    li.addEventListener('click', () => {
      wsPickerSelect(dir.path);
    });
    li.addEventListener('dblclick', () => {
      void wsPickerEnter(dir.path);
    });
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void wsPickerEnter(dir.path);
      }
    });
    el.wsDirs.appendChild(li);
  }
  if (state.dirs.length === 0 && state.stack.length === 0 && ui.wsPickerBrowseFailed) {
    const note = document.createElement('li');
    note.className = 'ws-picker-empty';
    note.textContent = WS_DEGRADED_NOTE + ' 可在下方手动输入路径。';
    el.wsDirs.appendChild(note);
  } else if (state.dirs.length === 0) {
    const note = document.createElement('li');
    note.className = 'ws-picker-empty';
    note.textContent = '（此目录下没有子目录）';
    el.wsDirs.appendChild(note);
  }
  el.btnWsPickerSelect.disabled = !browseCanCommit(state);
}

/** 「选择此文件夹」：选中目录 → POST 注册；错误 → dsh folderError 对话框（重试重开）。 */
async function wsPickerCommit() {
  const path = ui.wsPickerState?.selected;
  if (typeof path !== 'string' || path === '') return;
  el.btnWsPickerSelect.disabled = true;
  try {
    await fetchJson('/api/workspaces', { method: 'POST', body: { path } });
    toast(`已添加工作区「${workspaceName(path)}」`);
    closeWsPicker();
    ui.wsPickerState = null; // 下次打开回 homedir
    await refreshWorkspaces();
  } catch (err) {
    el.btnWsPickerSelect.disabled = false;
    await openWsError(workspaceErrorInfo(err).text);
  }
}

/** 错误对话框（dsh folderError：标题 + 文案 + 取消/重试 —— 重试重开目录弹窗）。 */
async function openWsError(text) {
  ui.wsErrorOpen = true;
  ui.wsErrorText = text;
  el.wsErrorText.textContent = text;
  el.wsErrorScrim.hidden = false;
  el.wsError.hidden = false;
  el.btnWsErrorRetry.focus();
}

function closeWsError() {
  if (!ui.wsErrorOpen) return;
  ui.wsErrorOpen = false;
  el.wsError.hidden = true;
  el.wsErrorScrim.hidden = true;
}

function retryWsError() {
  closeWsError();
  closeWsPicker();
  void openWsPicker(); // 保持上次浏览落点（state 未清 —— 错误后直接在原级重试）
}

/** ---- 移除工作区（kebab 菜单 → 确认 modal → DELETE；删除失败 400 回授默认根标记） ---- */

function requestRemoveWorkspace(root) {
  if (ui.wsRemoveOpen) return;
  ui.wsRemoveTarget = root;
  ui.wsRemoveOpen = true;
  el.wsRemoveText.textContent = `确认移除工作区「${workspaceName(root)}」？其下会话保留（归入「未知项目」）。`;
  el.wsRemoveScrim.hidden = false;
  el.wsRemoveConfirm.hidden = false;
  el.btnWsRemoveOk.focus();
}

function closeWsRemove() {
  ui.wsRemoveOpen = false;
  ui.wsRemoveTarget = null;
  el.wsRemoveConfirm.hidden = true;
  el.wsRemoveScrim.hidden = true;
}

async function confirmRemoveWorkspace() {
  const root = ui.wsRemoveTarget;
  closeWsRemove();
  if (!root) return;
  try {
    await fetchJson(`/api/workspaces/${encodeURIComponent(root)}`, { method: 'DELETE' });
    toast(`已移除工作区「${workspaceName(root)}」`);
  } catch (err) {
    const info = workspaceErrorInfo(err);
    if (info.kind === 'default-root') {
      // 回授校正：DELETE 400 即该根为默认根（客户端启发错位 → 学会并即时禁用）
      ui.wsDefaultRoot = root;
      toast(info.text, 'warn');
      refreshSessionSelection();
    } else {
      toast(`移除失败：${info.text}`, 'warn');
    }
  }
  void refreshWorkspaces();
}

// ---- 底部统计（/api/stats，纯展示；随 run-status 终态刷新） ----

async function refreshStats() {
  try {
    const stats = normalizeStats(await fetchJson('/api/stats'));
    el.statsLine.textContent = formatStatsLine(stats);
  } catch {
    // 端点未实现：保留占位（内存 – · 会话 – · Shell –）
  }
}

// ============================================================== 会话切换协调（S13-B：单流）

/**
 * 关闭旧会话流的 broker（长活流唯一的关闭点；直接 abort，服务端落
 * SSE 连接的 close 路径）。Open 中的新流未受影响 —— ensureStream 的
 * finally 由 streams.js 闸门做「引用相等」守卫（旧流收尾不清新流状态）。
 */
function closeStreamForSwitch() {
  streamGate.current()?.ctrl.abort();
}

/**
 * 恢复会话（点击列表项）——单流协调时序（任务书；**代码执行顺序**如下）：
 * 1) 关旧流 broker → 2) store.reset + GET /api/sessions/:id 回放（协议形状事件 → dispatch）
 * 3) 旧 run 视状态 POST /api/interrupt（best-effort，见 api.js backswitch）
 * → 4) UI 收口（选中态/列表/统计/「已恢复」toast）→ 5) ensureStream(新会话)。
 * 注：interrupt 在回放后发出（代码序如此）——回放不阻塞、中断不阻塞（best-effort）。
 * 期间 UI 不锁（历史拉取失败降级为系统提示 + 空视图，照常开流）。
 * 4 必须先于 5：流长活（run 结束不关、心跳保活，仅切会话/出错才闭），ensureStream 的
 * await 在流关闭前不返回 —— toast 与列表刷新排在之后即永远不发出。
 */
async function restoreSession(id) {
  if (!id) return;
  if (id === ui.sessionId && store.snapshot().items.length > 0) {
    // 恢复的就是当前已渲染会话：列表选中态已在 renderSessionList 同步 —— 无事可做
    return;
  }
  const previousSessionId = ui.sessionId;
  const previousRunActive = store.snapshot().runActive;

  closeStreamForSwitch(); // 1) 先关旧流 broker
  ui.sessionId = id;
  localStorage.setItem(LS_SESSION, id);
  store.reset();
  store.setSessionId(id);

  // 2) 回放历史（协议形状事件；失败降级为系统提示 + 空视图，流仍然照常接）
  let restored = null;
  try {
    restored = normalizeSessionDetail(await fetchJson(`/api/sessions/${encodeURIComponent(id)}`));
  } catch (err) {
    store.addSystem(
      `会话历史拉取失败：${err instanceof Error ? err.message : String(err)}`,
      'info',
    );
  }
  if (restored?.title) store.setTitle(restored.title);
  for (const ev of restored?.events ?? []) store.dispatch(ev);
  // 回放去重守卫：GET 覆盖的事务（用户文本序 + done 帧数）已是全量视图 —— 随后
  // ensureStream 接入的 broker 重放窗将投出同序帧（含直播合成的 delta），逐段丢弃。
  // GET 失败（空窗时兜底历史拉空）→ 解防（重放窗即时序本体，照常渲染）。
  if (restored) {
    const coveredUsers = (restored.events ?? [])
      .filter((e) => e?.event === 'session-user' && e?.data?.system !== true)
      .map((e) => String(e?.data?.text ?? ''));
    const coveredDone = (restored.events ?? []).filter((e) => e?.event === 'assistant-done').length;
    replayGuard.arm(coveredUsers, coveredDone);
  } else {
    replayGuard.clear();
  }
  if (restored && restored.truncated) {
    store.addSystem(
      `对话较长：本次载入最近 ${restored.events.length} 条事件（共 ${restored.totalCount} 条）。`,
      'info',
    );
  }

  // 3) 旧 run 视状态中断（不阻塞切换；旧会话继续跑的 shell 由服务端 close 兜底）
  await backswitch(previousSessionId, previousRunActive);

  // 4) UI 收口先行：toast 与列表/统计刷新不得排在长活流 await 之后 —— 流长活
  //    （run 结束不关，仅切会话/出错才闭），await 返回即流关闭，提示将永不显示。
  refreshSessionSelection();
  void refreshSessionList(true);
  void refreshStats();
  toast(`已恢复会话 #${shortId(id)}`);

  // 5) 换绑新流（连接在后台保持；其上的 UI 收口不得再依赖本 await 的顺序）
  await ensureStream(id);
}

/**
 * ＋新建：POST /api/sessions（未实现时回退「首条消息创建」）。
 * @param {string|null} workspaceRoot 目标工作区根（来自 ＋新建菜单/组头 ＋；
 *   null = 服务端默认根）。未注册 → 400 workspace-not-registered（容错映射 + 重读注册表）。
 */
async function newSession(workspaceRoot = null) {
  let id = null;
  let created = false;
  try {
    const res = await fetchJson('/api/sessions', {
      method: 'POST',
      // 显式传 null 也省略键：不带 workspaceRoot = 服务端默认根
      ...{ body: workspaceRoot ? { workspaceRoot } : {} },
    });
    id = res?.sessionId ?? null;
    created = Boolean(id);
  } catch (err) {
    // 服务端未实现预建端点：本地进入全新视图，首条消息经 /api/chat 建会话；
    // 已实现但工作区未注册（表已漂移）→ 提示 + 重读注册表（下轮再试）
    if (workspaceRoot !== null && workspaceErrorInfo(err).kind === 'not-registered') {
      toast(workspaceErrorInfo(err).text, 'warn');
      await refreshWorkspaces();
    }
  }
  const previousSessionId = ui.sessionId;
  const previousRunActive = store.snapshot().runActive;

  closeStreamForSwitch();
  ui.sessionId = id;
  if (id) localStorage.setItem(LS_SESSION, id);
  else localStorage.removeItem(LS_SESSION);
  store.reset();
  store.setSessionId(id);
  replayGuard.clear(); // 新会话无 GET 回放覆盖序 —— 守卫拆除（重放窗即时序本体）

  await backswitch(previousSessionId, previousRunActive);

  // UI 收口先行（同 restoreSession：toast/列表刷新排在长活流 await 之前发出 ——
  // 流长活不结束则 await 不返回，提示与刷新将永不发生）
  refreshSessionSelection();
  toast(created ? '已新建会话' : '已切换到新会话（发送后将自动创建会话）');
  void refreshSessionList(true);

  // 换绑新流（长活流；服务端未实现预建端点时 id=null —— 下一条消息经 /api/chat 建会话）
  if (id) await ensureStream(id);
}

function requestDeleteSession(s) {
  if (ui.confirmOpen) return;
  ui.pendingDelete = s;
  ui.confirmOpen = true;
  el.confirmText.textContent = `确认删除会话「${sessionDisplayTitle(s, shortId)}」？不可恢复。`;
  el.confirmScrim.hidden = false;
  el.confirm.hidden = false;
  el.btnConfirmOk.focus();
}

function closeConfirmModal() {
  ui.confirmOpen = false;
  ui.pendingDelete = null;
  el.confirm.hidden = true;
  el.confirmScrim.hidden = true;
}

async function confirmDeleteSession() {
  const s = ui.pendingDelete;
  closeConfirmModal();
  if (!s) return;
  try {
    await fetchJson(`/api/sessions/${encodeURIComponent(s.sessionId)}`, { method: 'DELETE' });
    if (s.sessionId === ui.sessionId) {
      // 删除的是当前会话：脱离流 + 全新视图（下一条消息建新会话）
      closeStreamForSwitch();
      ui.sessionId = null;
      localStorage.removeItem(LS_SESSION);
      store.reset();
      store.setSessionId(null);
    }
    toast('会话已删除');
  } catch (err) {
    // 语义判断（api.isStatus）替代 message.includes('409')：状态码以 err.status 为权威
    if (isStatus(err, 409)) toast('会话正在运行：先停止再删除', 'warn');
    else {
      toast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'warn');
    }
  }
  refreshSessionSelection();
  void refreshSessionList(true);
}

// ============================================================== 流式重绘

/** 惰性 rAF：同一帧内多次置脏只重绘一次（高频 delta 时保持平滑）。 */
function schedulePaint(id) {
  ui.dirtyItems.add(id);
  if (ui.rafPending) return;
  ui.rafPending = true;
  requestAnimationFrame(() => {
    ui.rafPending = false;
    const ids = [...ui.dirtyItems];
    ui.dirtyItems.clear();
    for (const i of ids) paintAssistant(i);
  });
}

/** 助手气泡：稳定部分（最后一个换行之前）走 markdownToDOM（textContent 纯路径），
 *  尾段（最后一个换行之后）直接 pre-wrap 文本 + 流式光标 —— 兼顾安全与性能。 */
function paintAssistant(id) {
  const node = ui.rendered.get(id);
  const view = ui.lastSnap?.items.find((it) => it.id === id);
  if (!node || !view) return;
  const body = node._body;
  const text = view.text;

  let stable = text;
  let tail = '';
  if (!view.done) {
    const idx = text.lastIndexOf('\n');
    if (idx >= 0) {
      stable = text.slice(0, idx);
      tail = text.slice(idx + 1);
    } else {
      tail = text;
    }
  }
  markdownToDOM(body, stable);
  if (tail) {
    const tailEl = document.createElement('span');
    tailEl.className = 'streaming-tail';
    tailEl.textContent = tail;
    body.appendChild(tailEl);
  }
  if (!view.done) {
    const cur = document.createElement('span');
    cur.className = 'cursor';
    cur.setAttribute('aria-hidden', 'true');
    body.appendChild(cur);
  }
  if (view.error) {
    let err = node._errorEl;
    if (!err) {
      err = document.createElement('div');
      err.className = 'msg-error';
      node._errorEl = err;
      body.appendChild(err);
    }
    err.textContent = view.error;
  }
}

// ============================================================== 消息装配（Wave 2：dsh 行级 meta）

/**
 * 行 meta（dsh MessageIconActions 局部形态：**消息正文下 hover 显现**）：
 * 时钟（formatMessageClock 分日模板）+ icon-actions（复制 clipboard —— 成功换对勾 1s）。
 * 无作者标题行（dsh 无；DevMate 旧「DevMate · 工作中」作者 meta 已删 —— meta 精简去重）。
 * 位置 = 行尾弱化 caption。author 由位置 + 侧栏品牌承载。
 */
function buildMessageMeta() {
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const time = document.createElement('time');
  time.className = 'msg-time';
  const ran = document.createElement('span');
  ran.className = 'msg-run';
  ran.hidden = true;
  const actions = document.createElement('span');
  actions.className = 'icon-actions';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'icon-action';
  copyBtn.setAttribute('aria-label', '复制消息');
  copyBtn.title = '复制消息';
  copyBtn.append(copyActionIcon('copy'), copyActionIcon('check'));
  copyBtn.addEventListener('click', () => {
    void copyMessageFeedback(meta.dataset.itemId, copyBtn);
  });
  actions.appendChild(copyBtn);
  meta.append(time, ran, actions);
  return { root: meta, time, ran };
}

function copyActionIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  if (kind === 'copy') {
    svg.setAttribute('class', 'ic-copy');
    path.setAttribute(
      'd',
      'M5.6 3.2h5.6l2 2v4.9a.9.9 0 0 1-.9.9H6.5a.9.9 0 0 1-.9-.9v-6.9zm2.6 8.3v.6c0 .5-.4.9-.9.9H4.3a.9.9 0 0 1-.9-.9V6.4c0-.5.4-.9.9-.9h.6',
    );
  } else {
    svg.setAttribute('class', 'ic-check');
    path.setAttribute('d', 'M3.6 8.6l3 3 5.8-7');
  }
  svg.appendChild(path);
  return svg;
}

/** 复制反馈（icon-actions 复制 → 对勾 1s 复原；dsh MessageIconActions 同语义）。 */
function copyMessageFeedback(itemId, btn) {
  const view = ui.lastSnap?.items.find((it) => it.id === itemId) ?? null;
  const text = messageCopyText(view);
  if (!text) return;
  void copyText(text).then((ok) => {
    if (!ok) {
      toast('复制失败', 'warn');
      return;
    }
    btn.classList.add('copied');
    btn.setAttribute('aria-label', '已复制');
    btn.title = '已复制';
    window.clearTimeout(btn._copyTimer);
    btn._copyTimer = window.setTimeout(() => {
      btn.classList.remove('copied');
      btn.setAttribute('aria-label', '复制消息');
      btn.title = '复制消息';
    }, CLIPBOARD_FEEDBACK_MS);
  });
}

/** clipboard API 优先；非安全上下文/被拒 → 隐藏 textarea + execCommand 兜底。 */
function copyText(text) {
  const t = String(text ?? '');
  if (!t) return Promise.resolve(false);
  try {
    const nav = navigator.clipboard;
    if (nav && typeof nav.writeText === 'function') {
      return nav.writeText(t).then(
        () => true,
        () => legacyCopy(t),
      );
    }
  } catch {
    // 非安全上下文等：落兜底
  }
  return Promise.resolve(legacyCopy(t));
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = String(text);
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** 思考折叠行（dsh ReasoningRow 本地形态：default 收起；摘要 = 定稿首行 / 流式末行）。 */
function buildThinkRow(itemId) {
  const root = document.createElement('div');
  root.className = 'think-row';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'think-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.title = '思考过程';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('class', 'think-icon');
  icon.setAttribute('aria-hidden', 'true');
  const bulb = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  bulb.setAttribute('fill', 'none');
  bulb.setAttribute('stroke', 'currentColor');
  bulb.setAttribute('stroke-width', '1.2');
  bulb.setAttribute(
    'd',
    'M8 2.2a3.7 3.7 0 0 1 3.7 3.7c0 1.5-.9 2.4-1.6 3.1-.3.3-.5.6-.5.9H6.4c0-.3-.2-.6-.5-.9-.7-.7-1.6-1.6-1.6-3.1A3.7 3.7 0 0 1 8 2.2zM6.6 10.6h2.8v1H6.6zM6.7 12.2h2.6v1H6.7z',
  );
  icon.appendChild(bulb);
  const caption = document.createElement('span');
  caption.className = 'think-caption';
  caption.textContent = '思考';
  const summary = document.createElement('span');
  summary.className = 'think-summary';
  const body = document.createElement('div');
  body.className = 'think-body';
  body.hidden = true;
  toggle.append(icon, caption, summary);
  root.append(toggle, body);
  const think = {
    root,
    toggle,
    body,
    open: false,
    built: false,
    current: '',
    itemId,
  };
  // 惰性：全文只在首次展开时写入 textContent；展开期间流式增量即时跟随（接管写入）
  toggle.addEventListener('click', () => {
    const open = think.open;
    think.open = !open;
    toggle.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
    if (!open) {
      // 展开：全文首次懒写入（超限截断 + 注记）
      body.textContent = thinkBodyText(think.current);
      think.built = true;
    }
  });
  return think;
}

/** 思考行增量同步（renderItems 每帧收口）：摘要位/展开态/收尾收起（dsh 定稿收起）。 */
function updateThink(think, item) {
  const has = Boolean(item.reasoning);
  if (!has) {
    think.root.hidden = true;
    return;
  }
  think.root.hidden = false;
  think.current = item.reasoning;
  think.toggle.querySelector('.think-summary').textContent = thinkSummary(
    item.reasoning,
    item.done,
  );
  // 定稿收尾：回到默认收起（dsh 语义——流式期间可手动展开选中，done 后收起）
  if (item.done && think.open) {
    think.open = false;
    think.toggle.setAttribute('aria-expanded', 'false');
    think.body.hidden = true;
  }
  // 展开：跟随流式增量（懒写入窗口已开 —— 折叠时 body 为空，不占 DOM）
  if (think.open) {
    think.body.textContent = thinkBodyText(think.current);
    think.built = true;
  }
}

function createItemEl(item) {
  // 渲染形态单一分类入口（纯函数 msgKind，messages.js：哨兵 'sys' 归一/未知兜底）
  const kind = msgKind(item);
  const row = document.createElement('div');
  row.className = `msg-row ${kind}`;
  row.dataset.id = item.id;
  if (kind === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const text = document.createElement('span');
    text.className = 'bubble-text';
    text.textContent = item.text; // 纯文本（CSS pre-wrap 保留换行）
    bubble.appendChild(text);
    // 行 meta 从「气泡内右上」移到气泡下方 hover 显现（dsh 行级 meta）
    const meta = buildMessageMeta();
    meta.root.dataset.itemId = item.id;
    meta.time.textContent = formatMessageClock(item.at);
    timeDateTime(meta.time, item.at);
    row.append(bubble, meta.root);
    row._metaTime = meta.time;
    row._metaRan = meta.ran;
  } else if (kind === 'assistant') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    // 思考折叠行（dsh ReasoningRow：先于正文 —— reasoning 常先于 delta 到达）
    const think = buildThinkRow(item.id);
    const body = document.createElement('div');
    body.className = 'markdown bubble-body';
    bubble.append(think.root, body);
    // 行 meta（正文/工具卡之后、行尾弱化 caption；hover 显现 —— 作者行已删）
    const meta = buildMessageMeta();
    meta.root.dataset.itemId = item.id;
    meta.time.textContent = formatMessageClock(item.at);
    timeDateTime(meta.time, item.at);
    row.append(bubble, meta.root);
    row._body = body;
    row._think = think;
    row._metaTime = meta.time;
    row._metaRan = meta.ran;
  } else if (kind === 'compaction') {
    // 上下文压缩披露（dsh context-injection-disclosure 理念本地形态）：
    // 折叠小记 —— 默认单行，展开才渲染摘要全文（懒惰；textContent only）
    const note = document.createElement('div');
    note.className = 'compaction-note';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'compaction-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = compactionLine(item);
    const body = document.createElement('div');
    body.className = 'compaction-body';
    body.hidden = true;
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
      note.classList.toggle('open', !open);
      // 摘要全文只在首次展开时渲染进 DOM（纯文本；折叠常驻只存字符串）。
      // 安全护栏：20k 上限截断 + 「…（截断）」注明（与 dsh 同类护栏）。
      if (!open && body.childElementCount === 0 && item.summary) {
        body.textContent = compactionSummary(item.summary);
      }
    });
    note.append(toggle, body);
    row.appendChild(note);
  } else if (kind === 'sys') {
    // R2-S2：评审哨兵系统样式消息（data.system===true 的 session-user 帧）——
    // 独立消息项：侧边居中 · 13/20 secondary · 浅色 elevation 面（无气泡 22px 圆角）、
    // 内联窄行、无折叠（纯说明行；折叠语义只属于 compaction 披露）。
    const note = document.createElement('span');
    note.className = 'sys-note';
    note.textContent = item.text;
    row.appendChild(note);
  } else {
    const chip = document.createElement('span');
    chip.className = 'system-chip' + (item.level === 'info' ? ' info' : '');
    chip.textContent = item.text;
    row.appendChild(chip);
  }
  return row;
}

/** <time> 机器可读值（原子集文案；dateTime 只认 number）。 */
function timeDateTime(timeEl, ts) {
  const t = Number(ts);
  if (Number.isFinite(t)) timeEl.dateTime = new Date(t).toISOString();
}

/**
 * 行 chrome 增量（dsh MessageIconActions：时钟 + Ran-for + 思考行；meta hover 显隐由
 * CSS 驱动 —— 本函数只写内容）。时钟分日模板单一源 = formatMessageClock；
 * Ran-for = 事件钟差（messages.js ranForMs，done 后才存在）。
 */
function updateRowChrome(node, item) {
  node._metaTime.textContent = formatMessageClock(item.at);
  if (typeof item.ranForMs === 'number' && item.ranForMs !== null) {
    node._metaRan.textContent = ranForCaption(item.ranForMs);
    node._metaRan.hidden = false;
  } else {
    node._metaRan.textContent = '';
    node._metaRan.hidden = true;
  }
  if (node._think) updateThink(node._think, item);
}

/** 长会话折叠摘要行：DOM 中恒为唯一一个（超限折叠计数来自 store.foldedCount）。 */
function renderFoldNote(snap) {
  if (snap.foldedCount > 0) {
    if (!ui.foldEl) {
      ui.foldEl = document.createElement('div');
      ui.foldEl.className = 'fold-note';
      ui.foldEl.setAttribute('aria-hidden', 'true');
      el.messages.insertBefore(ui.foldEl, el.messages.firstChild);
    }
    ui.foldEl.textContent = `（前 ${snap.foldedCount} 条消息已折叠）`;
  } else if (ui.foldEl) {
    ui.foldEl.remove();
    ui.foldEl = null;
  }
}

function renderItems(snap) {
  const seen = new Set();
  let structuralChange = false;
  for (const item of snap.items) {
    seen.add(item.id);
    let node = ui.rendered.get(item.id);
    if (!node) {
      node = createItemEl(item);
      ui.rendered.set(item.id, node);
      structuralChange = true;
    }
    if (item.kind === 'user') {
      if (node._sig !== item.text) {
        node._sig = item.text;
        node.querySelector('.bubble-text').textContent = item.text;
      }
    } else if (item.kind === 'assistant') {
      updateRowChrome(node, item);
      updateTools(node, item.tools);
      // 签名变化=内容变化（长度/定稿/出错翻转）→ 每帧至多重绘一次；
      // 已定稿且无新事件即不再重绘（修掉旧实现「每次 emit 全量重绘已完成消息」）。
      const sig = `${item.text.length}|${item.done}|${item.error ? 1 : 0}`;
      if (node._sig !== sig) {
        node._sig = sig;
        schedulePaint(item.id);
      }
    } else if (item.kind === 'compaction') {
      // 披露小记：内容在创建时一次性装配（不可变），此后无增量更新
    } else if (item.kind === 'sys') {
      // R2-S2：哨兵行一次性装配（不可变文本；防御性签名同步 —— 与 system 同模式）
      if (node._sig !== item.text) {
        node._sig = item.text;
        node.querySelector('.sys-note').textContent = item.text;
      }
    } else {
      if (node._sig !== `${item.level}|${item.text}`) {
        node._sig = `${item.level}|${item.text}`;
        node.querySelector('.system-chip').textContent = item.text;
      }
    }
  }
  // 清理消失节点（会话切换/重置）
  for (const [id, node] of ui.rendered) {
    if (!seen.has(id)) {
      node.remove();
      ui.rendered.delete(id);
    }
  }
  // 顺序单调：appendChild 移动语义保证与 snapshot 一致（折叠行恒为 container 首元素）
  if (structuralChange) {
    for (const item of snap.items) {
      const node = ui.rendered.get(item.id);
      if (node) el.messages.appendChild(node);
    }
  }
  el.empty.hidden = snap.items.length > 0;
  renderFoldNote(snap);
}

// ============================================================== 工具卡（Wave 2：ToolRow 变体）

/** 变体 leading 图标（14px currentColor；dsh ToolRow 各变体 icon 本地形态）。 */
function variantIconSvg(variant) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'tool-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  if (variant === 'bash') {
    path.setAttribute('d', 'M3.2 3.4h9.6v9.2H3.2zM5.6 6.2l2.1 1.9-2.1 1.9M9.2 10h1.8');
  } else if (variant === 'read') {
    path.setAttribute('d', 'M4.4 2.6h4.8l2.4 2.4v8.2H4.4zM9 2.8v2.4h2.5M5.8 8h4.4M5.8 10.4h4.4');
  } else if (variant === 'write' || variant === 'edit') {
    path.setAttribute('d', 'M3.5 12.5l.6-2.7 7.4-7.4 2.1 2.1-7.4 7.4-2.7.6z');
  } else if (variant === 'search') {
    path.setAttribute('d', 'M7 3.6a2.9 2.9 0 1 1-.01 5.8A2.9 2.9 0 0 1 7 3.6zM9.2 9.4l3.2 3.2');
  } else {
    path.setAttribute('d', 'M3.2 3.2h9.6v9.6H3.2zM6 6.4h.01M10 6.4h.01M6 10h.01M10 10h.01');
  }
  svg.appendChild(path);
  return svg;
}

/** 卡体（tool-body）按变体重建：generic = 参数/输出双卡（原形态）；bash/read =
 *  正文 mono 块；write/edit = DiffBlock；search = SearchBlock。**内容全惰性**：
 *  只有展开（或已在展开态收到更新）才写入 —— 折叠态零正文 DOM。 */
function ensureToolCardVariant(card, variant) {
  if (card._variant === variant) return;
  card._variant = variant;
  card._lazyBuilt = false;
  card._plan = null;
  const inner = card._inner;
  inner.replaceChildren();
  card._argLabel = null;
  card._args = null;
  card._result = null;
  card._lineEl = null;
  if (variant === 'generic') {
    const argsLabel = document.createElement('div');
    argsLabel.className = 'tool-args-label';
    argsLabel.textContent = '参数';
    const args = document.createElement('pre');
    args.className = 'tool-args';
    const outLabel = document.createElement('div');
    outLabel.className = 'tool-args-label';
    outLabel.textContent = '输出';
    const result = document.createElement('pre');
    result.className = 'tool-result';
    inner.append(argsLabel, args, outLabel, result);
    card._argLabel = argsLabel;
    card._args = args;
    card._result = result;
  } else if (variant === 'bash' || variant === 'read') {
    // Terminal/ReadBlock 形态粗版：单块 mono 滚动（bash 失败含错误首行红字）
    const outLabel = document.createElement('div');
    outLabel.className = 'tool-args-label';
    outLabel.textContent = variant === 'bash' ? '输出' : '内容';
    const block = document.createElement('pre');
    block.className = 'tool-block';
    inner.append(outLabel, block);
    card._argLabel = outLabel;
    card._result = block;
  } else {
    // DiffBlock / SearchBlock：行渲染（红-删/绿+加 / 命中行明黄）
    const lines = document.createElement('div');
    lines.className = variant === 'search' ? 'tool-search' : 'tool-diff';
    inner.appendChild(lines);
    card._lineEl = lines;
  }
}

/** 展开态渲染收口（惰性：第一次展开或展开中收到更新才落 DOM；块上限 BLOCK_MAX_CHARS）。 */
function flushToolCard(card) {
  const plan = card._plan;
  if (!plan) return;
  if (card._variant === 'generic') return flushGenericBlocks(card);
  if (card._variant === 'bash' || card._variant === 'read') {
    if (card._lazyBuilt) return;
    card._lazyBuilt = true;
    card._result.textContent = toolBlockText(plan);
    card._result.classList.toggle('err', !(plan.result?.ok ?? true));
    return;
  }
  if (card._variant === 'write' || card._variant === 'edit') {
    if (card._lazyBuilt) return;
    card._lazyBuilt = true;
    card._lineEl.replaceChildren(
      ...buildDiffLines(plan.args, BLOCK_MAX_CHARS).lines.map((l) => {
        const div = document.createElement('div');
        div.className = `tool-diff-line ${l.type}`;
        div.textContent = (l.type === 'del' ? '- ' : l.type === 'add' ? '+ ' : '') + l.text;
        return div;
      }),
    );
    return;
  }
  // search
  if (card._lazyBuilt) return;
  card._lazyBuilt = true;
  const args = parseToolArguments(plan.args);
  const content = plan.result?.content || plan.result?.preview || '';
  const pattern = args && typeof args.pattern === 'string' ? args.pattern : '';
  card._lineEl.replaceChildren(
    ...buildSearchLines(content, pattern, BLOCK_MAX_CHARS).lines.map((l) => {
      const div = document.createElement('div');
      div.className = 'tool-search-line' + (l.hit ? ' hit' : '');
      div.textContent = l.text;
      return div;
    }),
  );
}

/** generic 双卡惰性（原守卫行为：pending 引用，展开落一次）。 */
function flushGenericBlocks(card) {
  if (card._args._pending !== null) {
    card._args.textContent = card._args._pending;
    card._args._pending = null;
  }
  if (card._result._pending !== null) {
    card._result.textContent = card._result._pending;
    card._result._pending = null;
  }
}

/** bash/read 单块正文：失败首行错误（压平）+ 全量内容；上限截断 + 注记。 */
function toolBlockText(plan) {
  const full = plan.result?.content || plan.result?.preview || '';
  const errPrefix =
    plan.result && !plan.result.ok && plan.result.error ? `${plan.result.error}\n` : '';
  return buildReadBlock(errPrefix + full, BLOCK_MAX_CHARS).text;
}

function buildToolCard() {
  const card = document.createElement('div');
  card.className = 'tool-card';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'tool-head';
  head.setAttribute('aria-expanded', 'false');

  const leading = document.createElement('span');
  leading.className = 'tool-leading';
  const title = document.createElement('span');
  title.className = 'tool-title';
  const state = document.createElement('span');
  state.className = 'tool-state';
  const argSum = document.createElement('span');
  argSum.className = 'tool-arg-sum';
  const resSum = document.createElement('span');
  resSum.className = 'tool-res-sum';
  const spacer = document.createElement('span');
  spacer.className = 'tool-spacer';
  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('viewBox', '0 0 16 16');
  chev.setAttribute('class', 'tool-chevron');
  chev.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 6l4 4 4-4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  chev.appendChild(path);
  head.append(leading, title, state, argSum, resSum, spacer, chev);

  const body = document.createElement('div');
  body.className = 'tool-body';
  const inner = document.createElement('div');
  inner.className = 'tool-body-inner';
  body.appendChild(inner);

  head.addEventListener('click', () => {
    const open = !card._open;
    card._open = open;
    head.setAttribute('aria-expanded', String(open));
    body.classList.toggle('open', open);
    // DOM 轻量：只有展开时才把「待写全文」真正放进 textContent
    if (open) flushToolCard(card);
  });

  card.append(head, body);
  card._head = head;
  card._leading = leading;
  card._state = state;
  card._argSum = argSum;
  card._resSum = resSum;
  card._inner = inner;
  card._result = null;
  card._args = null;
  card._lazyBuilt = false;
  card._variant = null;
  card._plan = null;
  card._open = false;
  return card;
}

/** leading 槽：失败/拒绝/中断 → StateDot（红/琥珀，dsh error→StateDot）；其余 → 变体图标。 */
function setToolLeading(leading, variant, state) {
  const isError = state === 'failed' || state === 'denied' || state === 'interrupted';
  if (isError) {
    const dot = document.createElement('span');
    dot.className = `tool-dot ${state}`;
    leading.replaceChildren(dot);
  } else {
    leading.replaceChildren(variantIconSvg(variant));
  }
}

function updateToolCard(card, t) {
  const variant = classifyTool(t.name);
  ensureToolCardVariant(card, variant);
  setToolLeading(card._leading, variant, t.state);
  card._state.className = `tool-state ${t.state}`;
  card._state.textContent = TOOL_STATE_LABEL[t.state] ?? statusLabel(t.state);
  // 变体标题（dsh tool.title.*：非 mono）；原始工具名进 title 悬浮语义
  card._head.querySelector('.tool-title').textContent = TOOL_VARIANT_TITLES[variant];
  card._head.title = t.name || '(未命名工具)';
  card._argSum.textContent = toolSummaryArgs(t.arguments, variant);
  card._resSum.textContent = toolSummaryLine(t.result);
  card._resSum.classList.toggle('err', !(t.result?.ok ?? true));
  // 展开块待写（惰性引用：折叠不落 DOM；展开一次落成；块上限 BLOCK_MAX_CHARS）
  card._plan = { args: t.arguments, result: t.result, state: t.state };
  if (card._variant === 'generic') {
    if (card._args) card._args._pending = formatArguments(t.arguments);
    const full = t.result?.content || t.result?.preview || '';
    if (card._result) {
      card._result._pending = full || (t.state === 'running' ? '（还没有输出）' : '（无输出）');
      card._result.classList.toggle('err', !(t.result?.ok ?? true));
    }
  }
  // 默认折叠：单行摘要是消息流的扫视面；展开（含全量 body）由用户主动触发
  if (card._open) flushToolCard(card);
}

/** 工具卡增量同步（keyed by tool id）。 */
function updateTools(node, tools) {
  if (!node._toolEls) node._toolEls = new Map();
  if (!node._toolSlot) {
    node._toolSlot = document.createElement('div');
    node._toolSlot.className = 'tool-slot';
    node.querySelector('.bubble').appendChild(node._toolSlot);
  }
  const slot = node._toolSlot;
  const seen = new Set();
  for (const t of tools) {
    seen.add(t.id);
    let card = node._toolEls.get(t.id);
    if (!card) {
      card = buildToolCard();
      node._toolEls.set(t.id, card);
      slot.appendChild(card);
    }
    // 签名含折叠态可扫视部分（状态/名称/变体/参数变体摘要/结果摘要首行）；
    // 不含块全量 — 块内容只在展开时写入，不参与「要不要重渲染」判定
    const variant = classifyTool(t.name);
    const sig = `${t.state}|${t.name}|${variant}|${toolSummaryArgs(t.arguments, variant)}|${toolSummaryLine(t.result)}`;
    if (card._sig !== sig) {
      card._sig = sig;
      updateToolCard(card, t);
    }
  }
  for (const [id, card] of node._toolEls) {
    if (!seen.has(id)) {
      card.remove();
      node._toolEls.delete(id);
    }
  }
}

// ============================================================== 顶栏 / 状态条

function renderHeader(snap) {
  // 6 态连接语义：run 进行中 → busy（含工具执行/审批等待）；审批挂起 → warn；
  // 错误 → err；未配置密钥 → config；流未建立（未连接服务器）→ off；其余 ok。
  let connState = 'off';
  if (snap.runActive) connState = 'busy';
  else if (snap.approvals.length > 0) connState = 'warn';
  else if (snap.lastError) connState = 'err';
  else if (ui.settingsReady && !ui.settings.keyConfigured) connState = 'config';
  else if (streamGate.current()?.sessionId === ui.sessionId) connState = 'ok';
  el.conn.dataset.state = connState === 'config' ? 'warn' : connState;
  // 六态裁决的键恰好是 CONN_VISIBLE 全表键集（off 也在表内）—— 索引必有值，无兜底。
  el.connLabel.textContent = CONN_VISIBLE[connState];

  // 停止按钮：run 进行中（含工具执行/审批等待）始终可见 —— 由 runActiveFlag 控制
  el.stop.hidden = !snap.runActive;

  el.sessionTitle.textContent = truncate(snap.title || '新会话', 14);
  el.sessionId.textContent = snap.sessionId ? '#' + shortId(snap.sessionId) : '';
  // 用量统计已移入 composer 输入卡 footer（renderComposerStats）：顶栏不再承载对话统计
}

/**
 * composer 输入卡 footer 用量统计行（dsh InputBar footer 哲学本地形态）：
 * 窄行小字 = 步骤数 · 耗时 · 入/出/总 tokens · ≈成本（五项全显；estimated 标 ≈）。
 * 数据 = run-status（steps/durationMs）+ usage 事件（覆盖式，见 messages.js）双源拼行；
 * 无值（暂停/尚无数据）时整行隐藏（不占输入区空间，也无假「—」）。
 */
function renderComposerStats(snap) {
  const line = composerStatsLine(snap.runStatus, snap.usage);
  el.composerStats.hidden = !line;
  el.composerStatsText.textContent = line;
  // 溢出省略 + hover tooltip 全文（dsh StatsLine 同行为）
  el.composerStatsText.title = line;
}

/**
 * 运行状态条 —— 停靠式（dsh「目标/状态属于输入框上下文」哲学本地形态）：
 * 从顶栏移到 composer 输入区上方。
 * - 运行中（runActive）：细横条 = 状态色点（脉冲）+ 闪烁阶段词 + 实时墙钟耗时；
 * - 终态/完成：折叠为单行小字（色点 + 中文终态 + 步骤/时长，tone 单一源
 *   = format.js RUN_STATUS_SEMANTICS，未知状态灰色不再默认绿）；
 * - run-error：错误横条（err 色调）；无任何状态时整条隐藏。
 */
function runStageWord(snap) {
  // 阶段词 = run 当前所处阶段（dsh「Ongoing/Paused/Blocked Goal」的中文等价）；
  // 词汇表单一源 = format.js RUN_STAGE_WORDS（与 CONN_VISIBLE 的 busy/warn 共享来源）。
  if (snap.approvals.length > 0) return RUN_STAGE_WORDS.approval;
  for (const it of snap.items) {
    if (it.kind !== 'assistant') continue;
    for (const t of it.tools ?? []) {
      if (t.state === 'running') return RUN_STAGE_WORDS.tool;
    }
  }
  return RUN_STAGE_WORDS.generating;
}

function ensureStripParts() {
  if (el.runStrip._parts) return;
  // R2-S1：方法线小牌 = 条内最左元素（位于状态点同行、条起点侧）
  const badge = document.createElement('span');
  badge.className = 'run-method';
  badge.hidden = true;
  const dot = document.createElement('span');
  dot.className = 'rs-dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'rs-label';
  const meta = document.createElement('span');
  meta.className = 'rs-meta';
  el.runStrip.replaceChildren(badge, dot, label, meta);
  el.runStrip._parts = { badge, dot, label, meta };
}

/** 方法线小牌（R2-S1）：有 methodLine → 显示「方法线 <id>」（mono chip）；无则隐藏。
 *  语义：运行中即显示、完成态保留（快照 methodLine 在新用户回合/reset 前恒在）。 */
function setMethodBadge(methodLine) {
  const badge = el.runStrip._parts.badge;
  if (methodLine) {
    badge.hidden = false;
    badge.textContent = methodologyBadgeText(methodLine);
  } else {
    badge.hidden = true;
    badge.textContent = '';
  }
}

/**
 * run-strip 内容统一装配点：live/quiet 两档共用同一组
 * 「hidden=false → className（err 有 .err 类）→ dataset.tone → label → meta」赋值与
 * 「出错：」文案样式 —— 原先 live-err 与 quiet-err 各重复一遍（两条 21 行分支），
 * 收口至此，显示细节改一处生效。（视觉行为与旧版逐字一致：tone 由 data-tone 着色，
 * err 类随 live/quiet 追加；quiet 正常分支即使 tone=err 也不加 err 类 —— 有意保留。）
 */
function setStrip(mode, { tone, text, meta = '', err = false }) {
  const { label, meta: metaEl } = el.runStrip._parts;
  el.runStrip.hidden = false;
  el.runStrip.className = `run-strip ${mode}${err ? ' err' : ''}`;
  el.runStrip.dataset.tone = tone;
  label.textContent = text;
  metaEl.textContent = meta;
}

function renderStrip(snap) {
  ensureStripParts();
  setMethodBadge(snap.methodLine);
  const live = snap.runActive;

  if (live && snap.lastError) {
    // run-error 先于终态 run-status 到达：错误实时横条
    setStrip('live', { tone: 'err', err: true, text: `出错：${snap.lastError}` });
  } else if (live) {
    setStrip('live', {
      tone: 'busy',
      text: runStageWord(snap),
      meta: elapsedText(snap.runStartedAt),
    });
  } else if (snap.lastError) {
    // 出错落在终态前（run-error 也成对先行）：静默小字错误横条
    setStrip('quiet', { tone: 'err', err: true, text: `出错：${snap.lastError}` });
  } else if (snap.runStatus?.status) {
    // 终态/完成：折叠为单行小字；tone 单一源 = RUN_STATUS_SEMANTICS（未知状态灰色）
    setStrip('quiet', {
      tone: statusTone(snap.runStatus.status),
      text: runStatusLine(snap.runStatus),
    });
  } else {
    // 空态：无 run、无错误、无终态 → 整条隐藏（不占输入区空间）
    const { label, meta } = el.runStrip._parts;
    el.runStrip.hidden = true;
    label.textContent = '';
    meta.textContent = '';
  }
}

/** 运行中耗时秒表：只随 runActive 存在（render 收口驱动启停；每秒刷新耗时）。 */
function syncRunClock() {
  const active = ui.lastSnap?.runActive === true;
  if (active && ui.clockTimer === 0) {
    ui.clockTimer = window.setInterval(() => {
      if (ui.lastSnap?.runActive) renderStrip(ui.lastSnap);
      else stopRunClock();
    }, 1000);
  } else if (!active && ui.clockTimer !== 0) {
    stopRunClock();
  }
}

function stopRunClock() {
  if (ui.clockTimer !== 0) {
    window.clearInterval(ui.clockTimer);
    ui.clockTimer = 0;
  }
}

// ============================================================== 内嵌审批卡（dsh ApprovalPanel）

/**
 * 审批卡渲染（快照驱动）：approvals 队列**一次呈现一个**（第一个等待项；队列保序
 * 在 messages.js）。已同意后卡收起、tool 卡继续流式（tool-result 随流落色）。
 * 审批进行中 composer 保留可输入、发送仍由 runActive 管制（startStream 门禁）——
 * dsh 语义是 pending 接管 composer 槽；我们决策为「内嵌 dock 不夺输入焦点，
 * 仅挂起运行」，与既有单流模型一致（注明见 README-UI）。
 */
function renderApprovalBanner(snap) {
  const view = bannerFromApproval(snap.approvals);
  ui.currentApproval = view;
  if (!view) {
    el.approvalDock.hidden = true;
    return;
  }
  el.approvalDock.hidden = false;
  el.approvalHeadline.textContent = view.headline;
  el.approvalCommand.textContent = view.command || '（无参数）';
  el.btnBannerApprove.disabled = ui.approvalDeciding;
  el.btnBannerDeny.disabled = ui.approvalDeciding;
}

/** 应答（允许/拒绝；Esc 同拒绝语义）：本地先行落色（卡立即变化），再 POST。
 *  无附注框（dsh 并无）→ 拒绝一律无备注 = 服务端 user-interrupted 收尾本轮。 */
async function decideBannerApproval(approve) {
  const w = ui.currentApproval;
  if (!w || ui.approvalDeciding) return;
  ui.approvalDeciding = true;
  store.decideApproval(w.toolCallId, approve, ''); // 队列清该项（下一等待项随之呈现）
  if (approve) toast(`已批准 ${w.name}，继续执行……`);
  try {
    await fetchJson('/api/approval', {
      method: 'POST',
      body: { sessionId: ui.sessionId, toolCallId: w.toolCallId, approve },
    });
  } catch (err) {
    store.addSystem(`审批应答未送达：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ui.approvalDeciding = false;
    if (ui.lastSnap) renderApprovalBanner(ui.lastSnap); // 双纽回放（防连点态滞留）
  }
}

// ============================================================== PermissionSelect 访问模式 chip

/** 档位 glyph（16 视口、currentColor；chip 与 menu 行共用同一几何 —— dsh
 *  PermissionSelect：check 只读 / pencil 写 / 感叹号 full access）。 */
function permGlyphSvg(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  if (kind === 'check') {
    path.setAttribute('d', 'M3.2 8.6l3.1 3L12.8 4.9');
    svg.appendChild(path);
  } else if (kind === 'pencil') {
    path.setAttribute('d', 'M3.5 12.5l.6-2.7 7.4-7.4 2.1 2.1-7.4 7.4-2.7.6z');
    svg.appendChild(path);
  } else {
    // alert（full access）：感叹号
    path.setAttribute('d', 'M8 3.4v5.6');
    svg.appendChild(path);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', '8');
    dot.setAttribute('cy', '12.1');
    dot.setAttribute('r', '1');
    dot.setAttribute('fill', 'currentColor');
    svg.appendChild(dot);
  }
  return svg;
}

/** 菜单行装配（选项 = PERMISSION_VALUES 单一来源；行 = glyph + 档标签 + 描述）。 */
function buildPermMenu() {
  el.permMenu.replaceChildren();
  for (const value of PERMISSION_VALUES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'perm-menu-item';
    item.dataset.permissionValue = value;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-label', permissionLabel(value));
    const glyph = document.createElement('span');
    glyph.className = 'pm-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.appendChild(permGlyphSvg(permissionGlyph(value)));
    const text = document.createElement('span');
    text.className = 'pm-text';
    const label = document.createElement('span');
    label.className = 'pm-label';
    label.textContent = permissionLabel(value);
    const desc = document.createElement('span');
    desc.className = 'pm-desc' + (value === 'full-access' ? ' warn' : '');
    desc.textContent = PERMISSION_DESCRIPTIONS[value];
    text.append(label, desc);
    item.append(glyph, text);
    item.addEventListener('click', () => {
      void selectPermissionFromMenu(value);
    });
    el.permMenu.appendChild(item);
  }
  syncPermMenu();
}

/** 当前档回显（chip 标签/glyph + 菜单 current 高亮 + aria；单一收口）。 */
function syncPermChip() {
  const value = normalizePermission(ui.settings.permission);
  el.permLabel.textContent = permissionLabel(value);
  el.permGlyph.replaceChildren(permGlyphSvg(permissionGlyph(value)));
  const label = `访问模式，当前：${permissionLabel(value)}`;
  el.permChip.setAttribute('aria-label', label);
  el.permChip.title = label;
  syncPermMenu();
}

function syncPermMenu() {
  const current = normalizePermission(ui.settings.permission);
  for (const item of el.permMenu.querySelectorAll('.perm-menu-item')) {
    const active = item.dataset.permissionValue === current;
    item.classList.toggle('current', active);
    item.setAttribute('aria-checked', String(active));
  }
}

/** 菜单开关（定位 = menu.js 纯函数；chip 视口系锚 → fixed 落点，视口钳制）。 */
function togglePermMenu(force) {
  const open = force !== undefined ? force : !ui.permMenuOpen;
  if (open) {
    const rect = el.permChip.getBoundingClientRect();
    el.permMenu.hidden = false; // 先解除隐藏：offsetWidth/Height 实测
    const size = { width: el.permMenu.offsetWidth, height: el.permMenu.offsetHeight };
    const pos = menuPosition(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      size,
      { width: window.innerWidth, height: window.innerHeight },
    );
    el.permMenu.style.left = `${pos.left}px`;
    el.permMenu.style.top = `${pos.top}px`;
    ui.permMenuOpen = true;
    el.permChip.setAttribute('aria-expanded', 'true');
  } else {
    el.permMenu.hidden = true;
    ui.permMenuOpen = false;
    el.permChip.setAttribute('aria-expanded', 'false');
  }
}

/** 菜单选中（档位切换收口）：当前档 no-op；full-access 且无确认记录 → 风险确认门；
 *  其余一键切换（read-only/workspace-write 零确认），切换即 POST（防抖 300ms）。 */
function selectPermissionFromMenu(value) {
  const normalized = normalizePermission(value);
  togglePermMenu(false);
  if (normalized === ui.settings.permission) return; // 已在本档：不重复提交
  if (shouldConfirmRisk(normalized, ui.settings.permissionConfirmedAt)) {
    openRiskConfirm(normalized);
    return;
  }
  applyPermission(normalized);
}

/** 本地先落档（chip 即时反馈）+ 防抖提交（失败回滚重读 + toast —— 思考强度同纪律）。 */
function applyPermission(value) {
  ui.settings = { ...ui.settings, permission: normalizePermission(value) };
  syncPermChip();
  schedulePermissionSync(value);
}

// --- 风险确认门（full-access 一次性：复用删除确认 modal 视觉，危险色调） ---

function openRiskConfirm(target) {
  ui.riskConfirmOpen = true;
  ui.riskConfirmTarget = target;
  el.riskTitle.textContent = RISK_CONFIRM_TITLE;
  el.riskText.textContent = RISK_CONFIRM_TEXT;
  el.riskScrim.hidden = false;
  el.riskConfirm.hidden = false;
  el.btnRiskOk.focus();
}

function closeRiskConfirm() {
  ui.riskConfirmOpen = false;
  ui.riskConfirmTarget = null;
  el.riskConfirm.hidden = true;
  el.riskScrim.hidden = true;
}

function confirmRiskAccess() {
  const target = ui.riskConfirmTarget;
  closeRiskConfirm();
  if (!target) return;
  applyPermission(target); // 确认后 POST（permissionConfirmedAt 由服务端记录）
}

// --- 权限同步（防抖 300ms；失败回滚重读 + toast） ---

function schedulePermissionSync(value) {
  ui.permissionSyncPending = value;
  window.clearTimeout(ui.permissionSyncTimer);
  ui.permissionSyncTimer = window.setTimeout(() => {
    ui.permissionSyncTimer = 0;
    void flushPermissionSync();
  }, 300);
}

async function flushPermissionSync() {
  window.clearTimeout(ui.permissionSyncTimer);
  ui.permissionSyncTimer = 0;
  const value = ui.permissionSyncPending;
  ui.permissionSyncPending = null;
  if (value === null || value === undefined) return;
  try {
    const saved = await savePermission(value);
    ui.settings = { ...ui.settings, ...saved }; // 服务端权威回体（含 confirmedAt 记录）
  } catch {
    await revertPermission();
    toast('访问模式保存失败，已还原', 'warn');
  }
  syncPermChip();
}

/** POST 失败回滚：GET 服务端态还原（GET 也失败 → 保持现显示，不猜测）。 */
async function revertPermission() {
  try {
    const s = await loadSettings();
    ui.settings = { ...ui.settings, ...s };
  } catch {
    // 服务端不可达：保持当前值（下次切换再试）
  }
}

// ============================================================== 方法论先行开关（R2-S1）

/** 开关回显（设置页常规区卡片）：GET /api/settings 权威值（缺省 true）→ checkbox。 */
function syncMethodFirstToggle() {
  el.setMethodfirstEnabled.checked = normalizeMethodFirst(ui.settings.methodFirst) === true;
}

/** change 收口（data-methodfirst-field 委托）：本地即时回显 + 防抖 300ms POST
 *  （同思考强度/访问模式纪律：失败回滚重读 + toast，无队列只补发最后一片）。 */
function applyMethodFirstField(checked) {
  const value = normalizeMethodFirst(checked);
  ui.settings = { ...ui.settings, methodFirst: value };
  syncMethodFirstToggle();
  scheduleMethodFirstSync(value);
}

function scheduleMethodFirstSync(value) {
  ui.methodFirstSyncPending = value;
  window.clearTimeout(ui.methodFirstSyncTimer);
  ui.methodFirstSyncTimer = window.setTimeout(() => {
    ui.methodFirstSyncTimer = 0;
    void flushMethodFirstSync();
  }, 300);
}

async function flushMethodFirstSync() {
  window.clearTimeout(ui.methodFirstSyncTimer);
  ui.methodFirstSyncTimer = 0;
  const value = ui.methodFirstSyncPending;
  ui.methodFirstSyncPending = null;
  if (value === null || value === undefined) return;
  try {
    const saved = await saveMethodFirst(value);
    ui.settings = { ...ui.settings, ...saved }; // 服务端权威回体（含归一）
  } catch {
    await revertMethodFirst();
    toast('方法论先行保存失败，已还原', 'warn');
  }
  syncMethodFirstToggle();
}

/** POST 失败回滚：GET 服务端态还原（GET 也失败 → 保持现显示，不猜测）。 */
async function revertMethodFirst() {
  try {
    const s = await loadSettings();
    ui.settings = { ...ui.settings, ...s };
  } catch {
    // 服务端不可达：保持当前值（下次切换再试）
  }
}

// ============================================================== 收尾评审开关（R2-S2）

/** 开关回显（设置页常规区卡片）：GET /api/settings 权威值（缺省 true）→ checkbox。 */
function syncReviewModeToggle() {
  el.setReviewmodeEnabled.checked = normalizeReviewMode(ui.settings.reviewMode) === true;
}

/** change 收口（data-reviewmode-field 委托）：本地即时回显 + 防抖 300ms POST
 *  （同方法论先行/思考强度纪律：失败回滚重读 + toast，无队列只补发最后一片）。 */
function applyReviewModeField(checked) {
  const value = normalizeReviewMode(checked);
  ui.settings = { ...ui.settings, reviewMode: value };
  syncReviewModeToggle();
  scheduleReviewModeSync(value);
}

function scheduleReviewModeSync(value) {
  ui.reviewModeSyncPending = value;
  window.clearTimeout(ui.reviewModeSyncTimer);
  ui.reviewModeSyncTimer = window.setTimeout(() => {
    ui.reviewModeSyncTimer = 0;
    void flushReviewModeSync();
  }, 300);
}

async function flushReviewModeSync() {
  window.clearTimeout(ui.reviewModeSyncTimer);
  ui.reviewModeSyncTimer = 0;
  const value = ui.reviewModeSyncPending;
  ui.reviewModeSyncPending = null;
  if (value === null || value === undefined) return;
  try {
    const saved = await saveReviewMode(value);
    ui.settings = { ...ui.settings, ...saved }; // 服务端权威回体（含归一）
  } catch {
    await revertReviewMode();
    toast('收尾评审保存失败，已还原', 'warn');
  }
  syncReviewModeToggle();
}

/** POST 失败回滚：GET 服务端态还原（GET 也失败 → 保持现显示，不猜测）。 */
async function revertReviewMode() {
  try {
    const s = await loadSettings();
    ui.settings = { ...ui.settings, ...s };
  } catch {
    // 服务端不可达：保持当前值（下次切换再试）
  }
}

// ============================================================== 发送 / 流

function inputUnlocked() {
  // 设置可得且未配置密钥 → 锁输入（引导第一步「先去设置」）；静态预览环境不锁
  return !(ui.settingsReady && !ui.settings.keyConfigured);
}

async function send() {
  const text = el.input.value.trim();
  if (!text) return;
  if (!inputUnlocked()) {
    openSettings();
    toast('请先在设置里配置 API Key', 'warn');
    return;
  }
  // 门禁：运行中 → 明确提示（不再静默吞）；runActive 由终态 run-status 置 false
  if (!store.startStream()) {
    toast('上一条任务仍在运行，请等待或按停止', 'warn');
    return;
  }
  el.input.value = '';
  autogrow();
  try {
    const res = await fetchJson('/api/chat', {
      method: 'POST',
      body: { sessionId: ui.sessionId, text },
    });
    ui.sessionId = res?.sessionId ?? ui.sessionId;
    store.setSessionId(ui.sessionId);
    if (ui.sessionId) localStorage.setItem(LS_SESSION, ui.sessionId);
    store.addUser(text);
    // 单流模型：连接先于 run 事件建立（SessionBroker 全量缓冲兜底首轮 gap），
    // 此后该会话不再重开流 —— 第二条消息的帧为实时帧，不再重放重复。
    await ensureStream(ui.sessionId);
    if (ui.sessionId) {
      void refreshSessionList(true); // 首条消息落地 → 列表出现新会话
      void refreshStats();
    }
  } catch (err) {
    store.endRun();
    store.endStream();
    store.addSystem(`消息发送失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 单流保证：每个 sessionId 只开 /api/stream 一次（首条消息 / 恢复 / 切换会话时打开），
 * 直到切换会话或会话重置才关闭 —— 流长活，run 结束不关（服务端心跳保活+回放缓冲）。
 * 流把手与收尾裁决统一走 streams.js 的 streamGate（引用相等守卫）：切换会话竞态下，
 * 旧流 finally 晚到但 non-current —— 不触发 endStream，新流 streaming 态不受搅动。
 */
async function ensureStream(sessionId) {
  if (!sessionId) return;
  if (streamGate.isCurrent(sessionId)) return; // 已连且属本会话
  streamGate.current()?.ctrl.abort(); // 换会话：关闭旧流（静默，长活流唯一关闭点）
  const ctrl = new AbortController();
  streamGate.open(sessionId, ctrl);
  try {
    await consumeSSE({
      url: `/api/stream?sessionId=${encodeURIComponent(sessionId)}`,
      signal: ctrl.signal,
      onEvent: (ev) => {
        // 恢复历史回放去重（CS-001）：GET /api/sessions/:id 先落之后，长活流的重放窗
        // 会把同序事务帧再投一遍 —— 守卫判定为覆盖段重复的帧直接丢弃（不 dispatch）；
        // 序列走到下一个实时帧时自动解防，实时流零影响。
        if (replayGuard.consume(ev)) return;
        store.dispatch(ev);
        // 低成本刷新口径（任务书）：统计/列表随 run-status 事件刷新（run 少而稀疏）
        if (ev?.event === 'run-status' && TERMINAL_STATUSES.includes(ev?.data?.status)) {
          void refreshStats();
          void refreshSessionList(true);
        }
      },
    });
  } catch (err) {
    if (err?.name !== 'AbortError') {
      // 语义判断（isStatus，替代 message.includes('404')）：状态码以 err.status 为权威
      if (isStatus(err, 404)) {
        // localStorage 里的旧会话已被服务端清除：丢弃恢复指针，交给下一条消息开新会话
        ui.sessionId = null;
        localStorage.removeItem(LS_SESSION);
        store.setSessionId(null);
        store.addSystem('上次会话不存在，将开启新会话', 'info');
      } else {
        store.addSystem(`连接中断：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    // 收尾裁决：仅本流仍为当前流才解绑 + endStream（新流已接管则静默 ——
    // 旧流 finally 不清新流状态；见 streams.js 与 api.test / streams.test 的竞态用例）。
    streamGate.retire(ctrl);
  }
}

/** 停止：只 POST /api/interrupt，不动长活流 —— 终态 run-status 仍经本流到达。 */
async function stopStream() {
  if (!store.snapshot().runActive) return;
  if (ui.sessionId) {
    try {
      await fetchJson('/api/interrupt', { method: 'POST', body: { sessionId: ui.sessionId } });
    } catch (err) {
      toast(`停止失败：${err instanceof Error ? err.message : String(err)}`, 'warn');
    }
  }
}

// ============================================================== 「/」命令（纯逻辑 = commands.js）

/**
 * 触发纪律：输入区**首个字符** `/` + 防抖 150ms 出下拉（matchCommands 前缀过滤）；
 * Enter 在 `/` 行上 = 直接执行该命令（不下发聊天）；未知命令 → 消息流红字
 * （system-chip err 态）「未知命令 /xx，/help 查看」；菜单项点击同 Enter。
 * 结果面板 = dsh Menu/Modal 表面（cmd-panel）：/help 命令表、/cost 累计成本等。
 */

/** 调度下拉（防抖 150ms；首个字符不是 / 立即收起）。 */
function scheduleCommandMenu() {
  window.clearTimeout(ui.cmdTimer);
  ui.cmdTimer = 0;
  const text = el.input.value;
  if (!text.startsWith('/')) {
    hideCommandMenu();
    return;
  }
  ui.cmdTimer = window.setTimeout(() => {
    ui.cmdTimer = 0;
    showCommandMenu();
  }, 150);
}

/** 命令名查询串（/ 后第一个空白片段 —— 只按名字过滤，不匹配参数区）。 */
function commandQuery() {
  const text = el.input.value;
  if (!text.startsWith('/')) return null;
  const token = text.slice(1).split(/[\s/]+/)[0] ?? '';
  return `/${token}`;
}

function showCommandMenu() {
  const query = commandQuery();
  if (query === null) {
    hideCommandMenu();
    return;
  }
  const items = matchCommands(query, 8);
  renderCommandMenu(items);
  el.cmdMenu.hidden = items.length === 0;
  ui.cmdMenuOpen = items.length > 0;
  ui.cmdHighlight = 0;
  if (ui.cmdMenuOpen) refreshCommandHighlight();
}

function hideCommandMenu() {
  if (el.cmdMenu.hidden && !ui.cmdMenuOpen) return;
  el.cmdMenu.hidden = true;
  ui.cmdMenuOpen = false;
  ui.cmdHighlight = 0;
}

/** 下拉项（dsh Menu 行：mono 命令名 + label 小字）。 */
function renderCommandMenu(items) {
  el.cmdMenu.replaceChildren();
  for (const cmd of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'cmd-menu-item';
    item.dataset.cmdId = cmd.id;
    item.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.className = 'cmd-menu-name';
    const hint = cmd.hint ? ` ${cmd.hint}` : '';
    name.textContent = `${cmd.name}${hint}`;
    const label = document.createElement('span');
    label.className = 'cmd-menu-label';
    label.textContent = cmd.label;
    item.append(name, label);
    item.addEventListener('click', () => {
      void executeCommandLine(el.input.value);
    });
    el.cmdMenu.appendChild(item);
  }
}

function refreshCommandHighlight() {
  const items = [...el.cmdMenu.querySelectorAll('.cmd-menu-item')];
  items.forEach((item, index) => {
    item.classList.toggle('selected', index === ui.cmdHighlight);
  });
  items[ui.cmdHighlight]?.scrollIntoView({ block: 'nearest' });
}

function moveCommandHighlight(delta) {
  const count = el.cmdMenu.children.length;
  if (count === 0) return;
  ui.cmdHighlight = (ui.cmdHighlight + delta + count) % count;
  refreshCommandHighlight();
}

/** 执行命令行（Enter / 菜单点击；已键入行原样消费，不落聊天）。 */
async function executeCommandLine(line) {
  const parsed = parseCommandLine(line);
  if (parsed === null) return; // '/' 或 '/ '（尚未输入命令名）：不拦截
  hideCommandMenu();
  el.input.value = '';
  autogrow();
  renderComposer();
  const cmd = commandFor(parsed.name);
  if (!cmd) {
    // 未知命令：消息流红字（system-chip 默认 err 态）
    store.addSystem(`未知命令 ${parsed.name}，/help 查看`);
    return;
  }
  if (!commandArgValid(cmd, parsed.argList)) {
    store.addSystem(`用法：${cmd.name}${cmd.hint ? ` ${cmd.hint}` : '（无参数）`'}`);
    return;
  }
  switch (cmd.id) {
    case 'help':
      openHelpPanel();
      break;
    case 'new':
    case 'clear':
      // /clear = 新会话（同 /new；「清空当前对话」的本地语义 = 另起一个会话）
      void newSession();
      break;
    case 'stop':
      if (!store.snapshot().runActive) store.addSystem('当前没有运行中的任务', 'info');
      else await stopStream();
      break;
    case 'theme': {
      const value = parsed.argList[0];
      setTheme(value);
      toast(`主题已设为「${themeArgLabel(value)}」`);
      break;
    }
    case 'sessions':
      void openSessionsPanel();
      break;
    case 'cost':
      openCostPanel();
      break;
    case 'stats':
      void openStatsPanel();
      break;
    case 'model':
      openModelPanel();
      break;
    case 'skill':
      void openSkillPanel();
      break;
    case 'mcp':
      void openMcpPanel();
      break;
    case 'compact':
      openCompactPanel();
      break;
    default:
      store.addSystem(`未知命令 ${parsed.name}，/help 查看`);
      break;
  }
}

// ---- 命令面板（dsh Menu/Modal 表面：标题 + 行列表 + 关闭；Escape/外点关闭） ----

/**
 * 组行（label + value 双栏；label 缺省 = 说明单行）。
 * @param {Array<{label?: string, text: string, mono?: boolean, err?: boolean, button?: {label: string, action: () => void}}>} rows
 */
function buildCmdRows(rows) {
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    if (row.button) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-outline btn-sm cmd-row-btn';
      btn.textContent = row.button.label;
      btn.addEventListener('click', row.button.action);
      frag.appendChild(btn);
      continue;
    }
    const div = document.createElement('div');
    div.className = 'cmd-row';
    if (row.label !== undefined && row.label !== null) {
      const label = document.createElement('span');
      label.className = 'cmd-row-label';
      label.textContent = row.label;
      div.appendChild(label);
    }
    const value = document.createElement('span');
    value.className = 'cmd-row-value' + (row.mono ? ' mono' : '') + (row.err ? ' err' : '');
    value.textContent = row.text;
    div.appendChild(value);
    frag.appendChild(div);
  }
  return frag;
}

function openCmdPanel(title, rows) {
  el.cmdPanelTitle.textContent = title;
  el.cmdPanelBody.replaceChildren(buildCmdRows(rows));
  el.cmdPanel.hidden = false;
}

function closeCmdPanel() {
  if (el.cmdPanel.hidden) return;
  el.cmdPanel.hidden = true;
  el.cmdPanelBody.replaceChildren();
}

/** /help：命令表 + 说明（命令面板；表源 = commands.js COMMANDS 单一来源）。 */
function openHelpPanel() {
  const rows = [
    { text: '在输入框以 / 开头即可打开命令；Enter 直接执行。' },
    ...COMMANDS.map((cmd) => ({
      label: `${cmd.name}${cmd.hint ? ` ${cmd.hint}` : ''}`,
      text: `${cmd.label} —— ${cmd.desc}`,
      mono: true,
    })),
  ];
  openCmdPanel('命令帮助', rows);
}

/** /cost：本会话累计成本（usage 事件累积 —— messages.js costUsdCum）。 */
function openCostPanel() {
  const snap = store.snapshot();
  if (!snap.usage) {
    openCmdPanel('本会话累计成本', [{ text: '暂无用量数据：发送消息后按 usage 事件累积。' }]);
    return;
  }
  const rows = [
    { label: '累计成本', text: formatCostUsd(snap.costUsdCum ?? 0) },
    { label: '最近一次', text: formatCostUsd(snap.usage.costUsd ?? 0) },
    {
      label: '最近 tokens',
      text: snap.usage.totalTokens !== null ? formatTokens(snap.usage.totalTokens) : '–',
    },
    { label: '口径', text: snap.usage.estimated ? '本地估算（≈）' : '服务端精确' },
    { text: '仅展示用；服务端成本闸门才具权威。' },
  ];
  openCmdPanel('本会话累计成本', rows);
}

/** /sessions：会话列表 + 数字（优先现拉；失败回落侧栏缓存）。 */
async function openSessionsPanel() {
  let list = ui.sessionItems;
  try {
    list = normalizeSessionList(await fetchJson('/api/sessions'));
    ui.sessionItems = list;
  } catch {
    // 现拉失败：使用侧栏当前缓存（诚实降级，不冒充）
  }
  if (list.length === 0) {
    openCmdPanel(`会话（0）`, [{ text: '暂无会话，点新建开始' }]);
    return;
  }
  const rows = [
    { text: `共 ${list.length} 个会话（最近在前）` },
    ...list.slice(0, 12).map((s, i) => ({
      label: String(i + 1),
      text: sessionDisplayTitle(s, shortId),
      mono: true,
    })),
    ...(list.length > 12 ? [{ text: `……（其余 ${list.length - 12} 个略）` }] : []),
  ];
  openCmdPanel(`会话（${list.length}）`, rows);
}

/** /stats：GET /api/stats 数字。 */
async function openStatsPanel() {
  try {
    const stats = normalizeStats(await fetchJson('/api/stats'));
    const rows = [
      { label: '内存 RSS', text: stats.rssMb !== null ? `${Math.round(stats.rssMb)}MB` : '–' },
      { label: '堆内存', text: stats.heapMb !== null ? `${Math.round(stats.heapMb)}MB` : '–' },
      { label: '会话数', text: stats.sessions !== null ? String(Math.round(stats.sessions)) : '–' },
      {
        label: 'Shell',
        text: stats.activeShells !== null ? String(Math.round(stats.activeShells)) : '–',
      },
    ];
    openCmdPanel('运行统计', rows);
  } catch (err) {
    store.addSystem(`统计不可用：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** /model：当前模型 + 提示去设置（按钮直达设置抽屉）。 */
function openModelPanel() {
  const rows = [
    { label: '模型', text: ui.settings.model || DEFAULT_SETTINGS.model, mono: true },
    { label: '端点', text: ui.settings.baseUrl || DEFAULT_SETTINGS.baseUrl, mono: true },
    { text: '修改请在「设置 → 模型接口」（侧栏底部设置按钮）。' },
    {
      button: {
        label: '去设置',
        action: () => {
          closeCmdPanel();
          openSettings();
        },
      },
    },
  ];
  openCmdPanel('当前模型', rows);
}

/** /skill：已启用技能数 + 提示（数据 = GET /api/skills；失败降级行）。 */
async function openSkillPanel() {
  try {
    const skills = normalizeSkillsList(await fetchJson('/api/skills'));
    const enabled = skills.filter((s) => s.enabled).length;
    openCmdPanel('技能状态', [
      { label: '已启用', text: `${enabled} / ${skills.length}` },
      { text: '技能开关在「设置 → Skills」。' },
    ]);
  } catch {
    openCmdPanel('技能状态', [
      { text: SKILLS_DEGRADED_NOTE },
      { text: '技能开关在「设置 → Skills」。' },
    ]);
  }
}

/** /mcp：MCP 服务器登记态（GET /api/mcp；文案单一来源 = extensions.js）。 */
async function openMcpPanel() {
  let servers = null;
  try {
    servers = normalizeMcpServers(await fetchJson('/api/mcp'));
  } catch {
    servers = null;
  }
  if (servers === null) {
    openCmdPanel('MCP 服务器', [{ text: MCP_DEGRADED_NOTE }]);
    return;
  }
  if (servers.length === 0) {
    openCmdPanel('MCP 服务器', [
      { text: MCP_SIDEBAR_EMPTY_NOTE },
      {
        button: {
          label: '去设置',
          action: () => {
            closeCmdPanel();
            openSettings();
          },
        },
      },
    ]);
    return;
  }
  openCmdPanel('MCP 服务器', [
    {
      label: '共 ' + String(servers.length),
      text: servers.filter((s) => s.enabled).length + ' 已登记',
    },
    ...servers.map((s) => ({
      label: (s.enabled ? MCP_BADGE_ENABLED : MCP_BADGE_DISABLED) + ' · ' + s.name,
      text: s.command || '（未填 command）',
      mono: true,
    })),
    { text: '添加与开关在「设置 → MCP」。' },
  ]);
}

/** /compact：诚实信息条（服务端自动压缩，无手动入口 —— 不假装有操作）。 */
function openCompactPanel() {
  openCmdPanel('上下文压缩', [
    {
      label: '状态',
      text: '自动压缩运行中，无需手动',
    },
    {
      text: '上下文超过预算时由 DevMate 自动压缩（摘要保留关键信息）；此项自动执行，没有手动操作入口。',
    },
  ]);
}

// ============================================================== 思考强度选择器（分段 pill）

/** 分段 pill：选项由 settings.js REASONING_VALUES/LABELS 装配（单一来源防漂移）。 */
function buildReasoningSeg() {
  el.reasoningSeg.replaceChildren();
  for (const value of REASONING_VALUES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reasoning-opt';
    btn.dataset.reasoning = value;
    btn.setAttribute('role', 'radio');
    btn.textContent = REASONING_LABELS[value];
    btn.title = `思考强度：${REASONING_LABELS[value]}`;
    el.reasoningSeg.appendChild(btn);
  }
  syncReasoningSeg();
}

function syncReasoningSeg() {
  for (const btn of el.reasoningSeg.querySelectorAll('.reasoning-opt')) {
    const active = btn.dataset.reasoning === ui.settings.reasoning;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  }
}

/** 点击即 POST（防抖 300ms 合并；失败回滚重读 + toast —— 与 Subagent 同步同纪律）。 */
function scheduleReasoningSync(value) {
  ui.reasoningSyncPending = value;
  window.clearTimeout(ui.reasoningSyncTimer);
  ui.reasoningSyncTimer = window.setTimeout(() => {
    ui.reasoningSyncTimer = 0;
    void flushReasoningSync();
  }, 300);
}

async function flushReasoningSync() {
  window.clearTimeout(ui.reasoningSyncTimer);
  ui.reasoningSyncTimer = 0;
  const value = ui.reasoningSyncPending;
  ui.reasoningSyncPending = null;
  if (value === null || value === undefined) return;
  try {
    const saved = await saveReasoning(value);
    ui.settings = { ...ui.settings, ...saved };
  } catch {
    await revertReasoning();
    toast('思考强度保存失败，已还原', 'warn');
  }
  syncReasoningSeg();
}

/** POST 失败回滚：GET 服务端态还原（GET 也失败 → 保持现显示，不猜测）。 */
async function revertReasoning() {
  try {
    const s = await loadSettings();
    ui.settings = { ...ui.settings, ...s };
  } catch {
    // 服务端不可达：保持当前值（下次点击再试）
  }
}

// ============================================================== 上下文窗口占用环（meter.js 纯逻辑）

/**
 * 更新随 usage 事件（render 快照驱动）：占用量 =
 * 最近 usage.contextEstimateTokens / settings.window（无窗 → 「—」+tooltip）；
 * 阈值 >80% 琥珀、>95% 红（tier 单一来源 = meter.js；token 值倒推自超窗估算）。
 */
function renderMeter() {
  const usage = ui.lastSnap?.usage ?? null;
  const estimate = usage?.contextEstimateTokens ?? null;
  if (estimate === null) {
    el.meterRow.hidden = true; // 尚无投影估算：不显示（不装「—」假值）
    return;
  }
  el.meterRow.hidden = false;
  const windowTokens = ui.settings.windowTokens ?? null;
  const ratio = meterRatio(estimate, windowTokens);
  const tier = meterTier(ratio);
  const circumference = meterCircumference();
  el.meter.dataset.tier = tier;
  el.meterFill.setAttribute('stroke-dasharray', String(circumference));
  el.meterFill.setAttribute(
    'stroke-dashoffset',
    String(ratio === null ? 0 : circumference * (1 - ratio)),
  );
  el.meterText.textContent = meterPercentText(estimate, windowTokens);
  const tip = meterTooltip(estimate, windowTokens, formatTokens);
  el.meter.title = tip;
  el.meter.setAttribute('aria-label', meterAriaLabel(estimate, windowTokens, formatTokens));
}

// ============================================================== 设置

function closeDrawer() {
  // 切换前 flush 待提交的 Subagent 工作流同步（change 即提交：无队列，只补发最后一片）
  void flushSubagentSync();
  el.drawer.hidden = true;
  el.drawerScrim.hidden = true;
}

async function openSettings() {
  el.drawer.hidden = false;
  el.drawerScrim.hidden = false;
  el.settingsStatus.textContent = '';
  // 打开时总重读服务端（含掩码态）：「保存后只回掩码」在页面上可见
  try {
    const s = await loadSettings();
    ui.settings = { ...ui.settings, ...s };
    ui.settingsReady = true;
  } catch {
    if (!ui.settingsReady) {
      el.settingsStatus.textContent = '静态预览环境（未连接服务端）：设置保存仅本地提示';
      el.settingsStatus.className = 'drawer-status err';
    }
  }
  syncReasoningSeg(); // 服务端档位权威：回显（含窗口覆盖 —— meter 随之取值）
  syncPermChip(); // 权限档位（含 permissionConfirmedAt 记录 —— 风险门判定依据）
  syncMethodFirstToggle(); // R2-S1：方法论先行开关（GET /api/settings 权威回显）
  syncReviewModeToggle(); // R2-S2：收尾评审开关（GET /api/settings 权威回显）
  fillSettingsForm();
  // 设置页扩展区：Subagent 工作流（GET /api/workflow 同步；失败/缺端点降级本地）
  // + Skills/MCP 端点清单（缺失各自降级）+ 安装表单态（空输入 → 安装钮禁用）
  void loadWorkflowPrefView();
  void loadSkills();
  void loadMcp();
  syncSkillInstallForm();
  syncThemeRadios();
  el.setBaseUrl.focus(); // 键盘可达：打开即聚焦第一表单
}

async function saveSettingsForm() {
  const baseUrl = el.setBaseUrl.value.trim();
  const model = el.setModel.value.trim();
  const apiKey = el.setKey.value; // 明文仅存在于此刻读值
  el.setKey.value = ''; // 立即清空输入框 —— 明文不滞留
  el.settingsStatus.textContent = '保存中…';
  el.settingsStatus.className = 'drawer-status';
  try {
    const saved = await saveSettings({ baseUrl, model, apiKey });
    ui.settings = { ...ui.settings, ...saved };
    el.settingsStatus.textContent = '✓ 已保存';
    el.settingsStatus.className = 'drawer-status';
    fillSettingsForm();
    toast('设置已保存');
  } catch (err) {
    el.settingsStatus.textContent = `保存失败：${err instanceof Error ? err.message : String(err)}`;
    el.settingsStatus.className = 'drawer-status err';
  }
}

function fillSettingsForm() {
  el.setBaseUrl.value = ui.settings.baseUrl || DEFAULT_SETTINGS.baseUrl;
  el.setModel.value = ui.settings.model || DEFAULT_SETTINGS.model;
  // 工作区目录：服务端未提供时为占位（显示字段，不可改）
  el.setWorkspace.textContent =
    ui.settings.workspaceDir || '（服务端未提供 · 工作目录由 DevMate 启动位置决定）';
  if (ui.settings.keyConfigured) {
    el.keyState.textContent = `已配置 · 掩码 ${ui.settings.apiKeyMasked || '****'}`;
    el.keyState.className = 'field-help key-state';
  } else {
    el.keyState.textContent = '未配置（首次使用需填入密钥）';
    el.keyState.className = 'field-help key-state unset';
  }
}

// ============================================================== 设置页扩展区（Subagent / Skills / MCP）

/** Subagent 偏好填写 + 并行数随开关联动（disabled 只降视觉，不改提交/保存值）。 */
function fillSubagentPref() {
  el.setSubagentEnabled.checked = ui.subagent.enabled;
  el.setSubagentParallel.value = String(ui.subagent.parallel);
  el.setSubagentParallel.disabled = !ui.subagent.enabled;
}

/** 「未同步（仅本地）」旁注：仅降级态（source='local'）挂显 —— 与服务端源回显形成明示。 */
function updateSubagentNote() {
  el.setSubagentNote.hidden = ui.subagentSource === 'server';
  el.setSubagentNote.textContent = SUBAGENT_LOCAL_NOTE;
}

/** 打开设置时载入 Subagent 工作流：GET /api/workflow 成功 → 回显服务端值（后续保存走
 *  POST）；失败/缺端点 → 降级 localStorage（默认 {enabled:true,parallel:2} 与步进校验
 *  保留，旁注「未同步（仅本地）」）；一次尝试，无重试风暴。 */
async function loadWorkflowPrefView() {
  const res = await loadWorkflowPref({ storageLike: localStorage });
  ui.subagentSource = res.source;
  ui.subagent = res.value;
  fillSubagentPref();
  updateSubagentNote();
}

/**
 * Subagent 字段 change 收口（data-subagent-field 委托）：
 * - 服务端源（source='server'）→ 本地即时回显 + 防抖 300ms POST（切换/卸载前 flush）；
 * - 降级源（source='local'）→ 立即写 localStorage（无后端契约时的本地记忆）。
 */
function applySubagentField(field) {
  let patch = null;
  if (field === 'enabled') {
    const enabled = el.setSubagentEnabled.checked;
    ui.subagent = { ...ui.subagent, enabled };
    if (ui.subagentSource === 'server') patch = { enabled };
    else ui.subagent = saveSubagentPref(localStorage, ui.subagent);
  } else if (field === 'parallel') {
    // 1-4 步进，禁 0：越界/0/负 → 回落当前合法并行数（normalizeParallel 收口；纯函数
    // 缺省兜底 2 —— 提交值已归一，服务端再 400 走「回滚重读 + 提示」）
    const parallel = normalizeParallel(el.setSubagentParallel.value, ui.subagent.parallel);
    ui.subagent = { ...ui.subagent, parallel };
    if (ui.subagentSource === 'server') patch = { parallel };
    else ui.subagent = saveSubagentPref(localStorage, ui.subagent);
  }
  fillSubagentPref();
  if (patch) scheduleSubagentSync(patch);
}

/** 防抖 300ms 一次性提交：连续变更合并为单次 POST（patch 字段合并 ——
 *  混合字段部分提交 {subagentsEnabled?} | {maxParallel?}）。 */
function scheduleSubagentSync(patch) {
  ui.subagentSyncPending = { ...ui.subagentSyncPending, ...patch };
  window.clearTimeout(ui.subagentSyncTimer);
  ui.subagentSyncTimer = window.setTimeout(() => {
    ui.subagentSyncTimer = 0;
    void flushSubagentSync();
  }, 300);
}

/** 提交挂起变更（change 即提交，无队列；切换/卸载前 flush 同走此口）：
 *  成功 → 回显服务端回体；失败（含服务端 400）→ 回滚重读（GET）+「同步失败，已还原」。 */
async function flushSubagentSync() {
  window.clearTimeout(ui.subagentSyncTimer);
  ui.subagentSyncTimer = 0;
  const pending = ui.subagentSyncPending;
  ui.subagentSyncPending = null;
  if (!pending) return;
  const result = await syncWorkflowPref(pending);
  if (result.ok) {
    if (ui.subagentSource === 'server') {
      ui.subagent = result.value; // 服务端权威回体：回显归一（含并行数越界修正）
      fillSubagentPref();
    }
    return;
  }
  await revertSubagentPref();
  toast(SUBAGENT_SYNC_FAILED_TOAST, 'warn');
}

/** POST 失败回滚重读：GET 服务端态还原回显；GET 再失败 → 降级本地维持 + 旁注。 */
async function revertSubagentPref() {
  const res = await loadWorkflowPref({ storageLike: localStorage });
  ui.subagentSource = res.source;
  ui.subagent = res.value;
  fillSubagentPref();
  updateSubagentNote();
}

// ---- Skills（GET /api/skills；缺失/失败 → 降级「暂无可用技能」说明行，文案零端点路径） ----

async function loadSkills() {
  let skills = null;
  try {
    skills = normalizeSkillsList(await fetchJson('/api/skills'));
  } catch {
    skills = null; // 端点缺失/异常：诚实降级（不冒充空表）
  }
  renderSkillList(skills);
}

function renderSkillList(skills) {
  el.skillsList.replaceChildren();
  el.skillsNote.classList.remove('err');
  if (skills === null) {
    el.skillsNote.textContent = SKILLS_DEGRADED_NOTE;
    el.skillsNote.hidden = false;
    return;
  }
  el.skillsNote.hidden = true;
  for (const s of skills) {
    const li = document.createElement('li');
    li.className = 'set-list-item';
    const main = document.createElement('div');
    main.className = 'set-item-main';
    const name = document.createElement('span');
    name.className = 'set-item-name';
    name.textContent = s.name;
    const sum = document.createElement('span');
    sum.className = 'set-item-summary';
    sum.textContent = s.summary || '（摘要待补充）';
    main.append(name, sum);
    li.append(main);
    // origin='user' 徽章（「用户」小 pill；bundled 不标注 —— 简洁裁定）
    if (s.origin === 'user') {
      const badge = document.createElement('span');
      badge.className = 'badge-mono neutral';
      badge.textContent = '用户';
      badge.title = '本机安装的用户技能';
      li.appendChild(badge);
    }
    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.dataset.skillToggle = s.id;
    cb.setAttribute('aria-label', `启用技能：${s.name}`);
    const track = document.createElement('span');
    track.className = 'switch-track';
    sw.append(cb, track);
    li.appendChild(sw);
    el.skillsList.appendChild(li);
  }
}

/** 技能开关 → POST /api/skills/:id {enabled}；失败回滚（重读服务端态）。 */
async function toggleSkill(id, enabled) {
  try {
    await fetchJson(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: { enabled },
    });
  } catch (err) {
    el.skillsNote.textContent = `保存失败：${err instanceof Error ? err.message : String(err)}`;
    el.skillsNote.classList.add('err');
    el.skillsNote.hidden = false;
    void loadSkills();
  }
}

// ---- 技能安装表单（URL / 本地路径 单选 → POST /api/skills/install {source}） ----

/** 当前来源类型（'url'|'path'）：分段单选（无选择态兜底 url）。 */
function skillSourceKind() {
  const checked = el.skillSrcInputs.find((input) => input.checked);
  return checked?.value === 'path' ? 'path' : 'url';
}

/** 分段切换：placeholder 与说明随来源类型联动（文案 = extensions.js 常量单一来源）。 */
function syncSkillInstallForm() {
  const kind = skillSourceKind();
  el.skillInstallSource.placeholder =
    kind === 'path' ? SKILL_INSTALL_PATH_PLACEHOLDER : SKILL_INSTALL_URL_PLACEHOLDER;
  el.skillInstallHelp.textContent =
    kind === 'path' ? SKILL_INSTALL_HELP_PATH : SKILL_INSTALL_HELP_URL;
  syncSkillInstallButton();
}

/** 输入/来源变化时重算安装钮可用态（空来源禁用 —— 提交前还有一道空串拦截）。 */
function syncSkillInstallButton() {
  const empty = normalizeSkillSource(el.skillInstallSource.value) === '';
  if (!ui.skillInstalling) {
    el.btnSkillInstall.textContent = '安装';
    el.btnSkillInstall.disabled = empty;
  }
}

/**
 * 安装提交：POST /api/skills/install {source}；安装中按钮禁用 + 「安装中…」；
 * 成功 → toast「已安装 <id>」+ 清空来源 + 重拉清单；失败 → 状态行映射文案
 * （kind 白名单 → 中文；400/403 / 404 / 其余通用；文案零端点路径）。
 */
async function submitSkillInstall() {
  if (ui.skillInstalling) return;
  const source = normalizeSkillSource(el.skillInstallSource.value);
  if (source === '') {
    el.skillInstallNote.textContent = SKILL_INSTALL_EMPTY_SOURCE;
    el.skillInstallNote.classList.add('err');
    el.skillInstallNote.hidden = false;
    return;
  }
  ui.skillInstalling = true;
  el.btnSkillInstall.disabled = true;
  el.btnSkillInstall.textContent = SKILL_INSTALL_BUSY;
  el.skillInstallNote.hidden = true;
  const result = await installSkill({ source });
  ui.skillInstalling = false;
  if (result.ok) {
    el.skillInstallSource.value = '';
    syncSkillInstallButton();
    toast(result.id ? `已安装 ${result.id}` : '已安装');
    void loadSkills();
    return;
  }
  el.btnSkillInstall.textContent = '安装';
  el.btnSkillInstall.disabled = false;
  el.skillInstallNote.textContent = skillInstallErrorText(result.error);
  el.skillInstallNote.classList.add('err');
  el.skillInstallNote.hidden = false;
}

/** 重新扫描：重拉 GET /api/skills（服务端懒读，无独立刷新端点 —— 契约如此）。 */
function rescanSkills() {
  void loadSkills();
  toast('已重新扫描技能目录');
}

// ---- MCP（GET /api/mcp + POST /api/mcp；客户端协议已实现（stdio JSON-RPC，
//      见 src/core/mcp）；徽章按 enabled 态渲染 —— 契约不依赖服务端 status 字段） ----

async function loadMcp() {
  let servers = null;
  try {
    servers = normalizeMcpServers(await fetchJson('/api/mcp'));
  } catch {
    servers = null;
  }
  renderMcpList(servers);
}

function renderMcpList(servers) {
  el.mcpList.replaceChildren();
  el.mcpNote.classList.remove('err');
  if (servers === null) {
    el.mcpNote.textContent = MCP_DEGRADED_NOTE;
    el.mcpNote.hidden = false;
    return;
  }
  el.mcpNote.hidden = true;
  for (const s of servers) {
    const li = document.createElement('li');
    li.className = 'set-list-item';
    const main = document.createElement('div');
    main.className = 'set-item-main';
    const name = document.createElement('span');
    name.className = 'set-item-name mono';
    name.textContent = s.name;
    const sum = document.createElement('span');
    sum.className = 'set-item-summary';
    sum.textContent = s.command || '（未填 command）';
    main.append(name, sum);
    // 徽章 = 登记态（enabled）：开 = 「已登记」蓝 / 关 = 「已停用」中性（契约漂移修复：
    // 不再消费服务端 status —— extensions.js 对 status 宽容接受但此处单依 enabled；
    // 文案单一来源 = MCP_BADGE_ENABLED / MCP_BADGE_DISABLED（侧栏同族））
    const badge = document.createElement('span');
    badge.className = 'badge-mono' + (s.enabled ? '' : ' neutral');
    badge.textContent = s.enabled ? MCP_BADGE_ENABLED : MCP_BADGE_DISABLED;
    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.dataset.mcpToggle = s.name;
    cb.setAttribute('aria-label', `启用 MCP 服务器：${s.name}`);
    const track = document.createElement('span');
    track.className = 'switch-track';
    sw.append(cb, track);
    li.append(main, badge, sw);
    el.mcpList.appendChild(li);
  }
}

/** MCP 开关（登记态；POST /api/mcp/:name {enabled}，服务端已实现，与 skills 同形态）。 */
async function toggleMcp(name, enabled) {
  try {
    await fetchJson(`/api/mcp/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: { enabled },
    });
  } catch (err) {
    el.mcpNote.textContent = `保存失败：${err instanceof Error ? err.message : String(err)}`;
    el.mcpNote.classList.add('err');
    el.mcpNote.hidden = false;
    void loadMcp();
  }
}

/** 添加服务器 → POST /api/mcp {name, command, args[]}；成功后清表单并重读列表。 */
async function addMcpServer() {
  const name = el.mcpAddName.value.trim();
  const command = el.mcpAddCommand.value.trim();
  const args = el.mcpAddArgs.value.trim();
  el.mcpAddNote.hidden = true;
  el.mcpAddNote.classList.remove('err');
  if (!name || !command) {
    el.mcpAddNote.textContent = '名称与 command 为必填';
    el.mcpAddNote.classList.add('err');
    el.mcpAddNote.hidden = false;
    return;
  }
  try {
    await fetchJson('/api/mcp', {
      method: 'POST',
      body: { name, command, args: splitMcpArgs(args) },
    });
    el.mcpAddName.value = '';
    el.mcpAddCommand.value = '';
    el.mcpAddArgs.value = '';
    void loadMcp();
  } catch (err) {
    el.mcpAddNote.textContent = `添加失败：${err instanceof Error ? err.message : String(err)}`;
    el.mcpAddNote.classList.add('err');
    el.mcpAddNote.hidden = false;
  }
}

// ============================================================== 输入区

function autogrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 160) + 'px';
}

function renderComposer() {
  // 运行中不禁用发送钮：点击由 send() 门禁 toast「仍在运行」（不再静默吞）。
  const canSend = el.input.value.trim().length > 0 && inputUnlocked();
  el.send.disabled = !canSend;
  // 访问模式 chip：会话不可用（未配置密钥）时锁定（dsh PermissionSelect locked 语义）
  el.permChip.disabled = !inputUnlocked();
}

// ============================================================== 全局渲染收口

function autoscroll() {
  const nearBottom =
    el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
  if (nearBottom) requestAnimationFrame(() => el.messages.scrollTo(0, el.messages.scrollHeight));
}

function render(snap) {
  ui.lastSnap = snap;
  renderItems(snap);
  renderHeader(snap);
  renderComposerStats(snap);
  renderMeter();
  renderStrip(snap);
  syncRunClock();
  renderComposer();
  renderApprovalBanner(snap);
  autoscroll();
}

// ============================================================== 事件装配

function wireEvents() {
  el.send.addEventListener('click', send);
  el.stop.addEventListener('click', stopStream);
  // 内嵌审批卡双键（无附注框 —— dsh ApprovalPanel：拒绝(outline)/允许(primary)）
  el.btnBannerApprove.addEventListener('click', () => {
    void decideBannerApproval(true);
  });
  el.btnBannerDeny.addEventListener('click', () => {
    void decideBannerApproval(false);
  });
  // 访问模式 chip：点击开菜单（菜单自身点击由行 handle 收口；外点/Esc 关闭）
  el.permChip.addEventListener('click', () => {
    togglePermMenu();
  });
  el.riskScrim.addEventListener('click', closeRiskConfirm);
  el.btnRiskCancel.addEventListener('click', closeRiskConfirm);
  el.btnRiskOk.addEventListener('click', confirmRiskAccess);
  document.addEventListener('keydown', (e) => {
    // Esc：内嵌审批卡 = 该次拒绝（无备注拒绝 = 服务端 user-interrupted 收尾本轮，
    // 与点「拒绝」键完全同语义 —— 内嵌卡非 modal，无焦点陷阱，仅在页内停靠）；
    // 设置抽屉 / 删除确认 / 风险确认门同样支持 Esc 关闭。
    if (e.key === 'Escape') {
      if (ui.riskConfirmOpen) {
        closeRiskConfirm();
        return;
      }
      if (!el.approvalDock.hidden && ui.currentApproval) {
        void decideBannerApproval(false);
        return;
      }
      // S14 多工作区层叠（modal 优先于菜单）：移除确认 → 错误对话框 → 目录弹窗 → ＋新建菜单
      if (ui.wsRemoveOpen) {
        closeWsRemove();
        return;
      }
      if (ui.wsErrorOpen) {
        closeWsError();
        return;
      }
      if (ui.wsPickerOpen) {
        closeWsPicker();
        return;
      }
      if (ui.wsNewMenuOpen) {
        closeWsNewMenu();
        return;
      }
      if (ui.confirmOpen) {
        closeConfirmModal();
        return;
      }
      if (!el.drawer.hidden) {
        closeDrawer();
        return;
      }
      if (!el.cmdPanel.hidden) {
        closeCmdPanel();
        return;
      }
      if (ui.permMenuOpen || !el.permMenu.hidden) {
        togglePermMenu(false);
        return;
      }
      hideCommandMenu();
    }
  });
  el.btnSettings.addEventListener('click', openSettings);
  document.getElementById('btn-empty-open-settings').addEventListener('click', openSettings);
  document.getElementById('btn-settings-close').addEventListener('click', closeDrawer);
  // dsh 设置卡 Cancel/Apply 对：取消 = 关闭设置页（配置改动不落盘）
  el.btnSettingsCancel?.addEventListener('click', closeDrawer);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsForm);
  el.drawerScrim.addEventListener('click', closeDrawer);
  el.input.addEventListener('input', () => {
    autogrow();
    renderComposer();
    scheduleCommandMenu();
  });
  el.input.addEventListener('keydown', (e) => {
    // 「/」命令模式：菜单开时上下键循环高亮、Esc 收起；Enter 命中 `/…` 行即执行命令
    if (ui.cmdMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveCommandHighlight(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveCommandHighlight(-1);
        return;
      }
      if (e.key === 'Escape' || e.key === 'Tab') {
        hideCommandMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const line = el.input.value.trim();
      // 命令行拦截：/ 开头且已成型（非纯 '/'）→ 执行命令，不下发聊天
      if (line.startsWith('/') && parseCommandLine(line) !== null) {
        e.preventDefault();
        void executeCommandLine(line);
        return;
      }
      e.preventDefault();
      if (!el.send.disabled) send();
    }
  });

  // S13/S14：侧边栏（dsh 语义：toggle/品牌/新建 = 侧栏内；行点击/删除/组折叠 = 委托收口）
  el.btnSidebarToggle.addEventListener('click', toggleSidebar);
  el.btnBrand.addEventListener('click', () => {
    void newSession();
  });
  // ＋新建（dsh WorkspacePickFlow）：锚于按钮的菜单 —— 工作区列表 + 添加工作区…
  el.btnNewSession.addEventListener('click', () => {
    toggleWsNewMenu();
  });
  // 工作区组列表（#ws-groups 单点委托）：会话行点击 = 恢复；组头 = 折叠切换；
  // 组内 ＋ = 新建会话于该组；组头 kebab = 行菜单（移除工作区）
  el.wsGroups.addEventListener('click', (event) => {
    const kebab = event.target.closest('[data-ws-kebab]');
    if (kebab) {
      event.stopPropagation();
      const root = kebab.dataset.wsKebab ?? '';
      if (!root) return;
      if (el.rowMenu.hidden) {
        openRowMenu(kebab, {
          type: 'workspace',
          root,
          disabled: root === ui.wsDefaultRoot,
        });
      } else {
        closeRowMenu();
      }
      return;
    }
    const plus = event.target.closest('[data-ws-plus]');
    if (plus) {
      event.stopPropagation();
      const root = plus.dataset.wsPlus ?? '';
      if (root) void newSession(root);
      return;
    }
    const groupHeader = event.target.closest('.wsGroupHead');
    if (groupHeader) {
      toggleWsGroup(groupHeader);
      return;
    }
    const row = event.target.closest('li.sessionRow');
    if (row?.dataset.sessionId) void restoreSession(row.dataset.sessionId);
  });
  wireRowMenu();
  // ＋新建 菜单外点关闭（菜单自身点击由 item handler 负责 —— 不得抢先关）
  document.addEventListener('click', (event) => {
    if (!ui.wsNewMenuOpen) return;
    if (event.target instanceof Node && el.wsNewMenu.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('#btn-new-session')) return;
    closeWsNewMenu();
  });
  // 添加工作区（区块头 ＋ / 空态按钮）：直达目录弹窗
  el.btnAddWorkspace.addEventListener('click', () => {
    void openWsPicker();
  });
  el.btnEmptyAddWorkspace.addEventListener('click', () => {
    void openWsPicker();
  });
  // 目录选择弹窗（browse 形态）：面包屑/目录行/手动输入/取消/选择 全部这里挂
  el.btnWsPickerClose.addEventListener('click', closeWsPicker);
  el.btnWsPickerCancel.addEventListener('click', closeWsPicker);
  el.wsPickerScrim.addEventListener('click', closeWsPicker);
  el.btnWsPickerSelect.addEventListener('click', () => {
    void wsPickerCommit();
  });
  el.wsManualInput.addEventListener('input', () => {
    // 手动输入即视为落点候选：与当前 selected 共存（回车最终裁决）
    if (el.wsManualInput.value.trim() === '') return;
    ui.wsPickerState = browseSelect(ui.wsPickerState, el.wsManualInput.value.trim());
    renderWsPicker();
  });
  el.wsManualInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void wsPickerManualEnter();
    }
  });
  // 添加工作区错误对话框（dsh folderError：取消/重试）
  el.btnWsErrorCancel.addEventListener('click', closeWsError);
  el.wsErrorScrim.addEventListener('click', closeWsError);
  el.btnWsErrorRetry.addEventListener('click', retryWsError);
  // 移除工作区确认
  el.btnWsRemoveOk.addEventListener('click', () => {
    void confirmRemoveWorkspace();
  });
  el.btnWsRemoveCancel.addEventListener('click', closeWsRemove);
  el.wsRemoveScrim.addEventListener('click', closeWsRemove);
  el.btnConfirmOk.addEventListener('click', () => {
    void confirmDeleteSession();
  });
  el.btnConfirmCancel.addEventListener('click', closeConfirmModal);
  el.confirmScrim.addEventListener('click', closeConfirmModal);
  // 设置页扩展区：data-* 事件委托（一个 change + 一个 click 收口全部新控件）
  el.drawer.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.skillToggle) void toggleSkill(t.dataset.skillToggle, t.checked);
    else if (t.dataset.mcpToggle) void toggleMcp(t.dataset.mcpToggle, t.checked);
    else if (t.dataset.subagentField) applySubagentField(t.dataset.subagentField);
    else if (t.dataset.methodfirstField) applyMethodFirstField(t.checked);
    else if (t.dataset.reviewmodeField) applyReviewModeField(t.checked);
    else if (t.name === 'skill-install-src') syncSkillInstallForm();
  });
  el.drawer.addEventListener('click', (e) => {
    const action = e.target.closest('[data-set-action]')?.dataset?.setAction;
    if (action === 'mcp-add') void addMcpServer();
    else if (action === 'skill-install') void submitSkillInstall();
    else if (action === 'skill-rescan') rescanSkills();
  });
  // 技能安装输入：非空即解锁安装钮（提交前仍有一次空串拦截）
  el.skillInstallSource.addEventListener('input', syncSkillInstallButton);
  // 思考强度分段 pill：点击即选 + 防抖提交（失败回滚 toast）
  el.reasoningSeg.addEventListener('click', (event) => {
    const btn = event.target.closest('.reasoning-opt');
    if (!btn) return;
    const value = btn.dataset.reasoning ?? '';
    if (value === ui.settings.reasoning || !REASONING_VALUES.includes(value)) return;
    ui.settings = { ...ui.settings, reasoning: value };
    syncReasoningSeg();
    scheduleReasoningSync(value);
  });
  // 命令面板关闭（X 外点）
  el.cmdPanelClose.addEventListener('click', closeCmdPanel);
  document.addEventListener('click', (event) => {
    if (!el.cmdPanel.hidden) {
      if (event.target instanceof Node && el.cmdPanel.contains(event.target)) return;
      closeCmdPanel();
    }
    if (ui.cmdMenuOpen || !el.cmdMenu.hidden) {
      if (event.target instanceof Node && el.cmdMenu.contains(event.target)) return;
      hideCommandMenu();
    }
    if (ui.permMenuOpen || !el.permMenu.hidden) {
      if (event.target instanceof Node && el.permMenu.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest('#perm-chip')) return;
      togglePermMenu(false);
    }
  });
  // 输入离开即收起命令下拉（贴外层关闭不覆盖输入区的点击）
  el.input.addEventListener('blur', () => {
    window.setTimeout(hideCommandMenu, 120);
  });
  wireQuietBars();
  wireTheme();

  // 视口跨档（<900px 自动折叠 rail ↔ ≥900px 偏好；dsh AppFrame 约定：
  // 窄屏默认折叠、toggle 翻转运行时展开覆盖 —— 不落盘）
  if (narrowMq) {
    narrowMq.addEventListener?.('change', () => {
      scheduleSidebarSettle();
    });
  }
  // 卸载前 flush Subagent 工作流 / 思考强度 / 访问模式 / 方法论先行 / 收尾评审挂起同步（best-effort）
  window.addEventListener('pagehide', () => {
    if (ui.subagentSyncPending) void flushSubagentSync();
    if (ui.reasoningSyncPending !== null) void flushReasoningSync();
    if (ui.permissionSyncPending !== null) void flushPermissionSync();
    if (ui.methodFirstSyncPending !== null) void flushMethodFirstSync();
    if (ui.reviewModeSyncPending !== null) void flushReviewModeSync();
  });
}

// ============================================================== 启动

async function boot() {
  store.subscribe(render);

  // 主题（S13）：先于一切渲染 —— 首帧即按 localStorage + 系统偏好着色
  ui.theme = loadThemeKey(localStorage);
  applyTheme(document, ui.theme, systemPrefersDark());
  syncThemeRadios();

  // 侧边栏状态（dsh 语义：collapsed → rail 56px；窄屏自动折叠由 effectiveCollapsed 裁决；
  // 持久化仅字面量 'true' 服从 —— 损坏/旧记法一律按展开处理，见 sidebar.js）。
  // 冷渲染直接 settle：折叠态首帧即静态 rail（无 railIn/fading 动画）。
  ui.sidebarCollapsed = loadSidebarState(localStorage);
  ui.sidebarSettled = effectiveCollapsed();
  sidebarEverWide = !effectiveCollapsed();
  syncSidebarUi();
  el.buildVersion.textContent = BUILD_VERSION;

  // 设置与密钥状态（失败 → 按「静态预览」降级：输入不锁，界面可演示）
  try {
    const s = await loadSettings();
    ui.settings = { ...ui.settings, ...s };
    ui.settingsReady = true;
  } catch {
    ui.settingsReady = false;
  }
  // 思考强度分段 pill（选项 = settings.js 常量；回显当前档位）
  buildReasoningSeg();
  syncReasoningSeg();
  // 访问模式 chip（选项 = permissions.js 常量；回显当前档位 + 盾形 glyph）
  buildPermMenu();
  syncPermChip();
  // R2-S1：方法论先行开关（启动 GET 回显 —— 设置打开时也随 openSettings 重读）
  syncMethodFirstToggle();
  // R2-S2：收尾评审开关（启动 GET 回显 —— 设置打开时也随 openSettings 重读）
  syncReviewModeToggle();
  // 窗口覆盖就绪：上下文环重新取值（首帧可能在 settings 未到前渲染过）
  if (ui.lastSnap) renderMeter();

  // 会话恢复：localStorage 里的 sessionId 直接续用（无需额外端点）；
  // 单流模型：恢复即接入该会话的长活流（全量回放历史；run 若仍在进行则终态随流到达）
  ui.sessionId = localStorage.getItem(LS_SESSION) || null;
  store.setSessionId(ui.sessionId);
  if (ui.sessionId) {
    store.addSystem(`已恢复上次会话 #${shortId(ui.sessionId)}，发送下一条消息继续。`, 'info');
    void ensureStream(ui.sessionId);
  }

  // S14：per-workspace 折叠映射（损坏/缺失 → 全展开；读写容错见 workspaces.js）
  ui.wsCollapsed = loadWorkspaceCollapse(localStorage);
  // 侧栏数据（会话/工作区/统计）：端点未实现时各自降级（列表不可用说明/说明行 +
  // 会话根并集伪注册根 —— 组仍可见；工具清单与 MCP 只存在于设置页）
  void refreshWorkspaces();
  void refreshSessionList();
  void refreshStats();

  if (ui.settingsReady && !ui.settings.keyConfigured) {
    el.step1.classList.add('hot');
    toast('欢迎使用 DevMate：第一步，先配置你的 API Key');
  }

  el.input.disabled = !inputUnlocked();
  autogrow();
}

mountStaticIconGlyphs();
wireEvents();
boot();
