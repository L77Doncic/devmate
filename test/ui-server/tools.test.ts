/**
 * # test/ui-server/tools：工具清单 GET /api/tools（接缝 S12 延伸）
 *
 * - GET /api/tools → {tools:[{name, description, parameters}]}：数据源 = deps.tools
 *   （ToolRegistry.list()）。设计决策：parameters（JsonSchema）**原样返回不摘要**——
 *   前端已有本地摘要（src/ui/web/sessions.js 的 toolParamNames/normalizeToolsList），
 *   reduce 传输体积，服务端不做半套转换。
 * - 排序：按 name 升序（确定性字典序）。
 * - 未注入 tools（deps.tools 缺省）→ {tools: []}（与 sessionLister 同款回退；服务端不自行装配）。
 * - registry.list() 抛错 → 501 {error}（择一，理由：5xx + 统一 {error} 形状；前端
 *   refreshTools 的 fetch 失败路径回退内置静态清单；空列表则与「合法空注册表」不可区分，
 *   会掩盖服务端故障）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDef, ToolRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import { FakeLlm } from '../loop/support.js';
import { startServer } from './support.js';

/** 基座 deps：默认不注入 tools（「未注入 → 空列表」即缺省路径）。 */
function depsFor(extra: Partial<DevmateServerDeps> = {}): DevmateServerDeps {
  return {
    store: new MemorySessionAdapter(),
    llm: new FakeLlm([{ content: 'x' }]),
    model: 'test-model',
    ...extra,
  };
}

/** 最简假注册表（list 供断言；execute 本套件不用）。 */
function registryOf(defs: readonly ToolDef[]): ToolRegistry {
  return {
    list: () => defs,
    async execute() {
      throw new Error('unused in this suite');
    },
  };
}

const ALPHA: ToolDef = {
  name: 'alpha',
  description: 'Alpha tool.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, lines: { type: 'number' } },
    required: ['path'],
  },
};

const BETA: ToolDef = {
  name: 'beta',
  description: 'Beta tool.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

const GAMMA: ToolDef = {
  name: 'gamma',
  description: 'Gamma tool.',
  parameters: { type: 'object', properties: {}, required: [] },
};

describe('ui/server：工具清单 GET /api/tools', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('t1) 注入假 registry：按 name 升序；parameters/description 原样透传（不摘要）', async () => {
    // 故意乱序：服务端负责排序
    const { base, server } = await startServer(
      depsFor({ tools: registryOf([GAMMA, ALPHA, BETA, GAMMA]) }),
    );
    servers.push(server);

    const res = await fetch(new URL('/api/tools', base));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: ToolDef[] };
    // 深等断言形状 + 排序：name/description/parameters 三个键、无额外摘要键、顺序升序
    expect(body.tools).toEqual([ALPHA, BETA, GAMMA, GAMMA]);
  });

  it('t2) 注入空注册表 → {tools: []}', async () => {
    const { base, server } = await startServer(depsFor({ tools: registryOf([]) }));
    servers.push(server);

    const res = await fetch(new URL('/api/tools', base));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tools: [] });
  });

  it('t3) 未注入 tools（deps 缺省）→ 空列表而非 500/404', async () => {
    const { base, server } = await startServer(depsFor());
    servers.push(server);

    const res = await fetch(new URL('/api/tools', base));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tools: [] });
  });

  it('t4) registry.list() 抛错 → 501 {error}（不吞成空表）', async () => {
    const boom: ToolRegistry = registryOf([]);
    boom.list = () => {
      throw new Error('registry exploded');
    };
    const { base, server } = await startServer(depsFor({ tools: boom }));
    servers.push(server);

    const res = await fetch(new URL('/api/tools', base));
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('registry exploded');
  });
});
