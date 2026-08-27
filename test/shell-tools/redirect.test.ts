/**
 * # 常驻 Shell 行为切片 e：重定向目标 → jail.checkRedirect(src, dst) 边界检查
 *
 * 安全测试行为级验证（真实 jail + 真实文件系统）：
 * 界外目标 deny 时整命令不执行、文件不产生；界内 allow 时命令真的写入。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ShellFixture } from './support.js';
import { cleanupShellFixtures, makeShellFixture, payloadOf, run } from './support.js';
import { parseRedirectTargets } from '../../src/core/tools/shell.js';

let fx: ShellFixture;

beforeAll(async () => {
  fx = await makeShellFixture();
});

afterAll(async () => {
  await fx.dispose();
  cleanupShellFixtures();
});

describe('e) 重定向越界拒绝（> / >> / 2> / &>）', () => {
  it('> 到界外绝对路径：deny（type=path-outside-workspace），且文件未被创建', async () => {
    const outsideFile = join(fx.outside, 'out.txt');
    const r = await run(fx, `echo hi > ${outsideFile}`);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('path-outside-workspace');
    expect(payloadOf(r).error.type).toBe('path-outside-workspace');
    expect(existsSync(outsideFile)).toBe(false);
  });

  it('>> 到界外：deny', async () => {
    const outsideFile = join(fx.outside, 'append.txt');
    const r = await run(fx, `echo hi >> ${outsideFile}`);
    expect(r.error?.type).toBe('path-outside-workspace');
    expect(existsSync(outsideFile)).toBe(false);
  });

  it('2> 到界外：deny（stderr 重定向目标同样按写入检）', async () => {
    const outsideFile = join(fx.outside, 'err.txt');
    const r = await run(fx, `ls /nowhere 2> ${outsideFile}`);
    expect(r.error?.type).toBe('path-outside-workspace');
  });

  it('&> 到界外：deny', async () => {
    const outsideFile = join(fx.outside, 'both.txt');
    const r = await run(fx, `echo hi &> ${outsideFile}`);
    expect(r.error?.type).toBe('path-outside-workspace');
  });

  it('../ 抬升到界外（相对串夹 ..）：deny', async () => {
    const r = await run(fx, 'mkdir -p sub3 && cd sub3 && echo hi > ../outside-escaped.txt');
    expect(r.error?.type).toBe('path-outside-workspace');
  });

  it('heredoc 重定向到界外：deny 且命令不执行', async () => {
    const outsideFile = join(fx.outside, 'heredoc.txt');
    const r = await run(fx, `cat <<'EOF' > ${outsideFile}\ncontent\nEOF`);
    expect(r.error?.type).toBe('path-outside-workspace');
    expect(existsSync(outsideFile)).toBe(false);
    expect(r.content).not.toContain('[out] content');
  });

  it('该次命令的其它输出不产生（整命令在写入前被拒）：界内 echo 但界外写 → 无输出', async () => {
    const r = await run(fx, `echo visible-but-denied > ${join(fx.outside, 'x.txt')}`);
    expect(r.error?.type).toBe('path-outside-workspace');
    expect(JSON.stringify(r)).not.toContain('visible-but-denied');
  });
});

describe('e2) /dev/null 丢弃 sink：执行层直接放行（与 classify 口径一致）', () => {
  it('echo hi > /dev/null：执行（不询问 jail），无不可放行的误拦', async () => {
    const r = await run(fx, 'echo hi > /dev/null');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('--- exit code: 0 ---');
  });

  it('cat < /dev/null：输入侧丢弃 sink 放行', async () => {
    const r = await run(fx, 'cat < /dev/null');
    expect(r.ok).toBe(true);
  });

  it('报错命令 + 2>/dev/null：stderr 丢弃后正常回传退出码', async () => {
    const r = await run(fx, 'ls /definitely-nonexistent-xyz 2>/dev/null');
    expect(r.ok).toBe(true);
    expect(r.content).not.toContain('[err]');
    expect(r.content).toMatch(/--- exit code: [1-9]\d* ---/);
  });

  it('2>&1 / 2>&-：fd 复制/关闭不触发 jail', async () => {
    const a = await run(fx, 'echo dup 2>&1');
    expect(a.ok).toBe(true);
    const b = await run(fx, 'echo closed 2>&-');
    expect(b.ok).toBe(true);
  });
});

describe('e) 重定向界内放行', () => {
  it('> ./out.txt（工作区内，cwd=workspaceRoot）：allow 且文件写入成功', async () => {
    const r = await run(fx, 'echo hi > ./out.txt');
    expect(r.ok).toBe(true); // 重定向输出进了文件，所以工具可见输出无 [out] hi
    expect(r.content).not.toContain('[out] hi');
    const written = join(fx.ws, 'out.txt');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toBe('hi\n');
  });

  it('> 到含空格的引号目标（界内）：allow', async () => {
    mkdirSync(join(fx.ws, 'sub-space'), { recursive: true });
    const r = await run(fx, 'echo spaced > "sub-space/my out.txt"');
    expect(r.ok).toBe(true);
    expect(existsSync(join(fx.ws, 'sub-space', 'my out.txt'))).toBe(true);
  });

  it('src(读)+dst(写) 双端都在界内：cat in.txt > out.txt allow', async () => {
    const r = await run(fx, 'echo data > in.txt && cat in.txt > copy.txt');
    expect(r.ok).toBe(true);
    expect(existsSync(join(fx.ws, 'copy.txt'))).toBe(true);
  });

  it('前条命令 cd 之后的 cwd 内重定向：按 shell 跟踪 cwd 判定（cd sub 后 > rel.txt 界内）', async () => {
    mkdirSync(join(fx.ws, 'sub-cwd'), { recursive: true });
    await run(fx, 'cd sub-cwd');
    const r = await run(fx, 'echo hi > rel.txt');
    expect(r.ok).toBe(true);
    expect(existsSync(join(fx.ws, 'sub-cwd', 'rel.txt'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// f) 词法 fail-closed 与操作符识别（<<< / <> / >| / 解析异常 → 整命令拒绝）
// ---------------------------------------------------------------------------

describe('f) 重定向词法：操作符识别 + 解析异常 fail-closed', () => {
  it('<<<（herestring）不是 heredoc：词是内容不是路径，词后同行的重定向仍被检查', () => {
    const r = parseRedirectTargets('echo hi <<< hello > out.txt');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targets).toEqual([{ src: null, dst: 'out.txt' }]);
    }
  });

  it('<>（读写打开）是带目标操作符：目标按写入检', () => {
    const r = parseRedirectTargets('echo x <> rw.txt');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targets).toEqual([{ src: null, dst: 'rw.txt' }]);
    }
  });

  it('>|（clobber）识别为带目标重定向：>| out.txt / 2>| out.txt 均提目标', () => {
    const a = parseRedirectTargets('echo x >| clobber.txt');
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.targets.map((t) => t.dst)).toEqual(['clobber.txt']);
    const b = parseRedirectTargets('echo x 2>| clobber2.txt');
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.targets.map((t) => t.dst)).toEqual(['clobber2.txt']);
  });

  it('单纯 < file：输入侧目标', () => {
    const r = parseRedirectTargets('cat < input.txt > out.txt');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targets).toEqual([
        { src: 'input.txt', dst: null },
        { src: null, dst: 'out.txt' },
      ]);
    }
  });

  it('fd 复制/关闭（2>&1 / >&-）与 /dev/null 丢弃 sink：无文件目标', () => {
    const a = parseRedirectTargets('ls 2>&1 >/dev/null 2>&-');
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.targets).toEqual([]);
    const b = parseRedirectTargets('cat < /dev/null');
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.targets).toEqual([]);
  });

  it('heredoc 正文行整体跳过：正文里的 > 不是重定向', () => {
    const r = parseRedirectTargets("cat <<'EOF' > out.txt\nline > not-a-redirect\nEOF");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targets.map((t) => t.dst)).toEqual(['out.txt']);
  });

  it('进程替换 <(...) / >(...) 不是文件重定向：不分出伪目标', () => {
    const r = parseRedirectTargets('cat <(echo hi) > out.txt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targets.map((t) => t.dst)).toEqual(['out.txt']);
  });

  it('解析异常 → 整命令 fail-closed（不静默跳行尾）：> 后无目标', () => {
    const r = parseRedirectTargets('echo hi >');
    expect(r.ok).toBe(false);
  });

  it('解析异常：> 后引号未闭合', () => {
    expect(parseRedirectTargets('echo hi > "unclosed').ok).toBe(false);
  });

  it('解析异常：<<< 无 here-string 词 / << 无 delimiter 词 / < 无目标', () => {
    expect(parseRedirectTargets('echo x <<<').ok).toBe(false);
    expect(parseRedirectTargets('cat <<').ok).toBe(false);
    expect(parseRedirectTargets('cat <').ok).toBe(false);
  });

  it('解析异常：>| 后无目标', () => {
    expect(parseRedirectTargets('echo x >|').ok).toBe(false);
  });
});

describe('f) E2E：<<< / >| 越界写入必须被拦且不产生文件', () => {
  it('echo hi <<< hello > 界外：deny（type=path-outside-workspace）且文件未被创建', async () => {
    const outsideFile = join(fx.outside, 'herestring-escape.txt');
    const r = await run(fx, `echo hi <<< hello > ${outsideFile}`);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('path-outside-workspace');
    expect(existsSync(outsideFile)).toBe(false);
  });

  it('echo hi >| 界外（clobber）：deny 且文件未被创建', async () => {
    const outsideFile = join(fx.outside, 'clobber-escape.txt');
    const r = await run(fx, `echo hi >| ${outsideFile}`);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('path-outside-workspace');
    expect(existsSync(outsideFile)).toBe(false);
  });

  it('echo hi >| 界内：allow 且文件写入成功', async () => {
    // 共享 fixture 的 cwd 受前序测试影响：用绝对界内路径钉住
    const inFile = join(fx.ws, 'in-clobber.txt');
    const r = await run(fx, `echo hi >| ${inFile}`);
    expect(r.ok).toBe(true);
    expect(existsSync(inFile)).toBe(true);
    expect(readFileSync(inFile, 'utf8')).toBe('hi\n');
  });

  it('echo hi > "unclosed（重定向词解析异常）→ redirect-parse-failed，命令不执行', async () => {
    const before = existsSync(join(fx.ws, 'unclosed.txt'));
    const r = await run(fx, 'echo hi > "unclosed.txt');
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('redirect-parse-failed');
    expect(JSON.stringify(r)).not.toContain('[out] hi');
    expect(existsSync(join(fx.ws, 'unclosed.txt'))).toBe(before);
  });

  it('echo hi <<<（herestring 缺词）→ redirect-parse-failed', async () => {
    const r = await run(fx, 'echo hi <<<');
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('redirect-parse-failed');
  });
});
