/**
 * # 常驻 Shell 行为切片 c/g：超时→杀整棵进程树+回注 partial；256KB 采集上限
 *
 * 真进程可控：sleep/yes 必须在缩短的 timeoutMs 内被整组 SIGKILL；
 * 用「后台进程 pid 存活断言」验证进程树被杀（进程组级，非仅主 shell）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { realpathSync } from 'node:fs';
import type { ShellFixture } from './support.js';
import {
  cleanupShellFixtures,
  makeShellFixture,
  payloadOf,
  pidEventuallyGone,
  run,
} from './support.js';

let fx: ShellFixture;

beforeAll(async () => {
  fx = await makeShellFixture({ timeoutMs: 300 });
});

afterAll(async () => {
  await fx.dispose();
  cleanupShellFixtures();
});

describe('c) 超时：杀进程树 + partial 回注 + 自动恢复', () => {
  it('sleep 5 于 timeout 300ms：结果 ok:false、type=command-timeout、含 partial 标记与已捕获输出', async () => {
    const r = await run(fx, 'sleep 5 & echo "CHILD_PID:$!"; wait');
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('command-timeout');
    const payload = payloadOf(r);
    expect(payload.error.type).toBe('command-timeout');
    expect(payload.error.message).toContain('timed out after');
    expect(payload.error.message).toContain('300');
    expect(JSON.stringify(payload.error)).toContain('partial_output');
    expect(JSON.stringify(payload.error)).toContain('CHILD_PID');
  });

  it('超时后进程树已死：sleep 子进程 pid 消失（进程组级击杀，非仅主 shell）', async () => {
    const r = await run(fx, 'sleep 5 & echo "CHILD_PID:$!"; wait');
    const m = /CHILD_PID:(\d+)/.exec(JSON.stringify(payloadOf(r).error)) ?? null;
    expect(m, 'partial 输出中必须回注子进程 pid').not.toBeNull();
    expect(await pidEventuallyGone(Number(m![1]))).toBe(true);
  });

  it('超时后 shell 会话已死亡：下一条命令自动重启新会话并注明状态丢失、cwd 回 workspaceRoot', async () => {
    const r = await run(fx, 'pwd -P');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('shell restarted');
    expect(r.content).toContain(realpathSync(fx.ws));
  });
});

describe('g) 输出采集 256KB 硬上限', () => {
  it('默认上限常量 = 256KB（含截断与丢弃语义的对外常量）', async () => {
    const { DEFAULT_MAX_OUTPUT_BYTES } = await import('../../src/core/tools/shell.js');
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(256 * 1024);
  });

  it('yes 大量输出：超限截断 + 显式标记 + 丢弃字节数', async () => {
    // spawn 大写出：500KB 无误，300ms 内完成；采集缓冲 64KB 自定上限加速验证
    const small = await makeShellFixture({ maxOutputBytes: 64 * 1024, timeoutMs: 5_000 });
    const r = await run(small, 'yes abcdefghij | head -c 500000');
    const text = r.content;
    expect(text).toContain('output truncated');
    expect(text).toContain('dropped');
    expect(text.length).toBeLessThan(100 * 1024);
    expect(text).toContain('exit code');
    await small.dispose();
  });
});

describe('c2) timeout_ms 模型申请（ADR-0010：默认 120s、硬上限 900s）', () => {
  it('硬上限常量 = 900000ms', async () => {
    const { MAX_SHELL_TIMEOUT_MS } = await import('../../src/core/tools/shell.js');
    expect(MAX_SHELL_TIMEOUT_MS).toBe(900_000);
  });

  it('合法申请生效：fixture 默认 300ms 下 sleep 1 带 timeout_ms 2500 正常完成（不被默认超时误杀）', async () => {
    const r = await run(fx, 'sleep 1', 'timeout-request', 2500);
    expect(r.ok).toBe(true);
    expect(r.error?.type).toBeUndefined();
    expect(r.content).toContain('--- exit code: 0 ---');
  });

  it('超过硬上限 900000ms → invalid-arguments（不进入执行）', async () => {
    const r = await run(fx, 'echo quick', 'bad-request', 900_001);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('invalid-arguments');
    expect(JSON.stringify(r.content)).toContain('900');
  });

  it('非法取值（0 / 小数 / 字符串）→ invalid-arguments', async () => {
    const r0 = await run(fx, 'echo quick', 'bad-0', 0);
    expect(r0.ok).toBe(false);
    expect(r0.error?.type).toBe('invalid-arguments');
    const rFloat = await run(fx, 'echo quick', 'bad-float', 1.5);
    expect(rFloat.ok).toBe(false);
    expect(rFloat.error?.type).toBe('invalid-arguments');
    const rStr = await run(fx, 'echo quick', 'bad-str', Number.NaN);
    expect(rStr.ok).toBe(false);
    expect(rStr.error?.type).toBe('invalid-arguments');
  });

  it('未传 timeout_ms：仍用默认（无参数路径不变）', async () => {
    const r = await run(fx, 'echo default-ok', 'no-param');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('default-ok');
  });
});
