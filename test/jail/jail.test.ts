/**
 * # jail 攻击矩阵（接缝 S9）
 *
 * 安全审计重点模块。每条攻击向量一个深测试用例；期望值独立来源——
 * 手工解析路径字面量（../ 抬升数、符号链接链、Windows 语义）得出，
 * 绝不复用实现式计算。
 *
 * 矩阵分组（对应任务必覆盖向量 a–i）：
 *   a) ../ 逃逸（多级、中间段混入合法路径）
 *   b) 绝对路径逃逸；根内绝对路径
 *   c) 符号链接两端同检（dir/file 链接、两级链、断链、根内软链指向根外）
 *   d) 重定向目标按写入检（>=, >> 同义；空格/引号字面名）
 *   e) Windows：盘符/UNC/反斜杠/大小写（纯 normalize 层深度用例；
 *      并标记 Linux 上按字面处理的跨平台行为）
 *   f) extraRoots 登记后放行 / 含符号链的 extraRoot / 未登记即越界
 *   g) 根本身 = workspaceRoot 命中；`.`/`./` 前缀
 *   h) 不存在路径（读拒绝）、权限不足（注入 fs，fail-closed）、非法路径
 *   i) TOCTOU：判定是调用时刻快照（文档化局限——沙箱才是权威防线，
 *      ADR-0013 三层）与构造期 fail-closed
 *
 * 布局：
 *   base/ws/                          ← workspaceRoot（默认边界）
 *     inside.txt
 *     sub/inner/deep.txt
 *     sub/out-link-file -> out/outside.txt     （根内软链 → 根外文件）
 *     sub/out-link-dir -> out                  （根内软链 → 根外目录）
 *     sub/in-link -> ../inside.txt             （根内软链 → 根内文件）
 *     sub/two-link -> out-link-file            （两级软链）
 *     sub/three-out-link -> two-link           （三级软链 → 根外文件）
 *     sub/two-in-link -> in-link
 *     sub/three-in-link -> two-in-link         （三级软链 → 根内文件）
 *     sub/dangle-out -> out/missing-out.txt    （断链 → 根外）
 *     sub/dangle-in -> ../missing-in.txt       （断链 → 根内）
 *     link-extra-dir -> ex/dir                 （根内软链 → 已登记 extraRoot）
 *     link-outside-dir -> out
 *     my file.txt / it's.txt / C:\escape /
 *     ..\..\etc\passwd（Linux 上为含 `\` 的普通字面名）
 *   base/out/outside.txt                      ← 未登记（越界代表）
 *   base/extra/dir/extra.txt                  ← jailWithExtra 登记
 *     ex-in-link -> ../dir/extra.txt （extra 内软链 → extra 内）
 *     ex-out-link -> out/outside.txt （extra 内软链 → 根外）
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createJail,
  defaultJailFs,
  normalizePath,
  pathWithin,
  type Jail,
  type JailDecision,
  type JailFs,
} from '../../src/core/jail/index.js';

function expectAllow(d: JailDecision, msg?: string): void {
  expect(d.allowed, msg).toBe(true);
}

function expectDeny(d: JailDecision, msg?: string): void {
  expect(d.allowed, msg).toBe(false);
  // fail-closed 时用户必须能看到拒因（回注给模型，CONTEXT「错误回注」）
  expect(
    typeof d.reason === 'string' && d.reason.length > 0,
    `${msg ?? ''} reason=${d.reason ?? ''}`,
  ).toBe(true);
}

function errno(code: string): Error {
  const e = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('jail 攻击矩阵（接缝 S9）', () => {
  let base: string;
  let ws: string;
  let out: string;
  let ex: string;
  let jail: Jail;
  let jailWithExtra: Jail;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'devmate-jail-'));
    ws = join(base, 'ws');
    out = join(base, 'out');
    ex = join(base, 'extra');

    await mkdir(join(ws, 'sub/inner'), { recursive: true });
    await mkdir(join(ex, 'dir'), { recursive: true });
    await mkdir(out, { recursive: true });

    await writeFile(join(ws, 'inside.txt'), 'inside-content');
    await writeFile(join(ws, 'sub/inner/deep.txt'), 'deep-content');
    await writeFile(join(ws, 'my file.txt'), 'spaced');
    await writeFile(join(ws, "it's.txt"), 'quoted');
    await writeFile(join(ws, 'C:\\escape'), 'literal-winname');
    await writeFile(join(ws, '..\\..\\etc\\passwd'), 'literal-backslash-name');
    await writeFile(join(out, 'outside.txt'), 'outside-secret');
    await writeFile(join(ex, 'dir', 'extra.txt'), 'extra-content');

    // ws 内部软链（root 经 realpath 后再登记，模拟 tmpdir 可能的软链前缀）
    await symlink(join(out, 'outside.txt'), join(ws, 'sub/out-link-file'));
    await symlink(out, join(ws, 'sub/out-link-dir'), 'dir');
    await symlink(join(ws, 'inside.txt'), join(ws, 'sub/in-link'));
    await symlink(join(ws, 'sub/out-link-file'), join(ws, 'sub/two-link'));
    // 三级符号链（链长 = 3 个软链）：three-out-link → two-link → out-link-file → 根外文件；
    // three-in-link → two-in-link → in-link → 根内文件
    await symlink(join(ws, 'sub/two-link'), join(ws, 'sub/three-out-link'));
    await symlink(join(ws, 'sub/in-link'), join(ws, 'sub/two-in-link'));
    await symlink(join(ws, 'sub/two-in-link'), join(ws, 'sub/three-in-link'));
    await symlink(join(out, 'missing-out.txt'), join(ws, 'sub/dangle-out'));
    await symlink(join(ws, 'missing-in.txt'), join(ws, 'sub/dangle-in'));
    await symlink(join(ex, 'dir'), join(ws, 'link-extra-dir'), 'dir');
    await symlink(out, join(ws, 'link-outside-dir'), 'dir');

    // extra 内部软链
    await symlink(join(ex, 'dir', 'extra.txt'), join(ex, 'dir/ex-in-link'));
    await symlink(join(out, 'outside.txt'), join(ex, 'dir/ex-out-link'));

    const rootReal = await realpath(ws);
    jail = await createJail({ workspaceRoot: rootReal });
    jailWithExtra = await createJail({ workspaceRoot: rootReal, extraRoots: [ex] });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  describe('a) ../ 逃逸（多级 + 中间段混入合法路径）', () => {
    it('相对单级：../outside.txt 抬到边界外 → 拦', async () => {
      // ws/sub/../.. 无需：直接 ws/../outside.txt → base/outside.txt
      expectDeny(await jail.checkPath('../outside.txt', 'read'));
    });

    it('相对多级：sub/../../../outside.txt 抬 3 级（ws→base→tmp父目录）→ 拦', async () => {
      // 字面：ws/sub → ws → base → tmp 父目录 → outside.txt；越界（且不存在），按字面已越界
      expectDeny(await jail.checkPath('sub/../../../outside.txt', 'read'));
    });

    it('多级兜底：sub/inner/../../../../../../.. 抬到根之上 → 解析为 / → 拦', async () => {
      // 手工：ws/sub/inner 上抬 5 级出 ws → 到 /；含 6 级再抬仍停在 /
      expectDeny(await jail.checkPath('sub/inner/../../../../../../..', 'read'));
    });

    it('中间段混入合法前缀再退出：inner 抬 5 级（sub→ws→base→tmp→/）→ /outside.txt → 拦', async () => {
      // 手工抬升：inner → sub → ws → base → tmp 父目录 → /；剩 outside.txt
      expectDeny(await jail.checkPath('sub/inner/../../../../../outside.txt', 'read'));
    });

    it('中间段重排但未出界：sub/inner/../../inside.txt = ws/inside.txt → 放行', async () => {
      // ws/sub/inner/../.. → ws；剩下 inside.txt（存在）
      expectAllow(await jail.checkPath('sub/inner/../../inside.txt', 'read'));
    });

    it('相对写逃逸：sub/../../outside-new.txt → base/outside-new.txt → 拦', async () => {
      expectDeny(await jail.checkPath('sub/../../outside-new.txt', 'write'));
    });

    it('根内 .. 自消归位：sub/../inside.txt = ws/inside.txt → 放行', async () => {
      expectAllow(await jail.checkPath('sub/../inside.txt', 'read'));
    });
  });

  describe('b) 绝对路径逃逸；根内绝对路径', () => {
    it('/etc/passwd 绝对越界 → 拦', async () => {
      expectDeny(await jail.checkPath('/etc/passwd', 'read'));
    });

    it('绝对且抬升：<ws>/sub/../../../../etc/passwd → /etc/passwd → 拦', async () => {
      // 手工抬升：ws/sub → ws → base → tmp目录 → / ; 剩下 /etc/passwd
      expectDeny(await jail.checkPath(join(ws, 'sub/../../../../etc/passwd'), 'read'));
    });

    it('根内绝对路径：<ws>/inside.txt → 放行（读）', async () => {
      expectAllow(await jail.checkPath(join(ws, 'inside.txt'), 'read'));
    });

    it('根内绝对路径：<ws>/sub/deep-new.txt → 放行（写）', async () => {
      expectAllow(await jail.checkPath(join(ws, 'sub/deep-new.txt'), 'write'));
    });

    it('绝对但等价回根：<ws>/sub/../inside.txt → 放行（读）', async () => {
      expectAllow(await jail.checkPath(join(ws, 'sub/../inside.txt'), 'read'));
    });
  });

  describe('c) 符号链接两端同检（allow 须两端命中、deny 任一命中即拦）', () => {
    it('根内软链 → 根外文件（读）：字面在 ws、真实在 out → 拦', async () => {
      expectDeny(await jail.checkPath('sub/out-link-file', 'read'));
    });

    it('根内软链 → 根外文件（写覆盖真实目标）：拦', async () => {
      expectDeny(await jail.checkPath('sub/out-link-file', 'write'));
    });

    it('根内软链 → 根外目录 + 子路径：<ws>/sub/out-link-dir/file → 拦', async () => {
      expectDeny(await jail.checkPath('sub/out-link-dir/the-file.txt', 'read'));
    });

    it('根内软链 → 根内文件：in-link → inside.txt，两端都命中 → 放行', async () => {
      expectAllow(await jail.checkPath('sub/in-link', 'read'));
    });

    it('两级软链：two-link → out-link-file → out/outside.txt → 拦', async () => {
      expectDeny(await jail.checkPath('sub/two-link', 'read'));
    });

    it('三级软链到根外（读）：three-out-link → two-link → out-link-file → 根外文件 → 拦', async () => {
      expectDeny(await jail.checkPath('sub/three-out-link', 'read'));
    });

    it('三级软链到根外（写）：落点为根外文件 → 拦', async () => {
      expectDeny(await jail.checkPath('sub/three-out-link', 'write'));
    });

    it('三级软链到根内（读）：three-in-link → two-in-link → in-link → 根内文件 → 放行', async () => {
      expectAllow(await jail.checkPath('sub/three-in-link', 'read'));
    });

    it('断链到根外（读）：真实位置为 out/missing-out.txt → 拦（读且不存在）', async () => {
      expectDeny(await jail.checkPath('sub/dangle-out', 'read'));
    });

    it('断链到根外（写）：落点为 out/missing-out.txt → 拦', async () => {
      // 手工解析：dangle-out 是断链，其读链目标 = out/missing-out.txt（越界），写会创建该文件
      expectDeny(await jail.checkPath('sub/dangle-out', 'write'));
    });

    it('断链到根内（写）：dangle-in → ws/missing-in.txt（界内）→ 放行', async () => {
      expectAllow(await jail.checkPath('sub/dangle-in', 'write'));
    });

    it('断链到根内（读）：真实位置不存在 → 读拦（读要求已存在）', async () => {
      expectDeny(await jail.checkPath('sub/dangle-in', 'read'));
    });

    it('根内软链 → 已登记 extraRoot（file 级）：两端均在边界集合 → 放行', async () => {
      expectAllow(await jailWithExtra.checkPath(join(ws, 'link-extra-dir/extra.txt'), 'read'));
    });

    it('extra 内软链 → extra 内：ex-in-link → dir/extra.txt → 放行', async () => {
      expectAllow(await jailWithExtra.checkPath(join(ex, 'dir/ex-in-link'), 'read'));
    });

    it('extra 内软链 → 根外：ex-out-link → out/outside.txt → 拦', async () => {
      expectDeny(await jailWithExtra.checkPath(join(ex, 'dir/ex-out-link'), 'read'));
    });
  });

  describe('d) 重定向：目标按写入检（源按读取检）', () => {
    it('> 目标越界：src 合法、dst=/out/outside.txt → 拦', async () => {
      expectDeny(await jail.checkRedirect('inside.txt', join(out, 'outside.txt')));
    });

    it('> 目标越界（相对 .. 抬升）：dst 解析到 base/out-new.txt → 拦', async () => {
      expectDeny(await jail.checkRedirect('inside.txt', 'sub/../../out-new.txt'));
    });

    it('>> 追加同目标语义：dst=sub/new.txt（存在性无关，落点在界内）→ 放行', async () => {
      // >> 与 > 的差异在 shell 打开标志，对监狱的唯一共性是「目标按写入检」
      expectAllow(await jail.checkRedirect('inside.txt', 'sub/new.txt'));
    });

    it('源越界、目标界内：src=/out/outside.txt → 拦（deny 任一命中即拦）', async () => {
      expectDeny(await jail.checkRedirect(join(out, 'outside.txt'), 'sub/out.txt'));
    });

    it('src 不存在（读）→ 拦：文件不会凭空生成内容，按无法判定保守处理', async () => {
      expectDeny(await jail.checkRedirect('does-not-exist.txt', 'sub/out.txt'));
    });

    it('目标含空格：my file.txt 是真实字面名 → 放行', async () => {
      expectAllow(await jail.checkRedirect('my file.txt', 'sub/out file.txt'));
    });

    it("目标含引号字符：it's.txt 是真实字面名（调用侧应先做 shell 级解引号）→ 放行", async () => {
      expectAllow(await jail.checkRedirect('inside.txt', "it's.txt"));
    });

    it('目标含空格越界：/out/new file.txt → 拦', async () => {
      expectDeny(await jail.checkRedirect('inside.txt', join(out, 'new file.txt')));
    });
  });

  describe('e) Windows 语义（纯 normalize/pathWithin 层；Linux 主机上按字面）', () => {
    it('win32：C:\\Users\\me\\..\\..\\Windows\\system32 → C:\\Windows\\system32；对 C:\\Users\\me 边界不命中 → 拦', () => {
      const p = normalizePath('C:\\Users\\me\\..\\..\\Windows\\system32', 'C:\\Users\\me', 'win32');
      expect(p).toBe('C:\\Windows\\system32');
      expect(pathWithin(p, 'C:\\Users\\me', 'win32')).toBe(false);
    });

    it('win32：C:/ws//file 与反斜杠混用 → C:\\ws\\file；在 C:\\ws 内 → 放行', () => {
      const p = normalizePath('C:/ws//file', 'C:\\ws', 'win32');
      expect(p).toBe('C:\\ws\\file');
      expect(pathWithin(p, 'C:\\ws', 'win32')).toBe(true);
    });

    it('win32：盘符绝对路径自身是绝对 → 不做基准拼接', () => {
      expect(normalizePath('C:\\Program Files\\x.exe', 'D:\\ws', 'win32')).toBe(
        'C:\\Program Files\\x.exe',
      );
    });

    it('win32：UNC \\\\server\\share\\x 绝对；命中该 share 边界 → 放行，命中 C:\\ws 边界 → 拦', () => {
      const p = normalizePath('\\\\server\\share\\x.txt', 'C:\\ws', 'win32');
      expect(p).toBe('\\\\server\\share\\x.txt');
      expect(pathWithin(p, '\\\\server\\share', 'win32')).toBe(true);
      expect(pathWithin(p, 'C:\\ws', 'win32')).toBe(false);
    });

    it('win32：UNC 内 .. 抬升不越过 share 根：\\server\\share\\a\\..\\..\\x → share\\x', () => {
      const p = normalizePath('\\\\server\\share\\a\\..\\..\\x', '\\\\server\\share', 'win32');
      expect(p).toBe('\\\\server\\share\\x');
      expect(pathWithin(p, '\\\\server\\share', 'win32')).toBe(true);
    });

    it('win32：share 前缀假命中被挡：share2 不在 share 边界内', () => {
      expect(pathWithin('\\\\server\\share2\\key', '\\\\server\\share', 'win32')).toBe(false);
    });

    it('win32：大小写不敏感：C:\\UserS\\ME\\FILE.TXT 在 c:\\users\\me 内 → 放行', () => {
      expect(pathWithin('C:\\UserS\\ME\\FILE.TXT', 'c:\\users\\me', 'win32')).toBe(true);
    });

    it('win32：\\ 分隔符逃逸 C:\\ws\\sub\\..\\..\\Windows\\sys32 → 拦', () => {
      const p = normalizePath('C:\\ws\\sub\\..\\..\\Windows\\sys32', 'C:\\ws', 'win32');
      expect(p).toBe('C:\\Windows\\sys32');
      expect(pathWithin(p, 'C:\\ws', 'win32')).toBe(false);
    });

    it('win32：盘符相对 C:foo 同盘符 → 按基准目录解析（确定性）；D:foo 异盘符 → 无法确定 cwd，保留原样不命中', () => {
      const same = normalizePath('C:foo', 'C:\\Users\\me', 'win32');
      expect(same).toBe('C:\\Users\\me\\foo');
      expect(pathWithin(same, 'C:\\Users\\me', 'win32')).toBe(true);
      const other = normalizePath('D:foo', 'C:\\Users\\me', 'win32');
      expect(pathWithin(other, 'C:\\Users\\me', 'win32')).toBe(false);
    });

    it('跨平台标记：Linux 上 C:\\escape 与 ..\\..\\etc\\passwd 是含反斜杠的字面文件名 → 不越狱（放行）', async () => {
      // 期望依据：posix 中 \ 不是分隔符，整段是一个路径分量；
      // 同名字面文件已存在于 ws 内（fixture）。在 Windows 宿主上这两条
      // 由 e) 组 win32 语义覆盖（分处盘符/UNC 边界判定），行为按平台分支变化。
      expectAllow(await jail.checkPath('C:\\escape', 'read'));
      expectAllow(await jail.checkPath('..\\..\\etc\\passwd', 'read'));
    });

    it('跨平台标记：同一条注入字符串写入（新建）也按字面落在界内 → 放行', async () => {
      expectAllow(await jail.checkPath('..\\..\\etc\\passwd-new', 'write'));
    });
  });

  describe('f) extraRoots：显式登记才放行', () => {
    it('未登记：<base>/extra/dir/extra.txt → 拦', async () => {
      expectDeny(await jail.checkPath(join(ex, 'dir/extra.txt'), 'read'));
    });

    it('登记后：<base>/extra/dir/extra.txt → 放行（读）', async () => {
      expectAllow(await jailWithExtra.checkPath(join(ex, 'dir/extra.txt'), 'read'));
    });

    it('登记后：<base>/extra/dir/extra-new.txt → 放行（写）', async () => {
      expectAllow(await jailWithExtra.checkPath(join(ex, 'dir/extra-new.txt'), 'write'));
    });

    it('登记后 extra 内 .. 抬升逃逸：<base>/extra/dir/../../out/outside.txt → 拦', async () => {
      // 手工：ex/dir → ex → base → out/outside.txt（未登记），字面已越界
      expectDeny(await jailWithExtra.checkPath(join(ex, 'dir/../../out/outside.txt'), 'read'));
    });

    it('登记 extraRoot 不存在 → 构造 fail-closed（不影响已存在根）', async () => {
      await expect(
        createJail({ workspaceRoot: ws, extraRoots: [join(base, 'no-such-extra-xyz')] }),
      ).rejects.toThrow(/fail-closed/i);
    });
  });

  describe('g) 根本身与 . 前缀', () => {
    it('p = workspaceRoot：读/写均放行（边界命中；目录本体操作合法性归工具/OS 语义）', async () => {
      expectAllow(await jail.checkPath(ws, 'read'));
      expectAllow(await jail.checkPath(ws, 'write'));
    });

    it("p = '.' → workspaceRoot → 放行", async () => {
      expectAllow(await jail.checkPath('.', 'read'));
    });

    it("p = './' → workspaceRoot → 放行", async () => {
      expectAllow(await jail.checkPath('./', 'read'));
    });

    it("p = '././inside.txt' → ws/inside.txt → 放行", async () => {
      expectAllow(await jail.checkPath('././inside.txt', 'read'));
    });

    it("p = '..'（相对边界后退）→ base → 拦", async () => {
      expectDeny(await jail.checkPath('..', 'read'));
    });

    it("p = '' → 视作 '.' → workspaceRoot → 放行", async () => {
      expectAllow(await jail.checkPath('', 'read'));
    });
  });

  describe('h) 不存在路径 / 权限不足 / 非法（保守拒绝）', () => {
    it('根内不存在文件（读）：plain-missing.txt → 拦（读要求已存在）', async () => {
      expectDeny(await jail.checkPath('plain-missing.txt', 'read'));
    });

    it('根内不存在（写）：plain-new.txt 落点在界内 → 放行（创建许可）', async () => {
      expectAllow(await jail.checkPath('plain-new.txt', 'write'));
    });

    it('根内多级不存在（写）：sub/no-dir/deep/new.txt → 落点界内 → 放行（创建/中间目录由工具语义决定）', async () => {
      expectAllow(await jail.checkPath('sub/no-dir/deep/new.txt', 'write'));
    });

    it('越界不存在（写）：/tmp 邻居 no-such-dir/file → 按字面已越界 → 拦', async () => {
      expectDeny(await jail.checkPath(join(base, '../no-such-neighbor/file'), 'write'));
    });

    it('权限不足（EACCES 注入）：读 → 拦，写 → 拦（无法解析即 fail-closed）', async () => {
      const fs2: JailFs = {
        realpath: async (p) => {
          if (p === join(ws, 'secret.txt')) throw errno('EACCES');
          return defaultJailFs().realpath(p);
        },
        lstat: defaultJailFs().lstat,
        readlink: defaultJailFs().readlink,
      };
      const jailDeny = await createJail({ workspaceRoot: ws, fs: fs2 });
      expectDeny(await jailDeny.checkPath('secret.txt', 'read'));
      expectDeny(await jailDeny.checkPath('secret.txt', 'write'));
    });

    it('全部 fs 不可用：构造期 realpath(边界) EACCES → createJail 立即失败（fail-closed）', async () => {
      const dead: JailFs = {
        realpath: async () => {
          throw errno('EACCES');
        },
        lstat: () => Promise.reject(errno('EACCES')),
        readlink: () => Promise.reject(errno('EACCES')),
      };
      await expect(createJail({ workspaceRoot: ws, fs: dead })).rejects.toThrow(/fail-closed/i);
    });

    it('非法路径：NUL 字节 → 系统接口失败 → 拦（读/写）', async () => {
      expectDeny(await jail.checkPath('inside.txt\0', 'read'));
      expectDeny(await jail.checkPath('inside.txt\0', 'write'));
    });

    it('相对 workspaceRoot 本身非法（相对路径）：createJail 拒绝', async () => {
      await expect(createJail({ workspaceRoot: 'relative/ws' })).rejects.toThrow(
        /workspaceRoot.*绝对|绝对/i,
      );
    });

    it('win32 平台在非 Windows 宿主构造 → createJail 拒绝（fail-closed，不启用未验证分支）', async () => {
      await expect(createJail({ workspaceRoot: ws, platform: 'win32' })).rejects.toThrow(/win32/i);
    });
  });

  describe('i) TOCTOU 局限与构造期契约', () => {
    it('判定是调用时刻快照：旧快照越界替换发生在判定之后 → 本次判定放行、下次判定按新状态拦', async () => {
      // 模拟：第一次 realpath 看到的是界内文件；第二次调用前文件系统被换成越界落点。
      // 期望：本模块每次判定都读当前文件系统（单快照非锁），不发生跨调用缓存。
      // 局限文档化：判定与执行之间仍有窗口（TOCTOU），权威防线是第 3 层 OS 沙箱
      // （ADR-0013：监狱管「模型放不放行」，沙箱管隔离）。
      let calls = 0;
      const fs2: JailFs = {
        realpath: async (p) => {
          const target = join(ws, 'race.txt');
          // 只对竞态目标计数（createJail 的边界根 realpath 不参与）
          if (p === target) {
            calls += 1;
            if (calls > 1) throw errno('ENOENT');
            return target;
          }
          return defaultJailFs().realpath(p);
        },
        lstat: defaultJailFs().lstat,
        readlink: defaultJailFs().readlink,
      };
      const jailRace = await createJail({ workspaceRoot: ws, fs: fs2 });
      const first = await jailRace.checkPath('race.txt', 'read');
      expectAllow(first, '快照1：此刻界内文件存在');
      const second = await jailRace.checkPath('race.txt', 'read');
      expectDeny(second, '快照2：文件系统已变（消失）→ 按当前状态拦');
    });

    it('workspaceRoot 含软链组件也能归一：边界按 realpath(root) 校准（给定路径与真实路径两种写法均命中）', async () => {
      const wsLink = join(base, 'ws-link');
      await symlink(ws, wsLink, 'dir');
      const jailLink = await createJail({ workspaceRoot: wsLink });
      expectAllow(await jailLink.checkPath(join(wsLink, 'inside.txt'), 'read'));
      expectAllow(await jailLink.checkPath(join(ws, 'inside.txt'), 'read'));
      expectDeny(await jailLink.checkPath(join(out, 'outside.txt'), 'read'));
    });
  });
});
