/**
 * guard.js 单测：对话级「Token 护栏」纯逻辑（2026-08-31 定调）。
 * - 判据：本轮 run 累计 totalTokens 超上限 → 停机（status 'cost-guard' 保留，文案
 *   「Token 护栏停机」在 format.js）；判据与单价无关（不再 costUsd）。
 * - 默认关闭：未设置（null/缺失/坏值）= 不限制；清空 = 关闭。
 * - 作用域 = 会话级：localStorage 按 sessionId 记忆（键前缀 devmate.ui.guardTokens.）；
 *   发送时经 POST /api/chat 的 maxRunTokens（正整数）透传——本模块不管网络。
 * - 值域纪律与服务端「必须正整数」同口径（normalizeGuardValue / guardInputError）。
 */
import { describe, expect, it } from 'vitest';
import {
  GUARD_STORAGE_PREFIX,
  guardStorageKey,
  normalizeGuardValue,
  loadGuardTokens,
  saveGuardTokens,
  compactTokenCount,
  guardPillLabel,
  guardInputError,
  guardLimitHint,
} from '../../src/ui/web/guard.js';

/** 存储假件（localStorage-like 内存实现；与 extensions/theme 测试同纪律）。 */
function memStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => map.set(k, String(v)),
    removeItem: (k: string) => map.delete(k),
    _dump: () => Object.fromEntries(map.entries()),
  };
}

describe('guardStorageKey（键 = devmate.ui.guardTokens.<sessionId>）', () => {
  it('会话键：前缀 + sessionId；无会话/空串 → null（无键可记忆）', () => {
    expect(guardStorageKey('s-abc')).toBe(`${GUARD_STORAGE_PREFIX}s-abc`);
    expect(guardStorageKey(null)).toBeNull();
    expect(guardStorageKey('')).toBeNull();
    expect(guardStorageKey('   ')).toBeNull();
  });
});

describe('normalizeGuardValue（值域：正整数；其它 = 关闭）', () => {
  it('正整数原样；null/undefined/字符串/0/负数/小数/非有限 → null', () => {
    expect(normalizeGuardValue(500_000)).toBe(500_000);
    expect(normalizeGuardValue(1)).toBe(1);
    expect(normalizeGuardValue(null)).toBeNull();
    expect(normalizeGuardValue(undefined)).toBeNull();
    expect(normalizeGuardValue('500000')).toBeNull();
    expect(normalizeGuardValue(0)).toBeNull();
    expect(normalizeGuardValue(-5)).toBeNull();
    expect(normalizeGuardValue(12.5)).toBeNull();
    expect(normalizeGuardValue(Number.NaN)).toBeNull();
    expect(normalizeGuardValue(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('loadGuardTokens / saveGuardTokens（会话级记忆；默认关闭）', () => {
  it('缺省（无键）→ null = 关闭；保存 500000 → 读回原值', () => {
    const storage = memStorage();
    expect(loadGuardTokens(storage, 's-abc')).toBeNull();
    saveGuardTokens(storage, 's-abc', 500_000);
    expect(loadGuardTokens(storage, 's-abc')).toBe(500_000);
    expect(storage.getItem(`${GUARD_STORAGE_PREFIX}s-abc`)).toBe('500000');
  });

  it('按会话隔离：两会话各自值互不干扰', () => {
    const storage = memStorage();
    saveGuardTokens(storage, 's-abc', 100);
    saveGuardTokens(storage, 's-def', 2000);
    expect(loadGuardTokens(storage, 's-abc')).toBe(100);
    expect(loadGuardTokens(storage, 's-def')).toBe(2000);
  });

  it('清空（null）→ 删键 = 关闭；再次读取回落 null', () => {
    const storage = memStorage();
    saveGuardTokens(storage, 's-abc', 100);
    saveGuardTokens(storage, 's-abc', null);
    expect(loadGuardTokens(storage, 's-abc')).toBeNull();
    expect(storage._dump()).toEqual({});
  });

  it('坏值（非数字/非正整数/损坏字符串）→ null = 关闭（安全默认）；存储异常静默', () => {
    const broken = memStorage({ [`${GUARD_STORAGE_PREFIX}s-abc`]: '-7' });
    expect(loadGuardTokens(broken, 's-abc')).toBeNull();
    const nan = memStorage({ [`${GUARD_STORAGE_PREFIX}s-abc`]: 'NaN' });
    expect(loadGuardTokens(nan, 's-abc')).toBeNull();
    // 存储读写抛错（隐私模式）不 throw
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadGuardTokens(throwing, 's-abc')).toBeNull();
    expect(() => saveGuardTokens(throwing, 's-abc', 100)).not.toThrow();
    expect(loadGuardTokens(null, null)).toBeNull();
  });
});

describe('compactTokenCount / guardPillLabel（pill 显示：护栏 关 / 护栏 500k）', () => {
  it('紧凑显示：<1000 原样；≥1000 → k；≥1e6 → m（一位小数去尾 0）', () => {
    expect(compactTokenCount(100)).toBe('100');
    expect(compactTokenCount(999)).toBe('999');
    expect(compactTokenCount(1000)).toBe('1k');
    expect(compactTokenCount(1200)).toBe('1.2k');
    expect(compactTokenCount(500_000)).toBe('500k');
    expect(compactTokenCount(1_250_000)).toBe('1.3m');
    expect(compactTokenCount(2_000_000)).toBe('2m');
  });
  it('pill 标签：关 / 「护栏 500k」；坏值按关', () => {
    expect(guardPillLabel(null)).toBe('护栏 关');
    expect(guardPillLabel(500_000)).toBe('护栏 500k');
    expect(guardPillLabel(1200)).toBe('护栏 1.2k');
    expect(guardPillLabel(-3)).toBe('护栏 关');
  });
});

describe('guardInputError（弹层输入校验：先本地拦，与服务端 400 同口径）', () => {
  it('空串 = 关闭（不报错）；非 [0-9]+ / 非正整数 → 错误文案', () => {
    expect(guardInputError('')).toBe('');
    expect(guardInputError('   ')).toBe('');
    expect(guardInputError('500000')).toBe('');
    expect(guardInputError('0')).toBe('上限必须是正整数');
    expect(guardInputError('-5')).toBe('上限必须是正整数');
    expect(guardInputError('12.5')).toBe('上限必须是正整数');
    expect(guardInputError('abc')).toBe('上限必须是正整数');
    expect(guardInputError('1e6')).toBe('上限必须是正整数');
  });
});

describe('guardLimitHint（弹层动态提示：护栏上限须高于当前输出上限——评审观察 1 处置）', () => {
  it('有有效输出上限 → 提示含「输出上限」+ 动态值 + 预检截停说明', () => {
    const hint = guardLimitHint(384_000);
    expect(hint).toContain('输出上限');
    expect(hint).toContain('384000');
    expect(hint).toContain('预检截停');
    expect(guardLimitHint(8192)).toContain('8192');
  });
  it('拿不到值（null/undefined/字符串/非正整数）→ 方向式兜底文案且不编造数字', () => {
    const fallback = '当前配置的输出上限';
    for (const missing of [null, undefined, '384000', 0, -5, 12.5, Number.NaN]) {
      const hint = guardLimitHint(missing);
      expect(hint).toContain('输出上限');
      expect(hint).toContain(fallback);
      expect(hint).toContain('预检截停');
      expect(hint).not.toMatch(/[0-9]/); // 不编造缺省假数字（假精度误导）
    }
  });
});
