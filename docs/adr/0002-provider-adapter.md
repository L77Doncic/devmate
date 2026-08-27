---
Status: proposed
---

# Provider Adapter：五家协议差异归于一层，主循环只面向统一口径

「供应商」一词在 DevMate 中指提供 OpenAI 兼容聊天补全端点的模型平台：Bearer + messages/tools/SSE 的公共主干完全相同，差异全部集中在边缘（CONTEXT「供应商」词条）。主默认 DeepSeek、兼容 Qwen/GLM/Kimi/OpenAI 的选型已定（spec.md 开放问题 Q3），而五家的采样参数能否传（Kimi 传 temperature 会报错、DeepSeek 思考模式静默忽略）、strict 默认值（Kimi「不传即 true」而 OpenAI/DeepSeek 默认 false、且 DeepSeek strict 须换 /beta 端点）、流式 usage 的放置位置、finish_reason 词汇（GLM 的 `sensitive`/`network_error`、DeepSeek 的 `insufficient_system_resource`）、错误体形状、retry 头有无、推理内容历史回传策略互不兼容——差异是事实，统一口径必须发生在这一层。DevMate 的决定：主循环、会话、压缩只消费内部归一后的消息模型与统一账本（usage 归一为 prompt/completion/cached/reasoning 四字段），每供应商一个 adapter 完成——不确认/禁改的采样参数过白名单剔除后再发、strict 默认值按家注入、finish_reason 词表归一、usage 从各自载体提取、推理内容按 per-provider 三选一策略（一律剥离/存在即保留/从不发送）归一后再发送、错误体与 retry 头各留解析器。原因：五家不是「一个 SDK 能封装的差异面」，而是一组互相矛盾的平台契约，只有「每供应商一个最小 adapter 覆盖真实差异集」才是真 seam——单个通用 adapter 是假 seam，它的分支条件会泄漏回调用点，等于从未抽象过。

## Considered Options

- **每家调用点写直连分支**（`if provider === "deepseek"` 散落各处）：同一份判断分布在请求体组装、流式消费、错误处理、成本核算十数个调用点，改一家要翻全代码库、忘一处就是一个 400——调用点爆炸，且「差异清单」没有显式载体。
- **单个「通用 OpenAI 兼容 Provider」类**：即假 seam；Kimi 的 strict 默认 true、DashScope 仅 `auto` 的 tool_choice 与 `parallel_tool_calls` 默认 false、DeepSeek 的 prompt_cache_hit/miss 明细会把「通用」实现写成一类塞满 if 的分支，等于把真 seam 拆回调用点。

## Consequences

- ✍ 修订（2026-08-27）：WireRequest 是适配层唯一产物（base_url + 蛇形 body + Qwen extra_body），客户端只读它并照单发送、彻底不做字段映射（见 0001 修订）；测试的 wire 形状断言相应迁至适配层。剔除/策略等决策经 WireRequest.meta（strippedParams）记载，落实本 ADR「adapter 的决策必须是白的、可观测」要求；重试语义修正表（retryableRules）随 preset 数据声明，不再有 switch 分支。
- 未来接新供应商或新协议（见 ADR-0009）＝ 新增一个 adapter，核心循环零改动——扩展与归一化在同一层。
- adapter 的决策必须是白的：哪些参数被剔除、策略开关取哪一档，均须可观测（随事件 meta 记载），否则行为与成本出问题时无法归因。
- 归一账本（cached/hit 单列）让成本核算不用关心各家的 usage 形状，是 ADR-0003 成本护栏的输入前提。

依据：openai-compatible-api-spec.md §1.3（strict 默认值表）、§3.3（推理内容回传四家规则与三选一开关）、§4.4（finish_reason 词表）、§4.5（usage 位置）、§5.2（行为差异矩阵）、§6.1（错误体三种形状）、§6.3（Retry-After 有无）、§7.1（usage 字段形状）；context-and-error-handling.md §4.4（回注载荷与 Anthropic 语义映射）。待实测（Phase 2 联调验证）：§5.2 行 5/11/12/17（DashScope `parallel_tool_calls` 默认 false、`frequency_penalty` 缺席、旧「tools 与 stream」表述、DeepSeek/DashScope 错误信封）与 §4.5（GLM 是否支持 `include_usage`、Kimi usage 精确位置）——出处页不可核或已改版，按 §9 冒烟脚本逐项定案后固化为默认值。
