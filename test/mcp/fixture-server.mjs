#!/usr/bin/env node
/* global process:readonly, setTimeout:readonly, setInterval:readonly */
/**
 * # test/mcp/fixture-server：假 stdio MCP 服务器（jsonrpc 应答 initialize/list/call）
 *
 * 真实子进程（由宿主 vitest 以 process.execPath 启动），行定界 JSON-RPC（CRLF 输出——
 * 顺带证明客户端容忍 CRLF）。行为全部经 argv 配置；事件簿（请求到达/应答发出/自身
 * pid）以 JSON 行追加进 --log= 文件——stdout 只走协议（观察永不污染协议流）。
 *
 * 配置（`--key=value`）：
 * - --log=<path>          事件日志（必需；每行一个 JSON 对象）
 * - --tools=<json>        tools/list 应答的工具数组；缺省 = 一个 echo_tool
 * - --callContent=<json>  每次 tools/call 应答的 content；工具定义可带 callContent 覆盖
 * - --callIsError=<true|false> 每次 call 应答 isError（缺省 false）
 * - --callDelayMs=<n>     call 应答前延迟（串行测试/call 测试用）
 * - --slowOn=<name,...>  这些工具永不应答（故意挂起 → 宿主超时）
 * - --silentInitialize   忽略 initialize（不答 → 宿主握手超时）
 * - --protocolVersion=<v> initialize 应答强制版本（测试「服务器回退版本」）
 * - --logEnv=<K1,K2>     start 事件里回传这些环境变量的值（env 注入断言）
 * - --crashAfterCall     应答首个 tools/call 后 20ms 进程 exit(0)（崩溃测试）
 * - --exitAfterMs=<n>    启动 n ms 后自行 exit(0)
 * - --badJson=<n>        第 n 条收到的消息后输出一行非 JSON（协议错误测试）
 * - --stayOnEof         stdin EOF 后不退出（默认立即退）——模拟 mcp-remote 类「父死仍常驻」
 *                       （VT-2 进程组终止测试：组杀必须能终止它；只杀直接子进程会留孤儿）。
 */
import { appendFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// argv 解析
// ---------------------------------------------------------------------------

function flag(name) {
  const raw = `--${name}`;
  for (const arg of process.argv.slice(2)) {
    if (arg === raw) return 'true';
    const prefix = `${raw}=`;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

const cfg = {
  log: flag('log'),
  toolsJson: flag('tools'),
  callContentJson: flag('callContent'),
  callIsError: flag('callIsError') === 'true',
  callDelayMs: Number(flag('callDelayMs') ?? 0),
  slowOn: new Set((flag('slowOn') ?? '').split(',').filter((s) => s !== '')),
  silentInitialize: flag('silentInitialize') === 'true',
  protocolVersion: flag('protocolVersion'),
  logEnv: (flag('logEnv') ?? '').split(',').filter((s) => s !== ''),
  crashAfterCall: flag('crashAfterCall') === 'true',
  exitAfterMs: Number(flag('exitAfterMs') ?? 0),
  badJsonAfter: Number(flag('badJson') ?? 0),
  stayOnEof: flag('stayOnEof') === 'true',
};

if (cfg.log === undefined) {
  process.stderr.write('fixture-server: --log=<path> is required\n');
  process.exit(2);
}

const tools =
  cfg.toolsJson === undefined
    ? [
        {
          name: 'echo_tool',
          description: 'Echo the provided text back',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ]
    : JSON.parse(cfg.toolsJson);

const defaultCallContent =
  cfg.callContentJson === undefined ? null : JSON.parse(cfg.callContentJson);

// ---------------------------------------------------------------------------
// 事件日志（stdout 只走协议；观察者读 log 文件）
// ---------------------------------------------------------------------------

let badJsonCounter = 0;
function log(ev) {
  appendFileSync(cfg.log, `${JSON.stringify(ev)}\n`);
}

log({ ev: 'start', pid: process.pid });
// SIGTERM 记录后退出（进程组终止测试的观察点：EOF 之后进程仍存活、由信号终止——
// 只杀直接子进程会留下孤儿；缺省 kill 无记录可断言，故 fixture 自带 handler）。
process.on('SIGTERM', () => {
  log({ ev: 'sigterm' });
  process.exit(0);
});
if (cfg.logEnv.length > 0) {
  const snapshot = {};
  for (const key of cfg.logEnv) snapshot[key] = process.env[key] ?? '';
  log({ ev: 'rawEnv', ...snapshot });
}
process.on('exit', () => {
  try {
    log({ ev: 'exit' });
  } catch {
    /* 退出路径不折腾 */
  }
});

if (cfg.exitAfterMs > 0) setTimeout(() => process.exit(0), cfg.exitAfterMs);

// ---------------------------------------------------------------------------
// JSON-RPC 应答
// ---------------------------------------------------------------------------

function write(msg) {
  // 故意用 CRLF：客户端必须容忍（\n 定界 + \r 剥除）
  process.stdout.write(`${JSON.stringify(msg)}\r\n`);
}

function respond(id, payload, method) {
  log({ ev: 'response', id, method });
  write({ jsonrpc: '2.0', id, result: payload });
}

function respondError(id, code, message, data, method) {
  log({ ev: 'response', id, method, error: message });
  write({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    log({ ev: 'initialize', id, protocolVersion: params?.protocolVersion });
    if (cfg.silentInitialize) return; // 故意不回：宿主握手超时
    respond(
      id,
      {
        protocolVersion: cfg.protocolVersion ?? params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'devmate-test-fixture', version: '1.0.0' },
      },
      method,
    );
    return;
  }
  if (method === 'notifications/initialized') {
    log({ ev: 'initialized', id });
    return;
  }
  if (method === 'tools/list') {
    log({ ev: 'list', id, toolNames: tools.map((t) => t.name) });
    respond(id, { tools }, method);
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const arguments_ = params?.arguments;
    log({ ev: 'call', id, name, args: arguments_ });
    if (cfg.slowOn.has(name)) return; // 永不应答（宿主侧超时）
    const delay = cfg.callDelayMs > 0 ? cfg.callDelayMs : 0;
    const send = () => {
      const tool = tools.find((t) => t.name === name);
      let content = defaultCallContent;
      if (content === null) {
        content = tool?.callContent ?? [
          { type: 'text', text: `echo:${JSON.stringify(arguments_ ?? {})}` },
        ];
      }
      const payload = { content, ...(cfg.callIsError ? { isError: true } : {}) };
      if (cfg.crashAfterCall) {
        respond(id, payload, method);
        setTimeout(() => process.exit(0), 20);
      } else {
        respond(id, payload, method);
      }
    };
    if (delay > 0) setTimeout(send, delay);
    else send();
    return;
  }
  log({ ev: 'method-not-found', id, method });
  respondError(id, -32601, `method not found: ${method}`, undefined, method);
}

// ---------------------------------------------------------------------------
// 主循环（行定界，容忍客户端 CRLF/空行）
// ---------------------------------------------------------------------------

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx).replace(/\r$/, '').trim();
    buffer = buffer.slice(idx + 1);
    if (line === '') continue;
    if (cfg.badJsonAfter > 0) {
      badJsonCounter += 1;
      if (badJsonCounter === cfg.badJsonAfter) {
        log({ ev: 'bad-json-sent' });
        process.stdout.write('this is not json\r\n');
      }
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log({ ev: 'parse-error', line });
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(err) } })}\r\n`,
      );
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => {
  if (cfg.stayOnEof) {
    // 常驻模拟（mcp-remote 类：stdin 断管后仍保持进程）；被 SIGTERM 组杀终止。
    // 无定时器进程会自动退出——挂一个 interval 保持事件循环。
    log({ ev: 'stay-eof' });
    setInterval(() => {}, 60000);
    return;
  }
  process.exit(0);
});
