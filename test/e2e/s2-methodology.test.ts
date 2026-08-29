/**
 * # test/e2e/s2-methodology：S2 回归锁定（真 assembleDeps + fake llm 脚本；软契约）
 *
 * 只锁定契约，不锁死具体提示词措辞（防漂移柔性）：
 * - a) 方法论三规则在提示词中软在场：亮牌（方法线：<id>）/ 先加载（首个工具调用前
 *      use_skill 加载全文）/ 判据（收尾按 done 判据陈述完成情况）——逐词断言会把
 *     writing-for-agents 的重写锁死，此处按语义存在性断言（规则锚词）。
 * - b) 评审哨兵注入路径（与 test/loop/review-sentinel 同链路抽样）：真实 write_file
 *     执行（实质变更）→ 模型自然结束 → 注入 system-user（SSE 帧 data.system=true）→
 *     续跑一轮 → completed（steps=3）；注入口径 = 事件 meta.system:true 映射帧。
 *
 * 零外部网络：LLM 全假（assembleDeps 后覆写 deps.llm/createLlm——全链 A 档同模式）；
 * write_file/run_command 只碰本机 tmp 工作区。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DevmateServerDeps } from '../../src/ui/server/index.js';
import { assembleDeps } from '../../src/ui/server/deps.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, SseClient, startServer, waitForFrames } from '../ui-server/support.js';
import type { TestServerHandle } from '../ui-server/support.js';

/** 单一技能（method 型）技能资产 + methodologies.json（构成路由节）。 */
async function writeMethodSkillBundle(skillsDir: string): Promise<void> {
  await mkdir(join(skillsDir, 'tdd'), { recursive: true });
  await writeFile(
    join(skillsDir, 'tdd', 'SKILL.md'),
    '---\nname: tdd\ndescription: TDD loop.\n---\nTDD BODY',
  );
  await writeFile(
    join(skillsDir, 'methodologies.json'),
    JSON.stringify({
      tdd: { type: 'method', trigger: '修复 bug/新增功能', steps: '红先绿', done: '每片红→绿' },
    }),
  );
}

describe('E2E-S2：方法论/评审哨兵契约锁定（assembleDeps + fake llm）', () => {
  let dir: string;
  let skillsDir: string;
  let deps: DevmateServerDeps;
  let handle: TestServerHandle | null = null;
  let fake: FakeLlm;
  const clients: SseClient[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devmate-e2e-s2-'));
    skillsDir = join(dir, 'skills');
    await writeMethodSkillBundle(skillsDir);
    fake = new FakeLlm([]); // 每测试自设脚本
    deps = await assembleDeps({
      workspaceRoot: dir,
      sessionsDir: join(dir, 'sessions'),
      model: 'deepseek-v4-flash',
      skillsDir,
      userSkillsDir: join(dir, 'user-skills'),
    });
    deps.llm = fake;
    deps.createLlm = () => fake;
    handle = await startServer(deps);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await handle?.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('a) 提示词契约：亮牌/先加载/判据 三规则软在场（只锚语义存在性，不锁措辞）', async () => {
    fake = new FakeLlm([{ content: '修好了' }]);
    deps.llm = fake;
    const base = handle!.base;
    const res = await postJson(base, '/api/chat', { text: '修复 bug 报告' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 5, 10_000);
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({
      status: 'completed',
      steps: 1,
    });

    const systemPrompt = String(fake.requests[0]!.messages[0]!.content);
    // 路由节（method 型 enabled → 一行 + 三行规则）在合成提示词中
    expect(systemPrompt).toContain('## 方法论路由');
    expect(systemPrompt).toContain('- 修复 bug/新增功能 → tdd');
    // 三规则软存在性（锚词——不锁死整句措辞）
    expect(systemPrompt).toContain('方法线：<id>'); // 亮牌规则
    expect(systemPrompt).toContain('use_skill'); // 先加载规则
    expect(systemPrompt).toContain('判据'); // 收尾 done 判据规则
  });

  it('b) 评审哨兵注入路径：实质变更（write_file）→ 自然结束注入 system-user → 续跑 → completed', async () => {
    fake = new FakeLlm([
      {
        content: '写文件',
        toolCalls: [
          {
            id: 'w1',
            name: 'write_file',
            // 绝对路径（工作区内；fs 工具的字面执行路径 = 传入路径——相对路径另按进程 cwd，
            // 非本契约面——软链一致化语义见 deps.test 的 S2 用例）
            arguments: JSON.stringify({ path: join(dir, 'out.txt'), content: 's2' }),
          },
        ],
      },
      { content: '改完了' },
      { content: '先审查再收尾' },
    ]);
    deps.llm = fake;
    const base = handle!.base;
    const res = await postJson(base, '/api/chat', { text: '写个文件' });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const client = await SseClient.connect(base, sessionId);
    clients.push(client);
    await waitForFrames(client, 12, 10_000);

    // 注入帧：session-user + data.system=true（系统样式）+ 哨兵标记（契约锚点）
    const sentinelFrame = client.frames.find(
      (f) => f.event === 'session-user' && (f.data as Record<string, unknown>).system === true,
    );
    expect(sentinelFrame).toBeDefined();
    const text = (sentinelFrame!.data as { text: string }).text;
    expect(text).toContain('评审哨兵');
    expect(text).toContain('spawn_subagent');
    // 事件序：尾段 = assistant(自然结束) → [哨兵 user] → 模型续跑 → usage → run-status
    const seq = client.frames.map((f) => f.event);
    expect(seq.slice(0, 6)).toEqual([
      'session-user',
      'assistant-delta',
      'assistant-done',
      'tool-start',
      'tool-result',
      'assistant-delta',
    ]);
    const sentinelIndex = seq.findIndex((event, i) => event === 'session-user' && i > 0);
    expect(sentinelIndex).toBeGreaterThan(6);
    expect(seq[seq.length - 1]).toBe('run-status');
    expect(client.frames[client.frames.length - 1]!.data).toMatchObject({
      status: 'completed',
      steps: 3,
    });
    // 续跑的一轮请求：哨兵消息是最后一条 user 消息（模型对其 respond——注入路径收证）
    const third = fake.requests[2]!;
    const last = third.messages[third.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('评审哨兵');
  });
});
