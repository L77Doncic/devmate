import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_IDS,
  PROVIDER_PRESETS,
  ProviderAdapterError,
  buildRequest,
  defaultProviderPreset,
  getProviderPreset,
  normalizeFinishReason,
  normalizeError,
} from '../../src/core/llm/index.js';
import type { ChatRequest, WireRequest } from '../../src/core/llm/index.js';

/**
 * Provider Adapter 公共接口规格（接缝 S2，ADR-0002）。
 * 只打公共 API：buildRequest / normalizeFinishReason / normalizeError /
 * PROVIDER_PRESETS / getProviderPreset / defaultProviderPreset / PROVIDER_IDS。
 * 预期值逐字来自 openai-compatible-api-spec.md（§1.3/§1.6/§3.3/§4.4/§5.1/§5.2/§5.3/§6.1）
 * 与 notes/dashscope-qwen-compat-notes.md（§1/§3/§5），不复算。
 */

// ---------- 测试脚手架：unified 请求构造 + wire 访问助手 ----------

function unified(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'system', content: 'sys' }],
    ...over,
  };
}

/** 取 wire 消息链中第 index 条（绝大多数断言的是 assistant 角色）——替代重复的
 * `(req.body.messages as Array<Record<string, unknown>>)[i]` 长链条。 */
function assistantWire(req: WireRequest, index = 0): Record<string, unknown> {
  return (req.body.messages as Array<Record<string, unknown>>)[index] ?? {};
}

// ---------- 切片 a：DeepSeek 主默认 ----------

describe('buildRequest：DeepSeek 主默认（切片 a）', () => {
  it('主默认预设 = DeepSeek：base_url https://api.deepseek.com（§5.1 官方 curl 无 /v1）、默认模型 deepseek-v4-flash（§5.1）', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('deepseek');
    const p = defaultProviderPreset();
    expect(p.id).toBe('deepseek');
    expect(p.baseUrl).toBe('https://api.deepseek.com');
    expect(p.defaultModel).toBe('deepseek-v4-flash');
  });

  it('工具场景产出 tool_choice auto（§1.4 有 tools 时 auto 为默认）+ stream:true（§1.5）+ thinking 默认开启（§1.6）', () => {
    const req = buildRequest(
      unified({
        tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' } } }],
        toolChoice: 'auto',
      }),
      PROVIDER_PRESETS.deepseek,
    );
    expect(req.baseUrl).toBe('https://api.deepseek.com');
    expect(req.body.stream).toBe(true);
    expect(req.body.tool_choice).toBe('auto');
    expect(req.body.thinking).toEqual({ type: 'enabled' });
    expect(req.body.messages).toEqual([{ role: 'system', content: 'sys' }]);
  });

  it('思考模式开启时 temperature/top_p 被静默消除——发送前剔除而非透传（§5.2 行 1/3）', () => {
    const req = buildRequest(unified({ temperature: 0.3, topP: 0.8 }), PROVIDER_PRESETS.deepseek);
    expect('temperature' in req.body).toBe(false);
    expect('top_p' in req.body).toBe(false);
  });

  it('思考关闭（thinkingEnabled:false）时 temperature/top_p 保留并显式发 thinking:disabled（§1.6）', () => {
    const req = buildRequest(unified({ temperature: 0.3, topP: 0.8 }), {
      ...PROVIDER_PRESETS.deepseek,
      thinkingEnabled: false,
    });
    expect(req.body.thinking).toEqual({ type: 'disabled' });
    expect(req.body.temperature).toBe(0.3);
    expect(req.body.top_p).toBe(0.8);
  });

  it('历史 reasoning_content 原样保留回传（§3.3 DeepSeek 必须回传；携带 tools 时要求每轮回传）', () => {
    const req = buildRequest(
      unified({
        tools: [{ type: 'function', function: { name: 'run' } }],
        messages: [
          { role: 'system', content: 'sys' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'call_x',
                type: 'function',
                function: { name: 'run', arguments: '{"a":1}' },
              },
            ],
            reasoningContent: '先想了一步：稳妥起见用双引号。',
          },
        ],
      }),
      PROVIDER_PRESETS.deepseek,
    );
    const assistant = assistantWire(req, 1);
    expect(assistant.reasoning_content).toBe('先想了一步：稳妥起见用双引号。');
    expect(assistant.tool_calls).toBeDefined();
  });
});

// ---------- 切片 a2：wire 序列化形状（自 client.test.ts 迁来；序列化归 adapter） ----------

describe('buildRequest：wire 形状（自 client.test.ts 迁来，ADR-0001 修订）', () => {
  it('全字段请求 → wire 体：messages 四角色/tools/tool_choice/temperature/stream_options（OpenAI 无剔除）', () => {
    const req = buildRequest(
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: '北京天气?' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'call_xxx',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"北京"}' },
              },
            ],
          },
          { role: 'tool', content: '晴，25°C', toolCallId: 'call_xxx' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '查天气',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          },
        ],
        toolChoice: 'auto',
        temperature: 0.2,
        streamOptions: { includeUsage: true },
      },
      PROVIDER_PRESETS.openai,
    );
    expect(req.body).toEqual({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: '北京天气?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_xxx',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"北京"}' },
            },
          ],
        },
        { role: 'tool', content: '晴，25°C', tool_call_id: 'call_xxx' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('topP/maxTokens/stop/parallelToolCalls 映射为 snake_case wire 字段（§5.2 行 2 命名按预设）', () => {
    const req = buildRequest(
      unified({ topP: 0.9, maxTokens: 1024, stop: ['[END]'], parallelToolCalls: false }),
      PROVIDER_PRESETS.openai,
    );
    expect(req.body).toEqual({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'system', content: 'sys' }],
      top_p: 0.9,
      max_completion_tokens: 1024,
      stop: ['[END]'],
      parallel_tool_calls: false,
      stream: true,
    });
  });

  it.each([
    ['openai', 'max_completion_tokens', PROVIDER_PRESETS.openai],
    ['deepseek', 'max_tokens', PROVIDER_PRESETS.deepseek],
    ['dashscope', 'max_tokens', PROVIDER_PRESETS.dashscope],
    ['glm', 'max_tokens', PROVIDER_PRESETS.glm],
    ['kimi', 'max_completion_tokens', PROVIDER_PRESETS.kimi],
  ])('%s：maxTokens 映射为 %s（§5.2 行 2）', (_id, field, preset) => {
    const req = buildRequest(unified({ maxTokens: 2048 }), preset);
    expect(req.body[field]).toBe(2048);
    expect('max_tokens' in req.body).toBe(field === 'max_tokens');
    expect('max_completion_tokens' in req.body).toBe(field === 'max_completion_tokens');
  });
});

// ---------- 切片 a3：WireRequest.meta 剔除可观测（ADR-0002「决策白的」） ----------

describe('WireRequest.meta：被剔除参数的观测通道', () => {
  it('Kimi 剔除的 temperature/top_p 记录进 meta.strippedParams（§5.2 行 1/3，wire 键名）', () => {
    const req = buildRequest(unified({ temperature: 1.0, topP: 0.95 }), PROVIDER_PRESETS.kimi);
    expect(req.meta).toEqual({ strippedParams: ['temperature', 'top_p'] });
    expect('temperature' in req.body).toBe(false);
    expect('top_p' in req.body).toBe(false);
  });

  it('DeepSeek 思考开启时剔除同记录；无剔除时不带 meta', () => {
    const ds = buildRequest(unified({ temperature: 0.3 }), PROVIDER_PRESETS.deepseek);
    expect(ds.meta).toEqual({ strippedParams: ['temperature'] });
    const clean = buildRequest(unified(), PROVIDER_PRESETS.kimi);
    expect(clean.meta).toBeUndefined();
  });
});

// ---------- 切片 a4：preset 数据完备性（strictDefault / 死数据） ----------

describe('preset 数据完备性（strict 缺省矩阵/剔除集）', () => {
  it('strictDefault 按 §1.3 表/§5.2 行 6 权威矩阵：OpenAI/DeepSeek=false、Kimi=true、GLM/DashScope 未提供该字段', () => {
    expect(PROVIDER_PRESETS.openai.strictDefault).toBe(false);
    expect(PROVIDER_PRESETS.deepseek.strictDefault).toBe(false);
    expect(PROVIDER_PRESETS.kimi.strictDefault).toBe(true);
    expect(PROVIDER_PRESETS.glm.strictDefault).toBeUndefined();
    expect(PROVIDER_PRESETS.dashscope.strictDefault).toBeUndefined();
  });

  it('DeepSeek 思考剔除集不含 ChatRequest 无载体的 penalties（死数据剔除；§1.6 仅可传字段入表）', () => {
    expect(PROVIDER_PRESETS.deepseek.thinkingIgnoredSamplingParams).toEqual([
      'temperature',
      'top_p',
    ]);
  });
});

// ---------- 切片 b：Kimi 采样参数白名单 + strict 默认 true ----------

describe('buildRequest：Kimi（切片 b）', () => {
  it('固定采样参数剔除：temperature（固定 1.0）/top_p（固定 0.95）传了也删（§5.2 行 1/3），penalties 无 ChatRequest 载体不再透传', () => {
    const req = buildRequest(unified({ temperature: 1.0, topP: 0.95 }), PROVIDER_PRESETS.kimi);
    expect('temperature' in req.body).toBe(false);
    expect('top_p' in req.body).toBe(false);
  });

  it('strict 默认 true：缺省时对每个函数注入 strict:true（§1.3：Kimi 不传等价于 true，与 OpenAI/DeepSeek 默认 false 相反——适配层呈显）', () => {
    const req = buildRequest(
      unified({
        tools: [
          {
            type: 'function',
            function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
          },
        ],
      }),
      PROVIDER_PRESETS.kimi,
    );
    const tools = req.body.tools as Array<{ function: { strict?: boolean } }>;
    expect(tools[0]?.function.strict).toBe(true);
  });

  it('max_tokens 已弃用 → max_completion_tokens（§5.2 行 2）；max_tokens 不出现', () => {
    const req = buildRequest(unified({ maxTokens: 8192 }), PROVIDER_PRESETS.kimi);
    expect(req.body.max_completion_tokens).toBe(8192);
    expect('max_tokens' in req.body).toBe(false);
  });

  it('OpenAI 同规则：max_tokens → max_completion_tokens（§5.2 行 2，o 系不兼容 max_tokens）', () => {
    const req = buildRequest(unified({ maxTokens: 4096 }), PROVIDER_PRESETS.openai);
    expect(req.body.max_completion_tokens).toBe(4096);
    expect('max_tokens' in req.body).toBe(false);
  });

  it('历史 reasoning_content 原样保留（§3.3 Kimi：务必原样保留，否则模型可能丢失推理上下文）', () => {
    const req = buildRequest(
      unified({
        messages: [
          { role: 'system', content: 'sys' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
            reasoningContent: 'K3 推理链',
          },
        ],
      }),
      PROVIDER_PRESETS.kimi,
    );
    const assistant = assistantWire(req, 1);
    expect(assistant.reasoning_content).toBe('K3 推理链');
  });

  it('tool_choice:required 允许：预设值域含 required（§5.2 行 4 auto/none/required/named）——不支持 required 的是模型级例外 k2.6/k2.7-code，默认模型 kimi-k3 不受限', () => {
    const req = buildRequest(unified({ toolChoice: 'required' }), PROVIDER_PRESETS.kimi);
    expect(req.body.tool_choice).toBe('required');
  });
});

// ---------- 切片 c：Qwen/DashScope ----------

describe('buildRequest：DashScope（切片 c）', () => {
  it('base_url 为北京兼容端点 https://dashscope.aliyuncs.com/compatible-mode/v1（§5.1）', () => {
    expect(PROVIDER_PRESETS.dashscope.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const req = buildRequest(unified(), PROVIDER_PRESETS.dashscope);
    expect(req.baseUrl).toBe(PROVIDER_PRESETS.dashscope.baseUrl);
  });

  it('token 上限：unified.maxTokens 走顶层 max_tokens（兼容模式接受，笔记 §1）；Qwen 专属 max_input_tokens 走 extra_body', () => {
    const req = buildRequest(unified({ maxTokens: 4096 }), {
      ...PROVIDER_PRESETS.dashscope,
      maxInputTokens: 8192,
    });
    expect(req.body.max_tokens).toBe(4096);
    expect(req.extraBody?.max_input_tokens).toBe(8192);
    expect('max_input_tokens' in req.body).toBe(false); // 不在 body 顶层
  });

  it('enable_thinking/thinking_budget 走 extra_body（不在顶层；SDK extra_body 语义 = 序列化并入顶层，笔记 §1/§2）', () => {
    const req = buildRequest(unified(), {
      ...PROVIDER_PRESETS.dashscope,
      enableThinking: true,
      thinkingBudget: 4096,
    });
    expect(req.extraBody?.enable_thinking).toBe(true);
    expect(req.extraBody?.thinking_budget).toBe(4096);
    expect('enable_thinking' in req.body).toBe(false);
    expect('thinking_budget' in req.body).toBe(false);
  });

  it('tool_choice:required 禁发（值域无 required 记载，预期 400；笔记 §3）→ 抛错；auto/none/指定函数保留', () => {
    const p = PROVIDER_PRESETS.dashscope;
    expect(() => buildRequest(unified({ toolChoice: 'required' }), p)).toThrow(
      ProviderAdapterError,
    );
    const named = buildRequest(
      unified({ toolChoice: { type: 'function', function: { name: 'run' } } }),
      p,
    );
    expect(named.body.tool_choice).toEqual({ type: 'function', function: { name: 'run' } });
    const auto = buildRequest(unified({ toolChoice: 'auto' }), p);
    expect(auto.body.tool_choice).toBe('auto');
    const none = buildRequest(unified({ toolChoice: 'none' }), p);
    expect(none.body.tool_choice).toBe('none');
  });

  it('历史 reasoning_content 回传前剥离（笔记 §2「照单存档但回传前剥离」；回传改变计费）', () => {
    const req = buildRequest(
      unified({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'assistant', content: 'ok', reasoningContent: '想了一路' },
        ],
      }),
      PROVIDER_PRESETS.dashscope,
    );
    const assistant = assistantWire(req, 1);
    expect('reasoning_content' in assistant).toBe(false);
  });
});

// ---------- 切片 d：GLM finish_reason 词表归一 + clear_thinking ----------

describe('normalizeFinishReason：GLM 专用词 → 标准词表（切片 d）', () => {
  const glm = PROVIDER_PRESETS.glm;

  it('sensitive → content_filter（GLM 用它代替 content_filter，§4.4）；network_error → aborted；model_context_window_exceeded → aborted', () => {
    expect(normalizeFinishReason('sensitive', glm)).toBe('content_filter');
    expect(normalizeFinishReason('network_error', glm)).toBe('aborted');
    expect(normalizeFinishReason('model_context_window_exceeded', glm)).toBe('aborted');
  });

  it('标准词原样透传：stop/length/tool_calls/content_filter（§4.4）', () => {
    expect(normalizeFinishReason('stop', glm)).toBe('stop');
    expect(normalizeFinishReason('length', glm)).toBe('length');
    expect(normalizeFinishReason('tool_calls', glm)).toBe('tool_calls');
    expect(normalizeFinishReason('content_filter', glm)).toBe('content_filter');
  });

  it('OpenAI 弃用同义词 function_call → tool_calls；null 透传；未知词按 §4.4 一律提前终止 → aborted', () => {
    expect(normalizeFinishReason('function_call', glm)).toBe('tool_calls');
    expect(normalizeFinishReason(null, glm)).toBeNull();
    expect(normalizeFinishReason('weird_future_word', glm)).toBe('aborted');
  });

  it('DeepSeek 专用词 insufficient_system_resource → aborted（§4.4）；GLM 词在 DeepSeek 下不生效 → aborted（词表属于发布方）', () => {
    const ds = PROVIDER_PRESETS.deepseek;
    expect(normalizeFinishReason('insufficient_system_resource', ds)).toBe('aborted');
    expect(normalizeFinishReason('sensitive', ds)).toBe('aborted');
  });
});

describe('buildRequest：GLM（切片 d）', () => {
  it('历史 reasoning_content 回传前清除（§3.3 clear_thinking 默认 true=清除）并显式发 clear_thinking:true', () => {
    const req = buildRequest(
      unified({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'assistant', content: '有伴随文本', reasoningContent: '上一轮思考' },
        ],
      }),
      PROVIDER_PRESETS.glm,
    );
    const assistant = assistantWire(req, 1);
    expect('reasoning_content' in assistant).toBe(false);
    expect(req.body.clear_thinking).toBe(true);
  });

  it('clearThinking:false = Preserved Thinking：完整透传 reasoning_content 并明确发 clear_thinking:false（§3.3）', () => {
    const req = buildRequest(
      unified({
        messages: [{ role: 'assistant', content: null, reasoningContent: '完整未修改' }],
      }),
      { ...PROVIDER_PRESETS.glm, clearThinking: false },
    );
    const assistant = assistantWire(req, 0);
    expect(assistant.reasoning_content).toBe('完整未修改');
    expect(req.body.clear_thinking).toBe(false);
  });

  it('tool_choice 仅 auto（§5.2 行 4 参考文档声明）→ none/named 抛错，auto 放行', () => {
    expect(() => buildRequest(unified({ toolChoice: 'none' }), PROVIDER_PRESETS.glm)).toThrow(
      ProviderAdapterError,
    );
    expect(() =>
      buildRequest(
        unified({ toolChoice: { type: 'function', function: { name: 'run' } } }),
        PROVIDER_PRESETS.glm,
      ),
    ).toThrow(ProviderAdapterError);
    expect(
      buildRequest(unified({ toolChoice: 'auto' }), PROVIDER_PRESETS.glm).body.tool_choice,
    ).toBe('auto');
  });
});

// ---------- 切片 e：reasoning 三选一开关逐家验证 + 发送前归一化 ----------

describe('reasoning_content 回传策略三选一（切片 e）', () => {
  it('DeepSeek 带 tools：中间轮 assistant 的 reasoning_content 必须回传（§3.3 原文，否则 400）——keep', () => {
    const req = buildRequest(
      unified({
        tools: [{ type: 'function', function: { name: 'shell' } }],
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '看下目录' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              { id: 'a1', type: 'function', function: { name: 'shell', arguments: '{}' } },
            ],
            reasoningContent: '先ls再head',
          },
          { role: 'tool', content: 'ok', toolCallId: 'a1' },
        ],
      }),
      PROVIDER_PRESETS.deepseek,
    );
    const assistant = assistantWire(req, 2);
    expect(assistant.reasoning_content).toBe('先ls再head');
  });

  it('Kimi 原样保留：含首尾空格也逐字透传（§3.3 原样保留；归一化只删空值不改内容）', () => {
    const req = buildRequest(
      unified({
        messages: [
          { role: 'assistant', content: 'x', reasoningContent: '  reasoning with spaces  ' },
        ],
      }),
      PROVIDER_PRESETS.kimi,
    );
    expect(assistantWire(req).reasoning_content).toBe('  reasoning with spaces  ');
  });

  it('DashScope/OpenAI 从不发送：任何 assistant 的 reasoning_content 都剥离（never-send）', () => {
    for (const preset of [PROVIDER_PRESETS.dashscope, PROVIDER_PRESETS.openai]) {
      const req = buildRequest(
        unified({
          messages: [{ role: 'assistant', content: 'c', reasoningContent: '这笔钱不花' }],
        }),
        preset,
      );
      const assistant = assistantWire(req);
      expect('reasoning_content' in assistant).toBe(false);
    }
  });

  it('GLM 默认剥离 + clear_thinking:true；显式 clearThinking:false 关闭场景在切 d 已覆盖', () => {
    const req = buildRequest(
      unified({
        messages: [{ role: 'assistant', content: 'c', reasoningContent: '待清除' }],
      }),
      PROVIDER_PRESETS.glm,
    );
    expect('reasoning_content' in assistantWire(req)).toBe(false);
    expect(req.body.clear_thinking).toBe(true);
  });

  it('发送前归一化：keep 策略下空串/纯空白 reasoning_content 删键（无意义内容不发）', () => {
    for (const reasoningContent of ['', '   ']) {
      const req = buildRequest(
        unified({
          messages: [{ role: 'assistant', content: 'c', reasoningContent }],
        }),
        PROVIDER_PRESETS.deepseek,
      );
      expect('reasoning_content' in assistantWire(req)).toBe(false);
    }
  });
});

// ---------- 切片 f：normalizeError 业务码词表 → LlmError 映射 ----------

describe('normalizeError：供应商业务码修正重试语义（切片 f）', () => {
  it('GLM：业务码字符串 1302/1305（频率类限流）可退避重试；1308/1310/1313–1321（周期配额）重试无意义（§6.1 B）', () => {
    const to = (code: string, status = 429) =>
      normalizeError(
        JSON.stringify({ error: { code, message: '限' } }),
        status,
        PROVIDER_PRESETS.glm,
      );
    expect(to('1302').retryable).toBe(true);
    expect(to('1305').retryable).toBe(true);
    expect(to('1308').retryable).toBe(false);
    expect(to('1310').retryable).toBe(false);
    expect(to('1316').retryable).toBe(false);
  });

  it('GLM：1200/1230/1234（服务端/网络错误）→ true；1113（欠费）/1301（内容安全）/1210–1215（参数）/1001（鉴权）→ false', () => {
    const to = (code: string, status: number) =>
      normalizeError(
        JSON.stringify({ error: { code, message: 'x' } }),
        status,
        PROVIDER_PRESETS.glm,
      );
    expect(to('1234', 500).retryable).toBe(true);
    expect(to('1200', 500).retryable).toBe(true);
    expect(to('1113', 429).retryable).toBe(false);
    expect(to('1301', 400).retryable).toBe(false);
    expect(to('1213', 400).retryable).toBe(false);
    expect(to('1001', 401).retryable).toBe(false);
    const err = to('1301', 400);
    expect(err.kind).toBe('http');
    expect(err.code).toBe('1301');
    expect(err.message).toBe('x');
  });

  it('DashScope：Throttling 两类 429 成因为何——RateQuota/LimitRequests/BurstRate 频率类 true；AllocationQuota/insufficient_quota/FreeTierOnly 配额类 false（笔记 §5）', () => {
    const to = (code: string, status = 429) =>
      normalizeError(
        JSON.stringify({ error: { message: 'throttling', code } }),
        status,
        PROVIDER_PRESETS.dashscope,
      );
    expect(to('Throttling.RateQuota').retryable).toBe(true);
    expect(to('Throttling.LimitRequests').retryable).toBe(true);
    expect(to('Throttling.BurstRate').retryable).toBe(true);
    expect(to('Throttling.AllocationQuota').retryable).toBe(false);
    expect(to('Throttling.AllocationQuota', 429).retryable).toBe(false);
    expect(to('AllocationQuota.FreeTierOnly').retryable).toBe(false);
  });

  it('DashScope：500 InternalError 可重试；401 InvalidApiKey / 403 AccessDenied 不重试；原生信封（无 error 包装）也能取码（笔记 §5）', () => {
    const ds = PROVIDER_PRESETS.dashscope;
    expect(
      normalizeError(
        JSON.stringify({ error: { message: 'server boom', code: 'InternalError' } }),
        500,
        ds,
      ).retryable,
    ).toBe(true);
    expect(
      normalizeError(
        JSON.stringify({ error: { message: 'bad key', code: 'InvalidApiKey' } }),
        401,
        ds,
      ).retryable,
    ).toBe(false);
    expect(
      normalizeError(
        JSON.stringify({ status_code: 429, code: 'Throttling.RateQuota', message: 'throttled' }),
        429,
        ds,
      ).retryable,
    ).toBe(true);
  });

  it('Kimi：engine_overloaded_error（按 Retry-After 退避）/rate_limit_reached_error/server_error → true；exceeded_current_quota_error/content_filter/invalid_request_error → false（§6.2）', () => {
    const to = (type: string, status = 429) =>
      normalizeError(
        JSON.stringify({ error: { type, message: `t-${type}` } }),
        status,
        PROVIDER_PRESETS.kimi,
      );
    expect(to('engine_overloaded_error').retryable).toBe(true);
    expect(to('rate_limit_reached_error').retryable).toBe(true);
    expect(to('server_error', 500).retryable).toBe(true);
    expect(to('exceeded_current_quota_error').retryable).toBe(false);
    expect(to('content_filter', 400).retryable).toBe(false);
    expect(to('invalid_request_error', 400).retryable).toBe(false);
  });

  it('Kimi 504：响应体是 HTML（网关）→ bodySnippet 摘录 + 状态码口径可重试（§5.3/§6.1 形状 C）', () => {
    const err = normalizeError(
      '<html><body>504 Gateway Timeout</body></html>',
      504,
      PROVIDER_PRESETS.kimi,
    );
    expect(err.retryable).toBe(true);
    expect(err.bodySnippet).toContain('504 Gateway Timeout');
  });

  it('OpenAI：401 invalid_api_key → 不重试（§6.2）；DeepSeek：402 Insufficient Balance → 不重试（§6.2/§6.3 口径）', () => {
    const oa = normalizeError(
      JSON.stringify({
        error: {
          message: 'Incorrect API key provided',
          type: 'invalid_authentication_error',
          code: 'invalid_api_key',
        },
      }),
      401,
      PROVIDER_PRESETS.openai,
    );
    expect(oa.retryable).toBe(false);
    expect(oa.code).toBe('invalid_api_key');
    const ds = normalizeError(
      JSON.stringify({ error: { message: 'Insufficient Balance' } }),
      402,
      PROVIDER_PRESETS.deepseek,
    );
    expect(ds.retryable).toBe(false);
    expect(ds.status).toBe(402);
  });

  it('空 body（网关吞体）→ 兜底 message，不抛错（§6.1 形状 C 备注）', () => {
    const err = normalizeError('', 500, PROVIDER_PRESETS.deepseek);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('(empty response body)');
  });
});

// ---------- 切片 g：未知供应商 → 严格报错 ----------

describe('未知供应商（切片 g）', () => {
  const bogus = {
    id: 'vllm',
    baseUrl: 'https://vllm.local/v1',
    defaultModel: 'x',
    fixedSamplingParams: [],
    allowedToolChoices: [],
  } as unknown as import('../../src/core/llm/index.js').ProviderPreset;

  it('getProviderPreset 对未登记 id 抛 ProviderAdapterError（不许静默当 OpenAI）', () => {
    expect(() => getProviderPreset('vllm')).toThrow(ProviderAdapterError);
    expect(() => getProviderPreset('vllm')).toThrow(/未知供应商/);
  });

  it('buildRequest 对未知 preset 抛错而非按 OpenAI 处理', () => {
    expect(() => buildRequest(unified(), bogus)).toThrow(ProviderAdapterError);
    expect(() => buildRequest(unified(), bogus)).toThrow(/未知供应商/);
  });

  it('normalizeFinishReason / normalizeError 同样拒绝未知供应商', () => {
    expect(() => normalizeFinishReason('stop', bogus)).toThrow(ProviderAdapterError);
    expect(() => normalizeError('{}', 429, bogus)).toThrow(ProviderAdapterError);
  });

  it('原型链键（constructor/toString/hasOwnProperty/valueOf）不被当作供应商——必须抛 ProviderAdapterError', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(() => getProviderPreset(key)).toThrow(ProviderAdapterError);
    }
  });

  it('未知供应商错误消息由 PROVIDER_IDS join 派生：新增 id 自动进入消息（含 buildRequest 侧）', () => {
    expect(() => getProviderPreset('vllm')).toThrow(`仅支持 [${PROVIDER_IDS.join(', ')}]`);
    expect(() => buildRequest(unified(), bogus)).toThrow(`仅支持 [${PROVIDER_IDS.join(', ')}]`);
  });

  it('五个登记供应商 ID 与预设表一一对应（新供应商接入 = 两处同改）', () => {
    expect([...PROVIDER_IDS].sort()).toEqual(['dashscope', 'deepseek', 'glm', 'kimi', 'openai']);
    expect(Object.keys(PROVIDER_PRESETS).sort()).toEqual([...PROVIDER_IDS].sort());
  });
});

// ---------- 切片 C：思考强度 reasoningEffort 映射（reasoningParam 按家；无据保守 off） ----------

describe('buildRequest：reasoningEffort 映射（C 档切片）', () => {
  it('OpenAI-family（reasoningParam=reasoning_effort）：low/medium/high → body.reasoning_effort 逐字；off → 不传', () => {
    for (const [effort, value] of [
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
    ] as const) {
      const req = buildRequest(unified({ reasoningEffort: effort }), PROVIDER_PRESETS.openai);
      expect(req.body.reasoning_effort).toBe(value);
      expect('thinking' in req.body).toBe(false);
    }
    const off = buildRequest(unified({ reasoningEffort: 'off' }), PROVIDER_PRESETS.openai);
    expect('reasoning_effort' in off.body).toBe(false);
    expect('thinking' in off.body).toBe(false);
  });

  it('DeepSeek（reasoningParam=thinking）：low/medium/high → thinking enabled + budget_tokens 1024/4096/16384；off → 显式 disabled', () => {
    expect(
      buildRequest(unified({ reasoningEffort: 'low' }), PROVIDER_PRESETS.deepseek).body.thinking,
    ).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(
      buildRequest(unified({ reasoningEffort: 'medium' }), PROVIDER_PRESETS.deepseek).body.thinking,
    ).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(
      buildRequest(unified({ reasoningEffort: 'high' }), PROVIDER_PRESETS.deepseek).body.thinking,
    ).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(
      buildRequest(unified({ reasoningEffort: 'off' }), PROVIDER_PRESETS.deepseek).body.thinking,
    ).toEqual({ type: 'disabled' });
    // off = 思考显式禁用：temperature/top_p 不再被静默剔除（与 §1.6 思考关闭口径一致）
    expect(
      buildRequest(
        unified({ reasoningEffort: 'off', temperature: 0.3, topP: 0.8 }),
        PROVIDER_PRESETS.deepseek,
      ).body.temperature,
    ).toBe(0.3);
    // 思考开启（low）：temperature/top_p 剔除
    const low = buildRequest(
      unified({ reasoningEffort: 'low', temperature: 0.3, topP: 0.8 }),
      PROVIDER_PRESETS.deepseek,
    );
    expect('temperature' in low.body).toBe(false);
    expect('top_p' in low.body).toBe(false);
  });

  it('未提供 reasoningEffort → 掉落 preset 行为（DeepSeek 仍 thinking enabled；OpenAI 无 reasoning_effort）', () => {
    expect(buildRequest(unified(), PROVIDER_PRESETS.deepseek).body.thinking).toEqual({
      type: 'enabled',
    });
    expect('reasoning_effort' in buildRequest(unified(), PROVIDER_PRESETS.openai).body).toBe(false);
  });

  it('reasoningParam 未核实（Kimi/GLM/Qwen）：即使给 high 也保守不发任何字段（无据 off）', () => {
    for (const id of ['kimi', 'glm', 'dashscope'] as const) {
      const req = buildRequest(unified({ reasoningEffort: 'high' }), PROVIDER_PRESETS[id]);
      expect('reasoning_effort' in req.body).toBe(false);
      expect('thinking' in req.body).toBe(false);
    }
  });

  it('reasoningParam 值域常量：OpenAI=reasoning_effort、DeepSeek=thinking、其余未定义', () => {
    expect(PROVIDER_PRESETS.openai.reasoningParam).toBe('reasoning_effort');
    expect(PROVIDER_PRESETS.deepseek.reasoningParam).toBe('thinking');
    expect(PROVIDER_PRESETS.kimi.reasoningParam).toBeUndefined();
    expect(PROVIDER_PRESETS.glm.reasoningParam).toBeUndefined();
    expect(PROVIDER_PRESETS.dashscope.reasoningParam).toBeUndefined();
  });
});

describe('presets：contextWindowTokens（估算，可在设置覆盖）', () => {
  it('五家预设窗口值：deepseek 64000；qwen/glm/kimi/openai 128000', () => {
    expect(PROVIDER_PRESETS.deepseek.contextWindowTokens).toBe(64000);
    expect(PROVIDER_PRESETS.dashscope.contextWindowTokens).toBe(128000);
    expect(PROVIDER_PRESETS.glm.contextWindowTokens).toBe(128000);
    expect(PROVIDER_PRESETS.kimi.contextWindowTokens).toBe(128000);
    expect(PROVIDER_PRESETS.openai.contextWindowTokens).toBe(128000);
  });
});
