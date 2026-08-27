---
Status: proposed
---

# 轮次层错误一律错误回注自愈、与熔断成对；传输层只归重试器，两层绝不混同

失败处置的共识与一手依据都已踩实：Anthropic Bash 工具文档原话「把消息作为 tool_result 内容返回并置 is_error=true」、OpenAI 指南「结果格式由调用方决定（JSON、错误码、纯文本均可，模型自行解释）」、mini-swe-agent 把格式错误回填历史当作一等公民——失败是一条普通工具结果，绝不因工具失败崩进程（context-and-error-handling.md §4.3；open-source-agent-architectures.md §D）；OpenAI 官方参考实现对 unknown function 抛异常只是 happy path 演示，唯一例外是 harness 自身异常（以 `role:"exit"` 消息收尾再退出，ARCH §1.4）。DevMate 的分层：轮次层错误（畸形参数、未知工具、参数校验失败、执行失败、超时、用户拒绝）一律以该次工具调用（ToolCall）的工具结果内容回注（`{"ok":false,"error":{type,message,human_hint}}`，type 可枚举、附下一步建议，未知工具附可用工具名单）；传输层错误（限流、服务端错误、流式中断）只归重试器（指数退避 Equal Jitter + Retry-After，仅在未产生任何可见增量与工具执行时静默重试）——两层绝不混同，同一个畸形输出不能被重发三次、扣三次钱。回注必须与熔断成对出现：连续格式错误达阈值（3 次）、压缩防抖、成本超限、连续同类工具失败——任一客观信号连续命中即退出并连同原因回注给用户，一次干净的 Step 清零连续计数，否则模型会在同一个错误上空转烧钱。

## Considered Options

- **工具失败抛异常终止**：模型无自愈路径，一个 `command not found` 就死掉的 agent 不可交付；且审批拒绝也是「失败的执行」——无备注拒绝才结束本轮，有备注的拒因必须回注给模型继续工作（ARCH §D.2）。抛异常这条路直接违背「失败是普通消息」规则。
- **传输层错误也交回注纠偏**：无效自愈——429/500 不是模型换句措辞能解决的，且重试器与回注两套逻辑互相穿透（计数、账本、策略开关混在一处），「同一畸形输出重发三次、扣三次钱」正是混同后果。

## Consequences

- 被计费的失败轮次照记成本（mini 的 `self.cost += …` 补记行），否则回注自愈会成为绕过成本护栏的免费通道（与 ADR-0003 的保险丝前置配套）。
- 回注载荷是 OpenAI-compat 侧唯一合法载体（Chat Completions 的 tool 消息无 `is_error` 字段），其 JSON 约定与 Anthropic `is_error:true` 一一映射——未来加 Anthropic 后端无需改上层（§4.4，与 ADR-0009 扩展点同一设计）。
- 无进展检测不做语义级「兜圈子」判断：全部用客观可数的代理信号（连续格式错误、连续同类工具失败、重复动作、压缩不收敛、成本无下降趋势），此处只锁「熔断与回注成对」的机制，信号清单与阈值归 spec 参数表（§8C）。

依据：context-and-error-handling.md §4.3（回注四条一手依据与 OpenAI 反例标注）、§4.1（E1–E16 分层表）、§4.4（回注载荷）、§5.1/§5.2（熔断信号清单）、§2.2（压缩防抖）；open-source-agent-architectures.md §D（100% 回注共识与反例警告）、§1.3（连续 3 次格式错误）、§C.1（防抖句真出处）；openai-compatible-api-spec.md §3.2（配对规则与缺失后果）、§6.3（可重试/不可重试集合）。待实测（Phase 2 联调验证）：§3.2 各家缺失配对/只回传一半时的精确错误码与文案、assistant `content` 三变体（null/空串/缺省键）接受度——对应 §9 冒烟清单第 1/2 项。
