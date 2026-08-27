import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupWorkspaces, makeWorkspace, payloadOf, putFile, runTool } from './support.js';

afterEach(() => cleanupWorkspaces());

describe('edit_file（切片 c：SEARCH/REPLACE 精确匹配）', () => {
  it('单处替换成功：前后内容断言 + 结果消息', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'notes.txt');
    putFile(file, 'one\ntwo\nthree\n');
    const r = await runTool(ws, 'edit_file', { path: file, search: 'two', replace: 'TWO' });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('replaced 1 occurrence');
    expect(readFileSync(file, 'utf8')).toBe('one\nTWO\nthree\n');
  });

  it('替换为空串（删除段）允许：内容精确删除', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'drop.txt');
    putFile(file, 'a\nb\nc\n');
    const r = await runTool(ws, 'edit_file', { path: file, search: 'b\n', replace: '' });
    expect(r.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('a\nc\n');
  });

  it('无匹配：edit-no-match + 错误载荷含路径与 SEARCH 片段 + 可执行建议（read_file/write_file）；文件原样', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'keep.txt');
    putFile(file, 'alpha\nbeta\n');
    const r = await runTool(ws, 'edit_file', { path: file, search: 'gamma', replace: 'зeta' });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('edit-no-match');
    const payload = payloadOf(r);
    expect(payload.error.type).toBe('edit-no-match');
    expect(payload.error.message).toContain(file);
    expect(payload.error.message).toContain('gamma');
    expect(payload.error.message).toContain('0 occurrences');
    expect(payload.error.human_hint).toContain('read_file');
    expect(payload.error.human_hint).toContain('write_file');
    expect(readFileSync(file, 'utf8')).toBe('alpha\nbeta\n');
  });

  it('多处匹配：edit-multiple-matches + 明确「不猜」；文件保持原样', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'dup.txt');
    putFile(file, 'x\ny\nx\n');
    const r = await runTool(ws, 'edit_file', { path: file, search: 'x', replace: 'X' });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('edit-multiple-matches');
    expect(payloadOf(r).error.message).toContain('2 occurrences');
    expect(payloadOf(r).error.message).toContain('refusing to guess');
    expect(readFileSync(file, 'utf8')).toBe('x\ny\nx\n');
  });

  it('空 SEARCH：edit-empty-search 拒绝，文件原样', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'noop.txt');
    putFile(file, 'line\n');
    const r = await runTool(ws, 'edit_file', { path: file, search: '', replace: 'X' });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('edit-empty-search');
    expect(readFileSync(file, 'utf8')).toBe('line\n');
  });

  it('超过编辑缓冲上限（>64KB）：edit-file-too-large 拒绝 + 整写建议（write_file），文件原样', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'big.txt');
    putFile(file, 'a'.repeat(65_537));
    const r = await runTool(ws, 'edit_file', { path: file, search: 'a', replace: 'b' });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('edit-file-too-large');
    const payload = payloadOf(r);
    expect(payload.error.message).toContain('65537');
    expect(payload.error.message).toContain('65536');
    expect(payload.error.human_hint).toContain('write_file');
    expect(readFileSync(file, 'utf8')).toBe('a'.repeat(65_537));
  });
});
