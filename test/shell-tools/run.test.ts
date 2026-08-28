/**
 * # 常驻 Shell 行为切片 a/b/env/f/i：基本执行、cwd/env 保持、哨兵行剥离、
 *   多行/管道/链式命令、[out]/[err] 标签、退出码回传
 *
 * 每条重要行为一个断言（TDD 铁律：真进程测试必须可控——临时目录、短命令）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import type { ShellFixture } from './support.js';
import {
  cleanupShellFixtures,
  makeShellFixture,
  pidEventuallyGone,
  run,
  shellCwdForm,
  shellPath,
} from './support.js';

let fx: ShellFixture;

beforeAll(async () => {
  fx = await makeShellFixture();
});

afterAll(async () => {
  await fx.dispose();
  cleanupShellFixtures();
});

describe('a) 基本执行与哨兵行剥离', () => {
  it('echo 命令：输出经 [out] 标签回传', async () => {
    const r = await run(fx, 'echo hello');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('[out] hello');
  });

  it('哨兵行不泄漏：用户可见输出不含 __DEV_DONE_ 与内部协议行', async () => {
    const r = await run(fx, 'printf "x\\ny\\n"');
    expect(r.content).not.toContain('__DEV_DONE_');
    expect(r.content).not.toContain(':rc:');
    expect(r.content).not.toContain(':cwd:');
    expect(r.content).toContain('[out] x');
    expect(r.content).toContain('[out] y');
  });

  it('输出结束即命令结束：无 EOF 依赖（活进程管道上哨兵判界）——命令退出后仍能继续下一命令', async () => {
    const a = await run(fx, 'echo first');
    const b = await run(fx, 'echo second');
    expect(a.content).toContain('[out] first');
    expect(b.content).toContain('[out] second');
  });

  it('每条命令的哨兵是全新随机值：两条命令内容均无哨兵泄漏', async () => {
    const a = await run(fx, 'echo alpha');
    const b = await run(fx, 'echo beta');
    expect(a.content).not.toContain('__DEV_DONE_');
    expect(b.content).not.toContain('__DEV_DONE_');
  });

  it('退出码随结果回传（exit 0）', async () => {
    const r = await run(fx, 'echo code');
    expect(r.content).toContain('--- exit code: 0 ---');
  });
});

describe('b) cwd 与 env 常驻保持', () => {
  it('cwd 保持：cd 到子目录后，下一条命令 pwd 不变', async () => {
    const sub = join(fx.ws, 'sub-keep');
    mkdirSync(sub, { recursive: true });
    // shellPath：win32（git-bash）下反斜杠路径会被 bash 词法吃残 → 用正斜杠形态
    await run(fx, `cd "${shellPath(sub)}"`);
    const r = await run(fx, 'pwd -P');
    // git-bash 的 pwd -P 输出 MSYS 形态（/c/...）——shellCwdForm 化同一形态再比
    expect(r.content).toContain(shellCwdForm(realpathSync(sub)));
  });

  it('env 保持：export 变量在命令间保持', async () => {
    await run(fx, 'export DEV_KEEP=yes123');
    const r = await run(fx, 'echo $DEV_KEEP');
    expect(r.content).toContain('[out] yes123');
  });

  it('初值 cwd = workspaceRoot', async () => {
    const fx2 = await makeShellFixture({ sessionId: 'cwd-init' });
    const r = await run(fx2, 'pwd -P', fx2.sessionId);
    expect(r.content).toContain(shellCwdForm(realpathSync(fx2.ws)));
    await fx2.dispose();
  });

  it('env 兜底默认注入：PAGER/MANPAGER=cat、LESS=-R、TERM=dumb、TQDM_DISABLE=1', async () => {
    const r = await run(fx, 'echo "$PAGER|$MANPAGER|$LESS|$TERM|$TQDM_DISABLE|$GIT_PAGER"');
    expect(r.content).toContain('[out] cat|cat|-R|dumb|1|cat');
  });

  it('交互变量被清：EDITOR/VISUAL 不继承（进程原样会话）', async () => {
    const r = await run(fx, '[ -z "$EDITOR" ] && [ -z "$VISUAL" ] && echo CLEAN || echo DIRTY');
    expect(r.content).toContain('[out] CLEAN');
  });
});

describe('f) 多行/复杂命令在真 shell 中可跑', () => {
  it('heredoc：cat <<EOF 内容可回传', async () => {
    const r = await run(fx, `cat <<'EOF'\nhello world\nEOF`);
    expect(r.content).toContain('[out] hello world');
  });

  it('&& 链式命令 + 重定向到界内文件', async () => {
    const r = await run(fx, 'mkdir -p chain && cd chain && echo ok > f.txt && cat f.txt');
    expect(r.content).toContain('[out] ok');
  });

  it('管道命令：printf | tr', async () => {
    const r = await run(fx, "printf 'abc' | tr a-z A-Z");
    expect(r.content).toContain('[out] ABC');
  });

  it('组合链与多行脚本（&&/|/heredoc 并存）', async () => {
    const r = await run(
      fx,
      `cd /tmp && N=2 && printf 'n=%s\\n' "$N" && cat <<'EOT' | tr a-z A-Z\nsecond\nEOT`,
    );
    expect(r.content).toContain('[out] n=2');
    expect(r.content).toContain('[out] SECOND');
  });
});

describe('i) 输出标签 [out]/[err] 与退出码', () => {
  it('stderr 走 [err] 标签：echo boom 1>&2（stdout 无此内容）', async () => {
    const r = await run(fx, 'echo boom 1>&2');
    expect(r.content).toContain('[err] boom');
    expect(r.content).not.toContain('[out] boom');
  });

  it('stderr 与 stdout 分离保留交错：三行输出各带标签', async () => {
    const r = await run(fx, '(echo one; echo two 1>&2; echo three)');
    expect(r.content).toContain('[out] one');
    expect(r.content).toContain('[err] two');
    expect(r.content).toContain('[out] three');
  });

  it('报错命令：ls /nonexistent → [err] 且退出码（非零）回传', async () => {
    const r = await run(fx, 'ls /definitely-nonexistent-xyz');
    expect(r.ok).toBe(true); // 命令执行本身成功（失败是普通消息，非工具失败）
    expect(r.content).toContain('[err]');
    expect(r.content).toMatch(/--- exit code: [1-9]\d* ---/);
  });

  it('非零退出码不使工具失败（失败是普通消息：命令执行本身成功）', async () => {
    const r = await run(fx, 'exit 3');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('--- exit code: 3 ---');
  });
});

describe('会话隔离（ctx.sessionId → 每会话一个 shell）', () => {
  it('两个 session 的 shell 实例互不影响：A cd 后，B 仍在 workspaceRoot', async () => {
    const sub = join(fx.ws, 'sub-isolated');
    mkdirSync(sub, { recursive: true });
    await run(fx, `cd "${shellPath(sub)}"`, 'session-a');
    const rb = await run(fx, 'pwd -P', 'session-b');
    expect(rb.content).toContain(shellCwdForm(realpathSync(fx.ws)));
  });
});

describe('j) 完成标记诚实性（cat 经 stdin 无法伪造/偷走，无哨兵泄漏）', () => {
  let fxCat: ShellFixture;

  beforeAll(async () => {
    // 短 fixture：cat 挂住由 timeout 收场（非交互会话：stdin 永不关闭）
    fxCat = await makeShellFixture({ sessionId: 'cat-honesty', timeoutMs: 1_500 });
  });

  afterAll(async () => {
    await fxCat.dispose();
  });

  it('裸 cat（无参）：不产生虚假提前完成（完成判定只在标记文件）→ 报 command-timeout，:rc: 无泄漏', async () => {
    const r = await run(fxCat, 'cat', fxCat.sessionId);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('command-timeout');
    expect(JSON.stringify(r)).not.toContain('__DEV_DONE_');
    expect(JSON.stringify(r)).not.toContain(':rc:');
    expect(r.content).not.toContain('--- exit code: 0 ---');
  });

  it('cat 之后会话仍可用：虚假提前完成会污染下一条命令（被活着的 cat 吞掉）——重启后正常', async () => {
    await run(fxCat, 'cat', fxCat.sessionId);
    const r2 = await run(fxCat, 'echo after-cat', fxCat.sessionId);
    expect(r2.ok).toBe(true);
    expect(r2.content).toContain('[out] after-cat');
  });

  it('cat && echo late：cat 先挂住（stdin 永不关闭）——超时收场，输出无命令文本泄漏', async () => {
    const r = await run(fxCat, 'cat && echo late', fxCat.sessionId);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('command-timeout');
    expect(r.content).not.toContain('rc=$?');
    expect(r.content).not.toContain('__DEV_DONE_');
    expect(r.content).not.toContain('[out] late');
  });
});

describe('dispose：整树击杀与幂等', () => {
  it('dispose 后常驻 shell 进程消失（进程级断言）；再次 dispose 不报错', async () => {
    const fx2 = await makeShellFixture({ sessionId: 'dispose-test' });
    const r = await run(fx2, 'echo "SHELL_PID:$$"', 'dispose-test');
    const m = /SHELL_PID:(\d+)/.exec(r.content);
    expect(m, '应输出 shell pid').not.toBeNull();
    const pid = Number(m![1]);
    await fx2.dispose();
    await expect(fx2.dispose()).resolves.toBeUndefined(); // 幂等
    expect(await pidEventuallyGone(pid)).toBe(true);
  });
});
