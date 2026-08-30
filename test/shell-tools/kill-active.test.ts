/**
 * # test/shell-tools/kill-active：killActiveCommand（P2-3 停止杀命令树）
 *
 * 契约（shell.ts）：
 * - killActiveCommand(sessionId)：终止该会话**活动命令**——(1) 记 killed 标志与
 *   activePid（临时记录）；(2) abort 命令级终止控制器 → waitForCompletion 以
 *   'interrupted' 收尾（已捕获输出回注 partial_output——「回注部分输出+interrupted
 *   语义」）；(3) killTree 杀整棵进程组（活动命令树 + 常驻 bash）。
 * - 无活动命令（空闲/已收尾）→ false：不误杀（幂等）。
 * - 本轮（2026-08-31 实测修复）：sleep-30 停止后进程组零残留——killActiveCommand
 *   即杀即回注（不等到命令自然结束）。短超时 fixture（50ms）作测试兜底：
 *   若 killActiveCommand 无效应，命令 50ms 后超时自己死——测试立即红（行为契约钉点）。
 * win32（powershell/cmd 无进程组杀树语义，posix 契约不同）：跳过——posix 专用。
 */
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupShellFixtures, makeShellFixture, run } from './support.js';

const skipWin = process.platform === 'win32';

/** 残留取证模式（锚定全 cmdline——pgrep 子串会让「含该文本的编辑/打包命令」误命）。 */
function matchesRun(pattern = '^sleep 30$'): string[] {
  try {
    const out = execFileSync('pgrep', ['-af', pattern], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    return []; // 无匹配（pgrep 非零退出）
  }
}

/** 进程组零残留取证（轮询 ≤1.5s：SIGKILL 送达后进程组消失有毫秒级松弛，防 pgrep 竞态）。 */
async function expectNoSleepResidue(pattern = '^sleep 30$'): Promise<void> {
  const deadline = Date.now() + 1500;
  for (;;) {
    if (matchesRun(pattern).length === 0) return;
    if (Date.now() > deadline) {
      expect(matchesRun(pattern)).toEqual([]);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('shell：killActiveCommand（P2-3 停止杀命令树）', () => {
  const created: Array<{ dispose: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const fx of created.splice(0)) await fx.dispose();
    cleanupShellFixtures();
  });

  it.skipIf(skipWin)(
    'k1) 活动命令击杀：sleep-30 经 killActiveCommand 立即 interrupted 收尾（非自然 30s/超时结束），partial 输出回注',
    async () => {
      const fx = await makeShellFixture({ timeoutMs: 1_500 }); // 短超时兜底：若无效应 → 1.5s 超时红（不等 sleep-30）
      created.push(fx);
      const started = Date.now();
      // 前置两段 echo（0.4s 后已入采集器）——验证「已捕获输出部分回注」；
      // 击杀点在 sleep 30 段——若失效则跑满 30s（fixture 短超时其后立即红）
      const executing = run(fx, 'echo before-kill && sleep 0.4 && echo after-kill && sleep 30');
      await new Promise((resolve) => setTimeout(resolve, 800)); // 两段 echo 已产出
      // 轮询击杀：命令进入活动状态（currentKill 挂上）即杀——无「kill 早于活动」竞态
      let killed = false;
      for (let i = 0; i < 200; i += 1) {
        if (fx.shell.killActiveCommand(fx.sessionId)) {
          killed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(killed).toBe(true);

      const result = await executing;
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      expect(result.error?.type).toBe('interrupted'); // interrupted 语义
      const payload = JSON.parse(result.content) as {
        ok: boolean;
        error: Record<string, unknown>;
      };
      expect(payload.error.partial_output).toContain('before-kill'); // 已捕获输出部分回注
      expect(payload.error.partial_output).toContain('after-kill');
      expect(payload.error.partial_output).toContain('[partial output up to interrupt]');
      expect(elapsed).toBeLessThan(2000); // 即杀即回注——绝不等到 sleep 30 自然结束

      await expectNoSleepResidue(); // 进程组零残留：sleep 30 全部消失
    },
    10_000,
  );

  it.skipIf(skipWin)('k2) 无活动命令 → false（空闲会话不误杀；幂等）', async () => {
    const fx = await makeShellFixture({ timeoutMs: 200 });
    created.push(fx);
    expect(fx.shell.killActiveCommand(fx.sessionId)).toBe(false); // 从未执行：无活动命令
    // 执行一条快命令收尾后再杀：队列空闲 → 仍 false
    const done = await run(fx, 'echo hi');
    expect(done.ok).toBe(true);
    expect(fx.shell.killActiveCommand(fx.sessionId)).toBe(false);
    expect(fx.shell.killActiveCommand(fx.sessionId)).toBe(false); // 幂等
  });

  it.skipIf(skipWin)(
    'k3) 击杀后会话复活：下一次命令从全新 shell 开始（老进程组无残留——pgrep 直接取证）',
    async () => {
      const fx = await makeShellFixture({ timeoutMs: 50_000 });
      created.push(fx);
      const executing = run(fx, 'sleep 31.5'); // 独享时长标记（并行 worker 不串扰 pgrep）
      // 轮询击杀（命令进入活动状态即杀——无竞态）
      let killed = false;
      for (let i = 0; i < 200; i += 1) {
        if (fx.shell.killActiveCommand(fx.sessionId)) {
          killed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(killed).toBe(true);
      const killedResult = await executing;
      expect(killedResult.error?.type).toBe('interrupted');
      // 老进程组被 SIGKILL：进程组与 bash 都消失（即时取证——不等自然结束）
      await expectNoSleepResidue('^sleep 31.5$');
      // 下一条命令自动重启（shell restarted 注记）——新会话可用
      const next = await run(fx, 'echo alive');
      expect(next.ok).toBe(true);
      expect(String(next.content)).toContain('alive');
      expect(String(next.content)).toContain('shell restarted');
      await expectNoSleepResidue();
    },
    10_000,
  );
});
