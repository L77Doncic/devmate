import { describe, expect, it, vi } from 'vitest';
import { installGracefulSignals, main } from '../../src/cli/index.js';
import type { CliIo, SignalIo } from '../../src/cli/index.js';

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
    version: '0.1.1',
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
    expect(out.join('')).toContain('0.1.1');
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

describe('installGracefulSignals（VT-2 修复 a：SIGTERM 优雅关闭）', () => {
  /** 假 SignalIo：捕获注册处理器；exit 记录码并正常返回（不会引入 unhandled rejection）。 */
  function fakeIo(): {
    io: SignalIo;
    registered: Array<[string, () => void]>;
    exitCodes: number[];
  } {
    const registered: Array<[string, () => void]> = [];
    const exitCodes: number[] = [];
    return {
      registered,
      exitCodes,
      io: {
        once: (signal, handler) => {
          registered.push([signal, handler]);
        },
        exit: ((code: number) => {
          exitCodes.push(code);
        }) as unknown as (code: number) => never,
      },
    };
  }

  it('SIGINT 与 SIGTERM 都注册；SIGTERM 触发 → 同一完整关闭回调 → 退出 0', async () => {
    const { io, registered, exitCodes } = fakeIo();
    const shutdown = vi.fn(async () => undefined);
    installGracefulSignals(['SIGINT', 'SIGTERM'], io, shutdown);
    expect(registered.map(([s]) => s)).toEqual(['SIGINT', 'SIGTERM']);

    // SIGTERM（kill / 端口终止 / systemd stop 等典型运维信号）走与 Ctrl-C 相同的收尾
    const term = registered.find(([s]) => s === 'SIGTERM')![1]!;
    term();
    await new Promise((resolve) => setTimeout(resolve, 0)); // Promise 链落定
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([0]);
  });

  it('关闭回调抛错也退出 0（清理只可能错过、不虚报失败；SIGINT 同一语义）', async () => {
    const { io, registered, exitCodes } = fakeIo();
    const shutdown = vi.fn(async () => {
      throw new Error('close failed');
    });
    installGracefulSignals(['SIGINT', 'SIGTERM'], io, shutdown);
    const ctrl = registered.find(([s]) => s === 'SIGINT')![1]!;
    ctrl();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([0]);
  });

  it('一次信号只收尾一次（shutdown 幂等且 callback 只触发一次）', async () => {
    const { io, registered, exitCodes } = fakeIo();
    const shutdown = vi.fn(async () => undefined);
    installGracefulSignals(['SIGTERM'], io, shutdown);
    registered[0]![1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([0]);
  });
});
