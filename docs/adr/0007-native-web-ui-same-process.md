---
Status: proposed
---

# 零依赖原生 Web UI，与 Agent Core 同进程直调

「零依赖原生 Web UI（无前端框架、无构建步骤）」与「npm 包 + 可视化对话窗口 + 一键启动」均已在 spec 层锁定（spec.md §2/§3 F6-F7）；被调研对象中唯一可供对照的一手是 OpenCode 的 server 形态（HTTP + SSE 事件流、会话资源化 API、多前端叠加同一服务，ARCH §3.1/§3.2），Claude Code 无对外 IPC 文档（REVIEW.md D4）。DevMate 决定：Web UI 用零依赖原生 HTML/CSS/ES Modules 实现，作为内置静态资源由与 core 同进程的 local server 提供，UI 与 core 同进程直调——事件经 HTTP SSE 推流到浏览器做流式渲染与 tool-call 过程可视化；反向控制信令（用户停止生成、审批应答、会话恢复）拟走 WebSocket，其协议与时序图待 .scratch/coding-agent/issues/05 设计确认后闭合（REVIEW.md D4 明示「我们的方案」章节缺位、WS 在被调研对象中无一支撑，需先补一手证据）。原因：MVP 的验收线是「npx 一键、自动开浏览器」，不需要 client/server 分离带来的进程间契约、鉴权与版本同步；同进程直调下 UI 天然共享会话事件流与权限上下文——UI 只是会话的一个视图，读同一份事实源，UI 进程死亡 core 照常运行。

## Considered Options

- **React + Vite 等前端框架/构建链**：与「零框架依赖、无构建步骤」愿景直接冲突，为 MVP 引入 npm 依赖树与构建步骤；原生 ES Modules 对「流式文本 + 工具卡片 + 设置页」足够，渲染细节的复杂度不等于框架的必要性。
- **client/server 分离（OpenCode 形态）**：端点资源化、远程访问与多前端（TUI/IDE/Web）确实优雅，但要先决策鉴权、SDK 生成、事件投影与进程生命周期——复杂度增量不被任何 MVP 验收项消化；留作未来「远端/IDE 集成」的演化路径（ARCH §3.2 多前端形态在案）。

## Consequences

- 同进程直调 ≠ core 依赖 UI 存在：headless/CI 模式 UI 根本不启动，主循环照常（无人值守靠预算与隔离兜底，非 UI——ARCH §E）。
- 会话 JSONL（ADR-0004）就是 UI 后端的唯一事实源：resume/fork/成本面板都从事件流聚合，UI 不另设状态库；UI 的「视图性」与项目的「会话/视图」词条严格一致。
- WS 控制信令未闭合（issue 05 未关闭）：若最终裁决退化到纯 SSE（如 OpenCode `/tui/*` 驱动、或 POST 轮询），交互时序随之调整——本 ADR 只锁定「零依赖原生 UI + 同进程直调 + HTTP SSE 推流」主架构。

依据：open-source-agent-architectures.md §3.1（OpenCode server：HTTP、SSE `/event`、会话资源化 API 一手）、§3.2（多前端形态）；REVIEW.md D4（IPC 三选一缺位、「我们的方案」章节缺失）；spec.md §2/§3（UI 零依赖与 F6/F7 验收——决策输入，非研究报告小节）。

## 修订（2026-08-28）

Web UI 的视觉层（主题 token 与组件几何）改为忠实复刻 DeepSeek Harness（dsh）
Web UI：`style.css` 的 `--dsw-*` theme token（含浅/深双主题）逐值照抄其
`ui/design-platform.css`，布局壳与组件 chrome（按钮胶囊/输入卡/消息气泡/披露行/
审批面板/设置页/模态）几何与色值取自其 `ui/` 组件样式；dsh 为 MIT 许可
（© 2026 DeepSeek），按 MIT 保留声明属性（LICENSE / THIRD-PARTY-NOTICES.md）。
内容差异不伪造：无 goal/todo/queue/deliverables，composer dock 只放
run-status 条 + Statistics 行（StatsLine 五元组），侧栏无插件功能列表（空态卡保留）。
本修订不改动本 ADR 锁定的「零依赖原生 UI + 同进程直调 + HTTP SSE 推流」主架构。
