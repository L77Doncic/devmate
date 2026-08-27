import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupWorkspaces, makeWorkspace, payloadOf, putFile, runTool } from './support.js';

afterEach(() => cleanupWorkspaces());

describe('glob（切片 e）', () => {
  it('**/ 模式递归匹配，含根内文件；结果排序', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.root, 'a.ts'), 'x');
    putFile(join(ws.root, 'src', 'b.ts'), 'x');
    putFile(join(ws.root, 'src', 'nested', 'c.ts'), 'x');
    putFile(join(ws.root, 'src', 'd.txt'), 'x');
    const r = await runTool(ws, 'glob', { pattern: '**/*.ts', path: ws.root });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('a.ts\nsrc/b.ts\nsrc/nested/c.ts');
  });

  it('globstar 匹配零层目录：src/**/c.ts 同时命中 src/c.ts 与 src/x/y/c.ts', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.root, 'src', 'c.ts'), 'x');
    putFile(join(ws.root, 'src', 'x', 'y', 'c.ts'), 'x');
    const r = await runTool(ws, 'glob', { pattern: 'src/**/c.ts', path: ws.root });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('src/c.ts\nsrc/x/y/c.ts');
  });

  it('大小写敏感：foo.ts 与 Foo.ts 分属两个模式', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.root, 'foo.ts'), 'x');
    putFile(join(ws.root, 'Foo.ts'), 'x');
    const lower = await runTool(ws, 'glob', { pattern: 'foo.ts', path: ws.root });
    expect(lower.ok).toBe(true);
    expect(lower.content).toBe('foo.ts');
    const upper = await runTool(ws, 'glob', { pattern: 'Foo.ts', path: ws.root });
    expect(upper.content).toBe('Foo.ts');
  });

  it('单段 * 不跨越路径分隔符：*.ts 只命中根内', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.root, 'top.ts'), 'x');
    putFile(join(ws.root, 'src', 'b.ts'), 'x');
    putFile(join(ws.root, 'src', 'sub', 'c.ts'), 'x');
    const rootOnly = await runTool(ws, 'glob', { pattern: '*.ts', path: ws.root });
    expect(rootOnly.content).toBe('top.ts');
    const oneLevel = await runTool(ws, 'glob', { pattern: 'src/*.ts', path: ws.root });
    expect(oneLevel.content).toBe('src/b.ts');
  });

  it('不逃狱：符号链接指向外被剔除 —— glob 结果再经 jail 校验', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.outside, 'secret.ts'), 'x');
    symlinkSync(join(ws.outside, 'secret.ts'), join(ws.root, 'leak.ts'));
    putFile(join(ws.root, 'ok.ts'), 'x');
    const r = await runTool(ws, 'glob', { pattern: '**/*.ts', path: ws.root });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('ok.ts');
  });

  it('列表式阻断：jail 拦截前缀下的匹配被剔除', async () => {
    const ws = makeWorkspace((root) => [join(root, 'secret.txt')]);
    putFile(join(ws.root, 'seen.txt'), 'x');
    putFile(join(ws.root, 'secret.txt'), 'x');
    const r = await runTool(ws, 'glob', { pattern: '**/*.txt', path: ws.root });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('seen.txt');
  });

  it('无匹配：明文 "no matches"（ok:true——零命中是普通结果不是错误）', async () => {
    const ws = makeWorkspace();
    putFile(join(ws.root, 'a.ts'), 'x');
    const r = await runTool(ws, 'glob', { pattern: '*.md', path: ws.root });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('no matches for "*.md" in ' + ws.root);
  });

  it('base 不存在：file-not-found + 路径', async () => {
    const ws = makeWorkspace();
    const missing = join(ws.root, 'nope');
    const r = await runTool(ws, 'glob', { pattern: '*.ts', path: missing });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('file-not-found');
    expect(payloadOf(r).error.message).toContain(missing);
  });

  it('字节上限（64KB）：结果超过采集缓冲后截断并附显式截断标记', async () => {
    const ws = makeWorkspace();
    // 每条 rel ~95 字节；700 条 ≈ 66.5KB > 64KB → 截断标记出现
    for (let i = 0; i < 700; i++) {
      putFile(join(ws.root, `data-${String(i).padStart(4, '0')}-${'z'.repeat(80)}.txt`), 'x');
    }
    const r = await runTool(ws, 'glob', { pattern: '**/*.txt', path: ws.root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('(glob output capped; use a narrower pattern or base)');
    expect(r.content.split('\n').length).toBeLessThan(700);
  });
});
