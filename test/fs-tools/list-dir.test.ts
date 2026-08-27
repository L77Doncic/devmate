import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupWorkspaces,
  makeWorkspace,
  payloadOf,
  putFile,
  putDir,
  runTool,
} from './support.js';

afterEach(() => cleanupWorkspaces());

describe('list_dir（切片 d）', () => {
  it('目录与文件分列：各自归位、目录带斜杠后缀、条目排序', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.root, 'models', 'a.txt'), 'x');
    putFile(join(ws.root, 'docs', 'b.md'), 'x');
    putFile(join(ws.root, 'x.json'), 'x');
    const r = await runTool(ws, 'list_dir', { path: ws.root });
    expect(r.ok).toBe(true);
    expect(r.content).toBe(`${ws.root}:\ndirs:\n  docs/\n  models/\nfiles:\n  x.json`);
  });

  it('递归：相对路径列出所有后代（目录 + 文件分列）', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.root, 'a.ts'), 'x');
    putFile(join(ws.root, 'src', 'b.ts'), 'x');
    putFile(join(ws.root, 'src', 'sub', 'c.ts'), 'x');
    const r = await runTool(ws, 'list_dir', { path: ws.root, recursive: true });
    expect(r.ok).toBe(true);
    expect(r.content).toBe(
      `${ws.root}:\ndirs:\n  src/\n  src/sub/\nfiles:\n  a.ts\n  src/b.ts\n  src/sub/c.ts`,
    );
  });

  it('空目录：显式标注 (empty)', async () => {
    const ws = makeWorkspace();
    putDir(join(ws.root, 'empty'));
    const r = await runTool(ws, 'list_dir', { path: join(ws.root, 'empty') });
    expect(r.ok).toBe(true);
    expect(r.content).toBe(`${join(ws.root, 'empty')} (empty)`);
  });

  it('不存在：file-not-found + 路径 + 线索', async () => {
    const ws = makeWorkspace();
    const missing = join(ws.root, 'ghost');
    const r = await runTool(ws, 'list_dir', { path: missing });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('file-not-found');
    const payload = payloadOf(r);
    expect(payload.error.message).toContain(missing);
    expect(payload.error.human_hint).toContain('list_dir');
  });

  it('路径是文件：not-a-directory + 提示 read_file', async () => {
    const ws = makeWorkspace();
    const file = join(ws.root, 'single.ts');
    putFile(file, 'x');
    const r = await runTool(ws, 'list_dir', { path: file });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('not-a-directory');
    expect(payloadOf(r).error.human_hint).toContain('read_file');
  });

  it('条目上限（20000）截断：输出带显式截断标记（不静默）', async () => {
    const ws = makeWorkspace();
    for (let i = 0; i < 20_001; i++) {
      writeFileSync(join(ws.root, `entry-${String(i).padStart(5, '0')}.txt`), 'x');
    }
    const r = await runTool(ws, 'list_dir', { path: ws.root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('(output truncated at 20000 entries');
    // 头 + files: + 恰好 20000 条 + 截断标记（第 20001 条不出现）
    expect(r.content.split('\n')).toHaveLength(1 + 1 + 20_000 + 1);
    expect(r.content).not.toContain('entry-20000.txt');
  }, 300_000);
});
