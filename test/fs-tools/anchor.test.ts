import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupWorkspaces,
  makeWorkspace,
  putDir,
  putFile,
  runTool,
} from './support.js';

afterEach(() => cleanupWorkspaces());

/**
 * P1-1 工具锚点统一（回归）：fs 工具相对路径参数一律按「会话工作区根」（jail根）
 * 解析——绝不锚进程 cwd。进程 cwd ≠ 工作区时，旧实现 jail 按工作区根判定放行、
 * 但实际 I/O 在进程 cwd 执行（「写入成功却找不到 / 写到别处」）；修复后 jail 判定
 * 与实际 I/O 同路径（会话根），read 同路径可读回。
 */
describe('文件工具：锚点统一（P1-1 回归——cwd ≠ 工作区）', () => {
  it('write_file 相对路径落会话根（结果消息含锚定后的绝对路径）；read 同路径可读', async () => {
    const ws = makeWorkspace();
    // 回归前提：进程 cwd 明确不在工作区（fake jail 按 cwd 解析相对路径的旧病态在
    // 此前提上下才暴露——修复后工具层先 resolve 到会话根，不再经过该分裂）。
    expect(process.cwd()).not.toBe(ws.root);
    putDir(join(ws.root, 'anchor'));

    const w = await runTool(ws, 'write_file', {
      path: 'anchor/rel.txt',
      content: 'anchored',
    });
    expect(ws.root).toBeTruthy();
    expect(w.ok).toBe(true);
    expect(w.content).toBe(`wrote ${join(ws.root, 'anchor', 'rel.txt')} (8 bytes)`);
    expect(existsSync(join(ws.root, 'anchor', 'rel.txt'))).toBe(true);
    expect(readFileSync(join(ws.root, 'anchor', 'rel.txt'), 'utf8')).toBe('anchored');

    const r = await runTool(ws, 'read_file', { path: 'anchor/rel.txt' });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('anchored');
  });

  it('六个工具相对路径同锚：edit/list/glob/grep 走同一会话根解析', async () => {
    const ws = makeWorkspace();
    expect(process.cwd()).not.toBe(ws.root);
    putFile(join(ws.root, 'anchor', 'a.txt'), 'hello world');

    // edit_file 相对路径
    const e = await runTool(ws, 'edit_file', {
      path: 'anchor/a.txt',
      search: 'world',
      replace: 'devmate',
    });
    expect(e.ok).toBe(true);
    expect(readFileSync(join(ws.root, 'anchor', 'a.txt'), 'utf8')).toBe('hello devmate');

    // list_dir 相对路径（输出头 = 锚定绝对路径）
    const l = await runTool(ws, 'list_dir', { path: 'anchor' });
    expect(l.ok).toBe(true);
    expect(l.content).toBe(`${join(ws.root, 'anchor')}:\nfiles:\n  a.txt`);

    // glob 相对 base（pattern 相对 base 不变——锚点在 path/base 参数）
    const g = await runTool(ws, 'glob', { pattern: '*.txt', path: 'anchor' });
    expect(g.ok).toBe(true);
    expect(g.content).toBe('a.txt');

    // grep 相对 paths（文件命中行 = 锚定绝对路径前缀）
    const gr = await runTool(ws, 'grep', { pattern: 'devmate', paths: ['anchor'] });
    expect(gr.ok).toBe(true);
    expect(gr.content).toContain(`${join(ws.root, 'anchor', 'a.txt')}:1:hello devmate`);
  });
});
