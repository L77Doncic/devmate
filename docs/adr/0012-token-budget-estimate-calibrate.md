---
Status: proposed
---

# Token 预算：本地启发式估算 + 服务端 usage 滑动校准闭环；窗口未知不硬编码

精确 token 计数需要 tiktoken 级依赖（纯 JS BPE 词表数 MB、随模型换代更换），与零依赖愿景直接冲突；而所有计数标准自己都声明只是估算（Anthropic「The token count is an estimate」、Cookbook「Consider the counts … an estimate, not a timeless guarantee」），服务端 `usage.prompt_tokens` 才是最终真值——正确姿势是「本地估算做预判 → 服务端 usage 做事后校准 → 校正系数滑动更新」（context-and-error-handling.md §1.1/§1.2）。DevMate 采用 L2 分类加权启发式（CJK 每字符记 1 token、ASCII 连续段 `len/4`、源码/diff 用 K=3；再加 Cookbook 结构开销：每条消息 +3、带 name +1、回复 priming +3、每个 function +7（gpt-4o 系）/+10（gpt-4 系）、每 property +3、tools 收尾 +12，且 `overhead(messages)` 与 `overhead(tools)` 独立计量、工具定义会话开始算一次之后按增量维护，§1.3）做请求前预判——它同时是成本护栏闸门 A（请求前估价）与压缩触发阈值的输入；响应后以真实 usage 校准累计账本并滑动更新校正系数（L0 事后校准，最终态 0%）。窗口值不硬编码：`{provider}/{model}` 覆盖表优先、无覆盖时以请求参数为准；窗口未知时不按比例算阈值——兜底「超限报错 → 压缩 → 重试（上限 2 次，CONTEXT 裁决 8 修正口径）」（§1.4/§8B）。

## Considered Options

- **引入 tokenizer 依赖（L3 纯 JS BPE，如 js-tiktoken 类实现）**：<±2% 精度，但要打包数 MB 词表资产、三平台维护、模型换代即重标定，与「零框架依赖 + 轻」目标冲突；本题只需要「离窗口还有多远」，±5%~±15%（L2）足够定阈——精度换依赖不划算。
- **纯服务端 usage（只做 L0 校准，不做事前估算）**：事后体 0% 完美，但不解决请求前预判——保险丝必须前置在查询之前（ADR-0003），闸门 A 没有事前估价就只剩「支出后复盘」，成本护栏的「请求前检查剩余预算」落不了地。

## Consequences

- 校正系数与估算常数均须 per-provider/per-model 维护：换模型必须重标定（官方例子：同一输入在新 tokenizer 下多约 30%，§1.1）；K 与结构常数初值来自 Cookbook/经验值，落地前以 tiktoken 离线标定（REVIEW.md C 表，与 ADR-0005 同挂账）。
- 估算误差有方向性代价：系统性低估 → 压缩触发偏晚、超限增多 → 更多「超限报错→压缩→重试」兜底链路；系统性高估 → 阈值提前、被迫多压缩。故系数取「宁可高估」的保守倾向（§8 的 A-1：CJK 每字 1 token、窗口按未核实不设全局 fallback）。
- 单价表补齐前（REVIEW.md D3.1，留档 05 工单）：预算只能以「本地估算 token × 占位价 + 手工任务预算」近似运行——闸门 A 的定位是「拦住明显超预算的动作与重试」，不是精确计费（与 ADR-0003 的保险丝/统一账本分工衔接）。
- 结构性开销必须计入：只算正文不算消息/tool 定义会恒定系统性低估（工具定义本身很贵，Anthropic Bash 工具定义固定追加 244–325 token——属 A-2 体系，与 A-1 不可混加，§1.3/§8 表头体系声明）。

依据：context-and-error-handling.md §1.1（官方「估算」声明与正确姿势）、§1.2（L0–L3 四档与 L2+L0 选型建议）、§1.3（结构开销双分量与「工具定义本身很贵」两处一手）、§1.4（窗口未知三层兜底）、§8 的 A-1（参数登记行与表头体系声明——A-1/A-2 两套 tokenizer 常数不可混加）、§8B（超限重试上限 2 次）；REVIEW.md D3.1（单价表缺口，预算公式未数值化）。
