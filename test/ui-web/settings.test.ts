/**
 * settings.js 单测：默认值（以 S2 presets 为准）、掩码、读写 /api/settings（注入 fetch）。
 * 密钥纪律钉点：POST 之后返回值不含明文；掩码只保留首尾四位。
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
    expect(res.apiKeyMasked).toBe('');
  });

  it('空字段回落到默认值', async () => {
    const res = await loadSettings({ fetchImpl: asFetch(async () => okResponse({})) });
    expect(res.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
    expect(res.model).toBe(DEFAULT_SETTINGS.model);
  });

  it('workspaceDir：服务端提供即透传；缺失/坏值为 null（显示字段，设置抽屉降级占位）', async () => {
    const withDir = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', workspaceDir: '/work/devmate' }),
      ),
    });
    expect(withDir.workspaceDir).toBe('/work/devmate');
    const without = await loadSettings({ fetchImpl: asFetch(async () => okResponse({})) });
    expect(without.workspaceDir).toBeNull();
    const bad = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', workspaceDir: '   ' }),
      ),
    });
    expect(bad.workspaceDir).toBeNull();
  });

  it('reasoning：四档透传；缺失/非法归一 medium（缺省语义）', async () => {
    const high = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', reasoning: 'high' }),
      ),
    });
    expect(high.reasoning).toBe('high');
    const missing = await loadSettings({ fetchImpl: asFetch(async () => okResponse({})) });
    expect(missing.reasoning).toBe('medium');
    const bad = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', reasoning: 'ultra' }),
      ),
    });
    expect(bad.reasoning).toBe('medium');
  });

  it('window：正整数透传为 windowTokens；缺失/非法（非数字/0/负/小数/字符串）→ null', async () => {
    const withWindow = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', window: 64000 }),
      ),
    });
    expect(withWindow.windowTokens).toBe(64000);
    // windowTokens 双名兜底（服务端仅回 window；容错 accept 二者）
    const alias = await loadSettings({
      fetchImpl: asFetch(async () =>
        okResponse({ baseUrl: 'https://x', model: 'm', windowTokens: 128000 }),
      ),
    });
    expect(alias.windowTokens).toBe(128000);
    const missing = await loadSettings({ fetchImpl: asFetch(async () => okResponse({})) });
    expect(missing.windowTokens).toBeNull();
    const bad = await loadSettings({
      fetchImpl: asFetch(async () => okResponse({ baseUrl: 'https://x', model: 'm', window: 0 })),
    });
    expect(bad.windowTokens).toBeNull();
  });

  it('HTTP 错误上抛', async () => {
    await expect(
      loadSettings({
        fetchImpl: asFetch(async () => ({ ok: false, status: 500, json: async () => ({}) })),
      }),
    ).rejects.toThrow(/500/);
  });
});

describe('saveSettings', () => {
  it('POST JSON：只在 key 非空时带上行；返回掩码', async () => {
    let posted: unknown = null;
    const saved = await saveSettings(
      { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'sk-abc123456' },
      {
        fetchImpl: asFetch(async (_url: string, opts: any) => {
          posted = JSON.parse(opts.body);
          return okResponse({
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-v4-flash',
            apiKey: 'sk-a…3456',
          });
        }),
      },
    );
    expect(posted).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-abc123456',
    });
    expect(saved.keyConfigured).toBe(true);
    // 响应后不保留明文（模块内已丢弃）：序列化结果里没有完整 key
    expect(JSON.stringify(saved)).not.toContain('sk-abc123456');
  });

  it('apiKey 为空 → 不发送 key 字段（不改密钥）', async () => {
    let posted: unknown = null;
    await saveSettings(
      { baseUrl: 'https://new', model: 'm2', apiKey: '' },
      {
        fetchImpl: asFetch(async (_url: string, opts: any) => {
          posted = JSON.parse(opts.body);
          return okResponse({ baseUrl: 'https://new', model: 'm2', apiKey: null });
        }),
      },
    );
    const rec = posted as Record<string, unknown>;
    expect(rec).toEqual({ baseUrl: 'https://new', model: 'm2' });
    expect('apiKey' in rec).toBe(false);
  });

  it('默认值兜底 + 非 2xx 上抛', async () => {
    let posted: unknown = null;
    await saveSettings(
      { baseUrl: '', model: '', apiKey: 'k' },
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
        { baseUrl: 'x', model: 'y', apiKey: '' },
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

  it('saveReasoning：POST 恰一个 {reasoning} 补丁字段；返回归一快照', async () => {
    let posted: unknown = null;
    const saved = await saveReasoning('high', {
      fetchImpl: asFetch(async (_url: string, opts: any) => {
        posted = JSON.parse(opts.body);
        return okResponse({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          reasoning: 'high',
        });
      }),
    });
    expect(posted).toEqual({ reasoning: 'high' });
    expect(saved.reasoning).toBe('high');
    expect('apiKey' in (posted as Record<string, unknown>)).toBe(false);
  });

  it('saveReasoning：非 2xx 上抛（调用方回滚 toast 前提）', async () => {
    await expect(
      saveReasoning('low', {
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

  it('savePermission：POST 恰一个 {permission} 补丁字段；返回归一快照（确认后服务端回 confirmedAt）', async () => {
    let posted: unknown = null;
    const saved = await savePermission('full-access', {
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
    expect(posted).toEqual({ permission: 'full-access' });
    expect(saved.permission).toBe('full-access');
    expect(saved.permissionConfirmedAt).toBe(1_728_000_000_000);
    expect('apiKey' in (posted as Record<string, unknown>)).toBe(false);
  });

  it('savePermission：非法档位先归一（如大写/未知 → workspace-write 上行）', async () => {
    let posted: unknown = null;
    await savePermission('FULL-ACCESS', {
      fetchImpl: asFetch(async (_url: string, opts: any) => {
        posted = JSON.parse(opts.body);
        return okResponse({ baseUrl: 'x', model: 'm', permission: 'workspace-write' });
      }),
    });
    expect(posted).toEqual({ permission: 'workspace-write' });
  });

  it('savePermission：非 2xx 上抛 —— 调用方回滚路径（重读 GET + toast）的失败前提', async () => {
    await expect(
      savePermission('read-only', {
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
