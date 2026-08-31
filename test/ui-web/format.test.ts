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
  COMPOSER_STATS_EMPTY_LINE,
  COMPOSER_STATS_EMPTY_TITLE,
  elapsedText,
  RUN_STATUS_SEMANTICS,
  TERMINAL_STATUSES,
  RUN_STAGE_WORDS,
  CONN_VISIBLE,
  CONN_HINTS,
  TOOL_STATE_LABEL,
  methodologyLine,
  methodologyBadgeText,
  REVIEW_BLOCK_TITLE,
  isReviewSubagent,
  reviewBlockText,
  friendlySubagentError,
  friendlyImageError,
  friendlyProviderError,
  reviewSkippedHint,
  REVIEW_SKIPPED_HINT,
  TOAST_COPY_TITLE,
  TOAST_COPIED_TEXT,
  continueVisible,
  classifyTool,
  TOOL_VARIANT_TITLES,
  toolSummaryArgs,
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

describe('continueVisible（run-strip「继续」钮裁决——仅 user-interrupted 可续跑）', () => {
  it('user-interrupted 终态 + 有会话 + 非运行 + 无错误 → 显示', () => {
    expect(
      continueVisible({ status: 'user-interrupted' }, { runActive: false, hasSession: true }),
    ).toBe(true);
  });
  it('仅 user-interrupted 显示；completed/cost-guard/max-steps/wall-time 均不显示', () => {
    for (const status of ['completed', 'cost-guard', 'max-steps', 'wall-time', 'fatal']) {
      expect(continueVisible({ status }, { runActive: false, hasSession: true })).toBe(false);
    }
  });
  it('无会话 / 运行中 / 有错误 → 隐藏', () => {
    const base = { runActive: false, hasSession: true };
    expect(continueVisible({ status: 'user-interrupted' }, { ...base, hasSession: false })).toBe(
      false,
    );
    expect(continueVisible({ status: 'user-interrupted' }, { ...base, runActive: true })).toBe(
      false,
    );
    expect(continueVisible({ status: 'user-interrupted' }, { ...base, lastError: 'boom' })).toBe(
      false,
    );
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
    ).toBe('3 步 | 2.5s | 入 1.2k tokens · 出 340 tokens · 总 1.5k tokens | ≈$0.0012');
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
    ).toBe('0 步 | 0ms | 入 0 tokens · 出 0 tokens · 总 0 tokens | $0');
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
    ).toBe('入 100 tokens · 出 50 tokens · 总 150 tokens | ≈$1.0e-04');
  });
  it('运行中帧（steps/durationMs 缺省）：省略步骤与耗时；成本缺失不输出成本段', () => {
    expect(
      composerStatsLine(
        { status: 'running', steps: null, durationMs: null },
        { promptTokens: 1, completionTokens: 2, totalTokens: 3, costUsd: null, estimated: false },
      ),
    ).toBe('入 1 tokens · 出 2 tokens · 总 3 tokens');
  });
  it('空态（runStatus/usage 均无值）→ 诚实零值行：0 值为真，不整行隐藏', () => {
    expect(composerStatsLine(null, null)).toBe(COMPOSER_STATS_EMPTY_LINE);
    expect(composerStatsLine({ status: 'running', steps: null, durationMs: null }, null)).toBe(
      COMPOSER_STATS_EMPTY_LINE,
    );
    expect(composerStatsLine(null, null)).toBe(
      '0 步 | 0ms | 入 0 tokens · 出 0 tokens · 总 0 tokens | $0',
    );
    expect(COMPOSER_STATS_EMPTY_TITLE).toBe('尚未运行：暂无实际数据，运行后更新');
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

// ---------------------------------------------------------------------------
// R2-S1：方法论线提取（模型首条回复行首 `方法线：<skillId>`；run-strip 小牌数据源）
// ---------------------------------------------------------------------------

describe('methodologyLine（方法论线提取：行首锚定 /m、中英文冒号、流式校正）', () => {
  it('命中（中文冒号、首行、无空格）', () => {
    expect(methodologyLine('方法线：tdd')).toBe('tdd');
  });

  it('命中（英文冒号 + 空格）', () => {
    expect(methodologyLine('方法线: tdd')).toBe('tdd');
  });

  it('命中（首行带贴线正文：正文在换行之后）', () => {
    expect(methodologyLine('方法线：tdd\n我先复现这个 bug……')).toBe('tdd');
  });

  it('多行：方法线不在首行（模型排版漂移宽容 —— /m 任意行首命中）', () => {
    expect(methodologyLine('我先看一下……\n方法线：tdd\n好的，开始。')).toBe('tdd');
  });

  it('首行非首：首行只是普通文字，方法线出现在后行仍命中', () => {
    expect(methodologyLine('好的\n方法线：tdd\n开始')).toBe('tdd');
  });

  it('无命中：正文不含方法线', () => {
    expect(methodologyLine('好的，我来处理这个 bug。')).toBeNull();
  });

  it('正文中段出现「方法线：」但不处于行首 → 不命中（行首锚定）', () => {
    expect(methodologyLine('参考 方法线：tdd 的做法')).toBeNull();
    expect(methodologyLine('x方法线：tdd')).toBeNull();
  });

  it('流式半截校正：增量提取值随 delta 从半截校正到全量', () => {
    expect(methodologyLine('方法线：t')).toBe('t');
    expect(methodologyLine('方法线：td')).toBe('td');
    expect(methodologyLine('方法线：tdd')).toBe('tdd');
  });

  it('多命中取首个（行程顺序第一命中行）', () => {
    expect(methodologyLine('方法线：tdd\n方法线：random')).toBe('tdd');
  });

  it('id 字符集：字母数字下划线连字符', () => {
    expect(methodologyLine('方法线：mattpocock-skills:tdd')).toBe('mattpocock-skills');
    expect(methodologyLine('方法线：tdd_v2')).toBe('tdd_v2');
  });

  it('CRLF 行尾宽容；行首空白不宽容（^ 锚定：前导空白把「方法线」推出行首 → 不命中）', () => {
    expect(methodologyLine('你好\r\n方法线：tdd\r\n继续')).toBe('tdd');
    expect(methodologyLine('\t方法线：tdd')).toBeNull();
    expect(methodologyLine('\n方法线：tdd')).toBe('tdd'); // 空首行后的下一行仍行首命中
  });

  it('空/非法输入 → null（不抛）', () => {
    expect(methodologyLine('')).toBeNull();
    expect(methodologyLine(null)).toBeNull();
    expect(methodologyLine(undefined)).toBeNull();
    expect(methodologyLine(42)).toBeNull();
  });
});

describe('methodologyBadgeText（方法线小牌文本「方法线 tdd」单一来源）', () => {
  it('id 非空 → 「方法线 <id>」', () => {
    expect(methodologyBadgeText('tdd')).toBe('方法线 tdd');
  });
  it('缺失/空 → 空串（调用方仅在 methodLine 非空时渲染）', () => {
    expect(methodologyBadgeText('')).toBe('');
    expect(methodologyBadgeText(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 审查块判定与两行摘要（B：spawn_subagent + arguments.prompt 含 审查|review）
// ---------------------------------------------------------------------------

describe('isReviewSubagent（判据 = arguments.prompt 含 审查|review）', () => {
  const call = (name: string, argumentsJson: string) => ({ name, arguments: argumentsJson });

  it('spawn_subagent + prompt 含中文「审查」→ true', () => {
    const args = JSON.stringify({ prompt: '请用 subagent 独立审查以下文件（缺项清单）' });
    expect(isReviewSubagent(call('spawn_subagent', args))).toBe(true);
  });

  it('prompt 含英文 review（大小写不敏感）→ true', () => {
    expect(
      isReviewSubagent(call('spawn_subagent', JSON.stringify({ prompt: 'Do a REVIEW of src/' }))),
    ).toBe(true);
    expect(
      isReviewSubagent(call('spawn_subagent', JSON.stringify({ prompt: 'review this file' }))),
    ).toBe(true);
  });

  it('非 spawn_subagent 工具名（即使 prompt 含审查）→ false', () => {
    expect(isReviewSubagent(call('read_file', JSON.stringify({ prompt: '审查' })))).toBe(false);
    expect(
      isReviewSubagent({ name: undefined, arguments: JSON.stringify({ prompt: '审查' }) }),
    ).toBe(false);
  });

  it('prompt 不带 审查/review（即使用户文本提到）→ false', () => {
    expect(
      isReviewSubagent(call('spawn_subagent', JSON.stringify({ prompt: '重构这段代码' }))),
    ).toBe(false);
  });

  it('参数非 JSON / 无 prompt / 非对象 → false（防御不误判）', () => {
    expect(isReviewSubagent(call('spawn_subagent', '{not json'))).toBe(false);
    expect(isReviewSubagent(call('spawn_subagent', ''))).toBe(false);
    expect(isReviewSubagent(call('spawn_subagent', '[]'))).toBe(false);
    expect(isReviewSubagent(call('spawn_subagent', JSON.stringify({ title: '审查' })))).toBe(
      false, // 判据只认 prompt（任务书）：title 含审查不触发
    );
    expect(isReviewSubagent(null)).toBe(false);
    expect(isReviewSubagent(undefined)).toBe(false);
    expect(isReviewSubagent('x')).toBe(false);
  });
});

describe('reviewBlockText（副题 + 结论首行）', () => {
  const call = { name: 'spawn_subagent', arguments: JSON.stringify({ prompt: 'P'.repeat(80) }) };

  it('无 title → subject = prompt 首 40（压平换行）', () => {
    const t = reviewBlockText(call, null);
    expect(t.subject).toBe('P'.repeat(40) + '…');
  });

  it('有 title → subject 取 title（40 上限），prompt 只用兜底', () => {
    const t = reviewBlockText(
      { name: 'spawn_subagent', arguments: JSON.stringify({ title: '审查 /src（本轮总结页面）' }) },
      null,
    );
    expect(t.subject).toBe('审查 /src（本轮总结页面）');
    const long = reviewBlockText(
      { name: 'spawn_subagent', arguments: JSON.stringify({ title: 'T'.repeat(50) }) },
      null,
    );
    expect(long.subject).toBe('T'.repeat(40) + '…');
  });

  it('verdict = 报告首行（content → preview 兜底）取 60 字符；空结果 → 空串', () => {
    const firstLine = 'R'.repeat(80);
    const report = `${firstLine}\n详情……`;
    const result = { ok: true, content: report, preview: report };
    expect(reviewBlockText(call, result).verdict).toBe('R'.repeat(60) + '…');
    expect(
      reviewBlockText(call, { ok: true, content: null, preview: 'R'.repeat(40) }).verdict,
    ).toBe('R'.repeat(40));
    expect(reviewBlockText(call, null).verdict).toBe('');
    expect(reviewBlockText(call, { ok: true }).verdict).toBe('');
  });

  it('首行跳过空行（空白行不算首行）；REVIEW_BLOCK_TITLE 单一来源', () => {
    const t = reviewBlockText(call, { ok: true, content: '\n\n结论行\n后文' });
    expect(t.verdict).toBe('结论行');
    expect(REVIEW_BLOCK_TITLE).toBe('独立审查');
  });

  it('非对象/无 arguments → 全兜底（不抛）', () => {
    const t = reviewBlockText(null, { ok: true, content: 'x' });
    expect(t.subject).toBe('');
    expect(t.verdict).toBe('x');
  });
});

describe('toast 点击复制（clickable 选项）—— 文案/提示单一来源', () => {
  it('TOAST_COPY_TITLE / TOAST_COPIED_TEXT 常量（与 app.js 消费方同字面量）', () => {
    expect(TOAST_COPY_TITLE).toBe('点击复制完整会话 ID');
    expect(TOAST_COPIED_TEXT).toBe('已复制');
  });
  // 「恢复会话」toast 文案已随恢复静默移除（2026-08-30）——toast clickable 机制仍
  // 在（复制 ID 提示属该机制），其余场景复用；restoredToastText 无调用方即删除。
});

// ---------------------------------------------------------------------------
// P2-4：连接态悬停解释（CONN_HINTS = CONN_VISIBLE 同键集的下一动作一句话）
// ---------------------------------------------------------------------------

describe('CONN_HINTS（连接态悬停解释：键与 CONN_VISIBLE 同集、全非空）', () => {
  it('同键集（六态；app.js renderHeader 直接索引 CONN_HINTS[connState]）', () => {
    expect(Object.keys(CONN_HINTS).sort()).toEqual(Object.keys(CONN_VISIBLE).sort());
  });
  it('每态非空一句话（「待配置/未连接」第一次见有下一动作可循）', () => {
    for (const v of Object.values(CONN_HINTS)) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });
  it('config 提示指向设置→模型接口；off 提示先选工作区', () => {
    expect(CONN_HINTS.config).toContain('API Key');
    expect(CONN_HINTS.off).toContain('选择工作区');
  });
});

// ---------------------------------------------------------------------------
// P2-11：use_skill 卡语义化（变体 skill：标题「加载技能」+ 摘要 = id 一行）
// ---------------------------------------------------------------------------

describe('use_skill 卡片语义化（classifyTool / 标题 / 参数摘要）', () => {
  it('use_skill → 变体 skill（不再是 generic）', () => {
    expect(classifyTool('use_skill')).toBe('skill');
  });
  it('变体标题 = 加载技能', () => {
    expect(TOOL_VARIANT_TITLES.skill).toBe('加载技能');
  });
  it('参数摘要 = skill id 一行（不再是原始 JSON {"skill":"tdd"}）', () => {
    const args = JSON.stringify({ skill: 'tdd' });
    expect(toolSummaryArgs(args, classifyTool('use_skill'))).toBe('tdd');
    // 别名形态 id：
    expect(toolSummaryArgs(JSON.stringify({ id: 'research' }), 'skill')).toBe('research');
    // 非 JSON：原样压空白（兜底）
    expect(toolSummaryArgs('skill  tdd', 'skill')).toBe('skill tdd');
  });
});

// ---------------------------------------------------------------------------
// P2-9/P2-10：子代理失败 → 用户友好一行（审查块结论 / 工具卡失败判读共用）
// ---------------------------------------------------------------------------

describe('friendlySubagentError（子代理失败文案净化：无内部词、保留原义）', () => {
  it('认证被拒（governor / Authentication Fails）→ 中文一行', () => {
    const out = friendlySubagentError('sub-agent failed: Authentication Fails (governor)');
    expect(out).toContain('认证被拒');
    expect(out).not.toMatch(/governor|Authentication/);
  });
  it('subagents-disabled → 未启用指引', () => {
    const out = friendlySubagentError(
      'sub-agents are disabled in the workflow settings; enable them first',
    );
    expect(out).toContain('未启用');
  });
  it('网络不可用 → 网络一行', () => {
    expect(friendlySubagentError('fetch failed: ECONNREFUSED')).toContain('网络');
  });
  it('未知错误 → 压平原文（已是「类型: 消息」形态原样保留，零信息损失）', () => {
    expect(friendlySubagentError('boom: xyz')).toBe('boom: xyz');
  });
  it('审查块失败结论 = 友好一行（不再裸露 JSON/原文）', () => {
    const call = { name: 'spawn_subagent', arguments: '{"prompt":"请审查提交"}' };
    const view = reviewBlockText(call, {
      ok: false,
      content:
        '{"ok":false,"error":{"type":"subagent-error","message":"sub-agent failed: Authentication Fails (governor)"}}',
      error: 'sub-agent failed: Authentication Fails (governor)',
    });
    expect(view.subject).not.toBe('');
    expect(view.verdict).toContain('认证被拒');
    expect(view.verdict).not.toMatch(/governor/);
  });
});

// ---------------------------------------------------------------------------
// P2-6/P2-8：供应商报错本地化（图片被拒/超限/数量超 + 认证/网络）
// ---------------------------------------------------------------------------

describe('friendlyImageError（图片被供应商拒收 → 中文 + 指引）', () => {
  it('不支持图像（走查原文）→ 格式指引', () => {
    const out = friendlyImageError(
      '.messages[1].image[0]: You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif.',
    );
    expect(out).toContain('png');
    expect(out).toContain('移除');
  });
  it('数量超限 → 分批指引', () => {
    expect(friendlyImageError('too many images in one step')).toContain('分批');
  });
  it('体积/尺寸超限 → 压缩指引', () => {
    expect(friendlyImageError('total size of images exceeds')).toContain('压缩');
  });
  it('未命中 → null（保留原文）', () => {
    expect(friendlyImageError('some other error')).toBeNull();
  });
});

describe('friendlyProviderError（通用供应商/连接错误：未命中 → null）', () => {
  it('图片被拒带「图片请求被拒」前缀', () => {
    expect(friendlyProviderError('unsupported image')).toContain('图片请求被拒');
  });
  it('认证失败 → API Key 指引', () => {
    expect(friendlyProviderError('Authentication Fails (governor)')).toContain('API Key');
  });
  it('限流 → 稍等指引', () => {
    expect(friendlyProviderError('rate limit exceeded')).toContain('限流');
  });
  it('网络 → 检查网络', () => {
    expect(friendlyProviderError('ECONNREFUSED')).toContain('网络');
  });
  it('未知 → null', () => {
    expect(friendlyProviderError('odds and ends')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P2-10：收尾评审静默（子代理明确未启用时 run 后至多一次一行提示）
// ---------------------------------------------------------------------------

describe('reviewSkippedHint（评审未派提示裁决）', () => {
  const items = [
    { tools: [{ name: 'write_file', state: 'success' }] },
    { tools: [{ name: 'read_file', state: 'failed' }] },
  ];
  it('实质变更 + 评审开启 + 子代理明确未启用 → 提示', () => {
    expect(
      reviewSkippedHint({
        items,
        runActive: false,
        reviewMode: true,
        subagentsEnabled: false,
      }),
    ).toBe(REVIEW_SKIPPED_HINT);
  });
  it('子代理启用（或未知 true）→ 不提示', () => {
    expect(
      reviewSkippedHint({ items, runActive: false, reviewMode: true, subagentsEnabled: true }),
    ).toBeNull();
    expect(
      reviewSkippedHint({ items, runActive: false, reviewMode: true, subagentsEnabled: undefined }),
    ).toBeNull();
  });
  it('评审关闭 → 不提示（无义务）', () => {
    expect(
      reviewSkippedHint({ items, runActive: false, reviewMode: false, subagentsEnabled: false }),
    ).toBeNull();
  });
  it('运行中 → 不提示', () => {
    expect(
      reviewSkippedHint({ items, runActive: true, reviewMode: true, subagentsEnabled: false }),
    ).toBeNull();
  });
  it('无实质变更（只读/检索）→ 不提示', () => {
    expect(
      reviewSkippedHint({
        items: [{ tools: [{ name: 'read_file' }, { name: 'grep' }] }],
        runActive: false,
        reviewMode: true,
        subagentsEnabled: false,
      }),
    ).toBeNull();
  });
  it('已有独立审查卡（成功或失败尝试）→ 不提示（覆盖由卡承担）', () => {
    expect(
      reviewSkippedHint({
        items: [{ tools: [{ name: 'spawn_subagent', review: true, state: 'failed' }] }],
        runActive: false,
        reviewMode: true,
        subagentsEnabled: false,
      }),
    ).toBeNull();
  });
});
