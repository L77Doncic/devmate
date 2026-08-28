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
 * 对话级统计属于输入框上下文，随每一步 run 汇总到同一行）。
 * 内容 = 步骤数 · 耗时 · 入/出/总 tokens · ≈成本（estimated 标 ≈；五项全显沿用）。
 * 只输出存在项；runStatus 与 usage 均无值 → 返回 ''（UI 隐藏整行，
 * 暂停/无数据时不显示假值「—」。runStatus 步骤/耗时只认 number（非 0 兜底）。）
 */
export function composerStatsLine(runStatus, usage) {
  const parts = [];
  if (runStatus && Number.isFinite(runStatus?.steps)) parts.push(`${runStatus.steps} 步`);
  if (runStatus && Number.isFinite(runStatus?.durationMs)) {
    parts.push(formatDurationMs(runStatus.durationMs));
  }
  if (usage) {
    if (Number.isFinite(usage.promptTokens)) parts.push(`入 ${formatTokens(usage.promptTokens)}`);
    if (Number.isFinite(usage.completionTokens)) {
      parts.push(`出 ${formatTokens(usage.completionTokens)}`);
    }
    if (Number.isFinite(usage.totalTokens)) parts.push(`总 ${formatTokens(usage.totalTokens)}`);
    if (Number.isFinite(usage.costUsd)) {
      parts.push(`${usage.estimated ? '≈' : ''}${formatCostUsd(usage.costUsd)}`);
    }
  }
  return parts.join(' · ');
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
