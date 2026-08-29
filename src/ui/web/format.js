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
    if (Number.isFinite(usage.promptTokens)) u.push(`入 ${formatTokens(usage.promptTokens)}`);
    if (Number.isFinite(usage.completionTokens))
      u.push(`出 ${formatTokens(usage.completionTokens)}`);
    if (Number.isFinite(usage.totalTokens)) u.push(`总 ${formatTokens(usage.totalTokens)}`);
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
