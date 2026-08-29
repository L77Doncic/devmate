/**
 * approval-banner.js 单测：内嵌审批卡视图模型 —— headline（工具名+一句话）、
 * 命令预览提取（JSON cmd/command/path → mono 卡文本）、队列一次一个（取首个等待项）。
 * 队列状态机（出现/应答收敛/拒绝语义）在 messages.test.ts；本文件只钉「呈现视图」。
 */
import { describe, expect, it } from 'vitest';
import {
  approvalHeadline,
  commandPreview,
  bannerFromApproval,
} from '../../src/ui/web/approval-banner.js';

describe('headline（工具名 + 一句话）', () => {
  it('bash → "bash 请求执行命令"', () => {
    expect(approvalHeadline('bash')).toBe('bash 请求执行命令');
  });

  it('fs 工具名同样进 headline', () => {
    expect(approvalHeadline('write_file')).toBe('write_file 请求执行命令');
  });

  it('缺名/空白名 → 中性回退（不裸露空串）', () => {
    expect(approvalHeadline(undefined as unknown as string)).toBe('工具请求执行命令');
    expect(approvalHeadline('   ')).toBe('工具请求执行命令');
  });
});

describe('命令预览（mono 卡文本提取）', () => {
  it('bash：取 JSON 的 cmd 字段（dsh ApprovalCommand 同源：args.command）', () => {
    expect(commandPreview('{"cmd":"cat /etc/passwd"}')).toBe('cat /etc/passwd');
  });

  it('command 字段回退（契约别名）', () => {
    expect(commandPreview('{"command":"echo hi"}')).toBe('echo hi');
  });

  it('fs 写工具：path 字段', () => {
    expect(commandPreview('{"path":"src/a.txt"}')).toBe('src/a.txt');
  });

  it('cmd 优先于 path（bash 同时带两键）', () => {
    expect(commandPreview('{"cmd":"ls -la","path":"/tmp/x"}')).toBe('ls -la');
  });

  it('非 JSON 参数串原样（截断 300 上限）', () => {
    expect(commandPreview('raw arguments')).toBe('raw arguments');
    const long = 'x'.repeat(400);
    expect(commandPreview(long)).toBe('x'.repeat(300) + '…');
  });

  it('JSON 但不是对象（数组/标量）→ 原始串回退', () => {
    expect(commandPreview('["a","b"]')).toBe('["a","b"]');
    expect(commandPreview('42')).toBe('42');
  });

  it('无字段可提取 → JSON 原文（不裸散）', () => {
    expect(commandPreview('{"foo":1}')).toBe('{"foo":1}');
  });

  it('空/缺参数 → 空串（渲染层落「（无参数）」）', () => {
    expect(commandPreview('')).toBe('');
    expect(commandPreview(null as unknown as string)).toBe('');
    expect(commandPreview(undefined as unknown as string)).toBe('');
  });
});

describe('bannerFromApproval（队列 → 卡片视图模型；一次一个）', () => {
  const item = (toolCallId: string, name = 'bash', argumentsText = '{"cmd":"ls"}') => ({
    toolCallId,
    name,
    arguments: argumentsText,
  });

  it('队列 → 首项视图模型（headline + command + 原样 id/name）', () => {
    const view = bannerFromApproval([item('t1')]);
    expect(view).toEqual({
      toolCallId: 't1',
      name: 'bash',
      headline: 'bash 请求执行命令',
      command: 'ls',
    });
  });

  it('队列一次一个：多条等待只切第一个（第二个在首条应答后自然呈现）', () => {
    const view = bannerFromApproval([item('t1'), item('t2', 'write_file', '{"path":"a.txt"}')]);
    expect(view?.toolCallId).toBe('t1');
    expect(view?.command).toBe('ls');
    // 应答第一个后：队列切片 → 新 first = t2（状态机 decideApproval 后由 store 快照保证）
    const next = bannerFromApproval([item('t2', 'write_file', '{"path":"a.txt"}')]);
    expect(next?.toolCallId).toBe('t2');
    expect(next?.headline).toBe('write_file 请求执行命令');
    expect(next?.command).toBe('a.txt');
  });

  it('队列空 → null（内嵌卡收起）', () => {
    expect(bannerFromApproval([])).toBeNull();
    expect(bannerFromApproval(undefined as unknown as [])).toBeNull();
  });

  it('字段缺失防御：id 空串 + 名缺省（headline 走中性回退）', () => {
    const loose = [{ arguments: '{"cmd":"ls"}' }] as Array<{
      toolCallId: string;
      name: string;
      arguments: string;
    }>;
    const view = bannerFromApproval(loose);
    expect(view?.toolCallId).toBe('');
    expect(view?.headline).toBe('工具请求执行命令');
  });
});
