/**
 * # approval-banner.js — 内嵌审批卡（dsh ApprovalPanel 本地形态）纯逻辑（node 可直接 import）
 *
 * 服务端契约（S12，本轮语义）：
 * - `approval-request` 只在 ask 类需问询时到来（approval-request{toolCallId,name,arguments}）；
 * - deny 类（权限矩阵直拒）**不再产生** approval-request —— permission-denied 回注走
 *   tool-result(ok:false,error=...)，模型继续（前端无需任何特殊处理）；
 * - 应答：POST /api/approval {sessionId,toolCallId,approve}；无附注框（dsh 无——
 *   拒绝=无备注拒绝，服务端按 user-interrupted 收尾本轮）。
 *
 * 本模块只做「审批队列 → 卡片视图模型」的纯换算：headline（工具名+一句话）、
 * 命令预览（mono 卡文本，从 arguments 提取 cmd/path……）。出现时机、队列一次一个、
 * 应答后收敛等状态机在 messages.js（approvals 队列）+ app.js（渲染首个等待项）。
 * 分离原因：视图模型可测（JSON 断言语义钉死），DOM 装配零依赖于此。
 */

/**
 * 卡片 headline（理由头行 = 工具名 + 一句话；dsh 语义：reason 缺省时的回退形态
 * `工具 {toolName} 请求越权执行` 的本地等价 —— 我们无沙箱升级文案，用中性「请求执行」）。
 * @param {string} name 工具名（bash / write_file …）
 * @returns {string}
 */
export function approvalHeadline(name) {
  const n = String(name ?? '').trim();
  return n ? `${n} 请求执行命令` : '工具请求执行命令';
}

/**
 * 命令预览文本（mono 卡；dsh ApprovalCommand = 从 tool-call 节点取 args.command）。
 * 提取优先序：JSON parse 成功后取 `cmd` → `command` → `path`；parse 失败/全缺 →
 * 原参数串（截断 300）；参数缺失 → ''（调用方渲染「（无参数）"）。
 * @param {string} argumentsText 协议帧原始 arguments（JSON 字符串）
 * @returns {string}
 */
export function commandPreview(argumentsText) {
  const raw = String(argumentsText ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return restrict(trimmed);
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const key of ['cmd', 'command', 'path']) {
      if (typeof parsed[key] === 'string' && parsed[key].trim())
        return restrict(parsed[key].trim());
    }
  }
  return restrict(trimmed);
}

/** 截断 300（与 toolResultPreview 同口径；mono 卡不完形溢出）。 */
function restrict(text) {
  const s = String(text);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/**
 * 审批队列 → 卡片视图模型（每次**只呈现一个**：取第一个等待项；队列空 → null）。
 * dsh 队列隐式一次一个；DevMate approvals[] 保持等待列表（快照语义不丢队序），
 * 这里只切「当前应呈现的卡」。
 * @param {readonly Array<{toolCallId: string, name: string, arguments: string}>} queue
 *        messages.js 快照的 approvals（已过滤为 waiting 态）
 * @returns {{toolCallId: string, name: string, headline: string, command: string} | null}
 */
export function bannerFromApproval(queue) {
  const first = queue?.[0];
  if (!first) return null;
  return {
    toolCallId: String(first.toolCallId ?? ''),
    name: String(first.name ?? ''),
    headline: approvalHeadline(first.name),
    command: commandPreview(first.arguments),
  };
}
