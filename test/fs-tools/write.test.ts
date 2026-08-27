import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupWorkspaces, makeWorkspace, payloadOf, putFile, runTool } from './support.js';

afterEach(() => cleanupWorkspaces());

describe('write_file（切片 b）', () => {
  it('新建：写入内容逐字精确（中文/空行/换行保真），结果消息含路径与字节数', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'new.ts');
    const content = 'export const msg = "你好，DevMate";\n\n\nconst tail = 12;\n';
    const r = await runTool(ws, 'write_file', { path: file, content });
    expect(r.ok).toBe(true);
    expect(r.content).toBe(`wrote ${file} (${Buffer.byteLength(content, 'utf8')} bytes)`);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it('覆盖：以完整新内容整体替换旧内容', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'old.txt');
    putFile(file, 'old content with trailing\n');
    const r = await runTool(ws, 'write_file', { path: file, content: 'brand new\ncontent' });
    expect(r.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('brand new\ncontent');
  });

  it('父目录不存在：可执行错误（path + 缺失父目录 + mkdir 建议），不落任何文件', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'no-dir', 'deep.txt');
    const r = await runTool(ws, 'write_file', { path: file, content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('parent-directory-not-found');
    const payload = payloadOf(r);
    expect(payload.error.message).toContain(file);
    expect(payload.error.message).toContain('no-dir');
    expect(payload.error.human_hint).toContain('mkdir -p');
    expect(existsSync(file)).toBe(false);
  });

  it('目标已存在且是目录：is-a-directory', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.root, 'sub', 'a.txt'), 'x');
    const r = await runTool(ws, 'write_file', { path: join(ws.root, 'sub'), content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('is-a-directory');
  });

  it('空内容允许：创建 0 字节文件', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'empty.txt');
    const r = await runTool(ws, 'write_file', { path: file, content: '' });
    expect(r.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('');
  });
});
