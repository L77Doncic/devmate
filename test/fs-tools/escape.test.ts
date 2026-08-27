import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupWorkspaces,
  FakeJail,
  makeWorkspace,
  payloadOf,
  putFile,
  runTool,
} from './support.js';

afterEach(() => cleanupWorkspaces());

describe('越界矩阵（切片 g：工作区监狱——jail 判定、真判定归 S9）', () => {
  it('read_file：../ 词法越界 + 绝对路径指向外 → path-outside-workspace，内容零泄露', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.outside, 'secret.txt'), 'TOP SECRET');
    const escape = join(ws.root, '..', basename(ws.outside), 'secret.txt');
    const r = await runTool(ws, 'read_file', { path: escape });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('path-outside-workspace');
    expect(payloadOf(r).error.message).toContain(escape);
    expect(r.content).not.toContain('TOP SECRET');
  });

  it('write_file：绝对路径指向外 → path-outside-workspace，且文件未创建', async () => {
    const ws = makeWorkspace();
    const target = join(ws.outside, 'new.txt');
    const r = await runTool(ws, 'write_file', { path: target, content: 'evil' });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('path-outside-workspace');
    expect(existsSync(target)).toBe(false);
  });

  it('符号链接指向外：read/edit/list_dir 均被 jail 双端判定拦截（链接在根内、目标在根外）', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.outside, 'pw.txt'), 'password');
    const link = join(ws.root, 'leak.txt');
    symlinkSync(join(ws.outside, 'pw.txt'), link);
    const read = await runTool(ws, 'read_file', { path: link });
    expect(read.ok).toBe(false);
    expect(read.error?.type).toBe('path-outside-workspace');
    expect(read.content).not.toContain('password');
    const edit = await runTool(ws, 'edit_file', { path: link, search: 'pw', replace: 'xx' });
    expect(edit.ok).toBe(false);
    expect(edit.error?.type).toBe('path-outside-workspace');
    const list = await runTool(ws, 'list_dir', { path: link });
    expect(list.ok).toBe(false);
    expect(list.error?.type).toBe('path-outside-workspace');
    expect(readFileSync(join(ws.outside, 'pw.txt'), 'utf8')).toBe('password');
  });

  it('grep / glob：监狱外的输入路径 → path-outside-workspace（先问 jail、不扫描）', async () => {
    const ws = makeWorkspace();
    const grep = await runTool(ws, 'grep', { pattern: 'x', paths: [join(ws.outside, 'pw.txt')] });
    expect(grep.ok).toBe(false);
    expect(grep.error?.type).toBe('path-outside-workspace');
    const glob = await runTool(ws, 'glob', { pattern: '**/*', path: ws.outside });
    expect(glob.ok).toBe(false);
    expect(glob.error?.type).toBe('path-outside-workspace');
  });

  it('jail 决定一切（接缝探针）：全放行 jail 下工具不自行裁决——越界读成功', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.outside, 'secret.txt'), 'TOP SECRET');
    ws.ctx.jail = FakeJail.allowAll();
    const r = await runTool(ws, 'read_file', { path: join(ws.outside, 'secret.txt') });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('TOP SECRET');
  });

  it('缺失的越界路径优先级：path-outside-workspace 先于 file-not-found（守卫在 stat 之前）', async () => {
    const ws = makeWorkspace();
    const r = await runTool(ws, 'read_file', { path: join(ws.outside, 'does-not-exist.txt') });
    expect(r.ok).toBe(false);
    expect(payloadOf(r).error.type).toBe('path-outside-workspace');
  });
});
