---
Status: proposed
---

# 常驻 Shell：默认常驻会话 + 哨兵行判界 + 异常即重启；评测/CI 另开一次性进程

常驻与否是两派各有已核实一手依据的真实分歧：mini-swe-agent 每个动作独立进程（README 独立性子句「every action is completely independent (as opposed to keeping a stateful shell session running)」+ default.yaml instance_template 第 39 行「Every action is executed in a new subshell」，换来「换沙箱只需换一行 `execute` 实现」，代价是 FAQ 承认的三条反持久痛点——很难判断命令是否结束、坏命令可能杀掉整个会话、中断会污染后续输出抽取），Anthropic Bash 工具一手的对面方案是「一个长寿命 bash 进程 + 每条命令后打印独特哨兵行」——「通往活进程的管道永远不会有 EOF」，不能靠文件结束猜命令何时结束（context-and-error-handling.md §6.1/§6.2；open-source-agent-architectures.md §1.1/§G.5，双方已互加反向交叉引用）。DevMate 决定：默认常驻 shell 会话（注：此「会话」指 shell 进程的存活周期，与领域正术语「会话（Session）＝append-only 事件流」同名不同指；CONTEXT 术语裁决记录 #1 官方口径即「常驻会话」，两处并存），用哨兵行判定命令输出边界，异常（超时、会话被污染——残留前台进程、PATH 被改）即杀整棵进程树、重启全新会话（cwd/env/运行中进程全部消失），评测/CI 模式另开一次性进程（2026-08-27 用户拍板，CONTEXT 术语裁决记录 #1）。权衡：哨兵行恰好消除 mini-swe 反持久的第一条理由（无法判断命令结束），持久保留的 cwd/env/后台进程让模型不必 `cd XXXXX &&` 反复打前缀——多次 `npm test` 这类高频循环不用每次重建环境，而独立进程派凭「坏命令杀不掉会话」与「换沙箱一行」换来的两条好处，在常驻方案里已分别被 Shell 重启与「执行层实现与常驻与否正交」对价覆盖。

## Considered Options

- **每动作独立进程**（mini-swe 派）：实现最简——无结束判定、无会话污染、换沙箱只换一行；其实测分数不受 cwd/env 不持久影响（README 承认）。代价是状态全部丢失：环境变量、后台服务、构建产物每个动作后清零，模型只能靠前缀补救，token 浪费在重复 cd 上；且长命进程场景（`npm test` 循环、启动 dev server、依赖安装）每次重建环境，高频「改代码→跑测试→看输出」循环的成本每天可见——独立进程换来的「确定性」不产出自活进程，而是产自放弃任何跨动作状态。
- **常驻会话 + 无确定性结束判据**（靠提示符监测/超时猜结束）：mini FAQ 第一条痛点如此警告——提示符监测在脏输出下不稳、超时猜结束会把慢命令误判成僵尸，且活进程管道无 EOF（§6.1）使「读到 EOF 即结束」直接不成立；哨兵行即为此专门设计（CONTEXT「哨兵行」，提示符监测/EOF 判定/超时猜结束均属 Avoid）。

## Consequences

- 超时分层：单命令默认 120s，构建/测试类允许模型申请更长、硬上限 900s；超时即杀进程树 + 重启会话 + 把「timed out after Ns」与已捕获的部分输出回注（§6.2 timeout 分层；回注归 ADR-0006 的分层约定，属 E13 类信号）。
- 输出抽取不靠 EOF：必须读到哨兵行才判命令结束（活进程管道永无 EOF）；哨兵行必须是模型侧极不可能出现的唯一标记，且不得进入命令输出正文。
- 会话是非交互的：无 vim/less/密码提示/GUI；默认注入 PAGER/MANPAGER=cat 一类环境变量（§6.1，mini 一手 YAML）防非 TTY 下分页器/进度条挂住或刷屏。
- 每次 run 记录稳定 cwd：启动时 `cd` 到项目根，模型换目录用一次性前缀——与 mini 的提示词策略兼容（§6.2），平台差异（如 macOS `sed -i ''`）在提示词层兜底。
- 与 ADR-0008 分工：工具面 7 个工具包含 run_command（常驻 Shell 命令），「命令怎么跑」由本 ADR 锁定，「哪些命令可跑」由 ADR-0013 安全基线锁定。

依据：context-and-error-handling.md §6.2（持久会话派设计取向、timeout 分层与重启语义、与 ARCH §G.5 的反向交叉引用）；open-source-agent-architectures.md §1.1（FAQ 三痛点主出处：难判断命令是否结束、坏命令可能杀掉整个会话、中断会污染后续输出抽取；经 §G.5/§6.2 交叉引用链成立）；§G.5（「不维持常驻 shell」条目与其对立主张未裁决记录；对方一手依据见 §1.1/§5.3/§B.1）；CONTEXT「常驻 Shell」「哨兵行」「Shell 重启」词条与术语裁决记录 #1（2026-08-27 拍板）。
