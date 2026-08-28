# Contributing to DevMate

感谢你愿意为 DevMate 贡献力量。这个项目的两个不变量请先记住：

1. **零运行时依赖** — `package.json` 的 `dependencies` 必须保持为空。任何新功能（SSE 客户端、Markdown 渲染、Web UI、MCP 客户端……）都用 Node 原生能力 + 手写实现。
2. **讨论先于代码** — 领域术语、架构取舍记在 [CONTEXT.md](CONTEXT.md) 与 [docs/adr/](docs/adr/)；新概念先找到对应术语再动手，冲突记入「术语裁决记录」待 CTO 裁决，不单方面统一（见 `docs/agents/domain.md`）。

## 开发环境

- Node.js ≥ 20（本仓库不装运行时依赖，只需 npm）
- `npm install` 后即可工作；编辑器建议启用项目的 `.editorconfig` / `.prettierrc.json`

```bash
npm run typecheck    # 主 tsconfig + 测试 tsconfig 双重检查
npm run lint
npm test             # vitest run（同时可用 npx vitest run test/<module> 精准运行）
npm run build        # tsc + 复制静态 Web 资产 + 打包技能到 dist/
npm run format:check # prettier --check .
```

提交前至少跑一遍 `typecheck + lint + test + build`（CI 在 ubuntu 与 windows 上全跑）。

## 提交约定

采用 [Conventional Commits](https://www.conventionalcommits.org/)，`type(scope): 主题`，正文可中文：

| type       | 用途                            |
| ---------- | ------------------------------- |
| `feat`     | 新功能                          |
| `fix`      | 缺陷修复                        |
| `refactor` | 不改行为的重构                  |
| `test`     | 测试（新增/修改/用例盘点）      |
| `docs`     | 文档（README、CONTRIBUTING 等） |
| `chore`    | 工程化（构建脚本、依赖、CI）    |

示例：`feat(tools): 新增 file_stat 工具与越界测试`、`test: 全量测试与工程化收尾`、`docs: README 中英双语与发布准备`。

- scope 优先用模块名：`core` / `tools` / `tools/shell` / `llm` / `context` / `session` / `jail` / `mcp` / `ui/server` / `ui/web` / `cli`。
- 一条提交一个主题；跨模块的成组小改动允许合并（历史如此），但讨论点不要夹带。

## 测试纪律

测试是评审的门面，也是这个项目的硬性要求：

- **封闭性**：单元与集成测试不得访问外部网络、不得使用真实密钥。LLM 一律注入 `test/loop/support.ts` 的 `FakeLlm`；需要真实 server 的走 `test/ui-server/support.ts` 的 `startServer` + 假 deps；端到端套件（[`test/e2e/full-chain.test.ts`](test/e2e/full-chain.test.ts)）用假 LLM 跑真实装配（真 jail + 真 shell + 真服务）。
- **新功能必须带测试**：新增工具先写「执行路径 + 边界用例 + 错误回注形态」；新增端点先写协议形状断言（帧序列、掩码、错误码）。
- **别改数字行为不改测试**：默认值（成本上限、超时、阈值）的单一来源在 `src/core/loop/types.ts`、`src/core/tools/*` 的常量区，改动它们时同步改动声称这些默认值的测试。
- 跳过用例要写原因（现有 1 个 skip 即如此）。

## 提交流程

1. 从 `main` 起一条 topic 分支：`git checkout -b feat/<短名>`。
2. 小步提交（见上文约定），过程中保持每个 commit 可构建。
3. 推送后开 PR，描述里写清：改了什么、为什么（指向 ADR 或 CI 结论）、测试证据。
4. **`npm run format:check` 必须通过**（`CONTEXT.md` 与 `docs/adr/` 按设计豁免，改动它们需要先获得维护者确认并在 PR 里注明）。
5. CI 双平台（ubuntu / windows）全绿是合并条件之一；评审意见按「标准（是否符合文档化的规范）与规格（是否符合任务书）」双轴回复。

## 改动安全相关代码

涉及工作区监狱、审批、脱敏、命令分类时：

- 文案先行：对应 ADR / CONTEXT 词条更新，再动代码（`docs/adr/` 内决策记录不直接改写，增补附件篇）。
- 新工具必须挂接 `securedRegistry`（回注前脱敏）与监狱校验（文件路径两侧）。
- 审批相关改动同时更新 `src/ui/web/README-UI.md` 的协议速记。

## 交付检查清单

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run format:check
npm pack --dry-run   # 确认发布物：dist/ + README + LICENSE + THIRD-PARTY-NOTICES.md
```
