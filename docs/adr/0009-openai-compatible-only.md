---
Status: proposed
---

# 仅支持 OpenAI 兼容协议：MVP 收敛，明确不做 Anthropic 原生协议，扩展点留一层

「支持 OpenAI 格式 API」是交付形态（spec.md §2），「供应商」在 DevMate 中本义就是「提供 OpenAI 兼容聊天补全端点的模型平台」（CONTEXT 词条）——五家的 Bearer 认证 + messages/tools/SSE 公共主干完全相同，同一条 POST /chat/completions 闭环（工具调用请求 → 工具结果按 tool_call_id 回传 → SSE 以 `data: [DONE]` 收尾）是逐字核实的一手事实（openai-compatible-api-spec.md §0/§1.1/§3.1/§4.1）。DevMate 决定：MVP 只实现 OpenAI 兼容协议一条通路——DeepSeek/OpenAI/DashScope/GLM/Kimi 同一客户端、同一测试面，明确不做 Anthropic 原生 Messages 协议适配（spec 非目标明文列出），错误回注载荷（`{"ok":false,"error":…}` 与 Anthropic `is_error:true` 一一映射）与推理内容回传的归一化都按「未来可映射」设计，扩展点落在 Provider Adapter 一层，核心循环零改动。原因：PDF 允许的正是「OpenAI 兼容网关 + 模型原生 tool calling 接口」这条路（A1），一个协议就覆盖五家真实平台、测试面已足够宽；双协议等于适配面 ×2（第二套消息形状/工具定义/错误体/usage 全部重来），在两周档期里挤压的是主链（SSE 拼接、压缩、成本、会话）的深度打磨——「收敛范围换取深度打磨」就是答辩时的防御点；且 DeepSeek 官方就提供 Anthropic 兼容端点（api.deepseek.com/anthropic，让 Claude Code 把 DeepSeek 当后端、免改码），证明这条扩展点的现实路径随时可走（ARCH §5.4 逐字核实）。

## Considered Options

- **上 Anthropic 原生协议做双保险**：Anthropic 在本组调研中无任何协议章节（REVIEW.md D4 明示「知悉缺口即可」），字段语义、usage 形状、工具结果与错误码全部要从头摸底——MVP 档期不支持双线摸底。
- **双协议并行实现**：适配面 ×2、测试矩阵 ×2，而验收线（F1–F8）与功能演示都只打 OpenAI 兼容一端；「两个都浅」比「一个深」更难答辩。

## Consequences

- 未来接 Anthropic 原生协议 ＝ 新增一个 Provider Adapter + 一份回注载荷映射表，会话、压缩、成本、主循环全部复用（与 ADR-0002 共用同一扩展层）。
- 协议收敛 ≠ 行为一致：strict 默认值、usage 载体、finish_reason 词表等五家差异由 ADR-0002 归一，不在此重复；不支持原生 tool-calling 的模型由「动作解析」的「反引号代码块」回退兜底（CONTEXT「动作解析」）。
- 五家的兼容行为差异项仍须 Phase 2 冒烟（API-SPEC §9 清单），冒烟矩阵是协议收敛的守卫测试（相关待实测项已在 ADR-0002 挂账，此处不再重复）。

依据：openai-compatible-api-spec.md §0（五家主干相同）、§1.1/§1.2（请求端点与角色形状）、§3.1（工具回补顺序）、§4.1（SSE 传输层事实与 `[DONE]`）；open-source-agent-architectures.md §5.4（DeepSeek Anthropic 兼容端点逐字核实）、§B.2（「不要假设模型支持 tool-calling」）；REVIEW.md D4（Anthropic 无协议章节的知悉缺口）。
