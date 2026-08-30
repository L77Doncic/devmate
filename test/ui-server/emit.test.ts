/**
 * # test/ui-server/emit：SSE 序列化纯函数（接缝 S12；权威协议逐字核对点）
 *
 * CTO 协议：每帧 `event: <name>` + `data: <JSON>` + 空行；心跳为注释行 `: ping`。
 * 本测试钉住序列化字符串本身（前端按协议逐字解析，服务端只允许这一个序列化点）。
 */
import { describe, expect, it } from 'vitest';
import { pingFrame, serializeEvent, type SseEventData } from '../../src/ui/server/emit.js';

describe('ui/server/emit：SSE 序列化（纯函数）', () => {
  it('session-user 帧逐字序列化（event 行 + data JSON 行 + 空行）', () => {
    const frame: SseEventData = { event: 'session-user', data: { text: 'hello' } };
    expect(serializeEvent(frame)).toBe('event: session-user\ndata: {"text":"hello"}\n\n');
  });

  it('assistant-done 的 toolCalls 保序保字段（arguments 保持原字符串）', () => {
    const frame: SseEventData = {
      event: 'assistant-done',
      data: { content: 'hi', toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"x"}' }] },
    };
    expect(serializeEvent(frame)).toBe(
      'event: assistant-done\n' +
        'data: {"content":"hi","toolCalls":[{"id":"c1","name":"echo",' +
        '"arguments":"{\\"text\\":\\"x\\"}"}]}\n\n',
    );
  });

  it('data 恒为单行 JSON（字符串内换行被转义，不破坏帧边界）', () => {
    const frame: SseEventData = { event: 'run-error', data: { message: 'a\nb' } };
    const text = serializeEvent(frame);
    expect(text.match(/\n\n/g)).toHaveLength(1); // 恰好一个帧边界，未被数据内的换行撕开
    expect(text).toContain('"message":"a\\nb"');
  });

  it('pingFrame 恒为注释行', () => {
    expect(pingFrame()).toBe(': ping\n\n');
  });

  it('协议事件名单完整（11 类）且字段形状全量通过序列化', () => {
    const frames: SseEventData[] = [
      { event: 'session-user', data: { text: '' } },
      { event: 'assistant-delta', data: { text: '' } },
      { event: 'reasoning', data: { text: '' } },
      { event: 'assistant-done', data: { content: '', toolCalls: [] } },
      { event: 'tool-start', data: { id: 'a', name: 'echo', arguments: '{}' } },
      {
        event: 'tool-result',
        data: { id: 'a', name: 'echo', ok: true, contentPreview: '', content: '' },
      },
      { event: 'approval-request', data: { toolCallId: 'a', name: 'echo', arguments: '{}' } },
      {
        event: 'usage',
        data: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          estimated: false,
        },
      },
      { event: 'run-status', data: { status: 'completed', steps: 1, durationMs: 0 } },
      { event: 'run-error', data: { message: '' } },
      { event: 'compaction', data: { summary: '' } },
      {
        event: 'compaction',
        data: { summary: 's', tokensBefore: 1, tokensAfter: 2 },
      },
    ];
    for (const frame of frames) {
      const text = serializeEvent(frame);
      expect(text.startsWith(`event: ${frame.event}\ndata: `)).toBe(true);
      expect(text.endsWith('\n\n')).toBe(true);
    }
  });

  it('reasoning 帧逐字序列化：delta text（含换行）为单行 JSON，不破坏帧边界', () => {
    expect(serializeEvent({ event: 'reasoning', data: { text: 'im' } })).toBe(
      'event: reasoning\ndata: {"text":"im"}\n\n',
    );
    const frame: SseEventData = { event: 'reasoning', data: { text: 'a\nb' } };
    const text = serializeEvent(frame);
    expect(text.match(/\n\n/g)).toHaveLength(1);
    expect(text).toContain('"text":"a\\nb"');
  });

  it('compaction 帧逐字序列化：缺省 token 键不带入 JSON，data 单行', () => {
    expect(serializeEvent({ event: 'compaction', data: { summary: 's\ne' } })).toBe(
      'event: compaction\ndata: {"summary":"s\\ne"}\n\n',
    );
    expect(
      serializeEvent({
        event: 'compaction',
        data: { summary: 's', tokensBefore: 100, tokensAfter: 50 },
      }),
    ).toBe('event: compaction\ndata: {"summary":"s","tokensBefore":100,"tokensAfter":50}\n\n');
  });

  it('tool-result 的全量 content（含换行）序列化为单行 JSON，不破坏帧边界', () => {
    const frame: SseEventData = {
      event: 'tool-result',
      data: { id: 't', name: 'bash', ok: true, contentPreview: 'a\nb', content: 'a\nb\nc' },
    };
    const text = serializeEvent(frame);
    expect(text.match(/\n\n/g)).toHaveLength(1);
    expect(text).toContain('"content":"a\\nb\\nc"');
    expect(text).toContain('"contentPreview":"a\\nb"');
  });
});

describe('ui/server/emit：session-user 图像帧（ADR-0015）', () => {
  it('带 images 帧逐字序列化（dataURL 含 base64 转义后仍是单行 JSON）', () => {
    const frame: SseEventData = {
      event: 'session-user',
      data: {
        text: '看图',
        images: [{ url: 'data:image/png;base64,AA==', width: 800, height: 600 }],
      },
    };
    const text = serializeEvent(frame);
    expect(text).toBe(
      'event: session-user\n' +
        'data: {"text":"看图","images":[{"url":"data:image/png;base64,AA==",' +
        '"width":800,"height":600}]}\n\n',
    );
    expect(text.match(/\n\n/g)).toHaveLength(1); // frames 边界不被 base64 内的字符撕开
  });

  it('无 images 恒不带键（旧协议 zero 扰动——逐字形状钉点）', () => {
    const frame: SseEventData = { event: 'session-user', data: { text: 'hi' } };
    expect(serializeEvent(frame)).toBe('event: session-user\ndata: {"text":"hi"}\n\n');
  });
});
