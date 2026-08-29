import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_DEFAULTS,
  SUBAGENT_PARALLEL_MAX,
  SUBAGENT_PARALLEL_MIN,
  SUBAGENT_LS_KEY,
  WORKFLOW_API_URL,
  SUBAGENT_LOCAL_NOTE,
  SUBAGENT_SYNC_FAILED_TOAST,
  SKILLS_DEGRADED_NOTE,
  MCP_DEGRADED_NOTE,
  normalizeMcpServers,
  normalizeParallel,
  normalizeSkillsList,
  normalizeSubagentPref,
  normalizeWorkflowPref,
  loadSubagentPref,
  loadWorkflowPref,
  saveSubagentPref,
  syncWorkflowPref,
  splitMcpArgs,
  SKILL_INSTALL_API_URL,
  SKILL_INSTALL_BUSY,
  SKILL_INSTALL_URL_PLACEHOLDER,
  SKILL_INSTALL_PATH_PLACEHOLDER,
  SKILL_INSTALL_HELP_URL,
  SKILL_INSTALL_HELP_PATH,
  SKILL_INSTALL_NOTE_DIR,
  SKILL_INSTALL_EMPTY_SOURCE,
  SKILL_INSTALL_REJECTED_TEXT,
  SKILL_INSTALL_UNSUPPORTED_TEXT,
  SKILL_INSTALL_FAILED_TEXT,
  SKILL_INSTALL_ERRORS,
  normalizeSkillErrorKind,
  skillInstallErrorText,
  normalizeSkillSource,
  installSkill,
} from '../../src/ui/web/extensions.js';

/**
 * 设置页扩展区纯逻辑（extensions.js）：Subagent 工作流（/api/workflow 同步 + 降级）、
 * Skills/MCP 契约形状。契约形状 {skills:[...]} / {servers:[...]} / workflow
 * {subagentsEnabled,maxParallel}（任务书），宽容路径（裸数组 / 双形状）一并覆盖。
 */

interface StorageLike {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}

/** 测试用「极简 Response 假件」（与 api.test.ts 同法；运行时不依赖 DOM）。 */
function asFetch(fn: unknown): typeof fetch {
  return fn as unknown as typeof fetch;
}

function okResponse(json: unknown, status = 200) {
  return { ok: true, status, json: async () => json };
}

function errResponse(status: number, json: unknown = {}) {
  return { ok: false, status, json: async () => json };
}

function storageWith(initial = ''): StorageLike & { _value: () => string } {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_k: string, v: string) => {
      value = v;
    },
    _value: () => value,
  };
}

describe('normalizeParallel（1-4 步进，禁 0）', () => {
  it('合法值原样通过', () => {
    expect(normalizeParallel(1)).toBe(1);
    expect(normalizeParallel(2)).toBe(2);
    expect(normalizeParallel(4)).toBe(4);
  });

  it('小数四舍五入后 clamp', () => {
    expect(normalizeParallel(2.6)).toBe(3);
    expect(normalizeParallel(1.49)).toBe(1);
    expect(normalizeParallel(9)).toBe(SUBAGENT_PARALLEL_MAX);
  });

  it('0/负值/非数一律回落 fallback（默认 2）', () => {
    expect(normalizeParallel(0)).toBe(SUBAGENT_DEFAULTS.parallel);
    expect(normalizeParallel(-3)).toBe(SUBAGENT_DEFAULTS.parallel);
    expect(normalizeParallel(NaN)).toBe(SUBAGENT_DEFAULTS.parallel);
    expect(normalizeParallel(undefined)).toBe(SUBAGENT_DEFAULTS.parallel);
    expect(normalizeParallel('abc')).toBe(SUBAGENT_DEFAULTS.parallel);
    const fb: number = 4;
    expect(normalizeParallel(0, fb)).toBe(4); // 自定义 fallback
  });
});

describe('normalizeSubagentPref / load / save（显式开 → 数值越界兜底）', () => {
  it('缺省/空值 → 默认 {enabled:true, parallel:2}', () => {
    expect(normalizeSubagentPref(undefined)).toEqual({ enabled: true, parallel: 2 });
    expect(normalizeSubagentPref({})).toEqual({ enabled: true, parallel: 2 });
  });

  it('关闭态与并行数各自保留；并行数越界归一', () => {
    expect(normalizeSubagentPref({ enabled: false, parallel: 3 })).toEqual({
      enabled: false,
      parallel: 3,
    });
    expect(normalizeSubagentPref({ enabled: true, parallel: 9 }).parallel).toBe(4);
    expect(normalizeSubagentPref({ enabled: true, parallel: 0 }).parallel).toBe(2);
  });

  it('load：存储缺失/JSON 坏/读异常一律回落默认（不 throw）', () => {
    expect(loadSubagentPref(storageWith(''))).toEqual({ enabled: true, parallel: 2 });
    expect(loadSubagentPref(storageWith('not-json'))).toEqual({ enabled: true, parallel: 2 });
    expect(loadSubagentPref(null)).toEqual({ enabled: true, parallel: 2 });
  });

  it('save：写入键 + 归一化值；写异常静默（不 throw），返回归一值', () => {
    const s = storageWith();
    const saved = saveSubagentPref(s, { enabled: false, parallel: '3.6' });
    expect(saved).toEqual({ enabled: false, parallel: 4 });
    expect(s._value()).toBe(JSON.stringify(saved));
    expect(JSON.parse(s._value()).parallel).toBeLessThanOrEqual(SUBAGENT_PARALLEL_MAX);
    // 写失败：隐私模式
    const throwing = {
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as StorageLike;
    expect(() => saveSubagentPref(throwing, { enabled: true, parallel: 2 })).not.toThrow();
    // 往返一致性（enabled=false 是持久化的关键）
    expect(loadSubagentPref(s)).toEqual({ enabled: false, parallel: 4 });
  });

  it('存储键 = 任务书命名 devmate.ui.subagents', () => {
    expect(SUBAGENT_LS_KEY).toBe('devmate.ui.subagents');
  });
});

describe('normalizeSkillsList（{skills:[{id,name,summary,enabled}]}）', () => {
  it('契约对象与裸数组双兼容；坏项跳过，无 id 项丢弃', () => {
    const res = {
      skills: [
        { id: 'rev-patch', name: '补丁复核', summary: '核对 diff', enabled: true },
        { id: 'orphan' }, // 无 name → 名 = id
        null,
        { name: 'no-id' }, // 无 id → 丢弃
        42,
      ],
    };
    const list = normalizeSkillsList(res);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      id: 'rev-patch',
      name: '补丁复核',
      summary: '核对 diff',
      enabled: true,
      origin: 'bundled',
    });
    expect(list[1]).toEqual({
      id: 'orphan',
      name: 'orphan',
      summary: '',
      enabled: false,
      origin: 'bundled',
    });
  });

  it('null/缺 skills 字段 → []；裸数组支持', () => {
    expect(normalizeSkillsList(null)).toEqual([]);
    expect(normalizeSkillsList({})).toEqual([]);
    const arr = normalizeSkillsList([{ id: 'a', name: 'A' }]);
    expect(arr[0]?.id).toBe('a');
  });

  it("origin 白名单：'user' 原样、'bundled' 原样、缺失/未知 → bundled（仅 user 渲染徽章）", () => {
    const list = normalizeSkillsList({
      skills: [
        { id: 'a', name: 'A', origin: 'user' },
        { id: 'b', name: 'B', origin: 'bundled' },
        { id: 'c', name: 'C' }, // 缺省
        { id: 'd', name: 'D', origin: 'weird' }, // 未知
      ],
    });
    expect(list.map((s) => s.origin)).toEqual(['user', 'bundled', 'bundled', 'bundled']);
  });
});

describe('技能安装表单（normalizeSkillSource / installSkill / 错误 kind 白名单映射）', () => {
  it('normalizeSkillSource：trim；非字符串/空 → ""（按钮禁用 + 提交前拦截）', () => {
    expect(normalizeSkillSource('  https://example.com/sk/SKILL.md\n')).toBe(
      'https://example.com/sk/SKILL.md',
    );
    expect(normalizeSkillSource('   ')).toBe('');
    expect(normalizeSkillSource(null as unknown as string)).toBe('');
    expect(normalizeSkillSource(42 as unknown as string)).toBe('');
  });

  it('安装端点常量 = 契约路径', () => {
    expect(SKILL_INSTALL_API_URL).toBe('/api/skills/install');
  });

  it('installSkill 成功：POST {source}；回体 id 与 {skill:{id}} 双形状；无 id → null', async () => {
    const calls: string[] = [];
    const fetchImpl = asFetch(async (url: string, opts: unknown) => {
      calls.push(`${url}|${(opts as { body: string }).body}`);
      return okResponse({ id: 'my-skill' });
    });
    const r1 = await installSkill({ source: ' /tmp/s1 ' }, { fetchImpl });
    expect(r1).toEqual({ ok: true, id: 'my-skill' });
    expect(calls[0]).toBe('/api/skills/install|{"source":"/tmp/s1"}');
    const r2 = await installSkill(
      { source: '/tmp/s2' },
      { fetchImpl: asFetch(async () => okResponse({ skill: { id: 's2' } })) },
    );
    expect(r2).toEqual({ ok: true, id: 's2' });
    const r3 = await installSkill(
      { source: '/tmp/s3' },
      { fetchImpl: asFetch(async () => okResponse({ ok: true })) },
    );
    expect(r3).toEqual({ ok: true, id: null });
  });

  it('installSkill 空来源：直接 {ok:false,error:{kind:"invalid-source"}}，不发请求', async () => {
    let called = false;
    const r = await installSkill({
      source: '  ',
      fetchImpl: asFetch(async () => {
        called = true;
        return okResponse({});
      }),
    } as never as { source: string });
    expect(r.ok).toBe(false);
    expect((r.error as { kind: string }).kind).toBe('invalid-source');
    expect(called).toBe(false);
  });

  it('installSkill 服务端 400/{error:{type}}：ok=false 且 error 携带契约错误体（映射用）', async () => {
    const r = await installSkill(
      { source: 'https://x.dev/x' },
      { fetchImpl: asFetch(async () => errResponse(400, { error: { type: 'unsupported-host' } })) },
    );
    expect(r.ok).toBe(false);
    expect((r.error as { data: { error: { type: string } } }).data.error.type).toBe(
      'unsupported-host',
    );
  });

  it('installSkill 网络异常（fetch 抛）：ok=false，绝不 throw', async () => {
    const r = await installSkill({
      source: 'x',
      fetchImpl: asFetch(async () => {
        throw new TypeError('Failed to fetch');
      }),
    } as never as { source: string });
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(TypeError);
  });

  it('normalizeSkillErrorKind：服务端 {error:{type}} 形状优先；其余位置宽容；未知 → null', () => {
    expect(
      normalizeSkillErrorKind({
        status: 400,
        data: { error: { type: 'too-large', message: 'x' } },
      }),
    ).toBe('too-large');
    expect(normalizeSkillErrorKind({ status: 400, data: { kind: 'invalid-source' } })).toBe(
      'invalid-source',
    );
    expect(normalizeSkillErrorKind({ kind: 'write-failed' })).toBe('write-failed');
    expect(normalizeSkillErrorKind({ status: 400, data: { error: 'skill-exists' } })).toBe(
      'skill-exists',
    );
    expect(normalizeSkillErrorKind({ status: 400, data: { error: 'bogus-kind' } })).toBeNull();
    expect(normalizeSkillErrorKind({ status: 400 })).toBeNull();
    expect(normalizeSkillErrorKind(null)).toBeNull();
  });

  it('skillInstallErrorText：六个 kind 全映射（kind 优先）——中文明文案零端点路径', () => {
    const cases: Array<[string, string]> = [
      ['invalid-source', '来源无效'],
      ['fetch-failed', '获取技能失败'],
      ['too-large', '技能文件过大'],
      ['unsupported-host', '不支持的下载来源'],
      ['skill-exists', '技能已存在'],
      ['write-failed', '写入失败'],
    ];
    for (const [kind, prefix] of cases) {
      const text = skillInstallErrorText({ status: 413, data: { error: { type: kind } } });
      expect(text.startsWith(prefix)).toBe(true);
      expect(text).not.toMatch(/\/api\//);
    }
  });

  it('skillInstallErrorText：status 阶梯（409 已存在 / 413 过大 / 502 获取失败 / 400/403 通用 / 404 未支持 / 其余通用）', () => {
    expect(skillInstallErrorText({ status: 409 })).toBe(SKILL_INSTALL_ERRORS['skill-exists']);
    expect(skillInstallErrorText({ status: 413 })).toBe(SKILL_INSTALL_ERRORS['too-large']);
    expect(skillInstallErrorText({ status: 502 })).toBe(SKILL_INSTALL_ERRORS['fetch-failed']);
    expect(skillInstallErrorText({ status: 400 })).toBe(SKILL_INSTALL_REJECTED_TEXT);
    expect(skillInstallErrorText({ status: 403 })).toBe(SKILL_INSTALL_REJECTED_TEXT);
    expect(skillInstallErrorText({ status: 404 })).toBe(SKILL_INSTALL_UNSUPPORTED_TEXT);
    expect(skillInstallErrorText({ status: 500 })).toBe(SKILL_INSTALL_FAILED_TEXT);
    expect(skillInstallErrorText(new TypeError('Failed to fetch'))).toBe(SKILL_INSTALL_FAILED_TEXT);
    expect(skillInstallErrorText({})).toBe(SKILL_INSTALL_FAILED_TEXT);
  });

  it('安装表单文案常量为单一来源且零端点路径（placeholder/帮助/目录说明/安装中/空来源）', () => {
    const ALL = [
      SKILL_INSTALL_URL_PLACEHOLDER,
      SKILL_INSTALL_PATH_PLACEHOLDER,
      SKILL_INSTALL_HELP_URL,
      SKILL_INSTALL_HELP_PATH,
      SKILL_INSTALL_NOTE_DIR,
      SKILL_INSTALL_BUSY,
      SKILL_INSTALL_EMPTY_SOURCE,
      SKILL_INSTALL_REJECTED_TEXT,
      SKILL_INSTALL_UNSUPPORTED_TEXT,
      SKILL_INSTALL_FAILED_TEXT,
      ...Object.values(SKILL_INSTALL_ERRORS),
    ];
    for (const text of ALL) expect(text).not.toMatch(/\/api\//);
    expect(SKILL_INSTALL_BUSY).toBe('安装中…');
    expect(SKILL_INSTALL_URL_PLACEHOLDER).toContain('raw.githubusercontent.com');
  });
});

describe('normalizeMcpServers（{servers:[{name,command?,status,enabled}]}）', () => {
  it('契约对象归一；status 白名单（configured|unused），未知回落 unused', () => {
    const list = normalizeMcpServers({
      servers: [
        { name: 'filesystem', command: 'npx @mcp/server', status: 'configured', enabled: true },
        { name: 'empty', command: '  ', status: 'bogus', enabled: false },
        { name: 'no-cmd', status: 'unused', enabled: true },
      ],
    });
    expect(list[0]).toEqual({
      name: 'filesystem',
      command: 'npx @mcp/server',
      status: 'configured',
      enabled: true,
    });
    expect(list[1]).toEqual({ name: 'empty', command: null, status: 'unused', enabled: false });
    expect(list[2]?.command).toBeNull();
  });

  it('缺 name 项丢弃；null → []；裸数组支持', () => {
    expect(normalizeMcpServers({ servers: [{ command: 'npx x' }] })).toEqual([]);
    expect(normalizeMcpServers(null)).toEqual([]);
    const arr = normalizeMcpServers([{ name: 'a' }]);
    expect(arr[0]?.name).toBe('a');
  });
});

describe('normalizeMcpServers 无 status 形状（契约漂移修复：前端不依赖 status，宽容接受）', () => {
  it('服务端不下发 status → status 缺省 unused（不报错，enabled 照常归一）', () => {
    const list = normalizeMcpServers({
      servers: [{ name: 'filesystem', command: 'npx @mcp/server', enabled: true }],
    });
    expect(list[0]).toEqual({
      name: 'filesystem',
      command: 'npx @mcp/server',
      status: 'unused',
      enabled: true,
    });
  });

  it('status 若仍下发：configured/unused 白名单原样保留（宽容兼容旧形状，不破坏）', () => {
    const list = normalizeMcpServers({ servers: [{ name: 'a', status: 'configured' }] });
    expect(list[0]?.status).toBe('configured');
  });
});

describe('normalizeWorkflowPref（服务端 {subagentsEnabled,maxParallel} / 本地 {enabled,parallel} 双形状）', () => {
  it('服务端形状 → 内部 {enabled,parallel}：false 保真、越界/0 clamp 兜底', () => {
    expect(normalizeWorkflowPref({ subagentsEnabled: false, maxParallel: 3 })).toEqual({
      enabled: false,
      parallel: 3,
    });
    expect(normalizeWorkflowPref({ subagentsEnabled: true, maxParallel: 9 }).parallel).toBe(4);
    expect(normalizeWorkflowPref({ subagentsEnabled: true, maxParallel: 0 }).parallel).toBe(2);
    expect(normalizeWorkflowPref({ subagentsEnabled: true, maxParallel: -1 }).parallel).toBe(2);
  });

  it('缺省/空/坏值 → 默认 {true,2}；本地形状 {enabled,parallel} 一并接受（宽容）', () => {
    expect(normalizeWorkflowPref(undefined)).toEqual(SUBAGENT_DEFAULTS);
    expect(normalizeWorkflowPref({})).toEqual(SUBAGENT_DEFAULTS);
    expect(normalizeWorkflowPref({ subagentsEnabled: 'yes' })).toEqual(SUBAGENT_DEFAULTS);
    expect(normalizeWorkflowPref({ enabled: false, parallel: 4 })).toEqual({
      enabled: false,
      parallel: 4,
    });
  });
});

describe('loadWorkflowPref（GET /api/workflow 三路径：成功 / 失败 / 缺端点）', () => {
  it('成功：GET 命中 → source=server，回显服务端值 {enabled,parallel} 映射', async () => {
    const res = await loadWorkflowPref({
      fetchImpl: asFetch(async () => okResponse({ subagentsEnabled: false, maxParallel: 3 })),
      storageLike: storageWith(),
    });
    expect(res.source).toBe('server');
    expect(res.value).toEqual({ enabled: false, parallel: 3 });
  });

  it('失败（服务端 500）：降级 localStorage（无本地值时默认 {true,2}），绝不 throw', async () => {
    const res = await loadWorkflowPref({
      fetchImpl: asFetch(async () => errResponse(500, { error: 'boom' })),
      storageLike: storageWith(),
    });
    expect(res.source).toBe('local');
    expect(res.value).toEqual({ enabled: true, parallel: 2 });
  });

  it('缺端点（404）：降级 localStorage（保留已有本地偏好）', async () => {
    const s = storageWith(JSON.stringify({ enabled: false, parallel: 4 }));
    const res = await loadWorkflowPref({
      fetchImpl: asFetch(async () => errResponse(404)),
      storageLike: s,
    });
    expect(res.source).toBe('local');
    expect(res.value).toEqual({ enabled: false, parallel: 4 });
  });

  it('网络异常（fetch 抛 TypeError）：同样优雅降级，本地坏 JSON → 默认', async () => {
    const res = await loadWorkflowPref({
      fetchImpl: asFetch(async () => {
        throw new TypeError('Failed to fetch');
      }),
      storageLike: storageWith('not-json'),
    });
    expect(res.source).toBe('local');
    expect(res.value).toEqual(SUBAGENT_DEFAULTS);
  });
});

describe('syncWorkflowPref（POST /api/workflow 混合字段部分提交）', () => {
  it('enabled 变更：只提交 {subagentsEnabled}（不含 maxParallel）；成功回读服务端回体', async () => {
    const calls: Array<{ body: string }> = [];
    const fetchImpl = asFetch(async (_url: string, opts: unknown) => {
      calls.push(opts as { body: string });
      return okResponse({ subagentsEnabled: false, maxParallel: 3 });
    });
    const r = await syncWorkflowPref({ enabled: false }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ enabled: false, parallel: 3 });
    expect(JSON.parse(calls[0]!.body)).toEqual({ subagentsEnabled: false });
  });

  it('parallel 变更：只提交 {maxParallel}；0/负 → 本地兜底 2 后才提交（禁 0 契约）', async () => {
    const calls: Array<{ body: string }> = [];
    const fetchImpl = asFetch(async (_url: string, opts: unknown) => {
      calls.push(opts as { body: string });
      return okResponse({ subagentsEnabled: true, maxParallel: 2 });
    });
    const r0 = await syncWorkflowPref({ parallel: 0 }, { fetchImpl });
    expect(JSON.parse(calls[0]!.body)).toEqual({ maxParallel: 2 });
    await syncWorkflowPref({ parallel: 4 }, { fetchImpl });
    expect(JSON.parse(calls[1]!.body)).toEqual({ maxParallel: 4 });
    expect(r0.ok).toBe(true);
  });

  it('服务端 400（校验拒绝）：ok=false 且 error.status=400 —— 调用方据此回滚重读', async () => {
    const fetchImpl = asFetch(async () =>
      errResponse(400, { error: 'maxParallel must be an integer in 1-4' }),
    );
    const r = await syncWorkflowPref({ parallel: 7 }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect((r.error as { status?: number }).status).toBe(400);
  });

  it('端点常量 = 服务端实现路径（GET 与 POST 同源）', () => {
    expect(WORKFLOW_API_URL).toBe('/api/workflow');
  });
});

describe('文案纪律：扩展区用户可见文案零端点路径（字段变更回滚 / 降级解说单一来源）', () => {
  const USER_VISIBLE = [
    SKILLS_DEGRADED_NOTE,
    MCP_DEGRADED_NOTE,
    SUBAGENT_SYNC_FAILED_TOAST,
    SUBAGENT_LOCAL_NOTE,
  ];

  it('skills/mcp 降级文案（toggle 失败重读再失败同款）无 /api/ 字样', () => {
    expect(SKILLS_DEGRADED_NOTE).toBe('暂无可用技能。稍后重试或检查服务状态');
    expect(MCP_DEGRADED_NOTE).toBe('暂无可用服务器。稍后重试或检查服务状态');
    for (const s of USER_VISIBLE) expect(s).not.toMatch(/\/api\//);
  });

  it('workflow 回滚提示 = 「同步失败，已还原」；降级旁注含「未同步（仅本地）」前缀', () => {
    expect(SUBAGENT_SYNC_FAILED_TOAST).toBe('同步失败，已还原');
    expect(SUBAGENT_LOCAL_NOTE.startsWith('未同步（仅本地）')).toBe(true);
  });
});

describe('splitMcpArgs（args 文本行 → 参数数组）', () => {
  it('空白（空格/Tab/换行）分隔；空串 → []', () => {
    expect(splitMcpArgs('--port 8080\n--host 127.0.0.1')).toEqual([
      '--port',
      '8080',
      '--host',
      '127.0.0.1',
    ]);
    expect(splitMcpArgs('a\tb   c')).toEqual(['a', 'b', 'c']);
    expect(splitMcpArgs('')).toEqual([]);
    expect(splitMcpArgs('   ')).toEqual([]);
    expect(splitMcpArgs(undefined)).toEqual([]);
  });
});

describe('normalizeSubagentPref 的平行数下界（SUBAGENT_PARALLEL_MIN=1 与禁 0 契约）', () => {
  it('0 永远被拒（用户裁定禁 0 输入）', () => {
    const v = normalizeSubagentPref({ enabled: true, parallel: 0 });
    expect(v.parallel).not.toBe(0);
    expect(v.parallel).toBeGreaterThanOrEqual(SUBAGENT_PARALLEL_MIN);
  });
});
