/**
 * # test/registry：securedRegistry 装饰器（接缝 S11，src/core/tools/registry.ts）
 *
 * 纪律：装饰器测试一律用假 registry（最简 fakes、独立于被测代码）；
 * 语义验证：a) 回注前打码（content 与 error.message 均经 redactor）
 * b) 不改变 ToolResult 的 ok/error 结构 c) registry.list() 透传。
 */
import { describe, expect, it } from 'vitest';

import { securedRegistry } from '../src/core/tools/registry.js';
import type { ToolCall, ToolDef, ToolRegistry, ToolResult } from '../src/core/loop/index.js';

const DEFS: readonly ToolDef[] = [
  { name: 'read_file', description: 'read', parameters: { type: 'object' } },
  { name: 'run_command', description: 'shell', parameters: { type: 'object' } },
];

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const GH_TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0';

// ---------------------------------------------------------------------------
// 假 registry：脚本队列 + 调用记录（最简 fakes）
// ---------------------------------------------------------------------------

function fakeRegistry(script: readonly ToolResult[]): {
  registry: ToolRegistry;
  calls: ToolCall[];
} {
  const calls: ToolCall[] = [];
  const queue = [...script];
  return {
    calls,
    registry: {
      list: () => DEFS,
      async execute(call) {
        calls.push(call);
        const next = queue.shift();
        if (next === undefined) throw new Error('fake registry：脚本队列耗尽');
        return next;
      },
    },
  };
}

const CALL: ToolCall = { id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' };

describe('securedRegistry：执行结果打码与结构保持（切片 d）', () => {
  it('ok 结果：content 打码、ok 保持 true、不带 error 键', async () => {
    const { registry } = fakeRegistry([{ ok: true, content: `token=${GH_TOKEN}` }]);
    const secured = securedRegistry(registry);
    const result = await secured.execute(CALL);
    expect(result).toEqual({ ok: true, content: 'token=[REDACTED:github-token]' });
    expect('error' in result).toBe(false);
  });

  it('无 secret 的 ok 输出原样透传（脱敏是 no-op，不重写内容）', async () => {
    const { registry } = fakeRegistry([{ ok: true, content: 'plain output & line\n' }]);
    const secured = securedRegistry(registry);
    const result = await secured.execute(CALL);
    expect(result).toEqual({ ok: true, content: 'plain output & line\n' });
  });

  it('error 结果：ok:false 与 error.type 保留，error.message 与 content 内的 secret 均打码', async () => {
    const message = `git push failed (Bearer ${JWT})`;
    const { registry } = fakeRegistry([
      {
        ok: false,
        content: JSON.stringify({
          ok: false,
          error: { type: 'tool-error', message },
        }),
        error: { type: 'tool-error', message },
      },
    ]);
    const secured = securedRegistry(registry);
    const result = await secured.execute(CALL);
    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe('tool-error');
    // 设计：整个 `Bearer <token>` span → 单个标记（类型标签仍在，可分辨）
    expect(result.error?.message).toBe('git push failed ([REDACTED:bearer-token])');
    expect(result.content).toBe(
      '{"ok":false,"error":{"type":"tool-error","message":"git push failed ([REDACTED:bearer-token])"}}',
    );
    // 结构仍是 {ok:false,error:{type,message}}：不多不少
    expect(Object.keys(result).sort()).toEqual(['content', 'error', 'ok']);
    expect(Object.keys(result.error ?? {}).sort()).toEqual(['message', 'type']);
  });

  it('错误里带 token 的路径同样打码（不因 error 附的路径含主机路径凭据而泄露）', async () => {
    const { registry } = fakeRegistry([
      {
        ok: false,
        content: '',
        error: { type: 'tool-error', message: `config /root/.config/git/${GH_TOKEN}` },
      },
    ]);
    const secured = securedRegistry(registry);
    const result = await secured.execute(CALL);
    expect(result.error?.message).toBe('config /root/.config/git/[REDACTED:github-token]');
  });

  it('list() 透传（同一定义集对象，不复制不改写）', () => {
    const { registry } = fakeRegistry([]);
    const secured = securedRegistry(registry);
    expect(secured.list()).toBe(DEFS);
    expect(secured.list()[0]?.name).toBe('read_file');
  });

  it('execute 的调用对象原样传给底层 registry（装饰器不吞参数）', async () => {
    const { registry, calls } = fakeRegistry([{ ok: true, content: 'x' }]);
    const secured = securedRegistry(registry);
    await secured.execute(CALL);
    expect(calls).toEqual([CALL]);
  });

  it('自定义 redactor 生效（content 与 error.message 都走它）', async () => {
    const calls: number[] = [];
    const { registry } = fakeRegistry([
      {
        ok: false,
        content: 'SECRET-X inside content',
        error: { type: 'tool-error', message: 'SECRET-X inside message' },
      },
    ]);
    const secured = securedRegistry(registry, {
      redactor: (text) => {
        calls.push(0);
        return text.replace(/SECRET-X/g, '[REDACTED:probe]');
      },
    });
    const result = await secured.execute(CALL);
    expect(result.content).toBe('[REDACTED:probe] inside content');
    expect(result.error?.message).toBe('[REDACTED:probe] inside message');
    expect(calls.length).toBe(2); // content + message 各一次（结构不变，仅文本变换）
  });
});
