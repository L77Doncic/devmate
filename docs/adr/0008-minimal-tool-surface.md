---
Status: proposed
---

# 工具面克制：7 个内置工具（spec F3 分解得出，5–9 为可接受区间），而非大而全

「少」是被踩实的事实而非信心问题：mini-swe-agent 默认只有 1 个 bash 工具、连 tool-calling 接口都不用，仍宣称 SWE-bench Verified >74%（README 原话，逐字核实）；DeepSeek Harness 的 Minimal mode（成熟厂商亲手做的最小版）是 2 个工具——persistent bash + str_replace_editor；它们的第三梯队（todo/plan、子代理、web 访问）在三个最小版本里全部缺席——共识最小面只是「一个 shell + 一个字符串替换式编辑器」（open-source-agent-architectures.md §1.1/§1.2/§5.3/§B.2；CONTEXT「工具面」词条）。DevMate 决定：工具面固定为 7 个——read / write / edit / list / glob / grep / run_command（对应 spec F3 六个功能面 + 常驻 Shell 命令；5–9 为可接受区间，7 是 F3 分解的结果而非米勒常数论证），编辑格式按模型适配切换；todo/plan、子代理、web 抓取明确不做，探索需求由 grep/glob + 常驻 Shell 组合承担。原因：工具面是模型可见的最小心智宇宙，每个工具都要为上下文预算与测试面付复利——工具定义本身计 token（OpenAI 官方明言函数定义计入上下文并按其计费，Cookbook 有每 function +7 之类的结构开销），工具越多上下文开销叠加上限、schema/执行/测试面 ×N，而三个最小版本证明正确性并不来自工具数量；mini 的提示词策略更是直白：想让它做开 PR 之类的特定事情，与其在 agent 里实现专用工具，不如直接告诉模型想办法（ARCH §B.2 第 4 条，README 原话大意、未逐字核实）。

## Considered Options

- **大而全工具集**（对标 Claude Code 五大类 / OpenCode / dsh Standard）：能力更全但正确性增益未被证明（三家最小版都活着且高分），代价是上下文被工具定义逐字吃掉 + 每个工具的 schema、执行、测试面 ×N——MVP 档期里是负资产。
- **单工具极简**（照抄 mini 单 bash + 三反引号解析）：可行——且它已作为「无函数调用能力模型」的回退路线保留在 CONTEXT「动作解析」双模里；但 spec F3 要求结构化文件工具（read_file/write_file/edit_file/list_dir）承载工作区越界防护与编辑格式校验，不能退到裸 bash。

## Consequences

- 第三梯队不是「永远不做」：加工具容易、删工具难——新增须先证明现有 7 个覆盖不了（CONTEXT「工具面」：第三梯队不是正确性必需），这个「证明」本身就是评审门槛。
- edit 工具的多方言与降级路径（精确替换校验失败 → whole-file 回退，spec F9）是工具面里唯一需要按模型适配的部分，与「编辑格式无普适最优」（CONTEXT「编辑格式」词条）一致。

依据：open-source-agent-architectures.md §1.1（README：除 bash 外无工具）、§1.2（默认 1 个工具与 >74%）、§5.3（dsh Minimal 2 工具）、§B.1（对照表）、§B.2 第 3 条（第三梯队结论）、§B.2 第 4 条（「Just tell the LM to figure it out」，README 原话大意、未逐字核实）、§4.2（编辑格式无普适最优）；context-and-error-handling.md §1.3（工具定义的结构开销与「限制函数数量」官方建议）。
