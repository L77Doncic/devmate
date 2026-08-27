---
Status: proposed
---

# 零依赖自研 LLM 客户端：原生 fetch + 手写 SSE 解析器，连官方 SDK 也不用

考核 PDF 禁的是 agent 框架/SDK（R2），并明确把「模型厂商 API 客户端库」列为允许项（A1）——按字面，直接引 openai 官方 SDK 是合规且省事的显然路径，DevMate 刻意偏离它：客户端零依赖，只用 Node 原生 fetch 发请求、手写 SSE 解析器与 tool_calls 分片拼接器，不引入任何 SDK。偏离不是姿态而是被协议事实逼出来的：五家的流式 usage 载体（空 `choices` 附加 chunk vs 挂在末内容 chunk）、finish_reason 词表、错误体形状（GLM 字符串型业务码、DeepSeek 无统一信封、Kimi 504 返回 HTML）、分片节奏互不相同（openai-compatible-api-spec.md §5.2/§6.1/§4.4/§4.5），而官方 SDK 的类型、重试与错误模型只忠于 OpenAI 一家——把差异接进 SDK 反而让它把单一假设强加给我们。手写解析器总规模约百行（官方 SDK 自己的终止判断就是一行 `data.startswith("[DONE]")`，§4.1 可逐字照抄），「合并 tool_call 分片」「每 chunk 探测 usage」「按 tc.index 聚合分片」这类逻辑都是公开代码的等价实现——换来的是逐行可审计、每一条都对照「已核实平台行为最坏情况并集」的边界清单（§8.A 十一条 + §8.B 十三条），并把「零框架依赖」贯彻到依赖栈最底层。

## Considered Options

- **openai 官方 SDK**：省事，但它覆盖不了兼容网关的差异面（strict 默认、usage 位置、错误体各家不同），反而把 HTTP 客户端、重试器、日志等一条长依赖链带进零依赖愿景、掩盖协议细节——「用少量确定性换取被掩盖的不确定性」。
- **引入轻量 SSE 解析库（如 eventsource-parser）折中**：只省下几十行纯语法解析；难点全在解析器之外（usage 载体、分片节奏、HTML 混入 SSE 通道、断流兜底），该库不覆盖——为省几十行多一个依赖不划算。

## Consequences

- ✍ 修订（2026-08-27）：公共接口 chat 接收供应商归一后的 WireRequest——客户端为纯传输层，序列化/归一在 Provider Adapter（见 0002）。客户端不再持有任何字段映射（toWireBody/toWireMessage 移除），只做 fetch 传输、SSE 解析、usage 探测、tool_calls 聚合与状态码级基础错误映射；错误体解析（extractErrorBody/RETRYABLE_STATUS/parseRetryAfter）与 adapter 共享单一来源 error-parse。
- 解析器与拼接器不需要「猜」的边界（半行尾 JSON、幽灵空 chunk、`choices==[]`、`\r` 残留、UTF-8 分帧、`[DONE]` 前缀先行）都已有核实结论，直接成为单元测试用例集。
- ✍ 必须保留五家真实流量的冒烟脚本（§9），解析器的兜底分支覆盖率以 Phase 2 联调实测为准——见依据中的待实测项。

依据：openai-compatible-api-spec.md §8.A（SSE 解析边界 11 条）、§8.B（tool_calls 拼接 13 条）、§4.1（`[DONE]` 与官方 SDK 判断逻辑）、§6.1（三种错误体形状）、§9（待实测清单）；open-source-agent-architectures.md §1.1（「Just some 100 lines of python」）；REVIEW.md C 表（SSE 解析器判「直接可用」）。待实测（Phase 2 联调验证）：§9 冒烟清单第 5/6/7 项（GLM `include_usage`、Kimi usage 精确位置、DeepSeek/DashScope 错误信封）决定解析器兜底分支的实际覆盖率。
