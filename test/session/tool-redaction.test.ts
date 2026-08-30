import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { JsonlFileAdapter } from '../../src/core/session/index.js';
import { cleanupTmpDirs, createTmpDir, event, readAll, userPayload } from './support.js';

/**
 * VT-3 修复 b：存储层敏感值脱敏（默认开；最终口径）——
 * kind==='tool' 的 result content 落盘前过 redactSecrets：append 返回值、磁盘、resume/
 * 回放均为掩码（真实凭据不应在模型可见上下文出现两次——与原「回注前脱敏」一致且更彻底）；
 * 只作用于 tool 事件（user 等不脱敏）；开关可关（redactToolContent:false 原文落盘）。
 */
describe('存储层脱敏（VT-3 修复 b：tool result content 落盘掩码）', () => {
  const OPENAI_KEY = `sk-${'a'.repeat(40)}`; // 命中默认 openai-key 模式（sk- + ≥24 字符，VT2-2 阈值）

  it('tool 事件 content 落盘掩码：磁盘无明文、读回与 append 返回值均掩码（默认开）', async () => {
    const dir = createTmpDir();
    try {
      const store = new JsonlFileAdapter({ dir });
      await store.create('s1');
      const raw = `export DEV_MATE_API_KEY=${OPENAI_KEY}`;
      const saved = await store.append('s1', event('tool', { toolCallId: 'c1', content: raw }));

      // append 返回值（观察器/投影的消费面）即掩码
      expect(saved.kind).toBe('tool');
      if (saved.kind === 'tool') {
        expect(saved.payload.content).toContain('[REDACTED:openai-key]');
        expect(saved.payload.content).not.toContain(OPENAI_KEY);
      }

      // 磁盘：明文 key 不出现
      const disk = readFileSync(join(dir, 's1.jsonl'), 'utf8');
      expect(disk).not.toContain(OPENAI_KEY);
      expect(disk).toContain('[REDACTED:openai-key]');

      // 读回（同实例 events / 磁盘回放）统一掩码
      const replayed = await readAll(store, 's1');
      expect(replayed[0]!.kind).toBe('tool');
      if (replayed[0]!.kind === 'tool') {
        expect(replayed[0]!.payload.content).toBe(saved.payload.content);
      }

      // resume 口径：新实例从磁盘重建 → 掩码（最终口径——不会有「磁盘掩码、内存原文」两张皮）
      const fresh = new JsonlFileAdapter({ dir });
      const reread = await readAll(fresh, 's1');
      if (reread[0]!.kind === 'tool') {
        expect(reread[0]!.payload.content).toBe(saved.payload.content);
      }
    } finally {
      cleanupTmpDirs();
    }
  });

  it('掩码产物仍是合法 JSON（{ok:false,error:{message}} 载荷可继续被下游解析）', async () => {
    const dir = createTmpDir();
    try {
      const store = new JsonlFileAdapter({ dir });
      await store.create('s1');
      const raw = JSON.stringify({
        ok: false,
        error: { type: 'run-error', message: `token leak: ${OPENAI_KEY}` },
      });
      await store.append('s1', event('tool', { toolCallId: 'c1', content: raw }));
      const diskLine = readFileSync(join(dir, 's1.jsonl'), 'utf8').trimEnd();
      const parsed = JSON.parse(diskLine) as {
        payload: { content: string; ok?: boolean; error?: { type?: string } };
      };
      expect(parsed.payload.content).not.toContain(OPENAI_KEY);
      const inner = JSON.parse(parsed.payload.content) as { ok: boolean; error: { type: string } };
      expect(inner.ok).toBe(false);
      expect(inner.error.type).toBe('run-error'); // 结构不变——只做文本变换
    } finally {
      cleanupTmpDirs();
    }
  });

  it('范围仅 tool：user 事件内容原文落盘（用户消息不是工具结果刻录面）', async () => {
    const dir = createTmpDir();
    try {
      const store = new JsonlFileAdapter({ dir });
      await store.create('s1');
      await store.append('s1', event('user', userPayload(`paste: ${OPENAI_KEY}`)));
      await store.append('s1', event('tool', { toolCallId: 'c1', content: 'ok' }));
      const disk = readFileSync(join(dir, 's1.jsonl'), 'utf8');
      expect(disk).toContain(OPENAI_KEY); // user 行原文
      expect(disk).not.toContain('[REDACTED:openai-key]'); // tool 行 'ok' 无可掩码
    } finally {
      cleanupTmpDirs();
    }
  });

  it('开关关闭（redactToolContent:false）：原文落盘（白名单/第三方适配路径逃生口）', async () => {
    const dir = createTmpDir();
    try {
      const store = new JsonlFileAdapter({ dir, redactToolContent: false });
      await store.create('s1');
      await store.append('s1', event('tool', { toolCallId: 'c1', content: `K=${OPENAI_KEY}` }));
      const disk = readFileSync(join(dir, 's1.jsonl'), 'utf8');
      expect(disk).toContain(OPENAI_KEY);
    } finally {
      cleanupTmpDirs();
    }
  });
});
