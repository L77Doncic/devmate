/**
 * format.js 单测：截断/计数/金额/耗时/参数美化/状态标签。
 */
import { describe, expect, it } from 'vitest';
import {
  truncate,
  toolResultPreview,
  formatTokens,
  formatCostUsd,
  formatDurationMs,
  formatArguments,
  shortId,
  runStatusLine,
  statusLabel,
  statusTone,
  formatTime,
  argSummary,
  errorSummary,
  toolSummaryLine,
  compactionLine,
  compactionSummary,
  composerStatsLine,
  elapsedText,
  RUN_STATUS_SEMANTICS,
  TERMINAL_STATUSES,
  RUN_STAGE_WORDS,
  CONN_VISIBLE,
  TOOL_STATE_LABEL,
} from '../../src/ui/web/format.js';

describe('truncate', () => {
  it('短于上限原样', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });
  it('超长截断加省略号', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
  });
  it('默认 300 上限', () => {
    const s = 'x'.repeat(400);
    const out = truncate(s);
    expect(out.length).toBe(301);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('toolResultPreview', () => {
  it('取内容预览并截断到 300 字符', () => {
    const preview = truncate('y'.repeat(900), 300);
    expect(toolResultPreview({ ok: true, preview: 'y'.repeat(900), error: 'never' })).toBe(preview);
  });
  it('失败时优先 error 文案', () => {
    expect(toolResultPreview({ ok: false, preview: 'p', error: 'boom' })).toBe('boom');
  });
  it('无结果返回空', () => {
    expect(toolResultPreview(null)).toBe('');
  });
});

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [500, '500'],
    [1500, '1.5k'],
    [12345, '12.3k'],
    [1200, '1.2k'],
    [1000, '1k'],
    [2_500_000, '2.5m'],
  ])('%d → %s', (n, expected) => {
    expect(formatTokens(n)).toBe(expected);
  });
  it('非法值返回破折号', () => {
    expect(formatTokens(Number.NaN)).toBe('–');
  });
});

describe('formatCostUsd', () => {
  it.each([
    [0, '$0'],
    [12.3, '$12.30'],
    [0.5, '$0.5'],
    [0.00012, '$1.2e-04'],
    [120, '$120'],
  ])('%s → %s', (n, expected) => {
    expect(formatCostUsd(n)).toBe(expected);
  });
  it('非法值', () => {
    expect(formatCostUsd(-1)).toBe('–');
  });
});

describe('formatDurationMs', () => {
  it.each([
    [35, '35ms'],
    [2100, '2.1s'],
    [9200, '9.2s'],
    [15000, '15s'],
    [65_500, '1m 06s'], // 65.5s 四舍五入到秒
    [3_660_000, '1h 01m'],
  ])('%dms → %s', (n, expected) => {
    expect(formatDurationMs(n)).toBe(expected);
  });
});

describe('formatArguments', () => {
  it('JSON 美化', () => {
    const out = formatArguments('{"a":1,"b":[1,2]}');
    expect(out).toContain('\n');
    expect(out).toContain('"b": [');
  });
  it('非 JSON 原样', () => {
    expect(formatArguments('rm -rf /x')).toBe('rm -rf /x');
  });
  it('空 → 占位', () => {
    expect(formatArguments('')).toBe('(无参数)');
  });
});

describe('shortId', () => {
  it('取前 6 位', () => {
    expect(shortId('abc123def456')).toBe('abc123');
  });
});

describe('终态单一权威源（RUN_STATUS_SEMANTICS）—— 防三处镜像漂移', () => {
  it('TERMINAL_STATUSES = 表键集合，且恰为 8 项（S12 RunStatus 八值）', () => {
    expect(Object.keys(RUN_STATUS_SEMANTICS)).toEqual([...TERMINAL_STATUSES]);
    expect(TERMINAL_STATUSES).toHaveLength(8);
    expect(TERMINAL_STATUSES).not.toContain('running'); // running 是非终态，不得入表
  });

  it('每一项都有用户标签与合法 tone（ok/stop/err）—— 状态节拍与展示永不缺项', () => {
    const entries: Array<[string, { label: string; tone: string }]> =
      Object.entries(RUN_STATUS_SEMANTICS);
    for (const [status, sem] of entries) {
      expect(sem.label).toBeTypeOf('string');
      expect(sem.label.length).toBeGreaterThan(0);
      expect(['ok', 'stop', 'err']).toContain(sem.tone);
      expect(TERMINAL_STATUSES).toContain(status);
    }
  });

  it('statusTone 与表镜像：completed 绿 / 熔断与致命红 / 预算类琥珀；未知灰色兜底', () => {
    expect(statusTone('completed')).toBe('ok');
    expect(statusTone('circuit-break')).toBe('err');
    expect(statusTone('fatal')).toBe('err');
    expect(statusTone('cost-guard')).toBe('stop');
    expect(statusTone('wall-time')).toBe('stop');
    expect(statusTone('unknown-future-state')).toBe('unknown');
    expect(statusTone(undefined)).toBe('unknown');
  });
});

describe('RUN_STAGE_WORDS（运行阶段词单一权威源）—— 连接态/阶段词共享来源防漂移', () => {
  it('三段词齐全且值正确（generating/tool/approval）', () => {
    expect(RUN_STAGE_WORDS).toEqual({
      generating: '生成中',
      tool: '工具执行中',
      approval: '待审批',
    });
  });

  it('连接态 busy/warn 与阶段词共享同一来源 —— 同词改动只改一处（app.js 两处引用防漂移）', () => {
    expect(CONN_VISIBLE.busy).toBe(RUN_STAGE_WORDS.generating);
    expect(CONN_VISIBLE.warn).toBe(RUN_STAGE_WORDS.approval);
  });

  it('连接态 6 语义齐全（app.js 直接索引、无兜底所需）：off 在表内 + 全部非空', () => {
    expect(Object.keys(CONN_VISIBLE)).toEqual(['ok', 'busy', 'warn', 'err', 'config', 'off']);
    for (const v of Object.values(CONN_VISIBLE)) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('「待审批」三处同词：阶段词 approval = 连接态 warn = 工具卡 pending（术语统一）', () => {
    expect(TOOL_STATE_LABEL.pending).toBe(RUN_STAGE_WORDS.approval);
    expect(CONN_VISIBLE.warn).toBe(RUN_STAGE_WORDS.approval);
  });
});

describe('TOOL_STATE_LABEL 与 RUN_STATUS_SEMANTICS —— 双表互斥（同词纯属中文巧合）', () => {
  it('工具卡 7 态全部有独立标签（messages.js 状态机产出面）', () => {
    expect(Object.keys(TOOL_STATE_LABEL)).toEqual([
      'running',
      'success',
      'failed',
      'pending',
      'done-waiting-result',
      'denied',
      'interrupted',
    ]);
  });

  it('双表对象独立（非同一来源）；同词（已完成/已中断）各自语义、各自解析', () => {
    expect(TOOL_STATE_LABEL).not.toBe(RUN_STATUS_SEMANTICS);
    // 工具卡 = 单次工具执行结果；run-status = 整体 run 终态 —— 语义不同，改词会破坏工具卡语境
    expect(TOOL_STATE_LABEL.success).toBe('已完成');
    expect(RUN_STATUS_SEMANTICS.completed.label).toBe('已完成');
    expect(TOOL_STATE_LABEL.interrupted).toBe('已中断');
    expect(RUN_STATUS_SEMANTICS['user-interrupted'].label).toBe('已中断');
  });

  it('互斥完整性：工具卡状态名不与 run 终态名混用；工具卡无「终态」概念入终态表', () => {
    const runStates = new Set(Object.keys(RUN_STATUS_SEMANTICS));
    for (const t of Object.keys(TOOL_STATE_LABEL)) {
      expect(runStates.has(t)).toBe(false);
    }
  });
});

describe('statusLabel / runStatusLine', () => {
  it('8 个终态全部映射中文（S12 RunStatus 权威值）', () => {
    expect(statusLabel('completed')).toBe('已完成');
    expect(statusLabel('cost-guard')).toBe('成本护栏停机');
    expect(statusLabel('max-steps')).toBe('步数上限停机');
    expect(statusLabel('wall-time')).toBe('墙钟超时');
    expect(statusLabel('circuit-break')).toBe('熔断停机');
    expect(statusLabel('compaction-debounce')).toBe('压缩不收敛停机');
    expect(statusLabel('user-interrupted')).toBe('已中断');
    expect(statusLabel('fatal')).toBe('内部错误');
  });
  it('未知状态原样透传（协议演进可读；tone 走灰）', () => {
    expect(statusLabel('waiting_review')).toBe('waiting_review');
  });
  it('摘要行组合', () => {
    expect(runStatusLine({ status: 'completed', steps: 3, durationMs: 2500 })).toBe(
      '已完成 · 3 步 · 2.5s',
    );
    expect(runStatusLine({ status: 'completed', steps: null, durationMs: null })).toBe('已完成');
    expect(runStatusLine({ status: 'user-interrupted', steps: 2, durationMs: 1500 })).toBe(
      '已中断 · 2 步 · 1.5s',
    );
    expect(runStatusLine({})).toBe('');
  });
});

describe('formatTime', () => {
  it('时间戳格式 HH:MM', () => {
    const d = new Date(2026, 7, 27, 21, 5, 0);
    expect(formatTime(d.getTime())).toBe('21:05');
  });
});

describe('argSummary（工具行参数摘要：单行压平 + 截断）', () => {
  it('JSON 压平为单行', () => {
    expect(argSummary('{"path":"a.txt","recursive":true}')).toBe(
      '{"path":"a.txt","recursive":true}',
    );
  });
  it('非 JSON 压空白', () => {
    expect(argSummary('ls\n  -la  /tmp')).toBe('ls -la /tmp');
  });
  it('截断默认 60 字符，超长补 …', () => {
    const out = argSummary(`{"content":"${'x'.repeat(100)}"}`);
    expect(out.length).toBe(61);
    expect(out.endsWith('…')).toBe(true);
  });
  it('空/空白返回空串', () => {
    expect(argSummary('')).toBe('');
    expect(argSummary('   ')).toBe('');
    expect(argSummary(null as unknown as string)).toBe('');
  });
});

describe('errorSummary（失败压平：`error.type: message` 哲学的中文等价）', () => {
  it('已是「类型: 消息」形态原样保留（TypeError: x 即压平终态）', () => {
    expect(errorSummary('TypeError: cannot read x of undefined')).toBe(
      'TypeError: cannot read x of undefined',
    );
  });
  it('无类型前缀补「错误：」', () => {
    expect(errorSummary('command not found')).toBe('错误：command not found');
  });
  it('截断 80 字符', () => {
    const out = errorSummary('v'.repeat(100));
    expect(out).toBe(`错误：${'v'.repeat(77)}…`);
  });
  it('空值返回空串', () => {
    expect(errorSummary('')).toBe('');
    expect(errorSummary(null as unknown as string)).toBe('');
  });
});

describe('toolSummaryLine（工具摘要首行：成功=preview 首行；失败=压平形态）', () => {
  it('成功取 preview 首行', () => {
    expect(toolSummaryLine({ ok: true, preview: 'line1\nline2', error: null })).toBe('line1');
  });
  it('失败走 errorSummary', () => {
    expect(toolSummaryLine({ ok: false, preview: 'p', error: 'boom' })).toBe('错误：boom');
    expect(toolSummaryLine({ ok: false, preview: '', error: null })).toBe('');
  });
  it('空 result / 空 preview 返回空串', () => {
    expect(toolSummaryLine(null)).toBe('');
    expect(toolSummaryLine({ ok: true, preview: '', error: null })).toBe('');
  });
  it('首行超 80 截断', () => {
    const out = toolSummaryLine({ ok: true, preview: 'x'.repeat(90), error: null });
    expect(out.length).toBe(81);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('compactionLine（上下文压缩披露折叠记首行）', () => {
  it('有 token 值（约 N → M tokens）', () => {
    expect(compactionLine({ tokensBefore: 120_000, tokensAfter: 45_000 })).toBe(
      '上下文已压缩（约 120k → 45k tokens）',
    );
  });
  it('缺 token 值简化为「上下文已压缩」', () => {
    expect(compactionLine({})).toBe('上下文已压缩');
    expect(compactionLine({ tokensBefore: null, tokensAfter: null })).toBe('上下文已压缩');
    expect(compactionLine({ summary: 's' })).toBe('上下文已压缩');
  });
});

describe('elapsedText（运行中墙钟耗时展示）', () => {
  it('开始至今的时长', () => {
    expect(elapsedText(1000, 1250)).toBe('250ms');
  });
  it('缺失/非法/未到返回空串', () => {
    expect(elapsedText(null as unknown as number)).toBe('');
    expect(elapsedText(undefined as unknown as number)).toBe('');
    expect(elapsedText(Number.NaN)).toBe('');
    expect(elapsedText(2000, 1000)).toBe(''); // now < startedAt：尚未开始
  });
});

describe('composerStatsLine（composer 输入卡 footer 用量统计行：步骤 · 耗时 · 入/出/总 · ≈成本）', () => {
  it('全量组合：步骤数 · 耗时 · 入/出/总 tokens · ≈成本（estimated 标 ≈）', () => {
    expect(
      composerStatsLine(
        { status: 'completed', steps: 3, durationMs: 2500 },
        {
          promptTokens: 1200,
          completionTokens: 340,
          totalTokens: 1540,
          costUsd: 0.0012,
          estimated: true,
        },
      ),
    ).toBe('3 步 | 2.5s | 入 1.2k · 出 340 · 总 1.5k | ≈$0.0012');
  });
  it('estimated=false 不标 ≈；0 值也显示（沿用五项全显）', () => {
    expect(
      composerStatsLine(
        { status: 'completed', steps: 0, durationMs: 0 },
        {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          estimated: false,
        },
      ),
    ).toBe('0 步 | 0ms | 入 0 · 出 0 · 总 0 | $0');
  });
  it('无 runStatus（usage 单独到达）：仍显示 token/成本段（单组无竖杠）', () => {
    expect(
      composerStatsLine(null, {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        costUsd: 0.0001,
        estimated: true,
      }),
    ).toBe('入 100 · 出 50 · 总 150 | ≈$1.0e-04');
  });
  it('运行中帧（steps/durationMs 缺省）：省略步骤与耗时；成本缺失不输出成本段', () => {
    expect(
      composerStatsLine(
        { status: 'running', steps: null, durationMs: null },
        { promptTokens: 1, completionTokens: 2, totalTokens: 3, costUsd: null, estimated: false },
      ),
    ).toBe('入 1 · 出 2 · 总 3');
  });
  it('无值 → 空串（UI 隐藏该行；暂停/不存在时不显示假值）', () => {
    expect(composerStatsLine(null, null)).toBe('');
    expect(composerStatsLine({ status: 'running', steps: null, durationMs: null }, null)).toBe('');
  });
});

describe('compactionSummary（披露摘要全文安全护栏：超 20k 截断并注明「…（截断）」）', () => {
  it('≤20k 原样返回', () => {
    const s = 'x'.repeat(20_000);
    expect(compactionSummary(s)).toBe(s);
  });
  it('>20k 截断到 20k 并附「…（截断）」', () => {
    const out = compactionSummary('y'.repeat(20_001));
    expect(out.slice(0, 20_000)).toBe('y'.repeat(20_000));
    expect(out.slice(20_000)).toBe('…（截断）');
  });
  it('空/缺省 → 空串', () => {
    expect(compactionSummary('')).toBe('');
    expect(compactionSummary(null as unknown as string)).toBe('');
  });
  it('自定义上限（护栏可调）', () => {
    expect(compactionSummary('abcdef', 3)).toBe('abc…（截断）');
  });
});
