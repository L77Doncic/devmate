/**
 * # test/ui-server/deps：assembleDeps 一次性组装（供 S14 CLI；接缝 S12 接线档）
 *
 * assembleDeps(config) 装配真 engine 依赖（fs+jail+shell → defineRegistry+securedRegistry；
 * JsonlFileAdapter；wiredLlmAdapter+presets；同 llm 的摘要器）。本测试只做
 * 假依赖级的装配断言：不触发任何真实网络调用（无 chat → LlmClient 不连网），
 * 服务只做 listen/close + 静态页 + settings GET。
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlFileAdapter } from '../../src/core/session/index.js';
import type { DevmateServer } from '../../src/ui/server/index.js';
import { assembleDeps, type DevmateConfig } from '../../src/ui/server/deps.js';
import { createDevmateServer } from '../../src/ui/server/index.js';

describe('ui/server/deps：assembleDeps 一次组装', () => {
  const tempDirs: string[] = [];
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'devmate-deps-'));
    tempDirs.push(dir);
    return dir;
  }

  it('deps 形状：真 store（JSONL）+ 完整工具面（fs 六个 + run_command）+ 会话工具工厂 + 设置透传', async () => {
    const dir = await tempDir();
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 'sessions'),
      model: 'deepseek-v4-flash',
      apiKey: 'sk-0123456789abcdef',
      costLimitUsd: 0.5,
      maxSteps: 50,
      windowTokens: 128_000,
      systemPrompt: 'rules…',
    });
    expect(deps.store).toBeInstanceOf(JsonlFileAdapter);
    expect(deps.tools!.list().map((d) => d.name)).toEqual(
      expect.arrayContaining([
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'glob',
        'grep',
        'run_command',
      ]),
    );
    expect(deps.llm).toBeTypeOf('object');
    expect(deps.settings?.model).toBe('deepseek-v4-flash');
    expect(deps.settings?.apiKey).toBe('sk-0123456789abcdef');
    expect(deps.runOptions).toMatchObject({
      costLimitUsd: 0.5,
      maxSteps: 50,
      windowTokens: 128_000,
    });
    // 会话工具工厂：同一会话恒同一 registry（shell/工具缓存），不同会话各自实例；
    // close 路径经 deps.dispose 清理（有 dispose 回调）
    expect(deps.createSessionTools).toBeTypeOf('function');
    expect(deps.dispose).toBeTypeOf('function');
    expect(deps.createLlm).toBeTypeOf('function');
    expect(deps.createSummarizer).toBeTypeOf('function');
    const s1a = await deps.createSessionTools!('s1');
    const s1b = await deps.createSessionTools!('s1');
    const s2 = await deps.createSessionTools!('s2');
    expect(s1a).toBe(s1b);
    expect(s2).not.toBe(s1a);
    expect(s1a.list().map((d) => d.name)).toEqual(
      expect.arrayContaining(['run_command', 'read_file', 'write_file']),
    );
    // createLlm：一次设置一个适配器形状（LlmAdapter）；不触网（惰性连接）
    const adapter = deps.createLlm!({ baseUrl: 'https://x', apiKey: 'sk-1' });
    expect(adapter).toBeTypeOf('object');
  });

  it('组装出的服务：listen(0) + GET / 200 + settings 掩码往返；全程零真实网络', async () => {
    const dir = await tempDir();
    const deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 'sessions'),
      model: 'deepseek-v4-flash',
      apiKey: 'sk-0123456789abcdef',
    });
    const server = createDevmateServer(deps);
    servers.push(server);
    const { host, port } = await server.listen(0);
    expect(host).toBe('127.0.0.1');

    const base = `http://${host}:${port}`;
    const page = await fetch(new URL('/', base));
    expect(page.status).toBe(200);

    const settings = (await (await fetch(new URL('/api/settings', base))).json()) as {
      baseUrl: string;
      model: string;
      apiKey: string;
    };
    expect(settings.model).toBe('deepseek-v4-flash');
    expect(settings.baseUrl).toContain('deepseek');
    expect(settings.apiKey).toBe('sk-0****cdef');
    expect(JSON.stringify(settings)).not.toContain('0123456789');
  });

  it('config 缺省项兜底：无 sessionsDir → 组装即创建会话目录（不抛错），runOptions 缺省只含 summarizer + methodology（R2-S1：前置门缺省开）', async () => {
    const dir = await tempDir();
    const deps = await assembleDeps({ workspaceRoot: dir, model: 'deepseek-v4-flash' });
    // 摘要器恒注入（与 llm 同一调用面）；R2-S1 方法论前置门缺省注入（config.methodFirst !== false）；
    // 未配置的 run 键不出现
    expect(Object.keys(deps.runOptions ?? {}).sort()).toEqual(['methodology', 'summarizer']);
    expect(deps.settings?.apiKey).toBeUndefined();
    expect(deps.llm).toBeTypeOf('object');
  });

  it('波B 装配字段：skillsDir 缺省 dist/assets/skills（config.skillsDir 可覆盖）；memorySampler 真采样；disposeAllIdle 释放全部空闲 shell（跳过活跃）', async () => {
    const dir = await tempDir();
    const deps = await assembleDeps({ workspaceRoot: dir, model: 'm' });
    expect(deps.skillsDir).toBe(resolve(process.cwd(), 'dist', 'assets', 'skills'));
    const override = await assembleDeps({
      workspaceRoot: dir,
      model: 'm',
      skillsDir: join(dir, 'custom-skills'),
    });
    expect(override.skillsDir).toBe(join(dir, 'custom-skills'));
    // 用户技能目录：缺省 ~/.devmate/skills（不入 StoredConfig——CLI 无需配置）；config 可覆盖
    expect(deps.userSkillsDir).toBe(join(homedir(), '.devmate', 'skills'));
    const userOverride = await assembleDeps({
      workspaceRoot: dir,
      model: 'm',
      userSkillsDir: join(dir, 'custom-user-skills'),
    });
    expect(userOverride.userSkillsDir).toBe(join(dir, 'custom-user-skills'));

    // 内存守卫内置装配：真 rss 采样 + disposeAllIdle（Infinity TTL = 全部空闲 shell）
    const rss = await deps.memorySampler!();
    expect(typeof rss).toBe('number');
    expect(rss).toBeGreaterThan(0);
    expect(deps.disposeAllIdle).toBeTypeOf('function');

    const s1 = await deps.createSessionTools!('s1'); // 建 shell（真实进程懒建）
    expect(deps.activeShellCount!()).toBe(1);
    await deps.disposeAllIdle!(new Set(['s1'])); // 活跃集合覆盖 → 跳过
    expect(deps.activeShellCount!()).toBe(1);
    await deps.disposeAllIdle!(new Set()); // 不带活跃 → 视为全部空闲 → 释放
    expect(deps.activeShellCount!()).toBe(0);
    expect(s1.list().length).toBeGreaterThan(0); // 释放后 registry 仍在（懒重启语义）
  });

  it('devmate 包 shape 防散架：assembleDeps 输入由 DevmateConfig 声明', async () => {
    const config: DevmateConfig = { workspaceRoot: '/tmp', model: 'x' };
    expect(Object.keys(config)).toEqual(['workspaceRoot', 'model']);
  });

  it('S2 小修：软链工作区——canonical 根一次解析并同源注入 jail/shell（read 放行与 run_command pwd 一致）', async () => {
    const dir = await tempDir();
    const real = join(dir, 'real-ws');
    const link = join(dir, 'link-ws');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'a.txt'), 'hello s2');
    await symlink(real, link);
    const deps = await assembleDeps({ workspaceRoot: link, model: 'm' });
    try {
      const registry = await deps.createSessionTools!('s-s2');
      // read_file：路径用软链字面拼写（调用方视角）——jail 以 canonical 为边界，
      // 软链字面端经 realpath 落点仍在边界内 → 放行且内容可见
      const read = await registry.execute({
        id: 'r1',
        name: 'read_file',
        arguments: JSON.stringify({ path: join(link, 'a.txt') }),
      });
      expect(read.ok).toBe(true);
      expect(read.content).toBe('hello s2');
      // run_command pwd：shell 初值 cwd = canonical → pwd 与 realpath(link) 一致（同目录同拼写
      // ——判定不再因「shell 初值=原字面、jail=realpath」而错位）
      const pwd = await registry.execute({
        id: 'p1',
        name: 'run_command',
        arguments: JSON.stringify({ command: 'pwd' }),
      });
      expect(pwd.ok).toBe(true);
      expect(String(pwd.content)).toContain('--- exit code: 0 ---');
      expect(String(pwd.content)).toContain(await realpath(link));
      expect(String(pwd.content)).toContain(real); // 与真实目录拼写同一目录
      // 展示层 meta（deps.workspaceRoot）保持调用方字面拼写（不因规范化漂移）
      expect(deps.workspaceRoot).toBe(link);
    } finally {
      await deps.dispose?.();
    }
  });
});
