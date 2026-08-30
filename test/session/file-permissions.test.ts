import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlFileAdapter } from '../../src/core/session/index.js';
import { cleanupTmpDirs, createTmpDir, event, userPayload } from './support.js';

/**
 * VT-3 修复 a：会话存储目录/文件权限（POSIX 语义——Windows chmod 为近似实现，测试按 POSIX 环境）：
 * - 目录 0700（mk 时按位 + 存量 0755 构造时纠正）；
 * - 新建会话文件 0600（open mode 显式——不随 umask 走 0644）；
 * - 存量 0644 文件构造时一次性 chmod 0600（healDirectoryPermissions目录扫描）。
 */
describe('会话文件权限（VT-3 修复 a：0700/0600）', () => {
  let base: string;

  beforeEach(() => {
    base = createTmpDir();
  });

  afterEach(() => {
    cleanupTmpDirs();
  });

  it('新建目录 0700、新建会话文件 0600', async () => {
    const dir = join(base, 'sessions');
    const store = new JsonlFileAdapter({ dir });
    // 目录：mkdir 按位 0700（umask 不影响 group/other 位）
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    await store.create('s1');
    const file = join(dir, 's1.jsonl');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // 追加后权限不变（'a' 打开不改 mode）
    await store.append('s1', event('user', userPayload('x')));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('存量旧文件（0644 / 目录 0755）：构造时一次性纠正为 0600 / 0700', async () => {
    const dir = join(base, 'legacy');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    const file = join(dir, 's1.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({ v: 1, seq: 1, ts: 1, kind: 'user', payload: { content: 'a' } })}\n`,
      {
        mode: 0o644,
      },
    );
    chmodSync(file, 0o644);
    // 非会话文件（临时/其它扩展名）不受纠正影响
    const stray = join(dir, 'notes.txt');
    writeFileSync(stray, 'keep', { mode: 0o644 });
    chmodSync(stray, 0o644);

    new JsonlFileAdapter({ dir }); // 构造即纠正

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(stray).mode & 0o777).toBe(0o644); // 不越权纠正非会话文件
  });
});
