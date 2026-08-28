# Changelog

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。0.x 阶段：0.1.0 为首次发布，随后每轮交付增补条目。

## [0.1.0] - 2026-08-28

DevMate 首次发布：从零实现的零框架、零运行时依赖 TypeScript 编程智能体。至此已有的 8 个里程碑提交沉淀为本条目。

### Added

- **核心引擎**（`src/core/`）
  - 零依赖 LLM 客户端：原生 `fetch` + 手写 SSE 解析器（ADR-0001）
  - OpenAI 兼容供应商适配层：DeepSeek（默认）/ OpenAI / DashScope / GLM / Kimi，推理内容策略、采样参数白名单、错误体归一（ADR-0002）
  - 会话事件流：append-only JSONL、写序不变量、resume/fork、悬空工具调用占位（ADR-0004）
  - 上下文管理：投影、工具输出截断、工具结果裁剪 + 占位符、对话摘要 + 防抖、token 预算估算 + usage 校准（ADR-0005）
  - 主循环：Turn/Step、终止条件（成本/步数/墙钟）、熔断、错误回注、重试器（Equal Jitter、Retry-After）（ADR-0003/0006）
- **工具集与安全基线**（`src/core/tools`、`src/core/jail`）
  - 6 件文件工具（read_file / write_file / edit_file / list_dir / glob / grep，SEARCH/REPLACE 编辑）
  - 常驻 Shell + 哨兵行 + 重启（ADR-0010）
  - 工作区监狱：符号链接两端同检、重定向按写入审查（ADR-0013）
  - 命令分类器（只读白名单、危险命令识别，ADRs 0008/0011 配套）
  - 回注前机密脱敏（securedRegistry）
- **服务端与 Web 对话窗口**（`src/ui/`）
  - 本地 HTTP 服务：SSE 帧流、审批簿、设置/会话/统计/工具/技能/MCP/子代理端点（ADR-0007）
  - 零框架 Web UI（HTML/CSS/ES Modules，无构建步骤）：三态主题、按工作区分组侧栏、工具卡、审批弹窗、12 条 `/` 命令、思考强度 pill、上下文占用环、运行状态条、压缩披露
  - MCP stdio JSON-RPC 客户端，工具并入统一工具面（`mcp_` 前缀）
  - 子代理工作流：并行池（maxParallel 1–4，缺省 2）
  - 技能内化：构建时打包 mattpocock-skills 工程集（18 个）到 `dist/assets/skills`，`use_skill` 懒加载
- **提示词工程**（Phase 5）
  - 预算感知的系统提示合成：行为锚点（界内动 / 小步闭环 / 失败是普通消息）、技能清单节、子代理节
  - mock-LLM 端到端套件：真实装配 + 假 LLM，零密钥、零外部网络
- **工程化**
  - vitest 全量测试：90 个测试文件、1231 用例（1230 通过 / 1 跳过）
  - eslint flat config（typescript-eslint + prettier 冲突规则）、prettier、双 tsconfig typecheck
  - CI：ubuntu + windows 双平台（lint / typecheck / test / build）
  - 文档：CONTEXT.md 领域术语与规则、13 篇 ADR、README 中英双语、CONTRIBUTING / SECURITY

### Known Limitations

- 单价表为占位价（ADR-0003 定价缺口）：成本显示为估算值，服务端成本闸门才具权威
- 深度优先场景未接系统沙箱（容器/VM/资源限制仅文档化基线，见 ADR-0013）
- 发布物为 npm 包 `devmate-cli`，首个 0.1.0（本条目）为发布准备版

[0.1.0]: https://github.com/L77Doncic/devmate/releases/tag/v0.1.0
