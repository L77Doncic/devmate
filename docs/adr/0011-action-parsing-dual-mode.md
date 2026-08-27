---
Status: proposed
---

# 动作解析双模：原生 tool calling 协议优先，三反引号代码块解析作回退，产物统一为 ToolCall 请求

「模型输出解析」是考核 PDF 自研范围（R2 禁 agent 框架/SDK）内的核心部件，两条路线各有一手业绩：mini-swe-agent 纯三反引号代码块解析（FAQ 原文「Actions are parsed from triple-backtick blocks (rather than assuming a function calling/tool calling format)」），不用任何 tool-calling 也能拿 SWE-bench Verified >74%；原生 tool calling 协议则是五家 OpenAI 兼容平台的公共主干（assistant 消息吐 `tool_calls[]`、`function.arguments` 是 JSON 字符串、结果按 `tool_call_id` 严格配对回传，openai-compatible-api-spec.md §0/§2.1/§3.1）。DevMate 决定：双模——默认走原生 tool calling 协议（`tool_calls` 的 id/type/name/arguments 由协议承载，结构化保真），「三反引号代码块」解析保留为不支持 tool-calling 能力模型的回退（ARCH §B.2 第 5 条「不要假设模型支持 tool-calling」是明确敦促）；两条路线的产物归一为同一类 ToolCall 请求，进入同一个去重、编辑方言适配、越界检查、成本记账与错误回注入口。原因：单一原生协议会把 mini 证明可行的一批模型（无 function calling 能力、兼容网关、DeepSeek Anthropic 兼容端点组合）整体排除；单一代码块解析则放弃协议级结构化校验——一次回复携带多个并行动作、arguments 的非法 JSON 都要靠文本猜，且无机器级配对。

## Considered Options

- **仅原生 tool calling 协议**：校验由协议承载、零歧义、能开 parallel_tool_calls；但「任何模型都能跑」恰恰是 mini 路线的一手卖点，无 function calling 的模型全线出局——模型覆盖度与协议保真度本不必二选一，回退实现成本只有一份 40 行以内的三反引号解析器。
- **仅三反引号代码块解析**（照抄 mini）：零协议假设、任何模型都能跑；但放弃协议级结构化校验——「一个回复=多个并行动作」没有机器级配对（探索期同时发起 grep + edit + run 的组合动作与「任务清单驱动」的工作方式不同，双模解析对这类动作的转化成本较高——此为已知折中），回注/计时/费用记账都得在输出文本上猜；且 spec F3 的结构化文件工具（工作区越界防护、编辑格式校验）与「从反引号块解析」的接口天然错位。

## Consequences

- 回退路线的安全面收窄：越界防护从「结构化参数校验」降级为「代码块内容解析 + 工作区监狱兜底」（ADR-0013）；回退路线上编辑格式以 whole-file 回传为主（与 ADR-0008 的 edit 方言适配/降级路径联动）。
- 两路共用同一动作归一化层：产物统一为 ToolCall 请求（工具名 + 参数 JSON + 来源标志），工具面 7 个工具的 JSON Schema 只在协议路线上由服务端校验；回退路线上的「动作名/参数」由解析器提取，失败即走连续格式错误熔断（ADR-0006）。
- 原生路线的协议纪律照旧：拼完必须原样回传整条 assistant 消息（含未改动的 `arguments` 字符串）、每个 tool_call 都必须有配对的工具结果回传（API-SPEC §2.1 骨架与 §8.B 第 17/18 条）、缺失配对即 400（§3.2）——由 ADR-0006 的传输/轮次层分工兜底。
- 双模只解决「怎么从模型输出到 ToolCall」：工具面选多少、编辑格式按模型适配哪个方言均另归 ADR-0008；mini 的「单工具 bash 极简」路线已作为无回调模型的极端回退保留，不因双模而加工具。

依据：open-source-agent-architectures.md §1.2（三反引号解析原文与 >74%）、§B.2 第 5 条（「不要假设模型支持 tool-calling」）、§G.4（动作解析建议双模）；openai-compatible-api-spec.md §0/§2.1/§2.2（tool_calls 精确数据形状）、§3.1/§3.2（回传顺序与缺失配对后果）；CONTEXT「动作解析」「ToolCall」词条。
