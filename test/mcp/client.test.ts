/**
 * # test/mcp/client：McpClient——假 stdio 服务器（fixture-server.mjs）真进程往返
 *
 * 覆盖（CTO 定稿语义 a/b/d/e）：
 * a) 握手：initialize（2024-11-05 / 服务器回退版本）+ notifications/initialized；请求
 *    id 单调且应答按 id 路由（乱序返回不串线）；环境注入（NO_COLOR/MCP_LOG_LEVEL）。
 *   握手失败（静默服务器）→ 服务不可用判型 + 无进程残留。
 * b) tools/call 应答 content 块原样带回（类型化块；text 拼接/非 text 标记在 registry）。
 * d) call 超时（500ms）→ kind='timeout' 判型；close() SIGTERM+2s SIGKILL 兜底、
 *    幂等、进程无残留。
 * e) 同一服务器两并发 call 被串行化：服务器观察顺序 请求1→应答1→请求2→应答2。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { connectMcpServer, type McpCallResult } from '../../src/core/mcp/client.js';
import { McpError, spawnMcpTransport } from '../../src/core/mcp/transport.js';
import {
  fixturePath,
  fixtureSpec,
  mkLogPath,
  readLog,
  waitForLog,
  waitForPidGone,
  waitForStart,
} from './support.js';

describe('core/mcp：client（假 stdio 服务器真进程往返）', () => {
  /** 收尾兜底：客户端/传输层 close（幂等；进程无残留由各用例自证）。 */
  const opened: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const o of opened.splice(0)) {
      await o.close();
    }
  });

  it('a1) 握手成功：initialize(2024-11-05)+initialized 通知；tools() 往返 id 单调；CRLF 容忍', async () => {
    const log = mkLogPath();
    const client = await connectMcpServer(fixtureSpec({ log }, 'fixture', log));
    opened.push(client);

    const tools = await client.tools();
    expect(tools).toEqual([
      {
        name: 'echo_tool',
        description: 'Echo the provided text back',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ]);

    const entries = readLog(log);
    // initialize：客户端发 2024-11-05，服务器原样应答（CRLF 写入——客户端已容忍）
    const init = entries.find((e) => e.ev === 'initialize');
    expect(init?.protocolVersion).toBe('2024-11-05');
    expect(init?.id).toBe(1);
    expect(entries.find((e) => e.ev === 'initialized')).toBeDefined();
    // 请求 id 单调：initialize=1 → tools/list=2；应答 id = 请求 id（fixture 应答日志）
    const list = entries.find((e) => e.ev === 'list');
    expect(list?.id).toBe(2);
    const respIds = entries.filter((e) => e.ev === 'response').map((e) => e.id);
    expect(respIds).toContain(1);
    expect(respIds).toContain(2);
  });

  it('a2) 协议版本回退：服务器应答其它版本 → 握手仍成功（不固定 2024-11-05）', async () => {
    const log = mkLogPath();
    const client = await connectMcpServer(
      fixtureSpec({ log, protocolVersion: '2025-06-18' }, 'fixture', log),
    );
    opened.push(client);
    const tools = await client.tools();
    expect(tools.length).toBe(1); // 复用同一连接，往返正常
    expect(new McpError('timeout', '').kind).toBe('timeout'); // 错误判型类成型
  });

  it('a3) env 注入：子进程见 NO_COLOR=1 与 MCP_LOG_LEVEL=error（叠加继承环境）', async () => {
    const log = mkLogPath();
    const client = await connectMcpServer(
      fixtureSpec({ log, logEnv: 'NO_COLOR,MCP_LOG_LEVEL' }, 'fixture', log),
    );
    opened.push(client);
    await waitForStart(log);
    const env = readLog(log).find((e) => e.ev === 'rawEnv');
    expect((env as Record<string, unknown> | undefined)?.['NO_COLOR']).toBe('1');
    expect((env as Record<string, unknown> | undefined)?.['MCP_LOG_LEVEL']).toBe('error');
  });

  it('a4) 请求 id 匹配/应答路由到 pending：乱序返回不串线（list 快、call 慢）', async () => {
    const log = mkLogPath();
    const spec = fixtureSpec({ log, callDelayMs: 150 }, 'fixture', log);
    const transport = spawnMcpTransport({ command: spec.command, args: spec.args });
    opened.push(transport);
    // 并发：先发慢的 tools/call（id=1，150ms 后应答），再发快的 tools/list（id=2，立即）
    const callPromise = transport.request(
      'tools/call',
      { name: 'echo_tool', arguments: { text: 'slow' } },
      2000,
    );
    const listPromise = transport.request('tools/list', {}, 2000);
    const [callResp, listResp] = await Promise.all([callPromise, listPromise]);
    // 应答按 id 各归各的 pending：call 答的是 message 内容，list 答的是工具清单
    expect(callResp.id).toBe(1);
    const callResult = callResp.result as
      { content: Array<{ type: string; text: string }> } | undefined;
    expect(callResult?.content[0]?.text).toBe('echo:{"text":"slow"}');
    expect(listResp.id).toBe(2);
    const listResult = listResp.result as { tools: unknown[] } | undefined;
    expect(listResult?.tools.length).toBe(1);
    // fixture 日志：list 应答先于 call 应答（乱序）；两个 id 都路由正确
    const respIds = readLog(log)
      .filter((e) => e.ev === 'response')
      .map((e) => e.id);
    expect(respIds.indexOf(2)).toBeLessThan(respIds.indexOf(1));
  });

  it('a5) 握手失败（服务器静默）→ transport-error 判型 + close 清理无残留', async () => {
    const log = mkLogPath();
    const client = await connectMcpServer(
      fixtureSpec({ log, silentInitialize: true }, 'fixture', log),
      { handshakeTimeoutMs: 400 },
    ).catch((err: unknown) => err); // Promise<McpClient | unknown-error>
    // 连接失败拒绝且不返回客户端：判型 transport-error
    expect(client).toBeInstanceOf(McpError);
    expect((client as McpError).kind).toBe('transport-error');
    const pid = await waitForStart(log).catch(() => Number.NaN); // start 事件总在（静默只不回 initialize）
    if (Number.isFinite(pid)) {
      expect(await waitForPidGone(pid)).toBe(true); // 握手失败路径已杀死子进程
    }
  });

  it('b1) tools/call 应答 content 块类型化带回（text 原样；isError 透传）', async () => {
    const log = mkLogPath();
    const callContent = JSON.stringify([
      { type: 'text', text: 'first text' },
      { type: 'text', text: 'second text' },
      { type: 'image', data: 'xx', mimeType: 'image/png' },
    ]);
    const spec = fixtureSpec({ log, callContent, callIsError: true }, 'fixture', log);

    const client = await connectMcpServer(spec);
    opened.push(client);
    const result: McpCallResult = await client.call('echo_tool', { text: 'x' }, 2000);
    expect(result.isError).toBe(true);
    expect(result.content.map((b) => b.type)).toEqual(['text', 'text', 'image']);
    expect(result.content[0]?.['text']).toBe('first text');
    expect(result.content[1]?.['text']).toBe('second text');
    expect(result.content[2]?.['mimeType']).toBe('image/png');
    // 未知工具（JSON-RPC error 判型 unknown-tool 属客户端；覆盖见 registry）
  });

  it('d1) call 超时（500ms）→ kind=timeout；close() 幂等且进程无残留', async () => {
    const log = mkLogPath();
    const client = await connectMcpServer(
      fixtureSpec({ log, slowOn: 'echo_tool' }, 'fixture', log),
    );
    opened.push(client);
    const pid = await waitForStart(log);

    const err = await client.call('echo_tool', { text: 'hang' }, 500).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).kind).toBe('timeout');
    expect((err as McpError).message).toContain('500');

    await client.close();
    expect(await waitForPidGone(pid)).toBe(true);
    await client.close(); // 幂等：二次 close 不抛
    opened.pop();
  });

  it.skipIf(process.platform === 'win32')(
    'v2b) 进程组终止：close() 杀死中介+服务器整组（npm→node 形态；stdin 断管仍常驻的服务器不复存在）',
    async () => {
      const log = mkLogPath();
      // 中介 node（launcher，stdio 全继承 → 服务器 node 拿到同一根 stdin 管道）→ 真实服务器
      // node（fixture --stayOnEof：stdin EOF 后仍常驻——模拟 mcp-remote 类「父死仍不退出」；
      // 只杀直接子进程（launcher 对应 npm）会留下服务器孤儿）。
      // （sh 后台形态不适用：dash 对后台列表 stdin 重定向 /dev/null——服务器会提前 EOF。）
      const launcherJs =
        "const{spawn}=require('node:child_process');" +
        "const c=spawn(process.execPath,[process.argv[1],...process.argv.slice(2)],{stdio:'inherit'});" +
        "c.on('exit',code=>{process.exitCode=code??0});";
      const transport = spawnMcpTransport({
        command: process.execPath,
        args: ['-e', launcherJs, '--', fixturePath(), `--log=${log}`, '--stayOnEof'],
      });
      opened.push(transport);
      const nodePid = await waitForStart(log); // 服务器 node（组内孙进程）
      // stdin 仍开着（launcher 完整继承）——服务器不会提前 EOF
      expect((await readLog(log)).some((e) => e.ev === 'stay-eof')).toBe(false);

      const t0 = Date.now();
      await transport.close();
      // close() 先 stdin.end：服务器收到 EOF 但 stayOnEof 常驻（直到被信号终止）。
      // sigterm 事件证明：EOF 后进程仍存活（只杀直接子进程会留下这个孤儿）——
      // 组杀之后整组回收、close 无需等满 2s 宽限。短窗口轮询（fixture 的日志刷写与
      // close 返回之间存在调度间隙）。
      const sigtermSeen = await waitForLog(
        log,
        (list) => list.some((e) => e.ev === 'sigterm'),
        2000,
      )
        .then(() => true)
        .catch(() => false);
      expect(sigtermSeen).toBe(true);
      expect(await waitForPidGone(nodePid, 5000)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2000);
      opened.pop();
    },
  );

  it('e1) 串行化：并发 2 call → 服务器观察 请求1→应答1→请求2→应答2', async () => {
    const log = mkLogPath();
    const client = await connectMcpServer(fixtureSpec({ log, callDelayMs: 60 }, 'fixture', log));
    opened.push(client);
    const [r1, r2] = await Promise.all([
      client.call('echo_tool', { text: 'first' }, 3000),
      client.call('echo_tool', { text: 'second' }, 3000),
    ]);
    expect((r1.content[0]?.['text'] as string).includes('first')).toBe(true);
    expect((r2.content[0]?.['text'] as string).includes('second')).toBe(true);

    const seq = readLog(log).filter((e) => e.ev === 'call' || e.ev === 'response');
    const labels = seq.map((e): string =>
      e.ev === 'call'
        ? `call:${(e.args as { text?: string } | undefined)?.text ?? String(e.id)}`
        : `response(${e.method ?? ''}):${e.id}`,
    );
    const iCallFirst = labels.indexOf('call:first');
    const iRespFirst = labels.indexOf('response(tools/call):2'); // initialize=id1；首个 call=id2
    const iCallSecond = labels.indexOf('call:second');
    const iRespSecond = labels.indexOf('response(tools/call):3');
    expect(iCallFirst).toBeGreaterThanOrEqual(0);
    // 严格串行：先行的完整往返完成后第二个请求才出发
    expect(iCallFirst).toBeLessThan(iRespFirst);
    expect(iRespFirst).toBeLessThan(iCallSecond);
    expect(iCallSecond).toBeLessThan(iRespSecond);
  });
});
