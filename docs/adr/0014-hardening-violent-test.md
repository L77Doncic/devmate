---
Status: accepted
---

# 暴力测试增强：长行尾推导无窗口、MCP 进程组/SIGTERM 收尾、会话存储权限与脱敏、注册表 canonical 比较、损坏会话标记

独立暴力测试（violent-test.md，8 项可复现缺陷）后的加固决策。逐条「问题 → 决策 → 后果」：

## VT-1：lastEventSeqOnDisk 的 64KB 窗口截断（critical）

**问题**：`JsonlFileAdapter` reserveNextSeq 每写前从磁盘尾部派生 seq（单写者 + 磁盘真值优先，ADR-0004）。旧实现逆向扫描候选行时把「扫描窗口终点」当作「文件行终点」——末事件行 >64KB（b:1000/b:2800 复现路径）时候选行截断成不完整 JSON → parse 失败 → 误判 seq：同实例续写 500（缓存 vs 磁盘冲突）、服务重启后从错误 seq 续写 → 写出重复 seq 行 → 读端 out-of-order 跳过 → **静默数据丢失**；完成态 run 也在 run_result 落盘时抛错被报成 fatal/0 步。

**决策**：反向块扫描**只用于定位行边界**（找 `\n` 位置、逐行向前跳）；候选行按 [行首, 行尾 `\n`] 全量读取（任意长度，无截断）。同文件其余逆向扫描（readTailLine、truncateToLastNewline）复核无此缺陷（定位边界后按文件真实终点读取/截断），注释注明。

**后果**：任意合法长度的单事件行（百万字节级）尾部推导一致；无窗口假设残留在 `lastEventSeqOnDisk`/`readTailLine`/`truncateToLastNewline` 之外。回归测试：b:1000/b:2800 双尺寸 ×（同实例续写 / 全新实例 resume / 长行后接坏行）。

## VT-2：SIGTERM 后 MCP 子进程孤儿 + 进程组终止 + 凭据可见性（major）

**问题**：只注册了 SIGINT——`kill $(pid)`（SIGTERM）/systemd stop 等常见运维路径让 devmate 父进程直接死亡，`npm exec mcp-remote` 的 3 进程组（npm → sh → node）不随父关闭（实测常驻 11h+），且命令行含明文 `--header 'Authorization: Bearer …'`（同机任何进程可从 `/proc/<pid>/cmdline` 读）。

**决策**：
1. **SIGTERM 同优雅路径**：CLI 注册 SIGINT + SIGTERM 到同一关闭回调（server.close → deps.dispose → mcpLauncher.dispose + 常驻 shell 全清），退出 0；幂等（`process.once`）。
2. **进程组终止**：MCP transport spawn 加 POSIX `detached: true`（独立进程组）；close() 先 `process.kill(-pid, SIGTERM)` 组杀（命中 npm→sh→node 整棵树），2s 宽限后组 SIGKILL；组杀失败（Windows/已回收）回退直接子进程信号。只杀直接子进程会让中介（npm/sh）先死、真正服务器成为孤儿。
3. **限制记录**（无法由 DevMate 改变）：mcp-remote 类 CLI 凭据在命令行参数里、`ps` 可见——README（中/英）、CONTEXT「MCP」相关风险声明：**本机信任场景**（单用户机器 / 用环境变量注入凭据）。`kill -9` 无收尾途径（系统层强杀），进程残留由组语义与运维手段兜底。

**后果**：SIGINT/SIGTERM 后无 MCP 组残留（测试：sh→node 双进程组 kill 断言、pid 窗口消失）；凭据掩码面（GET /api/mcp、错误）不变；可见性限制成为文档化事实。

## VT-3：会话存储权限 0600/0700 + 存储层 tool 结果脱敏（major）

**问题**：会话文件 0644 / `.devmate`、`sessions` 目录 0755（saveConfig 只在新建目录时生效 0700、只纠正文件 0600）——配合「默认档 shell 读侧不受 jail 限制」（`cat ~/.devmate/config.json` 直读 apiKey），真实 apiKey 已进入会话文件；且掩码只护 API 响应面，落盘面为空。

**决策**：
1. **权限**：`JsonlFileAdapter` 目录 `mkdir mode 0700` + 构造时 `chmod 0700`；新会话文件 `open(...,'wx',0o600)`；存量 `*.jsonl` 构造时目录扫描一次性 chmod 0600（不越权纠正非会话文件）。POSIX 语义（Windows chmod 近似）；与 config.ts saveConfig 0600/0700 同口径。
2. **存储层脱敏（最终口径）**：`JsonlFileAdapter` append 前对 `kind==='tool'` 的 payload.content 过 `redactSecrets`（与 registry 层 securedRegistry 同一实现，幂等）——append 返回值、磁盘、resume/回放**全为掩码**（真实凭据不出现两次；与原「回注前脱敏」一致且更彻底）。只作用于 tool 事件（user 消息不脱敏）；开关 `redactToolContent:false`（默认 true）供白名单/第三方适配逃生；掩码产物无引号/换行 → JSON 形状保持可解析。
3. **边界记录**：脱敏只覆盖常见凭据形态（AKIA…、ghp_/gho_/ghu_…、`sk-`≥24、Bearer/Basic、PEM 块）——短 mock 形态（`sk-short`）不在正则集内（与 redact 模块「常见形态、不追求穷尽」经验取舍一致）；shell 读侧越界是**模型侧边界之外的事实**：监狱是行为约束层、非 OS 沙箱（ADR-0013 第 1 层），文档明示「读侧不受边界限制、密钥可被会话读取」，依赖存储 0600 + 落盘掩码兜底。

**后果**：shell 越界读出的 key 不再以明文出现在同机可读会话文件；磁盘/回放/投影掩码一次对齐（无「内存原文、磁盘掩码」两张皮）；e2e 断言基于 mock 无 key → 零影响。

## VT-4：400 空会话残留（minor）

**问题**：POST /api/chat 首建路径先 `store.create` 再校验 workspaceRoot 注册表 → 未注册根 400 但留下 0 字节会话文件与列表项（（空会话））；坏请求可反复注入耗尽 50 条上限。

**决策**：注册表校验移动到 `store.create` **之前**（guard 内：exists → 校验 → create → meta → user）。`/api/sessions` 恒为新建，维持既有先校验后 create 顺序并为 canonical 比较（VT-5）。resume 仍忽略参数（回退不校验——已注册/未注册根都忽略，行为不变）。

**后果**：失败请求零持久副作用；测试以真 JsonlFileAdapter 断言 400 后无文件、列表空。

## VT-5：字面 vs canonical 400（minor）

**问题**：注册表存 canonical（POST /api/workspaces realpath），会话根参数按字面 `includes` → UI browse 返回的尾斜杠路径（`/tmp/x/`）对已注册 `/tmp/x` 400。

**决策**：两端同口径——参数经 `canonicalizeWorkspaceRoot`（存在 → realpath；不存在 → normalize）后与注册表比较（存量非 canonical 条目也回退朗读）；meta 落 canonical 形（与注册表存储一致）。

**后果**：`/tmp/x/` ≡ `/tmp/x` 等效注册/建会话；session meta 改为 canonical（现有测试字面即 canonical，无漂移）。

## VT-8：全损坏会话冒充（空会话）（minor）

**问题**：100% 不可解析文件被 `events()` 逐行跳过 → 列表/详情按「（空会话）」展示，用户无法区分损坏与真空会话。

**决策**：`SessionStore.fileHealthFor?`（可选；JsonlFileAdapter 实现：总行数与可解析行数纯统计）→ 不可解析占比 > 0.8（`SESSION_CORRUPTION_RATIO`）判「（会话损坏）」：列表标题 `（会话损坏）` + `corrupted:true` 标记；详情同口径（`title` + `corrupted`）。阈值下=正常（「完整行+截断尾行」约占 1/3 不误标）。

**后果**：全坏文件不再冒充空会话；部分损坏仍正常展示（坏行照旧逐行跳过 + 告警——容错读语义不变）。

## 借鉴-1：审查子代理预载方法论全文（spawn_subagent skill 注入）（B-1）

**问题**：评审哨兵只要求模型 spawn 独立审查子代理（prompt 含「审查」/review），审查员
**空手上场**——无方法线、无判据，审查口径凭模型自由发挥；主代理经「蒸馏路由 + 前置门 +
use_skill」持有方法论全文，审查子代理却没有，审不齐、口惠而实不至（「与主代理同方法论
审查」纯靠哨兵文案口头要求）。

**借鉴**（调研借鉴①，来源 `/root/NJU/.scratch/coding-agent/research/internalized-skills-survey.md`，
调研日期 2026-08-30）：
`dist 蒸馏路由 + 前置门 + 评审哨兵` 组合在调研范围内无先例（唯一独特项），仅有一处
推荐借鉴——Claude Code subagent 的 `skills` 字段语义：*"The full skill content is injected,
not only the description"*（一手：https://code.claude.com/docs/en/sub-agents ）——技能全文
机械注入子代理上下文，而非只给描述。

**决策**：
1. `spawn_subagent` 新增可选参数 `skill`（技能 id，与 use_skill 同 id 语义）；装配层把技能
   索引解析器经 `skillContent` 注入工具（复用 skillsRef 晚绑定引用）——执行时
   先经 `list()` 校验 enabled（与 use_skill 开关纪律同源：关闭的技能不注入），再
   `content = await content(id)`；未知 id / disabled / 索引未回填 / 解析器异常 →
   **零注入跳过**（子代理普通模式，绝不硬失败——护栏故障不放大为行为故障）。
2. 池侧 `SubagentTask` 增可选 `skillId/skillContent`（内容随任务走——池不反向依赖
   技能索引，SubagentPoolDeps 不变）；execute 把 `SUBAGENT_SYSTEM_PROMPT + 「## 方法论（注入）」节
   + capSkill(内容)` 机械拼为 system。capSkill：按**码点** ≤6000 字符原样，超出头截 +
   「…（截断）」标记——**与 use_skill 的 4k 截断不同**：后者是生成期截断面板（头尾各半 +
   收窄建议，skill.ts「禁止手写头截断」），面板建议在 system 注入面无意义，资本条目
   B-1 定案采用简单头截（码点切片保持代理对完整）。
3. 哨兵文案追加一句：`建议 spawn_subagent 时带 skill:"code-review"（该方法论全文会注入
   审查子代理）；`——「prompt 含 审查/review」要求保留（hasReviewRun 判定不变），
   UI 审查块判定（prompt 含 审查|review）零改动。

**后果**：审查子代理与主代理同方法论文本（code-review 判据经 6000 码点头截注入——
截断点压掉该技能的 Aggregate/Why two axes 尾节，属定案边界；摘要级承诺由哨兵/标题
「按该方法论审查」承载）；成本护栏/队列/信号量不受影响（注入是装配在 system 提示的
纯字符义）；skill 不存在/关闭 → 零注入即旧行为；README（中/英）特性段、README-UI
协议节统一口径。

## 影响面与验收

- 无 API 协议破坏：`corrupted` 为新增可选字段；`workspaceRoot` meta 值 canonical 化（对能通过校验的现有根，值不变或仅去尾斜杠）。
- 全链：`npm test`（1594 基线用例不回退）＋新增回归（长行 ×6、权限 ×2、脱敏 ×4、损坏 ×2、工作区 ×2、MCP 组杀 ×1、信号 ×4）。
- 对齐 ADR-0013 权限矩阵新语义（deny 直拒路径删除；workspace-write 全命令零弹窗含破坏性；read-only = 唯一问询档）——CONTEXT.md「危险操作审批」「许可模式」「机密脱敏」词条、README/README.zh-CN 安全节同步。
