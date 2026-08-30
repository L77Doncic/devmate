/**
 * # commands.js — 「/」命令表与解析纯逻辑（node 可直接 import；无 DOM / 无 fetch）
 *
 * 输入区首个字符 `/` 触发（防抖 150ms 出下拉在 app.js），本模块只承载可测裁决：
 * 命令表（13 条的单一来源）、行解析（parseCommandLine）、前缀匹配
 * （matchCommands —— 下拉过滤）、theme 参数校验（commandArgValid）。
 * 执行（面板/网络/消息流）在 app.js —— 纯逻辑与副作用分离（同 menu.js 纪律）。
 *
 * 契约：
 * - parseCommandLine('/theme dark') → { name:'/theme', args:'dark', argList:['dark'] }；
 *   无 `/` 前缀（'theme dark' / ''）→ null；空名（'/' / '/ ' / '//'）→ null。
 * - matchCommands('the', 8) → 名称以 '/the' 开头的条目（含 '/' 前缀比较）；
 *   空查询 → 返回前 8 条（下拉首次展开 = 全表）。
 * - commandFor(name) 白名单精确匹配；未知 → null（调用方落「未知命令」错误行）。
 */

/** /theme 的参数白名单（与 theme.js THEME_VALUES 同序同值；单一来源防漂移断言）。 */
export const THEME_ARG_VALUES = Object.freeze(['dark', 'light', 'system']);

/** /continue（及 run-strip「继续」钮）的发往会话的续跑指令文本（单一来源）。 */
export const CONTINUE_PROMPT = '请继续刚才未完成的任务。';

/** 命令表（id/name/label/desc/hint 单一来源；执行分派在 app.js 按 id 白名单匹配）。 */
export const COMMANDS = Object.freeze([
  Object.freeze({
    id: 'help',
    name: '/help',
    label: '命令帮助',
    desc: '显示全部命令与说明',
    hint: '',
  }),
  Object.freeze({
    id: 'new',
    name: '/new',
    label: '新建会话',
    desc: '在项目下新建一个会话',
    hint: '',
  }),
  Object.freeze({
    id: 'clear',
    name: '/clear',
    label: '清空对话',
    desc: '新会话（当前对话页重置；与 /new 同义）',
    hint: '',
  }),
  Object.freeze({
    id: 'stop',
    name: '/stop',
    label: '停止任务',
    desc: '中断当前运行中的任务',
    hint: '',
  }),
  Object.freeze({
    id: 'continue',
    name: '/continue',
    label: '继续任务',
    desc: '向当前会话发送「请继续刚才未完成的任务。」（走正常聊天路径续跑）',
    hint: '',
  }),
  Object.freeze({
    id: 'sessions',
    name: '/sessions',
    label: '会话列表',
    desc: '列出全部会话与数量',
    hint: '',
  }),
  Object.freeze({
    id: 'cost',
    name: '/cost',
    label: '会话成本',
    desc: '本会话累计成本（按 usage 事件累积）',
    hint: '',
  }),
  Object.freeze({
    id: 'stats',
    name: '/stats',
    label: '运行统计',
    desc: '进程内存 / 会话 / Shell 统计',
    hint: '',
  }),
  Object.freeze({
    id: 'model',
    name: '/model',
    label: '当前模型',
    desc: '显示当前模型与端点，附去设置提示',
    hint: '',
  }),
  Object.freeze({
    id: 'skill',
    name: '/skill',
    label: '技能状态',
    desc: '显示已启用技能数（入口在设置 → Skills）',
    hint: '',
  }),
  Object.freeze({
    id: 'theme',
    name: '/theme',
    label: '主题',
    desc: '设置主题；参数 dark / light / system',
    hint: '<dark|light|system>',
  }),
  Object.freeze({
    id: 'mcp',
    name: '/mcp',
    label: 'MCP 服务器',
    desc: '显示 MCP 服务器登记态（配置在设置 → MCP）',
    hint: '',
  }),
  Object.freeze({
    id: 'compact',
    name: '/compact',
    label: '压缩状态',
    desc: '上下文压缩说明（服务端自动，无需手动）',
    hint: '',
  }),
]);

/** 命令条目 id → 条目（白名单）；未知 id 返回 null。 */
export function commandById(id) {
  const item = COMMANDS.find((c) => c.id === id);
  return item === undefined ? null : item;
}

/** 名称（含 `/` 前缀）→ 条目；未知 → null。 */
export function commandFor(name) {
  const item = COMMANDS.find((c) => c.name === name);
  return item === undefined ? null : item;
}

/**
 * 命令前缀匹配（下拉过滤）：`/` + 键入片段 → 表内名称以该片段为前缀的条目，
 * 按表内顺序；空片段 → 全表前 cap 条。cap ≤ 0 → 空数组（防御）。
 */
export function matchCommands(partial, cap = 8) {
  const p = String(partial ?? '');
  if (cap <= 0) return [];
  const hits = COMMANDS.filter((c) => p === '' || c.name.startsWith(p));
  return hits.slice(0, cap);
}

/**
 * 命令行解析：trim 后必须以 `/` 开头；name = 第一个空白前的字面量（须 > 1 字符，
 * 即 '/' 或 '/ ' → null —— 未输入命令名之前不构成可执行命令）。
 * 返回 { name, args, argList } 或 null。args 为原样剩余文本；argList 按空白切分。
 */
export function parseCommandLine(input) {
  const text = String(input ?? '').trim();
  if (!text.startsWith('/')) return null;
  const match = /^\/(?!\/)(\S+)(?:\s+(.*))?$/.exec(text);
  if (match === null) return null; // '/', '/ ', '//' 之类（空名不构成命令）
  const name = `/${match[1]}`;
  const args = match[2] ?? '';
  return {
    name,
    args,
    argList:
      args === ''
        ? []
        : String(args)
            .split(/\s+/)
            .filter((s) => s !== ''),
  };
}

/**
 * 命令参数合法性（目前仅 /theme 有参数）：theme 必须恰好 1 个参数且 ∈ 白名单。
 * 其余命令不接受参数（argList 非空 → false —— 调用方给出错误提示）。
 */
export function commandArgValid(cmd, argList) {
  const args = argList ?? [];
  if (cmd?.id === 'theme') {
    return args.length === 1 && THEME_ARG_VALUES.includes(args[0]);
  }
  return args.length === 0;
}

/** /theme 参数 → 中文名（复用表 hint 的反向展示；未知直接原样返回）。 */
export function themeArgLabel(value) {
  const labels = { dark: '深色', light: '浅色', system: '跟随系统' };
  return labels[value] ?? String(value ?? '');
}
