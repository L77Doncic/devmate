/**
 * settings.js 单测：默认值（以 S2 presets 为准）、掩码、读写 /api/settings（注入 fetch）。
 * 密钥纪律钉点：POST 之后返回值不含明文；掩码只保留首尾四位。
 * A 档（2026-08-30 用户实测修正）：模型名 `[N]m/k` UI 标记后缀全链净化——GET 回显净化 +
 * modelAutoCorrected 标记；POST 保存再净化（双保险）。
 * B 档（2026-08-30 用户强制）：maxInputTokens/maxOutputTokens **必填**——GET 恒回显
 * （缺失回填缺省 + `*Default` 提示键）；POST（含单字段补丁）恒要求两者；
 * tokenLimitError 提供展示层红字/禁存判据。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  maskApiKey,
  loadSettings,
  saveSettings,
  saveReasoning,
  savePermission,
  PROVIDER_PRESETS,
  matchProvider,
  normalizeBaseUrl,
  REASONING_VALUES,
  REASONING_LABELS,
  REASONING_DEFAULT,
  normalizeReasoning,
  normalizeWindow,
  METHODFIRST_DEFAULT,
  normalizeMethodFirst,
  saveMethodFirst,
  REVIEWMODE_DEFAULT,
  normalizeReviewMode,
  saveReviewMode,
} from '../../src/ui/web/settings.js';

/** 测试用自己的「极简 Response 假件」，类型上视为 fetch 使用（运行时不依赖 DOM）。 */
function asFetch(fn: unknown): typeof fetch {
  return fn as unknown as typeof fetch;
}

describe('DEFAULT_SETTINGS', () => {
  it('主默认 DeepSeek（与 src/core/llm/presets.ts 一致）', () => {
    expect(DEFAULT_SETTINGS.baseUrl).toBe('https://api.deepseek.com');
    // 权威值以 presets.ts 为准：defaultModel = deepseek-v4-flash
    expect(DEFAULT_SETTINGS.model).toBe('deepseek-v4-flash');
  });
});

describe('maskApiKey', () => {
  it('>12：前 4 + **** + 后 4（与服务端口径同款）', () => {
    expect(maskApiKey('sk-abcdefgh12345678')).toBe('sk-a****5678');
  });
  it('≤12（含 9~12 边界）全部 ****', () => {
    expect(maskApiKey('abcd')).toBe('****');
    expect(maskApiKey('123456789')).toBe('****');
    expect(maskApiKey('k'.repeat(12))).toBe('****');
  });
  it('>12 分界：13 字符显首尾 4', () => {
    expect(maskApiKey('m'.repeat(13))).toBe('mmmm****mmmm');
  });
  it('空值返回空', () => {
    expect(maskApiKey('')).toBe('');
    expect(maskApiKey(undefined as unknown as string)).toBe('');
  });
});

function okResponse(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}

describe('loadSettings', () => {
  it('解析服务端掩码响应（服务端口径：前 4 + **** + 后 4）', async () => {
    const res = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm1', apiKey: 'sk-aaa****1234' }),
      ),
    });
    expect(res.baseUrl).toBe('https://x');
    expect(res.model).toBe('m1');
    expect(res.keyConfigured).toBe(true);
    expect(res.apiKeyMasked).toBe('sk-a****1234');
  });

  it('未配置密钥 → keyConfigured false', async () => {
    const res = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm1', apiKey: null }),
      ),
    });
    expect(res.keyConfigured).toBe(false);
  });

  it('缺失模型字段 → 主默认兜底', async () => {
    const res = await loadSettings({ fetchImpl: asFetch(async () => okResponse({})) });
    expect(res.model).toBe(DEFAULT_SETTINGS.model);
  });

  it('模型名净化（A 档）：GET 值带 `[N]m/k` 尾标 → 回显净化值 + modelAutoCorrected；服务端 modelSanitized=true 为权威标记；无尾标 → false', async () => {
    const res = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'deepseek-v4-flash[1m]' }),
      ),
    });
    expect(res.model).toBe('deepseek-v4-flash');
    expect(res.modelAutoCorrected).toBe(true);
    // 服务端已净化（存量尾标在读取层剥离）→ 值无尾标、标记由服务端给出
    const live = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm2', modelSanitized: true }),
      ),
    });
    expect(live.model).toBe('m2');
    expect(live.modelAutoCorrected).toBe(true);
    const clean = await loadSettings({
      fetchImpl: asFetch(async () => okResponse({ baseUrl: 'https://x', model: 'm2' })),
    });
    expect(clean.model).toBe('m2');
    expect(clean.modelAutoCorrected).toBe(false);
  });

  it('上限缺省回填提示键（B 档）：服务端 `*Default=true` → 透传（前端「已用默认」提示依据）；无键 → false', async () => {
    const res = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({
          baseUrl: 'https://x',
          model: 'm',
          maxInputTokens: 128000,
          maxOutputTokens: 8192,
          maxInputTokensDefault: true,
          maxOutputTokensDefault: true,
        }),
      ),
    });
    expect(res.maxInputTokens).toBe(128000);
    expect(res.maxOutputTokens).toBe(8192);
    expect(res.maxInputTokensDefault).toBe(true);
    expect(res.maxOutputTokensDefault).toBe(true);
    const stored = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', maxInputTokens: 1, maxOutputTokens: 2 }),
      ),
    });
    expect(stored.maxInputTokensDefault).toBe(false);
    expect(stored.maxOutputTokensDefault).toBe(false);
  });

  it('服务端错误 → 上抛（HTTP 状态）', async () => {
    await expect(
      loadSettings({
        fetchImpl: asFetch(async () => ({ ok: false, status: 500, json: async () => ({}) })),
      }),
    ).rejects.toThrow(/500/);
  });
});

describe('saveSettings', () => {
  it('POST JSON：必填上限对恒上行（B 档）；模型名发送前净化（A 档）；只在 key 非空时带上行；返回掩码', async () => {
    let posted: unknown = null;
    const saved = await saveSettings(
      {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash[1m]',
        apiKey: 'sk-abc123456',
        maxInputTokens: 4096,
        maxOutputTokens: 2048,
      },
      {
        fetchImpl: asFetch(async (_url: string, opts: any) => {
          posted = JSON.parse(opts.body);
          return okResponse({
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-v4-flash',
            apiKey: 'sk-a…3456',
            maxInputTokens: 4096,
            maxOutputTokens: 2048,
          });
        }),
      },
    );
    expect(posted).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
      apiKey: 'sk-abc123456',
    });
    expect(saved.keyConfigured).toBe(true);
    expect(saved.model).toBe('deepseek-v4-flash');
    // 响应后不保留明文（模块内已丢弃）：序列化结果里没有完整 key
    expect(JSON.stringify(saved)).not.toContain('sk-abc123456');
  });

  it('apiKey 为空 → 不发送 key 字段（不改密钥）；上限对仍必发', async () => {
    let posted: unknown = null;
    await saveSettings(
      {
        baseUrl: 'https://new',
        model: 'm2',
        apiKey: '',
        maxInputTokens: 4096,
        maxOutputTokens: 2048,
      },
      {
        fetchImpl: asFetch(async (_url: string, opts: any) => {
          posted = JSON.parse(opts.body);
          return okResponse({ baseUrl: 'https://new', model: 'm2', apiKey: null });
        }),
      },
    );
    const rec = posted as Record<string, unknown>;
    expect(rec).toEqual({
      baseUrl: 'https://new',
      model: 'm2',
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
    });
    expect('apiKey' in rec).toBe(false);
  });

  it('上限缺任一/非法（空/null/0/-1/字符串）→ 本地抛错（不 POST——服务端 400 兜底）', async () => {
    let called = false;
    const fetchImpl = asFetch(async () => {
      called = true;
      return okResponse({});
    });
    for (const bad of [undefined, null, '', 0, -1, 1.5, 'x']) {
      await expect(
        saveSettings(
          { baseUrl: 'https://x', model: 'm', maxInputTokens: 4096, maxOutputTokens: bad },
          { fetchImpl },
        ),
      ).rejects.toThrow(/必填|正整数/);
      await expect(
        saveSettings(
          { baseUrl: 'https://x', model: 'm', maxInputTokens: bad, maxOutputTokens: 2048 },
          { fetchImpl },
        ),
      ).rejects.toThrow(/必填|正整数/);
    }
    expect(called).toBe(false); // 本地先拦：零上行
  });

  it('默认值兜底 + 非 2xx 上抛', async () => {
    let posted: unknown = null;
    await saveSettings(
      { baseUrl: '', model: '', apiKey: 'k', maxInputTokens: 1000, maxOutputTokens: 2000 },
      {
        fetchImpl: asFetch(async (_u: string, opts: any) => {
          posted = JSON.parse(opts.body);
          return okResponse({
            baseUrl: DEFAULT_SETTINGS.baseUrl,
            model: DEFAULT_SETTINGS.model,
            apiKey: 's…',
          });
        }),
      },
    );
    expect((posted as Record<string, unknown>).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
    await expect(
      saveSettings(
        { baseUrl: 'x', model: 'y', apiKey: '', maxInputTokens: 1, maxOutputTokens: 2 },
        {
          fetchImpl: asFetch(async () => ({
            ok: false,
            status: 401,
            json: async () => ({ error: 'unauthorized' }),
          })),
        },
      ),
    ).rejects.toThrow(/401/);
  });
});

// ---------------------------------------------------------------------------
// S13 侧边栏「供应商」：预设镜像（src/core/llm/presets.ts）与匹配逻辑
// ---------------------------------------------------------------------------

describe('PROVIDER_PRESETS（五家预设，镜像 presets.ts）', () => {
  it('五家齐备且 baseUrl/model 与权威源一致', () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual([
      'deepseek',
      'dashscope',
      'glm',
      'kimi',
      'openai',
    ]);
    expect(PROVIDER_PRESETS[0]).toMatchObject({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: DEFAULT_SETTINGS.model, // 深色主默认一致：DEFAULT_SETTINGS 同源
    });
    expect(PROVIDER_PRESETS[1]).toMatchObject({
      id: 'dashscope',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-coder-plus',
    });
    expect(PROVIDER_PRESETS[2]).toMatchObject({
      id: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
      model: 'glm-5.3',
    });
    expect(PROVIDER_PRESETS[3]).toMatchObject({
      id: 'kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k3',
    });
    expect(PROVIDER_PRESETS[4]).toMatchObject({
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
    });
  });
});

describe('reasoning 常量与 saveReasoning（分段 pill 提交）', () => {
  it('四档闭集 + 中文标签（off/low/medium/high ↔ 关闭/低/中/高）；缺省档 = medium', () => {
    expect(REASONING_VALUES).toEqual(['off', 'low', 'medium', 'high']);
    expect(REASONING_LABELS).toEqual({ off: '关闭', low: '低', medium: '中', high: '高' });
    expect(REASONING_DEFAULT).toBe('medium');
  });

  it('normalizeReasoning：四档原样；非法（含大写）→ medium', () => {
    expect(normalizeReasoning('off')).toBe('off');
    expect(normalizeReasoning('high')).toBe('high');
    expect(normalizeReasoning('MEDIUM')).toBe('medium');
    expect(normalizeReasoning('')).toBe('medium');
    expect(normalizeReasoning(null)).toBe('medium');
  });

  it('normalizeWindow：正整数 → number；其余（0/负/小数/字符串/NaN）→ null', () => {
    expect(normalizeWindow(64000)).toBe(64000);
    expect(normalizeWindow(1)).toBe(1);
    expect(normalizeWindow(0)).toBeNull();
    expect(normalizeWindow(-5)).toBeNull();
    expect(normalizeWindow(3.5)).toBeNull();
    expect(normalizeWindow('64000' as unknown as number)).toBeNull();
    expect(normalizeWindow(NaN)).toBeNull();
    expect(normalizeWindow(null)).toBeNull();
  });

  it('saveReasoning：POST {reasoning} + 必填上限对（B 档）；返回归一快照', async () => {
    let posted: unknown = null;
    const saved = await saveReasoning('high', {
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
      fetchImpl: asFetch(async (_url: string, opts: any) => {
        posted = JSON.parse(opts.body);
        return okResponse({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          reasoning: 'high',
        });
      }),
    });
    expect(posted).toEqual({ reasoning: 'high', maxInputTokens: 4096, maxOutputTokens: 2048 });
    expect(saved.reasoning).toBe('high');
    expect('apiKey' in (posted as Record<string, unknown>)).toBe(false);
  });

  it('saveReasoning：上限对缺失/非法 → 本地抛错（不 POST）；非 2xx → 上抛（调用方回滚前提）', async () => {
    let called = false;
    for (const bad of [null, undefined, 0, 'x']) {
      await expect(
        saveReasoning('low', {
          maxInputTokens: bad,
          maxOutputTokens: bad,
          fetchImpl: asFetch(async () => {
            called = true;
            return okResponse({});
          }),
        }),
      ).rejects.toThrow(/必填|正整数/);
    }
    expect(called).toBe(false);
    await expect(
      saveReasoning('low', {
        maxInputTokens: 1,
        maxOutputTokens: 2,
        fetchImpl: asFetch(async () => ({ ok: false, status: 500, json: async () => ({}) })),
      }),
    ).rejects.toThrow(/500/);
  });
});

describe('permission 预设（chip 提交/回滚契约；枚举权威 = permissions.js）', () => {
  it('loadSettings：permission 三档透传；缺失/非法 → 缺省 workspace-write', async () => {
    const full = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'x', model: 'm', permission: 'full-access' }),
      ),
    });
    expect(full.permission).toBe('full-access');
    const missing = await loadSettings({ fetchImpl: asFetch(async () => okResponse({})) });
    expect(missing.permission).toBe('workspace-write');
    const bad = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'x', model: 'm', permission: 'danger-full-access' }),
      ),
    });
    expect(bad.permission).toBe('workspace-write');
  });

  it('loadSettings：permissionConfirmedAt 透传；无记录/非数 → null（风险门判定依据）', async () => {
    const confirmed = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'x', model: 'm', permissionConfirmedAt: 1_728_000_000_000 }),
      ),
    });
    expect(confirmed.permissionConfirmedAt).toBe(1_728_000_000_000);
    const none = await loadSettings({ fetchImpl: asFetch(async () => okResponse({})) });
    expect(none.permissionConfirmedAt).toBeNull();
    const bad = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'x', model: 'm', permissionConfirmedAt: 'now' }),
      ),
    });
    expect(bad.permissionConfirmedAt).toBeNull();
  });

  it('savePermission：POST {permission} + 必填上限对；返回归一快照（确认后服务端回 confirmedAt）', async () => {
    let posted: unknown = null;
    const saved = await savePermission('full-access', {
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
      fetchImpl: asFetch(async (_url: string, opts: any) => {
        posted = JSON.parse(opts.body);
        return okResponse({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          permission: 'full-access',
          permissionConfirmedAt: 1_728_000_000_000,
        });
      }),
    });
    expect(posted).toEqual({
      permission: 'full-access',
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
    });
    expect(saved.permission).toBe('full-access');
    expect(saved.permissionConfirmedAt).toBe(1_728_000_000_000);
    expect('apiKey' in (posted as Record<string, unknown>)).toBe(false);
  });

  it('savePermission：非法档位先归一（如大写/未知 → workspace-write 上行）', async () => {
    let posted: unknown = null;
    await savePermission('FULL-ACCESS', {
      maxInputTokens: 1,
      maxOutputTokens: 2,
      fetchImpl: asFetch(async (_url: string, opts: any) => {
        posted = JSON.parse(opts.body);
        return okResponse({ baseUrl: 'x', model: 'm', permission: 'workspace-write' });
      }),
    });
    expect(posted).toEqual({
      permission: 'workspace-write',
      maxInputTokens: 1,
      maxOutputTokens: 2,
    });
  });

  it('savePermission：非 2xx 上抛 —— 调用方回滚路径（重读 GET + toast）的失败前提', async () => {
    await expect(
      savePermission('read-only', {
        maxInputTokens: 1,
        maxOutputTokens: 2,
        fetchImpl: asFetch(async () => ({ ok: false, status: 400, json: async () => ({}) })),
      }),
    ).rejects.toThrow(/400/);
    // 回滚 = 失败后再 loadSettings（服务端态还原）；GET 能回到旧档即回滚成立
    const after = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'x', model: 'm', permission: 'workspace-write' }),
      ),
    });
    expect(after.permission).toBe('workspace-write');
  });
});

describe('normalizeBaseUrl / matchProvider', () => {
  it('baseUrl 归一化：去空白 + 去末尾斜杠（glm 预设带尾斜杠也能匹配）', () => {
    expect(normalizeBaseUrl('  https://x.com/v1/// ')).toBe('https://x.com/v1');
    expect(matchProvider('https://api.deepseek.com')).toMatchObject({ id: 'deepseek' });
    expect(matchProvider('  https://api.deepseek.com/ ')).toMatchObject({ id: 'deepseek' });
    expect(matchProvider('https://open.bigmodel.cn/api/paas/v4/')).toMatchObject({ id: 'glm' });
  });
  it('未知端点/空值 → null（用户自定义 baseUrl 不误高亮）', () => {
    expect(matchProvider('https://my-proxy.example.com/v1')).toBeNull();
    expect(matchProvider('')).toBeNull();
    expect(matchProvider(null as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R2-S1：方法论先行开关（settings.methodFirst —— 前置门；缺省 true；补丁契约）
// ---------------------------------------------------------------------------

describe('methodFirst（R2-S1 方法论前置门开关：缺省 true / 布尔补丁 / 失败上抛）', () => {
  it('常量：缺省 true（服务端无键兜底 —— 旧服务端 GET 回退语义）', () => {
    expect(METHODFIRST_DEFAULT).toBe(true);
  });

  it('normalizeMethodFirst：boolean 原样；非布尔（缺失/字符串/0/1）→ 缺省 true', () => {
    expect(normalizeMethodFirst(true)).toBe(true);
    expect(normalizeMethodFirst(false)).toBe(false);
    expect(normalizeMethodFirst(undefined)).toBe(true);
    expect(normalizeMethodFirst(null)).toBe(true);
    expect(normalizeMethodFirst('true' as unknown as boolean)).toBe(true);
    expect(normalizeMethodFirst(0 as unknown as boolean)).toBe(true);
  });

  it('loadSettings：GET 布尔透传；服务端无该键 → 缺省 true（回显基线）', async () => {
    const off = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', methodFirst: false }),
      ),
    });
    expect(off.methodFirst).toBe(false);
    const on = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', methodFirst: true }),
      ),
    });
    expect(on.methodFirst).toBe(true);
    // 旧服务端（未实现 R2-S1）不回该键 → 缺省 true（服务端自身也缺省 true，双兜底一致）
    const legacy = await loadSettings({ fetchImpl: asFetch(async () => okResponse({})) });
    expect(legacy.methodFirst).toBe(true);
  });

  it('saveMethodFirst：POST {methodFirst} + 必填上限对；返回归一快照回显', async () => {
    let posted: unknown = null;
    const saved = await saveMethodFirst(false, {
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
      fetchImpl: asFetch(async (_url: string, opts: any) => {
        posted = JSON.parse(opts.body);
        return okResponse({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          methodFirst: false,
        });
      }),
    });
    expect(posted).toEqual({ methodFirst: false, maxInputTokens: 4096, maxOutputTokens: 2048 });
    expect(saved.methodFirst).toBe(false);
    // 未触碰字段不下行（补丁语义：不动 baseUrl/model/apiKey）
    const rec = posted as Record<string, unknown>;
    expect('apiKey' in rec).toBe(false);
    expect('baseUrl' in rec).toBe(false);
  });

  it('saveMethodFirst：值先归一（坏值 → true）再上行', async () => {
    let posted: unknown = null;
    await saveMethodFirst('off' as unknown as boolean, {
      maxInputTokens: 1,
      maxOutputTokens: 2,
      fetchImpl: asFetch(async (_url: string, opts: any) => {
        posted = JSON.parse(opts.body);
        return okResponse({ baseUrl: 'x', model: 'm', methodFirst: true });
      }),
    });
    expect(posted).toEqual({ methodFirst: true, maxInputTokens: 1, maxOutputTokens: 2 });
  });

  it('saveMethodFirst：非 2xx 上抛 —— 调用方回滚（重读 GET + toast「已还原」）前提', async () => {
    await expect(
      saveMethodFirst(true, {
        maxInputTokens: 1,
        maxOutputTokens: 2,
        fetchImpl: asFetch(async () => ({ ok: false, status: 500, json: async () => ({}) })),
      }),
    ).rejects.toThrow(/500/);
    // 回滚 = 失败后再 loadSettings（服务端态还原）；GET 能回到旧值即回滚成立
    const after = await loadSettings({
      fetchImpl: asFetch(async () => okResponse({ baseUrl: 'x', model: 'm', methodFirst: true })),
    });
    expect(after.methodFirst).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R2-S2：收尾评审开关（settings.reviewMode —— 评审哨兵；缺省 true；补丁契约）
// ---------------------------------------------------------------------------

describe('reviewMode（R2-S2 收尾评审哨兵开关：缺省 true / 布尔补丁 / 失败上抛）', () => {
  it('常量：缺省 true（服务端无键兜底 —— 旧服务端 GET 回退语义）', () => {
    expect(REVIEWMODE_DEFAULT).toBe(true);
  });

  it('normalizeReviewMode：boolean 原样；非布尔（缺失/字符串/0/1）→ 缺省 true', () => {
    expect(normalizeReviewMode(true)).toBe(true);
    expect(normalizeReviewMode(false)).toBe(false);
    expect(normalizeReviewMode(undefined)).toBe(true);
    expect(normalizeReviewMode(null)).toBe(true);
    expect(normalizeReviewMode('true' as unknown as boolean)).toBe(true);
    expect(normalizeReviewMode(0 as unknown as boolean)).toBe(true);
  });

  it('loadSettings：GET 布尔透传；服务端无该键 → 缺省 true（回显基线）', async () => {
    const off = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', reviewMode: false }),
      ),
    });
    expect(off.reviewMode).toBe(false);
    const on = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', reviewMode: true }),
      ),
    });
    expect(on.reviewMode).toBe(true);
    // 旧服务端（未实现 R2-S2）不回该键 → 缺省 true（服务端自身也缺省 true，双兜底一致）
    const legacy = await loadSettings({ fetchImpl: asFetch(async () => okResponse({})) });
    expect(legacy.reviewMode).toBe(true);
  });

  it('saveReviewMode：POST {reviewMode} + 必填上限对；返回归一快照回显', async () => {
    let posted: unknown = null;
    const saved = await saveReviewMode(false, {
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
      fetchImpl: asFetch(async (_url: string, opts: any) => {
        posted = JSON.parse(opts.body);
        return okResponse({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          reviewMode: false,
        });
      }),
    });
    expect(posted).toEqual({ reviewMode: false, maxInputTokens: 4096, maxOutputTokens: 2048 });
    expect(saved.reviewMode).toBe(false);
    // 未触碰字段不下行（补丁语义：不动 baseUrl/model/apiKey）
    const rec = posted as Record<string, unknown>;
    expect('apiKey' in rec).toBe(false);
    expect('baseUrl' in rec).toBe(false);
  });

  it('saveReviewMode：值先归一（坏值 → true）再上行', async () => {
    let posted: unknown = null;
    await saveReviewMode('off' as unknown as boolean, {
      maxInputTokens: 1,
      maxOutputTokens: 2,
      fetchImpl: asFetch(async (_url: string, opts: any) => {
        posted = JSON.parse(opts.body);
        return okResponse({ baseUrl: 'x', model: 'm', reviewMode: true });
      }),
    });
    expect(posted).toEqual({ reviewMode: true, maxInputTokens: 1, maxOutputTokens: 2 });
  });

  it('saveReviewMode：非 2xx 上抛 —— 调用方回滚（重读 GET + toast「已还原」）前提', async () => {
    await expect(
      saveReviewMode(true, {
        maxInputTokens: 1,
        maxOutputTokens: 2,
        fetchImpl: asFetch(async () => ({ ok: false, status: 500, json: async () => ({}) })),
      }),
    ).rejects.toThrow(/500/);
    // 回滚 = 失败后再 loadSettings（服务端态还原）；GET 能回到旧值即回滚成立
    const after = await loadSettings({
      fetchImpl: asFetch(async () => okResponse({ baseUrl: 'x', model: 'm', reviewMode: true })),
    });
    expect(after.reviewMode).toBe(true);
  });
});

describe('A/B 档：normalizeTokenLimit / tokenLimitError（必填校验判据）/ saveSettings 上限字段（ADR-0015）', () => {
  it('normalizeTokenLimit：正整数原样；非法/缺失 → null（null = 数据未到/坏值）', async () => {
    const { normalizeTokenLimit } = await import('../../src/ui/web/settings.js');
    expect(normalizeTokenLimit(4096)).toBe(4096);
    expect(normalizeTokenLimit(1)).toBe(1);
    expect(normalizeTokenLimit(0)).toBeNull();
    expect(normalizeTokenLimit(1.5)).toBeNull();
    expect(normalizeTokenLimit('4096')).toBeNull();
    expect(normalizeTokenLimit(undefined)).toBeNull();
  });

  it("tokenLimitError（B 档必填校验）：正整数 → ''；空/非正/非法 → 带 label 红字文案", async () => {
    const { tokenLimitError } = await import('../../src/ui/web/settings.js');
    expect(tokenLimitError(4096)).toBe('');
    expect(tokenLimitError(1)).toBe('');
    expect(tokenLimitError('4096')).toBe('');
    expect(tokenLimitError('')).toBe('输入/输出上限必填（正整数）');
    expect(tokenLimitError(null)).toBe('输入/输出上限必填（正整数）');
    expect(tokenLimitError(undefined)).toBe('输入/输出上限必填（正整数）');
    expect(tokenLimitError(0)).toBe('输入/输出上限必须是正整数');
    expect(tokenLimitError(-1)).toBe('输入/输出上限必须是正整数');
    expect(tokenLimitError(1.5)).toBe('输入/输出上限必须是正整数');
    expect(tokenLimitError('4096.5')).toBe('输入/输出上限必须是正整数');
    expect(tokenLimitError('x', '输入上限')).toBe('输入上限必须是正整数');
  });

  it('sanitizeModel（A 档镜像）：尾标逐层剥离；非尾标保留', async () => {
    const { sanitizeModel } = await import('../../src/ui/web/settings.js');
    expect(sanitizeModel('deepseek-v4-flash[1m]')).toBe('deepseek-v4-flash');
    expect(sanitizeModel('my/model[128k]')).toBe('my/model');
    expect(sanitizeModel('my/model[1m][2m]')).toBe('my/model');
    expect(sanitizeModel('my/model-1m-v2')).toBe('my/model-1m-v2');
    expect(sanitizeModel('my[m]model[1m]')).toBe('my[m]model');
    expect(sanitizeModel('')).toBe('');
  });
});
