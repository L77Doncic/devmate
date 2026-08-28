# Security Policy

## Reporting a Vulnerability

DevMate 是本地开发工具：攻击面主要在工作区内的提示注入、越界文件访问与命令执行，以及 Web UI 的 XSS 与密钥暴露。

- **私密通道**：请向仓库维护者发送邮件/私信（GitHub 上的贡献者列表），附件或正文不要包含真实密钥、完整 `~/.devmate/config.json`、会话 JSONL。
- **公开通道**：也可以开 Issue（`[security]` 标签）。公开报告通常更适合「边界讨论」而非漏洞细节本身。
- 报告模板：复现步骤（命令 + 观察到的行为）、影响面（能打到什么）、以及你试过的缓解。
- 涉及机密脱敏与密钥处理的缺陷请优先上报，相关代码在 `src/core/tools/redact.ts`、`src/shared/masking.ts`、`src/ui/server/index.ts`（/api/settings 掩码）。

## Supported Versions

以最新 npm 发布（`devmate-cli`）与 `main` 分支为支持范围；仓库处于 0.x 阶段，不承诺跨版本补丁。

## Security Model / Scope

安全基线见 [docs/adr/0013-safety-baseline.md](docs/adr/0013-safety-baseline.md)：**工作区监狱**（模型行为约束层）+ **危险操作审批**（交互层）+ **沙箱/资源限制**（OS 级隔离，无人值守的唯一可靠防线）。字符串黑名单只作 tripwire，不是安全边界——报告「黑名单能绕过」前请先确认它是否已属于框架声明过的边界。

**范围内**：

- 工作区监狱的边界绕过（符号链接、重定向、runner 组合、路径归一化）
- 机密脱敏失效（回注中泄露密钥/凭据，含错误信息内嵌）
- Web UI 的 XSS 与密钥显示泄漏（innerHTML、href 白名单、掩码回读）
- 审批机制被绕过（无人值守场景除外——它本就不该依赖审批）
- 会话文件的写入损坏（并发 append、崩溃残留导致语义破坏）

**范围外**：

- 模型层提示注入（由监狱与隔离兜底，属预期威胁模型）
- 恶意用户以被杀进程相同权限执行的任何操作（本地工具边界如此）
- 把任意 GPT 供应商端点当信任边界的场景
- 对第三方技能的依赖面（其各自许可与安全声明在 `dist/assets/skills/LICENSE-mattpocock-skills.txt`）

无人值守（评测/CI）请按 ADR-0013 走隔离 + `$3` 成本保险丝，不依赖审批流。
