/**
 * commands.js 单测：「/」命令表、行解析、前缀匹配（下拉过滤）、theme 参数校验。
 * 純函数节点可测；执行（面板/网络/消息流）在 app.js，不在本文件范围。
 */
import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  CONTINUE_PROMPT,
  THEME_ARG_VALUES,
  commandById,
  commandFor,
  commandArgValid,
  matchCommands,
  parseCommandLine,
  themeArgLabel,
} from '../../src/ui/web/commands.js';

describe('命令表（13 条单一来源）', () => {
  it('13 条；name 唯一且都以 / 开头；help 首条', () => {
    expect(COMMANDS).toHaveLength(13);
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of COMMANDS) {
      expect(c.name.startsWith('/')).toBe(true);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.desc.length).toBeGreaterThan(0);
    }
    expect(COMMANDS[0]).toMatchObject({ id: 'help', name: '/help' });
    expect(COMMANDS.map((c) => c.id)).toEqual([
      'help',
      'new',
      'clear',
      'stop',
      'continue',
      'sessions',
      'cost',
      'stats',
      'model',
      'skill',
      'theme',
      'mcp',
      'compact',
    ]);
  });

  it('id → 命令白名单匹配；未知 id → null', () => {
    expect(commandById('theme')).toMatchObject({ id: 'theme', name: '/theme' });
    expect(commandById('continue')).toMatchObject({ id: 'continue', name: '/continue' });
    expect(commandById('nope')).toBeNull();
  });

  it('/continue：无参数；CONTINUE_PROMPT = 续跑指令文本（单一来源）', () => {
    expect(commandFor('/continue')).toMatchObject({ id: 'continue', name: '/continue' });
    expect(parseCommandLine('/continue')).toEqual({
      name: '/continue',
      args: '',
      argList: [],
    });
    expect(commandArgValid(commandFor('/continue'), [])).toBe(true);
    expect(commandArgValid(commandFor('/continue'), ['1'])).toBe(false);
    expect(CONTINUE_PROMPT).toBe('请继续刚才未完成的任务。');
  });

  it('THEME_ARG_VALUES = theme.js 三态（dark/light/system；防两表漂移）', () => {
    expect(THEME_ARG_VALUES).toEqual(['dark', 'light', 'system']);
  });
});

describe('parseCommandLine', () => {
  it('拆出 name / args / argList；只认首段且容忍多余空白', () => {
    expect(parseCommandLine('/theme dark')).toEqual({
      name: '/theme',
      args: 'dark',
      argList: ['dark'],
    });
    expect(parseCommandLine('/theme   dark  ')!.argList).toEqual(['dark']);
    expect(parseCommandLine('/cost')).toEqual({ name: '/cost', args: '', argList: [] });
    expect(parseCommandLine('/sessions 2 3')!.argList).toEqual(['2', '3']);
  });

  it('非命令（无 / 前缀）→ null（普通消息不拦截）', () => {
    expect(parseCommandLine('theme dark')).toBeNull();
    expect(parseCommandLine('')).toBeNull();
    expect(parseCommandLine('hello /world')).toBeNull();
  });

  it('空名（纯 / 或后随空白）→ null（尚未输入命令名不构成命令）', () => {
    expect(parseCommandLine('/')).toBeNull();
    expect(parseCommandLine('/ ')).toBeNull();
    expect(parseCommandLine('//')).toBeNull();
  });

  it('未知命令：解析成立但 commandFor → null（调用方落「未知命令 /xx，/help 查看」红字）', () => {
    expect(parseCommandLine('/wat')).toEqual({ name: '/wat', args: '', argList: [] });
    expect(commandFor('/wat')).toBeNull();
    expect(commandFor('/cost')).toMatchObject({ id: 'cost' });
  });
});

describe('matchCommands（下拉前缀过滤，防抖 150ms 后展示）', () => {
  it('空片段 → 全表前 8 条（下拉首次展开 = 10+ 条菜单的超集裁量）', () => {
    expect(matchCommands('', 8)).toHaveLength(8);
    expect(matchCommands('', 12)).toHaveLength(12);
  });
  it('按名称前缀过滤（typing /the → /theme；命中按表内固有顺序）', () => {
    const hits = matchCommands('/the', 8);
    expect(hits.map((c) => c.name)).toEqual(['/theme']);
    // 表内顺序（help,new,clear,stop,sessions,cost,stats,model,skill,…）：/stop 在前
    expect(matchCommands('/s', 8).map((c) => c.name)).toEqual([
      '/stop',
      '/sessions',
      '/stats',
      '/skill',
    ]);
    expect(matchCommands('/n', 8).map((c) => c.name)).toEqual(['/new']);
    expect(matchCommands('/c', 8).map((c) => c.name)).toEqual([
      '/clear',
      '/continue',
      '/cost',
      '/compact',
    ]);
  });
  it('无命中 → []（菜单收起）；cap ≤ 0 防御', () => {
    expect(matchCommands('/zzz', 8)).toEqual([]);
    expect(matchCommands('/the', 0)).toEqual([]);
    expect(matchCommands('/the', -1)).toEqual([]);
  });
});

describe('commandArgValid（参数合法裁决）', () => {
  it('/theme 需要恰好一个合法参数；其余命令不接受参数', () => {
    const theme = commandFor('/theme')!;
    expect(commandArgValid(theme, ['dark'])).toBe(true);
    expect(commandArgValid(theme, ['light'])).toBe(true);
    expect(commandArgValid(theme, ['system'])).toBe(true);
    expect(commandArgValid(theme, [])).toBe(false);
    expect(commandArgValid(theme, ['dark', 'light'])).toBe(false);
    expect(commandArgValid(theme, ['night'])).toBe(false);
    const cost = commandFor('/cost')!;
    expect(commandArgValid(cost, [])).toBe(true);
    expect(commandArgValid(cost, ['1'])).toBe(false);
  });
});

describe('themeArgLabel', () => {
  it('三态中文；未知原样返回', () => {
    expect(themeArgLabel('dark')).toBe('深色');
    expect(themeArgLabel('light')).toBe('浅色');
    expect(themeArgLabel('system')).toBe('跟随系统');
    expect(themeArgLabel('nope')).toBe('nope');
  });
});
