# DevMate

> **devmate-cli** — 零框架依赖、运行时零依赖的 TypeScript 编程智能体。
> A TypeScript coding agent built from scratch: no frameworks, zero runtime dependencies.

用户给出一个编程任务，DevMate 自主读写文件、执行命令、反复调用 LLM 直至完成——
对标简化版 Claude Code（npx @deepseek-ai/dsh 式 harness），整个依赖栈的最底层也只用
Node 原生能力：原生 `fetch` + 手写 SSE 解析器（见 [docs/adr/0001-zero-dependency-llm-client.md](docs/adr/0001-zero-dependency-llm-client.md)）。

## 状态

**开发中（0.1.0，骨架阶段）**。当前仅有工程骨架与占位模块；完整 README 属 Phase 6 产出，
本文件只锁定项目定位与目录入口。

## 徽章

<!--
  GitHub Actions CI 徽章位置（仓库有 remote 后填入）：
  [![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)
-->

## 目录结构

```
.
├── src/
│   ├── cli/            # bin 入口（node_modules/.bin/devmate-cli）
│   ├── core/           # Agent 循环核心
│   │   ├── llm/        #   LLM 客户端与供应商适配层（零依赖 fetch + 手写 SSE）
│   │   ├── context/    #   上下文管理：投影与两级压缩
│   │   ├── loop/       #   主循环：Turn/Step、终止条件、熔断与重试
│   │   └── tools/      #   工具面：内置工具集与放行/隔离
│   ├── ui/web/         # 原生 Web UI（零依赖 HTML/CSS/ES Modules，预留）
│   └── shared/         # 内部消息模型（核心事件类型）
├── test/               # vitest 测试
├── CONTEXT.md          # 领域术语与规则（单一事实来源）
└── docs/adr/           # 架构决策记录（13 篇）
```

## 开发

```
npm install
npm run dev          # tsc -w 增量编译
npm run typecheck    # 主配置 + 测试配置双重类型检查
npm run lint         # eslint（flat config，typescript-eslint）
npm test             # vitest run；npm run test:watch 进入 watch
npm run build        # tsc 产出 dist/
```

## 文档

- [CONTEXT.md](CONTEXT.md) — 领域术语、规则与决策记录（中文）。
- [docs/adr/](docs/adr/) — 13 篇架构决策记录；改动遵循 `docs/agents/domain.md` 的冲突上报约定。

## License

MIT — [DevMate contributors](LICENSE)
