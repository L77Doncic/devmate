import { describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli/index.js';
import type { CliIo } from '../../src/cli/index.js';

/**
 * S14 入口分发规格：
 * - `--version` → 打版本号，退出 0；
 * - `--help` → 打帮助，退出 0；
 * - 空参数 → 帮助（视为需要帮助），退出 0；
 * - `web` → 委托给 runWeb，返回其退出码；
 * - 其余未知命令 → 帮助文本 + 退出码 1。
 */

function makeIo(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const runWeb = vi.fn(async () => 0);
  const io: CliIo = {
    println: (s: string) => {
      out.push(s);
    },
    printErr: (s: string) => {
      err.push(s);
    },
    runWeb,
    version: '0.1.0',
    ...overrides,
  };
  // 返回运行时实际生效的 runWeb（overrides 可能替换它），供断言。
  return { io, out, err, runWeb: io.runWeb as unknown as ReturnType<typeof vi.fn> };
}

describe('main：命令分发', () => {
  it('--version → 输出版本，退出 0', async () => {
    const { io, out } = makeIo();
    const code = await main(['--version'], io);
    expect(code).toBe(0);
    expect(out.join('')).toContain('0.1.0');
  });

  it('--help → 帮助文本含 web/--port 说明，退出 0', async () => {
    const { io, out } = makeIo();
    const code = await main(['--help'], io);
    expect(code).toBe(0);
    const help = out.join('\n');
    expect(help).toContain('web');
    expect(help).toContain('--port');
  });

  it('空参数 → 帮助，退出 0', async () => {
    const { io, out } = makeIo();
    const code = await main([], io);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('用法');
  });

  it('web → 委托 runWeb，返回其退出码；参数透传', async () => {
    const { io, runWeb } = makeIo({ runWeb: vi.fn(async () => 7) });
    const code = await main(['web', '--port', '8080'], io);
    expect(code).toBe(7);
    expect(runWeb).toHaveBeenCalledTimes(1);
    expect(runWeb).toHaveBeenCalledWith(['--port', '8080'], expect.anything());
  });

  it('未知命令 → printErr + 帮助 + 退出码 1', async () => {
    const { io, out, err } = makeIo();
    const code = await main(['frobnicate'], io);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('frobnicate');
    expect(out.join('\n')).toContain('用法');
  });
});
