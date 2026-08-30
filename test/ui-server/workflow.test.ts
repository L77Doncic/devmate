/**
 * # test/ui-server/workflow：/api/workflow 端点（波 B：契约 A2；subagent 无上限）
 *
 * GET /api/workflow → {subagentsEnabled, maxParallel}（缺省 true/2）；
 * POST /api/workflow 部分字段更新 + 校验 + saveWorkflow 持久化（config.json 经 CLI 注入；
 * 无则仅内存）；maxParallel 接受 0-8（0 = 无上限）整数；<0 / >8 / 非整 → 400；
 * subagentsEnabled 必须 boolean（初值越界由 clampMaxParallel 归一 0..8——本端点只夹初值）。
 * 本端点只做配置层：子代理实际执行属独立子代理池（P2 接入），此处只有开关数值。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '../../src/core/loop/index.js';
import { MemorySessionAdapter } from '../../src/core/session/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
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

interface WorkflowConfig {
  subagentsEnabled: boolean;
  maxParallel: number;
}

describe('ui/server：/api/workflow', () => {
  const servers: DevmateServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('w1) GET 缺省 {subagentsEnabled:true, maxParallel:2}；deps.workflow 注入初值优先', async () => {
    const { base, server } = await startServer(baseDeps());
    servers.push(server);
    const def = (await (await fetch(new URL('/api/workflow', base))).json()) as WorkflowConfig;
    expect(def).toEqual({ subagentsEnabled: true, maxParallel: 2 });

    const { base: base2, server: server2 } = await startServer(
      baseDeps({ workflow: { subagentsEnabled: false, maxParallel: 3 } }),
    );
    servers.push(server2);
    const ini = (await (await fetch(new URL('/api/workflow', base2))).json()) as WorkflowConfig;
    expect(ini).toEqual({ subagentsEnabled: false, maxParallel: 3 });
  });

  it('w2) POST 更新（部分字段保留未指字段）+ saveWorkflow 全量快照；GET 反映新值', async () => {
    const saveWorkflow = vi.fn();
    const { base, server } = await startServer(baseDeps({ saveWorkflow }));
    servers.push(server);

    const res = await postJson(base, '/api/workflow', { maxParallel: 8 });
    expect(res.status).toBe(200);
    expect((await res.json()) as WorkflowConfig).toEqual({
      subagentsEnabled: true,
      maxParallel: 8,
    });
    expect(saveWorkflow).toHaveBeenCalledTimes(1);
    expect(saveWorkflow).toHaveBeenLastCalledWith({ subagentsEnabled: true, maxParallel: 8 });

    const res2 = await postJson(base, '/api/workflow', { subagentsEnabled: false });
    expect((await res2.json()) as WorkflowConfig).toEqual({
      subagentsEnabled: false,
      maxParallel: 8,
    });
    expect(saveWorkflow).toHaveBeenLastCalledWith({ subagentsEnabled: false, maxParallel: 8 });

    const got = (await (await fetch(new URL('/api/workflow', base))).json()) as WorkflowConfig;
    expect(got).toEqual({ subagentsEnabled: false, maxParallel: 8 });
  });

  it('w3) 校验：maxParallel 越界/非整数 → 400；subagentsEnabled 非 boolean → 400；空体 → 400', async () => {
    const { base, server } = await startServer(baseDeps());
    servers.push(server);

    // 0-8 合法（0 = 无上限）；>8 / 负 / 非整 / 非数 → 400
    for (const bad of [9, 8.5, 2.5, '3', -1, 1.1]) {
      const res = await postJson(base, '/api/workflow', { maxParallel: bad });
      expect(res.status, `maxParallel=${String(bad)}`).toBe(400);
    }
    const badEnable = await postJson(base, '/api/workflow', { subagentsEnabled: 'yes' });
    expect(badEnable.status).toBe(400);
    const empty = await postJson(base, '/api/workflow', {});
    expect(empty.status).toBe(400);
    const nonObj = await postJson(base, '/api/workflow', [1, 2]);
    expect(nonObj.status).toBe(400);

    // 校验失败不持久化
    expect((await (await fetch(new URL('/api/workflow', base))).json()) as WorkflowConfig).toEqual({
      subagentsEnabled: true,
      maxParallel: 2,
    });
  });

  it('w4) 无 saveWorkflow → 仅内存（POST 生效但不落盘）；初值越界 maxParallel 夹紧到 0-8', async () => {
    const { base, server } = await startServer(
      baseDeps({ workflow: { subagentsEnabled: true, maxParallel: 99 } }),
    );
    servers.push(server);
    const ini = (await (await fetch(new URL('/api/workflow', base))).json()) as WorkflowConfig;
    expect(ini.maxParallel).toBe(8);

    const res = await postJson(base, '/api/workflow', { maxParallel: 1 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkflowConfig).maxParallel).toBe(1);
    const got = (await (await fetch(new URL('/api/workflow', base))).json()) as WorkflowConfig;
    expect(got).toEqual({ subagentsEnabled: true, maxParallel: 1 });
  });

  it('w5) 0 与 8 均接受（0 = 无上限）；9 → 400；GET 回显服务端态', async () => {
    const { base, server } = await startServer(baseDeps());
    servers.push(server);

    const res0 = await postJson(base, '/api/workflow', { maxParallel: 0 });
    expect(res0.status).toBe(200);
    expect(((await res0.json()) as WorkflowConfig).maxParallel).toBe(0);
    const res8 = await postJson(base, '/api/workflow', { maxParallel: 8 });
    expect(res8.status).toBe(200);
    expect(((await res8.json()) as WorkflowConfig).maxParallel).toBe(8);
    const bad = await postJson(base, '/api/workflow', { maxParallel: 9 });
    expect(bad.status).toBe(400);

    const got = (await (await fetch(new URL('/api/workflow', base))).json()) as WorkflowConfig;
    expect(got).toEqual({ subagentsEnabled: true, maxParallel: 8 });
  });
});
