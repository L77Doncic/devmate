/**
 * # format.js — 展示格式化纯函数（node 可直接 import）
 *
 * 职责只限「数字/文本 → 展示串」，不做状态机、不触 DOM、不触网络。
 * 另收敛三张「用户可见词表」（单一权威源，防镜像漂移测试见 test/ui-web/format.test.ts）：
 * RUN_STATUS_SEMANTICS（run 终态）/ RUN_STAGE_WORDS（运行阶段词）/ CONN_VISIBLE（连接态）/
 * TOOL_STATE_LABEL（工具卡状态词）。
 */

/** 截断到 n 个字符（默认 300，语义与「工具结果预览截断 300 字符」对应）。 */
export function truncate(text, n = 300) {
  const s = String(text ?? '');
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n)) + '…';
}

/** 工具结果预览：成功用 contentPreview，失败用 error；截断 300 字符。 */
export function toolResultPreview(result, n = 300) {
  if (!result) return '';
  const raw = result.ok ? result.preview : result.error || result.preview;
  return truncate(raw ?? '', n);
}

/** token 数 → 人类刻度：`0` `1.2k` `12.3k` `1.4m`。 */
export function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '–';
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'm';
}

/** USD 金额 → 短格式：注意保留有效位（0.00012 这种值）。 */
export function formatCostUsd(usd) {
  const v = Number(usd);
  if (!Number.isFinite(v) || v < 0) return '–';
  if (v === 0) return '$0';
  if (v >= 100) return '$' + v.toFixed(0);
  if (v >= 1) return '$' + v.toFixed(2);
  if (v >= 0.001) return '$' + v.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '');
  return '$' + v.toExponential(1).replace('e-', 'e-0'); // 例如 $1.2e-06
}

/** 毫秒 → `35ms` `2.1s` `3m 20s` `1h 05m`。 */
export function formatDurationMs(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '–';
  const total = Math.round(v);
  if (total < 1000) return `${total}ms`;
  const s = total / 1000;
  if (s < 60) return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + 's';
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m}m ${rem.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, '0')}m`;
}

/** 工具参数：尽力 JSON 美化；不是 JSON 的原样展示（模型给的是字符串）。 */
export function formatArguments(raw) {
  const s = String(raw ?? '');
  if (!s.trim()) return '(无参数)';
  try {
    const parsed = JSON.parse(s);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return s;
  }
}

/** id 短显示：取前 6 位（会话/工具卡都用）。 */
export function shortId(id) {
  return String(id ?? '').slice(0, 6);
}

/** 毫秒时间戳 → `21:05`（无日期；会话内足够）。 */
export function formatTime(ts) {
  const d = ts instanceof Date ? ts : new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * run-status 语义表（S12 RunStatus 八值；前端**单一权威源**）。
 * 终态判定（messages.js 的 TERMINAL_STATUSES）、中文标签（statusLabel）、
 * tone（app.js 的 statusTone）全部由本表导出 —— 新增状态只改这里，漂移测试
 * 见 test/ui-web/format.test.ts。tone：ok 绿 / stop 琥珀 / err 红。
 * **互斥裁决**：本表（run **整体终态**）与 TOOL_STATE_LABEL（工具卡**单次执行结果**）
 * 是两张独立词表 —— 「已完成/已中断」同词纯属中文巧合，语义不同、禁止互相改词。
 */
export const RUN_STATUS_SEMANTICS = Object.freeze({
  completed: { label: '已完成', tone: 'ok' },
  'cost-guard': { label: '成本护栏停机', tone: 'stop' },
  'max-steps': { label: '步数上限停机', tone: 'stop' },
  'wall-time': { label: '墙钟超时', tone: 'stop' },
  'circuit-break': { label: '熔断停机', tone: 'err' },
  'compaction-debounce': { label: '压缩不收敛停机', tone: 'stop' },
  'user-interrupted': { label: '已中断', tone: 'stop' },
  fatal: { label: '内部错误', tone: 'err' },
});

/** 终态清单（八值）：messages.js 判 runActive=false；app.js 判「run 已落幕 → 刷统计/列表」。 */
export const TERMINAL_STATUSES = Object.freeze(Object.keys(RUN_STATUS_SEMANTICS));

/**
 * 运行阶段词（run 进行中状态条的阶段词；dsh「Ongoing/Paused/Blocked Goal」中文等价）：
 * generating = 默认（LLM 主循环执行中）/ tool = 工具执行中 / approval = 审批等待。
 * **单一权威源**：app.js 的 runStageWord（三处 return）与 CONN_VISIBLE 的 busy/warn
 * 都引用本表 —— 同词同义，「生成中/待审批」改动只发生在这里；防漂移测试见 format.test.ts。
 */
export const RUN_STAGE_WORDS = Object.freeze({
  generating: '生成中',
  tool: '工具执行中',
  approval: '待审批',
});

/**
 * 连接态 6 语义（顶栏 conn pill；off = 本会话流未建立；键与 app.js renderHeader 的
 * 六态裁决一一对应）。busy/warn **复用** RUN_STAGE_WORDS（共享 Value 引用）：
 * 「run 进行中 ↔ 阶段词默认『生成中』」「审批等待 ↔ 阶段词『待审批』」本就同义。
 * 本表与 RUN_STAGE_WORDS / TOOL_STATE_LABEL 各自独立（仅 busy/warn 两词共享字面来源），
 * 防漂移断言见 test/ui-web/format.test.ts。
 */
export const CONN_VISIBLE = Object.freeze({
  ok: '已连接',
  busy: RUN_STAGE_WORDS.generating,
  warn: RUN_STAGE_WORDS.approval,
  err: '出错',
  config: '待配置',
  off: '未连接',
});

/**
 * 连接态悬停解释（顶栏 conn pill 的 title；与 CONN_VISIBLE 同键集）：
 * 每个词给「下一动作」一句话 —— 第一次出现「待配置/未连接」不再需要去猜。
 * 键不镜像 = 漂移（防漂移断言见 format.test.ts）。
 */
export const CONN_HINTS = Object.freeze({
  ok: '已连接：当前会话可正常收发消息',
  busy: '任务进行中：可点输入区左侧的「停止」中断',
  warn: '等待审批：请处理输入区上方的批准提示',
  err: '上次运行出错：看看消息流中的错误说明',
  config: '待配置：打开设置→模型接口，填写 API Key 并保存后即可开始',
  off: '未连接：先选择工作区（「选择工作区…」或「使用默认工作区」）',
});

/**
 * 工具卡状态词（7 态；messages.js 状态机是唯一产出面：running / success / failed /
 * pending / done-waiting-result / denied / interrupted）。app.js 以
 * `TOOL_STATE_LABEL[t.state] ?? statusLabel(t.state)` 兜底读取。
 * **互斥裁决**：与 RUN_STATUS_SEMANTICS（run 终态）是两张**独立表** —— 工具卡 = 单次
 * 工具执行结果，run-status = 整体 run 收场，语义不同。「已完成/已中断」与 run 终态同词
 * 纯属中文巧合，禁止合并、禁止改词（改词会破坏工具卡语境）。
 */
export const TOOL_STATE_LABEL = Object.freeze({
  running: '执行中…',
  success: '已完成',
  failed: '失败',
  pending: '待审批',
  'done-waiting-result': '完成',
  denied: '已拒绝',
  interrupted: '已中断',
});

/** run-status → 中文状态标签（值为协议权威；未知值原样显示，协议演进可读可扩展）。 */
export function statusLabel(status) {
  return RUN_STATUS_SEMANTICS[String(status ?? '')]?.label ?? String(status ?? '');
}

/** run-status → tone（ok/stop/err）；未知 → 'unknown'（灰，不再默认绿）。 */
export function statusTone(status) {
  return RUN_STATUS_SEMANTICS[String(status ?? '')]?.tone ?? 'unknown';
}

/**
 * run-strip「继续」钮可见性（唯一裁决；app.js 只消费）：
 * 仅终态 user-interrupted（用户主动中断，历史 + interrupted 占位可安全续跑）显示；
 * cost-guard/max-steps/wall-time 等其它终态不提供（各为独立停机原因，语义不同）。
 * 无会话（sessionId 缺失）/ 运行中 / 有错误（run-error 横条场景）一律隐藏。
 */
export function continueVisible(runStatus, view = {}) {
  if (view.runActive) return false;
  if (view.lastError) return false;
  if (!view.hasSession) return false;
  return runStatus?.status === 'user-interrupted';
}

/** run-status 完整的摘要行，如 `已完成 · 3 步 · 2.1s`。 */
export function runStatusLine(rs) {
  if (!rs?.status) return '';
  const parts = [statusLabel(rs.status)];
  if (Number.isFinite(rs.steps)) parts.push(`${rs.steps} 步`);
  if (Number.isFinite(rs.durationMs)) parts.push(formatDurationMs(rs.durationMs));
  return parts.join(' · ');
}

/**
 * 参数摘要（工具行单行扫视）：JSON 压平为单行；不是 JSON 的原样压空白；
 * 截断 n（默认 60）字符。只做展示，不动存储形态。
 */
export function argSummary(raw, n = 60) {
  const s = String(raw ?? '');
  if (!s.trim()) return '';
  let flat;
  try {
    flat = JSON.stringify(JSON.parse(s));
  } catch {
    flat = s.replace(/\s+/g, ' ').trim();
  }
  return truncate(flat, n);
}

/**
 * 失败摘要压平（对齐 `error.name: error.code` 哲学的中文等价）：
 * 已是「类型: 消息」形态（如 TypeError: x）原样保留 —— 那正是压平后的形状；
 * 否则统一补 `错误：` 前缀（协议只给 message 字符串，没有 name/code 结构）。
 */
export function errorSummary(error, n = 80) {
  const s = String(error ?? '').trim();
  if (!s) return '';
  const flat = /^[A-Za-z_][\w.]*:\s*/.test(s) ? s : `错误：${s}`;
  return truncate(flat, n);
}

/** 工具摘要首行（折叠态单行）：成功 = 结果 preview 首行；失败 = errorSummary 压平形态；截断 80。 */
export function toolSummaryLine(result, n = 80) {
  if (!result) return '';
  if (!result.ok) return errorSummary(result.error || result.preview, n);
  const first = String(result.preview ?? '').split('\n')[0] ?? '';
  return truncate(first, n);
}

/** compaction 披露折叠记首行：`上下文已压缩（约 N → M tokens）`；缺 token 值时简化为「上下文已压缩」。
 *  只用 number 判型 —— Number(null)=0 会把「无 token 估算」误判成「0 → 0」。 */
export function compactionLine(c) {
  const before = c?.tokensBefore;
  const after = c?.tokensAfter;
  return typeof before === 'number' && typeof after === 'number'
    ? `上下文已压缩（约 ${formatTokens(before)} → ${formatTokens(after)} tokens）`
    : '上下文已压缩';
}

/** 披露摘要全文的安全护栏（与 dsh 同类）：折叠记展开时一次性写入 body 的文本上限。
 *  超限截断并以「…（截断）」注明 —— 防超大 summary 撑爆 DOM 的兜底纪律。 */
export const COMPACTION_SUMMARY_CAP = 20_000;

/** 披露摘要全文（展开时渲染）：≤ cap 原样；超出截断到 cap + 「…（截断）」。 */
export function compactionSummary(summary, cap = COMPACTION_SUMMARY_CAP) {
  const s = String(summary ?? '');
  if (s.length <= cap) return s;
  return s.slice(0, Math.max(0, cap)) + '…（截断）';
}

/**
 * composer 输入卡 footer 用量统计行（dsh InputBar footer 哲学本地形态：
 * 对话级统计属于输入框上下文，随每一步 run 汇总到同一行；**dsh StatsLine 分组重排**：
 * 组之间用 ` | ` 分隔、组内用 ` · ` 点号 —— 见 B 节 statsline 分组细节）。
 * 分组：组1 步数（turns 协议字段未提供 → 只出 {steps} 步，注明）；组2 耗时；
 *       组3 用量（入/出/总，= dsh tokenUsage 投影剔除缓存命中后可得项）；
 *       组4 ≈成本（estimated 标 ≈）。
 * 只输出存在组；runStatus 与 usage 均无值 → 返回 ''；单组时无 ` | `（自然形态）。
 * runStatus 步骤/耗时只认 number（非 0 兜底）。
 */
export function composerStatsLine(runStatus, usage) {
  const groups = [];
  if (runStatus && Number.isFinite(runStatus?.steps)) groups.push([`${runStatus.steps} 步`]);
  if (runStatus && Number.isFinite(runStatus?.durationMs)) {
    groups.push([formatDurationMs(runStatus.durationMs)]);
  }
  if (usage) {
    const u = [];
    if (Number.isFinite(usage.promptTokens))
      u.push(`入 ${formatTokens(usage.promptTokens)} tokens`);
    if (Number.isFinite(usage.completionTokens))
      u.push(`出 ${formatTokens(usage.completionTokens)} tokens`);
    if (Number.isFinite(usage.totalTokens)) u.push(`总 ${formatTokens(usage.totalTokens)} tokens`);
    if (u.length > 0) groups.push(u);
    if (Number.isFinite(usage.costUsd)) {
      groups.push([`${usage.estimated ? '≈' : ''}${formatCostUsd(usage.costUsd)}`]);
    }
  }
  return groups.map((g) => g.join(' · ')).join(' | ');
}

/** 运行中墙钟耗时文本（展示层推算；开始时间缺失/非法/未到返回 ''）。
 *  只接受 number —— Number(null)=0 / Number('')=0 会把缺失值误判成 epoch。 */
export function elapsedText(startedAt, now = Date.now()) {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return '';
  const d = Number(now) - startedAt;
  if (!Number.isFinite(d) || d < 0) return '';
  return formatDurationMs(d);
}

/** 相对时间：<60s 刚刚；<60m n 分钟前；否则 HH:MM。 */
export function timeAgo(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return formatTime(t);
}

// ---------------------------------------------------------------------------
// Wave 2：消息行 chrome（dsh MessageItem / MessageIconActions 纯逻辑）
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 消息时钟（dsh formatMessageClock zh 模板）：同日 → `HH:mm`；今年内 →
 * `M月d日 HH:mm`（clock.md 模板）；跨年 → `yyyy/M/d HH:mm`。
 * 只认 number（Number(null)=0 会把缺失误判成 epoch；非法/缺失 → ''）。
 */
export function formatMessageClock(ts, now = Date.now()) {
  const t = typeof ts === 'number' ? ts : ts instanceof Date ? ts.getTime() : NaN;
  const ref = typeof now === 'number' ? now : now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(t) || !Number.isFinite(ref)) return '';
  const d = new Date(t);
  const r = new Date(ref);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === r.getFullYear() &&
    d.getMonth() === r.getMonth() &&
    d.getDate() === r.getDate();
  if (sameDay) return hm;
  if (d.getFullYear() === r.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 消息行 icon-actions 的时钟追加（dsh turn-tail 同款）：`· Ran for 15s`。
 * 用时数据 = 事件 duration（run-status.durationMs）或钟差（messages.js 的 startedAt→doneAt）；
 * 缺失/非法（< 0）→ ''（Meta 行不追加）。
 */
export function ranForCaption(ms) {
  if (typeof ms !== 'number') return '';
  if (!Number.isFinite(ms) || ms < 0) return '';
  return `· Ran for ${formatDurationMs(ms)}`;
}

/** 复制反馈时长（icon-actions 复制成功换对勾的 1s —— dsh 同值；纯常量可测）。 */
export const CLIPBOARD_FEEDBACK_MS = 1000;

/**
 * toast 点击复制（clickable 选项）的悬停提示：点击 toast → 复制 data-copy
 * 完整值 → 闪现 TOAST_COPIED_TEXT。文案单一来源（app.js 消费，防漂移断言见
 * test/ui-web/format.test.ts）。
 */
export const TOAST_COPY_TITLE = '点击复制完整会话 ID';
/** toast 点击复制成功后的闪现文案（与 icon-actions 对勾反馈同词）。 */
export const TOAST_COPIED_TEXT = '已复制';

/**
 * 复制载荷：消息行复制目标 = 正文纯文本（user/assistant 均抄正文，
 * 不抄工具卡/元信息 —— dsh MessageIconActions 复制语义）。
 */
export function messageCopyText(item) {
  if (!item || typeof item !== 'object') return '';
  return String(item.text ?? '');
}

/** 思考折叠行全文的安全护栏（与 compactionSummary 同类）：展开时懒写入上限。 */
export const THINK_TEXT_CAP = 20_000;

/** 思考折叠行全文（展开时渲染）：≤ cap 原样；超出截断 + 「…（截断）」。 */
export function thinkBodyText(reasoning, cap = THINK_TEXT_CAP) {
  const s = String(reasoning ?? '');
  if (s.length <= cap) return s;
  return s.slice(0, Math.max(0, cap)) + '…（截断）';
}

/**
 * 思考折叠行摘要（dsh ReasoningRow summary）：定稿 = 第一行；运行中（未定稿）= 最新
 * 一行（跟随流）；截断 n（默认 120）。空/全空白 → ''（行不显示）。
 */
export function thinkSummary(reasoning, done, n = 120) {
  const s = String(reasoning ?? '');
  const lines = s.split('\n');
  const pick = done ? lines[0] : lines[lines.length - 1];
  const line = String(pick ?? '').trim();
  return line ? truncate(line, n) : '';
}

// ---------------------------------------------------------------------------
// Wave 2：ToolRow 变体（dsh classifyTool 语义本地形态）
// ---------------------------------------------------------------------------

/**
 * 工具卡变体（dsh classifyTool 子集：bash/read/write/edit/search/generic）：
 * run_command → bash；read_file/list_dir → read；write_file → write；
 * edit_file → edit；grep/glob/web_search → search；其余 → generic（现形态兜底）。
 */
export function classifyTool(name) {
  switch (String(name ?? '')) {
    case 'run_command':
    case 'bash':
    case 'pwsh':
      return 'bash';
    case 'read_file':
    case 'list_dir':
      return 'read';
    case 'write_file':
      return 'write';
    case 'edit_file':
      return 'edit';
    case 'grep':
    case 'glob':
    case 'web_search':
      return 'search';
    case 'use_skill':
      return 'skill';
    default:
      return 'generic';
  }
}

/** 变体标题（dsh tool.title.* locale 键的中文等价；标题非 mono —— 非原始工具名）。 */
export const TOOL_VARIANT_TITLES = Object.freeze({
  bash: '运行命令',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  search: '检索',
  skill: '加载技能',
  generic: '工具调用',
});

/** 尽力解析工具参数 JSON 对象；非对象/非 JSON → null（摘要/块函数各自兜底）。 */
export function parseToolArguments(raw) {
  const s = String(raw ?? '');
  if (!s.trim()) return null;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 审查块（B：spawn_subagent 且 arguments.prompt 含 审查|review → 独立审查块）
// 纯逻辑边界：只裁决「是不是审查子代理」与「审查块两行摘要文字」；
// 状态机侧标记（messages.js review 标志）与 DOM 形状（app.js .review-block）不在此处。
// ---------------------------------------------------------------------------

/** 审查块标题（「独立审查」；app.js 行的唯一来源，防镜像漂移）。 */
export const REVIEW_BLOCK_TITLE = '独立审查';

/**
 * 审查子代理判定（判据 = arguments.prompt 含 审查|review，大小写不敏感）：
 * name 恒为 spawn_subagent（协议工具名）；arguments 非 JSON / 无 prompt / 命中用户
 * 文本里的「审查」字样均按此裁决（误判面 = 真审查任务；宽匹配是产品语义——审查
 * 用户看到的即是审查块，宁可多包一次不可漏包）。
 */
export function isReviewSubagent(call) {
  if (!call || typeof call !== 'object') return false;
  if (String(call.name ?? '') !== 'spawn_subagent') return false;
  const args = parseToolArguments(call.arguments);
  const prompt = args && typeof args.prompt === 'string' ? args.prompt : '';
  return /审查|review/i.test(prompt);
}

/**
 * 审查块两行摘要（标题行「独立审查」之外的副题与结论首行）：
 * - subject：args.title（若有）否则 prompt 首行压平取前 40 字符；
 * - verdict：报告内容（content → preview 兜底）首行非空行取前 60 字符；
 * - 无结果（tool 在途/无输出）→ verdict 空串（渲染层落「（审查进行中…）」）。
 */
/**
 * 子代理失败 → 用户友好一句话（评审块失败结论 + 工具卡失败判读共用）：
 * 识别常见池级/传输层差错原文（认证被拒 / 未启用 / 网络不可用），映射为中文一行
 * （无端点路径、无内部词；保留原义）；未命中 → 原样压平（错误仍是普通消息）。
 */
export function friendlySubagentError(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '子代理调用失败（未知错误）';
  if (/authentication|auth\s*fail|auth error|governor|invalid[ _]api[ _]?key|401/i.test(s)) {
    return '子代理调用失败：认证被拒——检查 API Key 与模型权限后重试';
  }
  if (/subagents-disabled|sub-agents are disabled/i.test(s)) {
    return '子代理未启用：在设置→常规开启子代理工作流后可派独立评审';
  }
  if (/cost-guard|cost guard/i.test(s)) {
    return '子代理未派出：子代理预算已到上限（稍后释放或调高预算）';
  }
  if (/queue-full|queue is full/i.test(s)) {
    return '子代理未派出：排队已满（稍后重试或直接收尾）';
  }
  if (/network|econnrefused|fetch failed|timeout|timed ?out|unreachable|connection/i.test(s)) {
    return '子代理调用失败：网络不可用（稍后重试或直接收尾）';
  }
  return truncate(errorSummary(s, 60), 60);
}

export function reviewBlockText(call, result) {
  const args = parseToolArguments(call?.arguments);
  const prompt = args && typeof args.prompt === 'string' ? args.prompt : '';
  const title = args && typeof args.title === 'string' ? args.title.trim() : '';
  const subject =
    title !== '' ? truncate(title, 40) : truncate(prompt.replace(/\s+/g, ' ').trim(), 40);
  // 失败（子代理未派出）：结论 = 用户友好一行（不再裸露原始 JSON/内部错误原文）
  if (result && typeof result === 'object' && result.ok === false) {
    return {
      subject,
      verdict: friendlySubagentError(result.error ?? result.preview ?? result.content ?? ''),
    };
  }
  const full = String(result?.content ?? result?.preview ?? '');
  const firstLine =
    full
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s !== '')[0] ?? '';
  return { subject, verdict: truncate(firstLine, 60) };
}

// ---------------------------------------------------------------------------
// 供应商报错本地化（图片拒绝 / 认证失败 / 网络不可用）：裸英文 API 文本 → 中文指引。
// 命中返回用户友好一行；未命中返回 null（调用方保留原始文本 —— 零信息损失）。
// 只做「匹配已知模式 → 中文」，绝不替供应商说没有的话。
// ---------------------------------------------------------------------------

/** 图片被供应商拒收（非图像 / 超限 / 数量超）：中文 + 下一步指引。 */
export function friendlyImageError(raw) {
  const s = String(raw ?? '');
  if (/unsupported image|invalid image|bad image|not a valid image|image.*format/i.test(s)) {
    return '图片未被接受：请换用 png / jpg(jpeg) / webp / gif 格式的图片重发（可在附件预览中移除这张后重试）';
  }
  // 体积/尺寸超限要在「数量超限」之前判 —— “total size of images exceeds the limit” 含
  // “images … limit” 字样，会被数量模式优先误吞
  if (/total size|too large|too many pixels|image.*size|payload.*large|size.*exceeds/i.test(s)) {
    return '图片体积/尺寸超出供应商上限：请压缩或换小图后重发';
  }
  if (/too many images|maximum.*images|too many.*image|image.*too many/i.test(s)) {
    return '图片数量超出一次发送上限：请分批发送（发送前可在附件预览中先移除几张）';
  }
  return null;
}

/** 通用供应商/连接层报错本地化（未命中 → null：保留原文，不冒充解释）。 */
export function friendlyProviderError(raw) {
  const s = String(raw ?? '');
  const image = friendlyImageError(s);
  if (image !== null) return `图片请求被拒：${image}`;
  if (/authentication|auth\s*fail|auth error|governor|invalid[ _]api[ _]?key|401/i.test(s)) {
    return '认证失败：请检查 API Key（设置→模型接口）是否有效、模型名是否正确';
  }
  if (/rate limit|too many requests|429/i.test(s)) {
    return '请求频繁被限流：稍等片刻再试（服务端自动重试已尽力）';
  }
  if (/network|econnrefused|fetch failed|timeout|timed ?out|unreachable/i.test(s)) {
    return '网络连接失败：检查网络后重试';
  }
  return null;
}

// ---------------------------------------------------------------------------
// R2-S2 · 收尾评审静默（P1-2 附）：子代理明确未启用时，run 结束后至多提示一次
// 「本次未派独立评审（子代理不可用）」（一行，不双失败、不每任务重复）。
// ---------------------------------------------------------------------------

/** 轻提示文案（单一来源；app.js 消费，防漂移断言见 format.test.ts）。 */
export const REVIEW_SKIPPED_HINT =
  '本次未派独立评审（子代理不可用）；可在设置→常规开启子代理工作流';

/** 实质变更工具体例（与 core/loop/types 的 SUBSTANTIVE_TOOL_NAMES + mcp_ 前缀同口径）。 */
const SUBSTANTIVE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'run_command',
  'spawn_subagent',
]);

/**
 * 评审未派提示裁决（纯函数）：run 已落幕 + 收尾评审开启 + 子代理未启用（明确态）+
 * 有实质变更 + 尚无独立审查卡 → 返回提示文案；否则 null（不提示——避免每任务轰炸）。
 * @param {{ items?: unknown[]; runActive?: boolean; reviewMode?: unknown; subagentsEnabled?: unknown }} view
 */
export function reviewSkippedHint(view) {
  const { items = [], runActive = false, reviewMode, subagentsEnabled } = view ?? {};
  if (runActive) return null;
  if (subagentsEnabled !== false) return null; // 只在「明确未启用」时提示（网络挂由失败卡+模型一行说明覆盖）
  if (reviewMode === false) return null; // 评审未开 → 无提示义务
  let substantive = false;
  let reviewSeen = false;
  for (const item of items) {
    for (const t of item?.tools ?? []) {
      if (t?.name === undefined) continue;
      if (t.review === true) reviewSeen = true;
      if (SUBSTANTIVE_TOOL_NAMES.has(t.name) || String(t.name).startsWith('mcp_'))
        substantive = true;
    }
  }
  if (!substantive || reviewSeen) return null;
  return REVIEW_SKIPPED_HINT;
}

/**
 * 工具行折叠摘要（ToolRow summary 变体选择）：
 * - bash：args.description（模型为工具写的 5-10 词描述）?? command 首 60；
 * - read/write/edit：文件路径；
 * - search：pattern；
 * - generic：argSummary 压平（原形态）。
 * 统一截断 n（默认 60）字符。
 */
export function toolSummaryArgs(raw, variant = 'generic', n = 60) {
  const args = parseToolArguments(raw);
  if (!args) return argSummary(raw, n);
  switch (variant) {
    case 'bash': {
      const desc = typeof args.description === 'string' ? args.description.trim() : '';
      if (desc) return truncate(desc, n);
      return truncate(
        String(args.command ?? '')
          .replace(/\s+/g, ' ')
          .trim(),
        n,
      );
    }
    case 'read':
    case 'write':
    case 'edit':
      return truncate(String(args.path ?? ''), n);
    case 'search':
      return truncate(String(args.pattern ?? ''), n);
    case 'skill':
      // 加载技能（use_skill）：摘要 = 技能 id 一行（不再是 `{"skill":"tdd"}` 原始 JSON）
      return truncate(String(args.skill ?? args.id ?? ''), n);
    default:
      return argSummary(raw, n);
  }
}

// ---------------------------------------------------------------------------
// Wave 2：工具卡展开块（dsh toolviews：Diff/Read/Search 卡；全惰性 + 块上限）
// ---------------------------------------------------------------------------

/** 展开块字符上限（dsh CHAT_DIFF/READ/SEARCH_MAX_LINES 哲学的本地形态：
 *  单块 ≤ 2000 字符，超出截断 + 「…（截断）」注记；折叠态永不渲染块内容）。 */
export const BLOCK_MAX_CHARS = 2000;

function intoLines(text) {
  return String(text ?? '').split(/\r?\n/);
}

/**
 * DiffBlock 行（dsh DiffBlock 粗版：红-删 / 绿+加 两色 mono）：
 * edit_file：search → '-' 行，replace → '+' 行（空 replace = 纯删除）；
 * write_file：content → 全 '+' 行。
 * 上限 cap（默认 BLOCK_MAX_CHARS）字符；超限落 note 行「…（截断）」。
 * 返回 { lines: [{type:'del'|'add'|'note', text}], truncated, removed, added }。
 */
export function buildDiffLines(raw, cap = BLOCK_MAX_CHARS) {
  const args = parseToolArguments(raw);
  if (!args) return { lines: [], truncated: false, removed: 0, added: 0 };
  let delText = '';
  let addText = '';
  if (typeof args.search === 'string') delText = args.search;
  if (typeof args.replace === 'string') addText = args.replace;
  else if (typeof args.content === 'string') addText = args.content;
  const delLines = delText ? intoLines(delText) : [];
  const addLines = addText ? intoLines(addText) : [];
  const lines = [];
  let chars = 0;
  let truncated = false;
  const push = (type, text) => {
    chars += text.length + 1;
    if (chars > cap) {
      truncated = true;
      return false;
    }
    lines.push({ type, text });
    return true;
  };
  for (const t of delLines) if (!push('del', t)) break;
  if (!truncated) for (const t of addLines) if (!push('add', t)) break;
  if (truncated) lines.push({ type: 'note', text: '…（截断）' });
  return { lines, truncated, removed: delLines.length, added: addLines.length };
}

/** ReadBlock 正文（read_file/list_dir 输出）：≤ cap 原样；超出截断 + 注记行。 */
export function buildReadBlock(content, cap = BLOCK_MAX_CHARS) {
  const s = String(content ?? '');
  if (s.length <= cap) return { text: s, truncated: false };
  return { text: s.slice(0, Math.max(0, cap)) + '\n…（截断）', truncated: true };
}

/**
 * SearchBlock 行（grep/glob 结果）：命中行（含 pattern，大小写不敏感）→ hit 标记
 * （明黄高亮）；`--` 分组行/上下文行不标记。上限 cap；截断 + 注记行。
 * 返回 { lines: [{text, hit}], hits, truncated }。
 */
export function buildSearchLines(content, pattern, cap = BLOCK_MAX_CHARS) {
  const s = String(content ?? '');
  const needle = String(pattern ?? '')
    .trim()
    .toLowerCase();
  const lines = [];
  let chars = 0;
  let truncated = false;
  for (const raw of s.split('\n')) {
    if (chars + raw.length + 1 > cap) {
      truncated = true;
      break;
    }
    const hit = needle !== '' && raw.toLowerCase().includes(needle);
    lines.push({ text: raw, hit });
    chars += raw.length + 1;
  }
  if (truncated) lines.push({ text: '…（截断）', hit: false });
  return { lines, hits: lines.filter((l) => l.hit).length, truncated };
}

// ---------------------------------------------------------------------------
// R2-S1：方法论线（模型首条回复声明的方法技能；run-strip 小牌数据源）
// ---------------------------------------------------------------------------

/**
 * 方法论线提取：从模型首条回复文本中提取 `方法线：<skillId>` 的 skill id。
 * 契约（服务端提示词）：agent 首条回复第一行为 `方法线：<skillId>`（中英文冒号均可）。
 * - 行首锚定（^ + /m 多行）：防止正文中段出现「方法线：」字样被误采；
 * - /m 允许任意行首（首行非首也命中 —— 模型排版漂移宽容）；
 * - 流式友好：delta 渐进到达时增量重提取，值会从半截（'t'）校正到全量（'tdd'）；
 * - 同一文本多个命中（如后续行引用）取首个（行程顺序第一命中）。
 * @param {unknown} text 文本串（delta 累积或 assistant-done 权威全文）
 * @returns {string|null} 技能 id（[A-Za-z0-9_-]+），无命中 → null
 */
export function methodologyLine(text) {
  const m = /^方法线[:：]\s*([A-Za-z0-9_-]+)/m.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * 方法线徽章文本（run-strip 小牌：`方法线 tdd`；单一来源防漂移）。
 * id 缺失/空 → ''（调用方仅在 methodLine 非空时调用；防御返回空串不输出裸词）。
 */
export function methodologyBadgeText(id) {
  const s = String(id ?? '');
  return s ? `方法线 ${s}` : '';
}
