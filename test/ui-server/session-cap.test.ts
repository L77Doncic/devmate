/**
 * # test/ui-server/session-cap：会话数上限提示（波 B：契约 A5）
 *
 * GET /api/sessions 会话数 > N（缺省 50；deps.sessionCap 可调）→ 响应附加
 * {capped:true, hint:'…'}，并把「最旧 10 个空闲会话」标记 compact:true——
 * 只提示不自动删除（删除仍走 DELETE /api/sessions/:id）；空闲 = 无活跃 run
 * （活跃 run 会话跳过标记）；≤ N 时无 capped/hint，条目无 compact 标记。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type {
  DevmateServer,
  DevmateServerDeps,
  SessionSummary,
} from '../../src/ui/server/index.js';
import { FakeLlm } from '../loop/support.js';
import { postJson, startServer } from './support.js';

function baseDeps(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    tools: defineRegistry([], { sessionId: 's1' }),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    ...extra,
  };
}

/** n 个会话摘要（lastEventMs 递增；可指定活跃会话 id 与位置）。 */
function summaries(n: number): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      sessionId: `s-${String(i).padStart(3, '0')}`,
      title: `title-${i}`,
      createdAtMs: 1_000 + i,
      lastEventMs: 2_000 + i,
    });
  }
  return out;
}

describe('ui/server：会话数上限（capped 提示）', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('c1) ≤ N（缺省 50）：无 capped/hint，无 compact 标记；超过 50 才提示', async () => {
    const sessionLister = async () => summaries(50);
    const { base, server } = await startServer(baseDeps({ sessionLister }));
    servers.push(server);

    const ok = (await (await fetch(new URL('/api/sessions', base))).json()) as {
      sessions: SessionSummary[];
      capped?: boolean;
      hint?: string;
    };
    expect(ok.sessions).toHaveLength(50);
    expect(ok.capped).toBeUndefined();
    expect(ok.hint).toBeUndefined();
    expect(ok.sessions.every((s) => s.compact === undefined)).toBe(true);
  });

  it('c2) > N：capped:true + hint；最旧 10 个会话标记 compact:true（其余不标）', async () => {
    const sessionLister = async () => summaries(55);
    const { base, server } = await startServer(baseDeps({ sessionLister }));
    servers.push(server);

    const body = (await (await fetch(new URL('/api/sessions', base))).json()) as {
      sessions: SessionSummary[];
      capped: boolean;
      hint: string;
    };
    expect(body.capped).toBe(true);
    expect(typeof body.hint).toBe('string');
    expect(body.hint).toContain('50'); // 上限数字入提示
    expect(body.hint).toContain('s-000'); // 最旧会话 id 入提示
    const marked = body.sessions.filter((s) => s.compact === true);
    // 标记集合 = 最旧 10 个（lastEventMs 升序取 10）；响应内顺序保持列表序（新→旧）
    expect(marked.map((s) => s.sessionId).sort()).toEqual(
      summaries(55)
        .slice(0, 10)
        .map((s) => s.sessionId)
        .sort(),
    );
    // 非标记条目上不带 compact 字段
    const unmarked = body.sessions.filter((s) => s.compact === undefined);
    expect(unmarked).toHaveLength(45);
  });

  it('c3) 活跃 run 会话不算空闲：即使最旧也不标记', async () => {
    const sessionLister = async () => summaries(52);
    const held = new FakeLlm([
      { content: 'x', gate: new Promise(() => {}) }, // run 悬停在 chat —— 会话保持活跃
    ]);
    const { base, server } = await startServer(baseDeps({ llm: held, sessionLister }));
    servers.push(server);

    const created = (await (
      await postJson(base, '/api/chat', { text: 'hi', sessionId: 's-000' })
    ).json()) as { sessionId: string };
    expect(created.sessionId).toBe('s-000');

    const body = (await (await fetch(new URL('/api/sessions', base))).json()) as {
      sessions: SessionSummary[];
      capped: boolean;
      hint: string;
    };
    expect(body.capped).toBe(true);
    expect(body.sessions.find((s) => s.sessionId === 's-000')!.compact).toBeUndefined();
    // 跳过活跃会话后：后续 10 个最旧空闲会话被标记（s-001..s-010）
    const marked = body.sessions
      .filter((s) => s.compact === true)
      .map((s) => s.sessionId)
      .sort();
    expect(marked[0]).toBe('s-001');
    expect(marked).toHaveLength(10);
    expect(marked).toEqual(
      Array.from({ length: 10 }, (_, i) => `s-${String(i + 1).padStart(3, '0')}`),
    );
  });

  it('c4) deps.sessionCap 自定义上限生效；恰好 N 个会话不提示', async () => {
    const sessionLister = async () => summaries(3);
    const { base, server } = await startServer(baseDeps({ sessionCap: 3, sessionLister }));
    servers.push(server);

    const ok = (await (await fetch(new URL('/api/sessions', base))).json()) as {
      capped?: boolean;
    };
    expect(ok.capped).toBeUndefined();

    const overLister = async () => summaries(4);
    const { base: base2, server: server2 } = await startServer(
      baseDeps({ sessionCap: 3, sessionLister: overLister }),
    );
    servers.push(server2);
    const over = (await (await fetch(new URL('/api/sessions', base2))).json()) as {
      capped: boolean;
      hint: string;
      sessions: SessionSummary[];
    };
    expect(over.capped).toBe(true);
    expect(over.hint).toContain('3');
    // 4 个会话全部空闲：最旧 10 个 = 全部 4 个（标记数 ≤ min(10, 空闲数)）
    expect(over.sessions.filter((s) => s.compact === true)).toHaveLength(4);
  });
});
