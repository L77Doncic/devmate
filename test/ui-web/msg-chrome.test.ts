/**
 * Wave 2 消息区保真——纯逻辑测试：
 * 消息行 meta（时钟分日模板/复制计时常量/Ran-for caption）、思考折叠行（摘要选取
 * = 定稿首行 / 流式末行；全文护栏）、ToolRow 变体（classify/variant 标题/摘要变体选择/
 * DiffBlock 红绿行/SearchBlock 命中行/ReadBlock 截断）。
 * DOM 折叠态/复制对勾/hover 显现由 CDP 截图验证（deliverables/w2-*）。
 */
import { describe, expect, it } from 'vitest';
import {
  formatMessageClock,
  ranForCaption,
  CLIPBOARD_FEEDBACK_MS,
  messageCopyText,
  thinkSummary,
  thinkBodyText,
  THINK_TEXT_CAP,
  classifyTool,
  TOOL_VARIANT_TITLES,
  parseToolArguments,
  toolSummaryArgs,
  buildDiffLines,
  buildReadBlock,
  buildSearchLines,
  BLOCK_MAX_CHARS,
} from '../../src/ui/web/format.js';

const NOON = new Date(2026, 7, 29, 12, 0).getTime(); // 2026-08-29 12:00

describe('formatMessageClock（dsh 分日模板）', () => {
  it('同日 → HH:mm', () => {
    expect(formatMessageClock(new Date(2026, 7, 29, 21, 5).getTime(), NOON)).toBe('21:05');
  });
  it('今年内（非同日）→ M月d日 HH:mm', () => {
    expect(formatMessageClock(new Date(2026, 7, 28, 9, 41).getTime(), NOON)).toBe('8月28日 09:41');
  });
  it('跨年 → yyyy/M/d HH:mm', () => {
    expect(formatMessageClock(new Date(2025, 11, 31, 23, 59).getTime(), NOON)).toBe(
      '2025/12/31 23:59',
    );
  });
  it('缺失/非法 → 空串（不显示假值）', () => {
    expect(formatMessageClock(null, NOON)).toBe('');
    expect(formatMessageClock(NaN, NOON)).toBe('');
  });
});

describe('ranForCaption / 复制计时（icon-actions 纯逻辑）', () => {
  it('· Ran for 15s（≥10 取整；<10 一位小数）', () => {
    expect(ranForCaption(15_000)).toBe('· Ran for 15s');
    expect(ranForCaption(1200)).toBe('· Ran for 1.2s');
  });
  it('非法/负值 → 空串（行尾不追加）', () => {
    expect(ranForCaption(null)).toBe('');
    expect(ranForCaption(-5)).toBe('');
  });
  it('复制反馈时长 = 1000ms（dsh 对勾 1s 同值）', () => {
    expect(CLIPBOARD_FEEDBACK_MS).toBe(1000);
  });
  it('复制载荷 = 正文纯文本（user/assistant 均抄正文；非消息物件 → 空串）', () => {
    expect(messageCopyText({ kind: 'user', text: '你好' })).toBe('你好');
    expect(messageCopyText({ kind: 'assistant', text: '回答' })).toBe('回答');
    expect(messageCopyText(null)).toBe('');
    expect(messageCopyText({ kind: 'system', text: 'x' })).toBe('x');
  });
});

describe('thinkSummary（思考折叠行摘要：定稿首行 / 运行中末行）', () => {
  it('定稿 → 第一行；运行中 → 最新一行', () => {
    const r = '先看文件结构\n再决定修改方案';
    expect(thinkSummary(r, true)).toBe('先看文件结构');
    expect(thinkSummary(r, false)).toBe('再决定修改方案');
  });
  it('空/全空白 → 空串（行不显示）；超 120 截断', () => {
    expect(thinkSummary('', true)).toBe('');
    expect(thinkSummary('   \n ', false)).toBe('');
    expect(thinkSummary('x'.repeat(200), true).endsWith('…')).toBe(true);
  });
  it('全文护栏：≤ THINK_TEXT_CAP 原样；超出截断 + 「…（截断）」', () => {
    expect(thinkBodyText('短')).toBe('短');
    const big = 'y'.repeat(THINK_TEXT_CAP + 10);
    expect(thinkBodyText(big)).toBe('y'.repeat(THINK_TEXT_CAP) + '…（截断）');
  });
});

describe('classifyTool（ToolRow 变体选择）', () => {
  it('run_command→bash；read/list_dir→read；write_file→write；edit_file→edit；grep/glob→search', () => {
    expect(classifyTool('run_command')).toBe('bash');
    expect(classifyTool('read_file')).toBe('read');
    expect(classifyTool('list_dir')).toBe('read');
    expect(classifyTool('write_file')).toBe('write');
    expect(classifyTool('edit_file')).toBe('edit');
    expect(classifyTool('grep')).toBe('search');
    expect(classifyTool('glob')).toBe('search');
    expect(classifyTool('skill')).toBe('generic');
    expect(classifyTool('mcp__search')).toBe('generic');
    expect(classifyTool('')).toBe('generic');
  });
  it('变体标题表覆盖全部六类', () => {
    for (const v of Object.keys(TOOL_VARIANT_TITLES) as Array<keyof typeof TOOL_VARIANT_TITLES>) {
      expect(TOOL_VARIANT_TITLES[v]).toBeTruthy();
    }
    expect(TOOL_VARIANT_TITLES.bash).toBe('运行命令');
  });
});

describe('toolSummaryArgs（ToolRow 摘要变体选择）', () => {
  it('bash：args.description 优先；缺失 → command 首 60', () => {
    const args = JSON.stringify({
      command: 'ls -la src/',
      description: 'List the source directory',
    });
    expect(toolSummaryArgs(args, 'bash')).toBe('List the source directory');
    expect(toolSummaryArgs('{"command":"ls -la src/"}', 'bash')).toBe('ls -la src/');
  });
  it('command 过长截断 60', () => {
    const args = JSON.stringify({ command: 'a'.repeat(80) });
    expect(toolSummaryArgs(args, 'bash')).toBe('a'.repeat(60) + '…');
  });
  it('文件变体 → 路径；search → pattern；generic 回落压平', () => {
    expect(toolSummaryArgs('{"path":"src/utils.ts"}', 'edit')).toBe('src/utils.ts');
    expect(toolSummaryArgs('{"path":"/w/a/b.txt"}', 'read')).toBe('/w/a/b.txt');
    expect(toolSummaryArgs('{"pattern":"TODO"}', 'search')).toBe('TODO');
    expect(toolSummaryArgs('{"path":"x","content":"y"}', 'generic')).toBe(
      '{"path":"x","content":"y"}',
    );
  });
  it('非 JSON 参数 → 原样压平截断（防御）', () => {
    expect(toolSummaryArgs('not json', 'bash')).toBe('not json');
  });
  it('parseToolArguments：对象解析/非对象 null', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments('[1,2]')).toBeNull();
    expect(parseToolArguments('')).toBeNull();
    expect(parseToolArguments('oops')).toBeNull();
  });
});

describe('buildDiffLines（DiffBlock：红-删 / 绿+加 两色 mono）', () => {
  it('edit_file：search → del 行，replace → add 行（保持换行拆分）', () => {
    const { lines, removed, added } = buildDiffLines(
      JSON.stringify({ path: 'a.ts', search: '旧行一\n旧行二', replace: '新行一\n新行二' }),
    );
    expect(lines).toEqual([
      { type: 'del', text: '旧行一' },
      { type: 'del', text: '旧行二' },
      { type: 'add', text: '新行一' },
      { type: 'add', text: '新行二' },
    ]);
    expect(removed).toBe(2);
    expect(added).toBe(2);
  });
  it('edit_file：空 replace = 纯删除（零 add 行）', () => {
    const { lines, added, removed } = buildDiffLines(
      JSON.stringify({ path: 'a.ts', search: '删除我', replace: '' }),
    );
    expect(lines).toEqual([{ type: 'del', text: '删除我' }]);
    expect(added).toBe(0);
    expect(removed).toBe(1);
  });
  it('write_file：content 全部 → add 行（绿）', () => {
    const { lines } = buildDiffLines(JSON.stringify({ path: 'new.ts', content: 'a\nb' }));
    expect(lines).toEqual([
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });
  it('区块上限：超 BLOCK_MAX_CHARS 截断 + note 注记行', () => {
    const { lines, truncated } = buildDiffLines(
      JSON.stringify({ path: 'a.ts', search: 'x'.repeat(BLOCK_MAX_CHARS + 100), replace: 'y' }),
    );
    expect(truncated).toBe(true);
    expect(lines[lines.length - 1]).toEqual({ type: 'note', text: '…（截断）' });
  });
  it('非对象参数 → 空行集（折叠态无正文）', () => {
    expect(buildDiffLines('nope').lines).toEqual([]);
  });
});

describe('buildReadBlock / buildSearchLines（ReadBlock / SearchBlock）', () => {
  it('ReadBlock：≤ 2000 原样；超出截断 + 注记行', () => {
    expect(buildReadBlock('abc').text).toBe('abc');
    const big = 'z'.repeat(BLOCK_MAX_CHARS + 5);
    const r = buildReadBlock(big);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('z'.repeat(BLOCK_MAX_CHARS))).toBe(true);
    expect(r.text.endsWith('\n…（截断）')).toBe(true);
  });
  it('SearchBlock：命中行（大小写不敏感含 pattern）hit；未命中/分组行不标记', () => {
    const content = 'src/util.ts:3:export function todo()\n--\nsrc/util.ts:4:safe';
    const { lines, hits } = buildSearchLines(content, 'todo');
    expect(hits).toBe(1);
    expect(lines.find((l) => l.hit)?.text).toBe('src/util.ts:3:export function todo()');
    expect(lines.filter((l) => !l.hit).length).toBe(2);
  });
  it('SearchBlock：cap 截断 + note；空 pattern 零命中（glob 结果无高亮）', () => {
    expect(buildSearchLines('x'.repeat(BLOCK_MAX_CHARS + 5), 'x').truncated).toBe(true);
    expect(buildSearchLines('a\nb', '').hits).toBe(0);
  });
});
