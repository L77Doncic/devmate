# DevMate · 原生 Web UI（src/ui/web，接缝 S13）

零框架、零构建步骤、零运行时依赖的对话窗口。浏览器直接可跑：`index.html` 是入口，
`app.js` 是 ES Module 入口，全部 `import` 均为相对路径（服务端原样把本目录当静态根即可）。

## 怎么开发

```bash
# 无服务端 API 时（纯静态预览：设置/会话端点 404，界面向容错态优雅降级）
python3 -m http.server 8123            # 在 src/ui/web 目录内
# 打开 http://localhost:8123/

# 有本地 server（S12, src/ui/server）时直接由它提供：npx devmate 路径自动
```

只要改 `app.js / style.css / index.html` 刷新即生效 —— 没有构建、没有打包。

## 怎么测试

纯逻辑模块（node 可直接 import 的 ESM `.js`）：

| 文件            | 职责                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sse.js`        | SSE 行缓冲/事件边界解析器 + fetch/ReadableStream 消费器                                                                                                                                                                                                                                                                                                                                                             |
| `markdown.js`   | 手写安全 Markdown：块/行内解析、escapeHtml、safeHref 白名单、HTML 串渲染 & DOM 渲染                                                                                                                                                                                                                                                                                                                                 |
| `messages.js`   | SSE 事件 → 消息状态机（delta 累积、工具卡、审批队列（**内嵌卡一次呈现一个** —— 快照保序，渲染层只取第一个等待项）、用量/运行状态、长会话裁剪；usage 透传 contextEstimateTokens + costUsdCum 会话累计成本）                                                                                                                                                                                                          |
| `settings.js`   | GET/POST /api/settings、密钥掩码、默认值、工作区目录显示字段、**思考强度四档（off/low/medium/high，缺省 medium）与上下文窗口覆盖归一、saveReasoning 补丁提交**、**权限档位（read-only/workspace-write/full-access，缺省 workspace-write）与 permissionConfirmedAt 归一、savePermission 补丁提交**、供应商预设镜像（仅供测试/兼容保留）                                                                              |
| `format.js`     | 截断/token/金额/耗时/参数美化等纯格式化函数                                                                                                                                                                                                                                                                                                                                                                         |
| `sessions.js`   | 侧栏数据纯逻辑：会话列表/详情归一化（**含 workspaceRoot**）、**workspaceLabel/groupSessionsByWorkspace 归组**（未知项目尾组）、统计行（S13）                                                                                                                                                                                                                                                                        |
| `workspaces.js` | 多工作区纯逻辑（S14）：注册根归一/去重保序、**friendly basename + home 缩写 meta**、**注册表驱动分组树**（`groupSessionsByRegisteredWorkspaces`：未注册根/无根会话 → 「未知项目」尾组）、目录浏览状态机（stack/上下级/selected/browsing + 面包屑段）、per-workspace 折叠映射持久化（仅布尔服从）、**错误映射**（`workspaceErrorInfo`：400 默认根/未注册/绝对路径/目录/权限 → kind + 中文文案，端点缺失 → 容错提示） |
| `theme.js`      | 三态主题（system/dark/light）：归一化、localStorage 读写、applyTheme（S13）                                                                                                                                                                                                                                                                                                                                         |
| `sidebar.js`    | 侧边栏状态纯逻辑（dsh 语义）：展开 260 / rail 56 常量、窄屏阈值、resolveSidebarCollapsed（宽屏偏好 + 窄屏自动折叠 + 运行时覆盖）、折叠持久化 `devdev.sidebarCollapsed` **仅字面量 `'true'` 服从**（损坏/未定义 → 展开；防 localStorage 默认风险）、BUILD_VERSION = package.json version（版本徽章单一来源）                                                                                                         |
| `menu.js`       | 行菜单（kebab → dsh Menu）纯逻辑：条目模型（delete 危险项）、id → action 白名单匹配（未知 id 不落破坏性分支）、锚点定位（先下后上、右缘对齐、视口钳制）                                                                                                                                                                                                                                                             |

> S14 侧栏（dsh WorkspaceBrowser 形态）：侧栏「对话」区 = dsh sectionHeader（label + 添加工作区 ＋）
>
> - 注册根 → 工作区分组组树（ProjectRowItem 34px 组头：folder↔hover chevron + basename/meta + kebab/组内 ＋；
>   SessionNodeItem 32px 行保留）；「＋新建」= dsh WorkspacePickFlow 菜单（工作区列表 + 勾选当前 + 分隔 +
>   底部钉置「添加工作区…」，默认根项在下）；目录选择弹窗 = dsh ui-directory-picker-browse 形态（标题 + 可点路径条 +
>   「..」首行 + 目录行 + 手动路径输入 + 「选择此文件夹」启用裁决）；错误对话框复用 dsh folderError 形态（取消/重试）。
>   **已知差异（≤4，注明）**：① 默认根识别 = 「注册表首项」启发（服务端 GET /api/workspaces 无默认根字段），DELETE
>   400 回授校正 —— 与 dsh workspace controller 的权威顺序不同；② 组内会话**无拖拽排序**、行菜单仅「移除工作区」
>   （dsh: drag 排序 + host 回写 + rename/fork/archive）；③ 目录浏览无「新建文件夹」affordance（服务端 browse 仅展示）；
>   ④ 主列空态保留 DevMate 三步卡 + hero「选择工作区…」快捷入口（dsh EmptyHero 无三步卡；wsCollapsed 逐工作区
>   持久化 —— dsh 为 groupExpansion 全局数组）。
>   | `extensions.js` | 设置页扩展区纯逻辑：Subagent 工作流（/api/workflow 同步 + localStorage 降级）、Skills/MCP 清单归一化（MCP 徽章按 enabled 渲染，不依赖 status）、args 解析 |
>   | `commands.js` | 「/」命令纯逻辑：12 条命令表（id/name/label/desc/hint 单一来源）、parseCommandLine 行解析、matchCommands 前缀过滤（下拉）、commandFor 白名单匹配、commandArgValid 参数合法裁决、THEME_ARG_VALUES 白名单 |
>   | `meter.js` | 上下文窗口占用环纯逻辑：meterRatio（contextEstimateTokens / window，夹取 [0,1]、只认 number）、meterTier（>80% 琥珀 / >95% 红 / 缺窗 unknown）、百分比文本、tooltip 与 aria（缺窗「—」= 估算模式）、周长常量 |
>   | `permissions.js` | dsh 式权限预设纯逻辑（**三档枚举/中文标签/描述/盾形 glyph 单一来源**）：档位归一（非法 → workspace-write）、permissionConfirmedAt 归一与已确认判定、**风险门计算**（切 full-access 且无确认记录 → 一次性确认门）、风险门文案（复用删除确认视觉） |
>   | `approval-banner.js` | 内嵌审批卡视图模型纯逻辑：headline（工具名+一句话）、命令预览提取（JSON cmd/command/path → mono 卡文本，截断 300）、**队列 → 卡视图换算（一次一个，取首个等待项）**；出现/应答收敛/拒绝语义状态机在 messages.js（approvals 队列）+ app.js（渲染首个等待项） |

```bash
npx vitest run test/ui-web      # 用例数见 vitest 输出（sse/markdown/messages/settings/format/theme/sessions/extensions/sidebar/menu）
```

`app.js`（DOM/网络编排）与 `index.html/style.css` 不在单测范围（浏览器行为；
无 jsdom 依赖 —— 项目刻意零依赖）。页面级验收方式：本地起服务 + 浏览器/无头
Chromium 手动过一遍「设置 → 发消息 → 工具卡 → 审批 → 完成」；XSS 钉点由
`markdown.test.ts` 的「假 document innerHTML setter 抛错」与 HTML 转义断言覆盖。

## tsconfig

npm run typecheck 需要能解析测试里的 `.js` import：`tsconfig.test.json` 已加
`"allowJs": true / "checkJs": false`（`src/ui/web/*.js` 不经 tsc 编译，发布物
就是源文件本身；`index.ts` 仅为保留占位）。仓库 `tsconfig.json`（build）不改动。

注意：`src/ui/server/*` 与 `test/ui-server/*` 属 S12 并行工单，由对应负责人修改；
本工单不动它们（验收时 prettier 若报其未格式化属对方在途状态）。

## 安全约束（改动 UI 必须遵守）

- **全文禁止 innerHTML / outerHTML / insertAdjacentHTML**；内容一律
  `createElement` + `textContent`。模型/用户文本经 markdown.js 渲染。
- 所有转义只发生在渲染点（`escapeHtml`），不做解析前转义（防双重转义）。
- 链接 href 必须经 `safeHref`（http/https/mailto 白名单；javascript/data 一律成纯文本）。
- 不渲染 `<img>`（图片降级为链接文本）；CSP meta 只放同源资源（script/connect/style）。
- apiKey 只保存时上行一次；POST 后立即清空输入框，页面只剩掩码（服务端只回掩码）。

## 协议速记（详见 app.js/sse.js 头注释与 emit.ts）

GET `/api/stream?sessionId=` → SSE（**帧清单 11 类**）：`session-user{text}` / `assistant-delta{text}` /
`reasoning{text}`（思考**增量**帧：流内逐段推送、历史回放为折叠单帧——前端就地累积；服务端已下发）/
`assistant-done{content,toolCalls}` / `tool-start{id,name,arguments}` /
`tool-result{id,name,ok,contentPreview,content,error}` / `approval-request{toolCallId,name,arguments}` /
`usage{promptTokens,completionTokens,totalTokens,costUsd,estimated,contextEstimateTokens?}` /
`run-status{status,steps,durationMs}` / `run-error{message}` /
`compaction{summary,tokensBefore?,tokensAfter?}`（披露折叠记；服务端已下发，前端接缝就绪）；
注释行 `: ping` 忽略。
**approval-request 只在 ask 类需问询时到来（权限预设矩阵决定）；deny 类（rm -rf 等
不可逆命令）不再产生本帧** —— permission-denied 回注是普通 `tool-result{ok:false,error:…}`，
模型继续（前端无需任何特殊路径）。应答只有 允许/拒绝 两键（**无附注框**）：拒绝一律
无备注 = 服务端按 `user-interrupted` 收尾本轮。
POST `/api/chat {sessionId?,text} → {sessionId}`；POST `/api/approval {sessionId,toolCallId,approve}`；
POST `/api/interrupt`；GET/POST `/api/settings {baseUrl,model,apiKey?,reasoning?,windowTokens?,permission?}`
（只回掩码；response 恒带 `reasoning`（off/low/medium/high，缺省 medium）、`window`（
上下文窗口覆盖；未配置 → 缺省不带键 = 估算模式）与 `permission`（read-only/
workspace-write/full-access，缺省 workspace-write；`permissionConfirmedAt`（epoch ms）仅在
已记录时携带 —— full-access 风险确认记录，后端记录不强制）；POST `reasoning`/`windowTokens`/
`permission` 为**补丁字段**（未触碰保持现值）—— 思考强度 pill 只上行 `{reasoning}`，
访问模式 chip 只上行 `{permission}`）。
S13 侧栏端点（S12 提供；缺失时前端逐项降级）：
GET `/api/sessions → {sessions:[{sessionId,title,lastEventMs,stepCount,workspaceRoot}]}`
（`workspaceRoot: string|null` = 会话所属项目文件夹，null → 「未知项目」）；
GET `/api/sessions/:id → {sessionId,title,events:[{event,data}]}`（协议形状，≤500 帧）；
POST `/api/sessions {text?} → {sessionId}`；DELETE `/api/sessions/:id`（409=活跃 run）；
GET `/api/stats → {rssMb,heapMb,sessions,activeShells}`；GET `/api/tools → {tools:[{name,description,parameters}]}`
（服务端已实现：deps 注册表原样映射；前端仍保留「端点缺失/异常 → 内置 7 工具静态清单回退」的防御路径）。

**协议变更（本轮）**：`tool-result` 增补 `content`（全量结果内容，服务端收集缓冲
64KB 上限内完整；`contentPreview` 保留供列表/降级，展开详情渲染 `content` 不截断至 300）；
`usage` 增补 `contextEstimateTokens?`（run 内最后一次投影的上下文估算；缺省不带键 ——
上下文占用环在无估算时隐藏）；`sessions[]` 增补 `workspaceRoot`（分组键）。

**设置页扩展区（Skills / MCP / Subagent 工作流；纯逻辑见 `extensions.js`）**：

- GET `/api/skills → {skills:[{id,name,summary,enabled}]}`（缺省/失败 → 「暂无可用技能」
  降级行，用户可见文案零端点路径）；POST `/api/skills/:id {enabled}`（开关）。
- GET `/api/mcp → {servers:[{name,command?,enabled}]}` —— **契约不依赖 status 字段**：
  前端按 enabled 态渲染徽章（开=「已登记」蓝 / 关=「已停用」中性），服务端若仍下发
  status 前端宽容接受不消费（`normalizeMcpServers` 白名单归一保持不变）；
  POST `/api/mcp {name,command,args:string[]}`（添加服务器表单：name+command+args 文本行，
  args 按空白切分）；POST `/api/mcp/:name {enabled}`（开关，形态与 skills 同构）。
  客户端协议已实现：stdio JSON-RPC 客户端；服务器经 spawn（无 shell）连接，
  懒连接 + 串行化 + 超时判型（见 src/core/mcp/）；启用开关为登记态。
- Subagent 工作流与 **GET/POST `/api/workflow` 同步**（服务端已实现）：
  GET → `{subagentsEnabled,maxParallel}`（成功回显服务端值，后续保存走 POST）；
  开关/并行数变更 → POST **混合字段部分提交**（`{subagentsEnabled}` 或 `{maxParallel}`，
  防抖 300ms 一次性提交，卸载/切换前 flush）；失败/缺端点 → 回滚重读（GET）+ toast
  「同步失败，已还原」（服务端 400 同一路径）。服务端不可达时**降级 localStorage**
  `devmate.ui.subagents` `{enabled,parallel}`（默认 `{enabled:true,parallel:2}`；
  parallel 1-4 步进禁 0，0/负 → 本地兜底 2），控件旁注「未同步（仅本地）」。
- 扩展区用户可见文案全部为纯中文说明（零端点路径；copy 单一来源 = extensions.js 常量，
  防漂移断言见 `test/ui-web/extensions.test.ts`）。新设置控件全部走 `data-*` 事件委托
  （drawer 上单一 change/click 监听），app.js 不逐控件挂监听。

## 已知待接点 / 决策记录

- **单流模型（S13）**：`/api/stream` 每会话唯一且长活 —— `ensureStream` 每会话只开
  一次（首条消息 / 历史恢复 / 切换会话时接入，事件连入后直达或由服务端全量缓冲回放
  补序）；run 结束后流不关（服务端心跳保活）。发送门禁与停止按钮统一由
  runActive 驱动（run-status 8 终态事件后置 false）：运行中发送 → toast
  「上一条任务仍在运行，请等待或按停止」（不再静默吞）；同会话第二条消息不再
  重放旧 run 事件（连接先于 run 建立）→ 重复气泡问题根除。
- **run-status 终态（8 值）**：completed / cost-guard / max-steps / wall-time /
  circuit-break / compaction-debounce / user-interrupted / fatal（中文标签见
  format.js RUN_STATUS_SEMANTICS；tone 完成=绿 / 中断与预算类=琥珀 / 熔断与致命=红 / 未知=灰）。
- **运行状态条（dsh「状态属于输入框上下文」）**：停靠式，从顶栏移到 **composer 输入区
  上方**。运行中 = 细横条（色点脉冲 + 闪烁阶段词「生成中/工具执行中/待审批」+ 实时墙钟
  耗时——秒表锚点 runStartedAt 由 startStream 设立）；终态/完成 = 折叠单行小字
  （色点 + 中文终态 · 步骤 · 时长）；run-error = 错误横条；空态隐藏。**live 与 quiet
  高度统一 36px**（修 review 指出的 26/18 漂移：切换态不再跳版）。**完成态常驻至下次
  run**（有意保留：dsh 完成即隐藏——我们扩为终态确认可见性的 UX 决策；下次 run 的
  running 帧到达时重置，见 style.css 对应段注释）。**顶栏只保留 会话名/连接状态**
  —— 品牌行移入侧栏 logoRow（dsh 语义）、设置入口移入侧栏底部 settingsArea、
  用量统计在 composer footer、**停止按钮移入 composer 发送钮左侧**（见下「五改 UI」）。
- **审批语义（dsh ApprovalPanel 内嵌卡）**：approval-request 前必有 assistant-done +
  tool-start；UI **内嵌审批卡**在 composer 上方 dock 停靠（run-strip 与 composer 卡
  之间，同宽列），**队列一次一个**（第一等待项；快照保序）。`approve` → 卡收起、
  本地把工具卡恢复 running、等服务端 tool-result 落色；`deny`（**无附注框** ——
  dsh 并无）→ 服务端按无备注拒绝收尾本轮：不落 tool 事件，终态 run-status=
  user-interrupted 到达时所有 pending 审批卡统一置「已中断」（不再永脉冲）。
  **Esc = 该次拒绝语义**（与「拒绝」键完全同路径）；内嵌卡非 modal —— 焦点不强制
  移入、无 Tab 陷阱，composer 保留可输入（发送仍由 runActive 门禁管制）。
- **侧边栏（S13 · dsh SidebarRoot 复刻，仅「对话」区）**：会话单景区 + 底部统计
  （**无供应商区块**：协议开放任意 OpenAI 兼容端点，用户裁定无需列预设）。
  **工具 / MCP / 插件三个侧栏区块已删**（2026-08-28 五改：工具清单与 MCP 的入口只
  存在于设置页 —— 设置=常规/模型接口/Skills/MCP 四区；工具栏与 MCP 不再在侧栏
  展示）。**会话按 workspaceRoot 分作者分组**：组头 = 文件夹 basename（dsh
  ProjectRowItem 同解剖 + chevron 折叠，组内为会话行；组间 2px 节奏；默认全部
  展开）；`workspaceRoot: null` 组 = 「未知项目」**恒为尾组**；归组纯逻辑 =
  sessions.js `groupSessionsByWorkspace`/`workspaceLabel`（可单测）；无会话 →
  空态 empty.none「暂无会话，点新建开始」（「对话」空组保持可见）。壳级结构（DOM/CSS 一一对应 dsh 命名与值，
  风格表头注记中给全结构对应表）：`.sidebar-track`（AppFrame 列轨道 260px ↔ 56px rail，
  overflow 剪裁 + l1 右边线）= SidebarRoot .root（pad 6/12、fill、14px 基字号）；
  `.logoRow`（品牌按钮 = **新建会话快捷键**（dsh startSession 语义：DevMate + 版本徽章
  `BUILD_VERSION`=package.json 0.1.0，figma I133:7632 列排）+ `.iconButton.toggle` 在右；
  rail 态 toggle 静置 = 品牌 mark 24、悬停换 panel icon 18（dsh railMark 互换）、
  36x36/56 轨几何）；`.newSession`（38px r12 横条 icon14+label；rail 态 36 icon-only）；
  `.regionArea`（margin-left -4 / margin-right -12 抵消壳 inset、rail 态清零）；
  `.treeBody > .list`（唯一滚动区：8px stable 主题滚动条、2px 边距、右 pad =
  12-8-2，有/无溢出不挪行）+ `.fade`（24px 底部渐隐 → 侧栏 fill）；
  `.footArea`（`.footerActions` = 应用级遥测统计行（内存/会话/Shell —— 对话统计在
  composer footer，两者不相混）+ `.settingsArea` = **设置入口（自顶栏移入）**；
  rail 态 icon-only 36，统计行隐藏）。收起状态折叠持久化 `devdev.sidebarCollapsed`
  仅字面量 `'true'` 服从，损坏/未定义 → 展开（sidebar.js 纯逻辑），**collapsed =
  rail 56px**（不再是旧版 0 宽）。**窄屏 <900** 遵循 dsh AppFrame 约定：自动折叠成 rail、
  手动展开为运行时覆盖（不落盘）—— 旧抽屉 + 汉堡 + scrim 已废弃。折叠 = slide +
  crossfade（15 值全部照抄）：wide 内容**冻结宽度**（inline 260）就地淡出 150ms
  （`.fading > *`），轨道 300ms 滑向 56px，settle（150ms）后卸载 wide 内容、切 rail 布局
  并 rail-in 150ms 同源偏移入场（49px，仅活折叠；冷折叠渲染静态）；展开即重挂载
  `.wide` 200ms 淡回。**quietBars**：指针离开侧栏 2s 后滚动条 thumb → transparent
  （`--dsh-scrollbar-thumb*` 重定向，`scrollbar-gutter: stable` 保留 → 显隐零回流），
  回栏即消隐；栏几何判定（pointerenter/leave + document pointermove 盒判定，dsh 同构）。
  区块 = dsh Group 解剖：外层「对话」`.projectRow`（34px 组头：folder slot ↔ hover
  chevron 互换、aria-expanded 旋转）+ 组内 `.groupHeader`（同解剖、30px 节奏、
  组体缩进 8px、chevron 折叠）；行 = `SessionNodeItem` 解剖（32px、slot 16 状态槽
  （当前会话状态点）、title 14/20、time 12/20、hover 时 time→kebab 让位、选中
  hover 面同色）；空态 = dsh `empty.none`（pad 16/12、13px、tertiary）。
  kebab → 行菜单：dsh Menu 语义本地形态（侧栏内绝对定位浮层，逃出 .list 剪裁；条目 =
  删除（danger 红）、外点/Escape/pointer-leave/滚动关闭；纯逻辑 = menu.js 可测）。
  会话列表走 `GET /api/sessions`；点列表项 = `restoreSession`（**单流协调时序**：关旧流
  broker → 视旧 run 状态 POST /api/interrupt → store.reset + `GET /api/sessions/:id`
  协议形状事件回放 → ensureStream(新会话)）；`newSession` 按钮/品牌按钮 =
  `POST /api/sessions`（前端仍保留「未实现时回退首条消息创建」的防御路径）；删除 =
  kebab 菜单 → 确认 modal（复用审批视觉语言，危险色调）+ `DELETE`（409 提示先停止）。
  会话恢复仍由 localStorage 记忆，刷新后续发。
- **主题（S13）**：三态（跟随系统/浅色/深色），localStorage 键 `devdev.theme`（任务书
  原文；与侧栏折叠键 `devdev.sidebarCollapsed` 同族）。`data-theme` 缺省时纯 CSS 走
  `prefers-color-scheme`（系统切换零 JS），显式值经 theme.js 写入 html 属性并同步
  meta theme-color/color-scheme。颜色全 token 化（见 style.css `:root` 三块）：
  深色 = 原 GitHub 暗色；浅色 = GitHub Light 系（#f6f8fa/#24292f/#d0d7de/#0969da），
  状态色各自调浅深。token 表修改纪律：新增颜色一律加变量，禁止在规则里写死色值。
- **DOM 轻量（S13）**：a) 消息上限 200（messages.js `{maxItems}`，超限裁最旧为
  `（前 N 条消息已折叠）` 摘要行）；b) 工具卡全量 body（参数/结果全文）**只在展开时**
  写入 textContent —— 折叠卡只存待写引用（参数与 content 同等懒惰）；c) 流式重绘
  保持 rAF 节流且**已定稿消息不再被重复重绘**（sig 驱动，修掉「每次 emit 全量重绘
  已完成气泡」）；d) 主题/折叠只走 class + transform/width 有限过渡。
- **工具行（dsh 卡片哲学）**：**默认折叠**的单行摘要 = 状态槽色点 + 工具名 + 参数
  压平单行（`argSummary`）+ 结果首行截断 80 字符（`toolSummaryLine`；失败统一走
  `errorSummary` 压平形态——已具「类型: 消息」形状原样保留，否则补「错误：」前缀，
  不再各画各的失败 div）。展开才渲染全量 body；固定行高；执行中不再自动展开。
- **上下文压缩披露（dsh context-injection-disclosure）**：`compaction` 协议帧 →
  消息流中的折叠小记（`上下文已压缩（约 N → M tokens）`，含展开摘要全文的懒惰体）。
  **服务端已下发**（emit.ts 序列化 + 流内观察器与历史回放共用 eventFrames 同一合成规则，
  见 src/ui/server/index.ts），前端接缝（messages.js dispatch + sessions.js 存储形态映射 +
  app.js 渲染）天然点亮。token 值缺失时标题降级为「上下文已压缩」。摘要全文有安全
  护栏：超 **20k 字符**截断并注明「…（截断）」（`format.js compactionSummary`，与 dsh
  同类；展开时写入 DOM 前执行，state machine 恒存全量）。
- **设置抽屉（领域分组）**：常规（主题三选 + 工作区目录显示字段——服务端未提供时
  占位降级）/ 模型接口（base_url / model / api_key）；无插件、无供应商区块。
- **模型默认值**：baseUrl `https://api.deepseek.com` / model `deepseek-v4-flash`
  （以 `src/core/llm/presets.ts` 为准；历史版本曾写 deepseek-chat）。
- **用量统计（composer 输入卡 footer；dsh InputBar footer 哲学）**：从顶栏 pill 移到
  **输入框下方窄行小字**，与 run-strip 共享同一 860px 列。内容 = 步骤数 · 耗时 ·
  入/出/总 tokens · ≈成本（estimated 标 ≈；五项全显沿用），数据源 = run-status
  （steps/durationMs）+ usage 事件双源拼行（`format.js composerStatsLine` 纯函数）；
  无值（暂停/尚无数据）时整行隐藏。**与 dsh 的分工**：对话级统计归 composer footer；
  侧栏 footer 的 内存/会话/Shell 是**应用级遥测**（进程统计），非对话统计——两者不相混。
  仅展示用，服务端成本闸门才具权威。
- **停止**：POST /api/interrupt（长活流不动，终态 run-status 仍经本流到达）；
  运行中（含工具执行/审批等待）停止按钮始终可见；连接态 6 语义
  （已连接/生成中/待审批/出错/待配置/未连接）。
- **设置链路**：POST /api/settings 应用后即写回 `~/.devmate/config.json`
  （CLI 经 saveConfig 注入 persistSettings；apiKey:'' = 显式删除密钥）；每次 run
  从当前设置重建 llm 接线（baseUrl/model/apiKey 变更即时生效）。

## 五改 UI（2026-08-28 · dsh 对话框五项对齐）

1. **侧栏 = 仅对话**：工具/MCP/插件三个侧栏区块删除（渲染函数与 DOM 全部移除；
   工具清单与 MCP 入口只存在于设置页 —— 设置 = 常规/模型接口/Skills/MCP）。
   **会话按 `workspaceRoot` 分作者分组**：组头 = 文件夹 basename（组内行解剖不变）；
   无 workspace 的旧会话归「未知项目」组（**尾组**）；空态「暂无会话，点新建开始」。
2. **「/」命令**（输入区首个字符 `/` 触发，防抖 150ms 出下拉；纯逻辑 =
   `commands.js` 可单测）：12 条 —— `/help`（命令表+说明面板）、`/new`（新建会话）、
   `/clear`（新会话，同 `/new`，注明）、`/stop`（POST /api/interrupt）、`/sessions`
   （列表+数量）、`/cost`（本会话累计成本面板，数据 = messages.js `costUsdCum` ——
   usage 事件按 run 边界累加）、`/stats`（/api/stats 数字）、`/model`（当前模型+去设置
   按钮）、`/skill`（已启用技能数+提示）、`/theme <dark|light|system>`、`/mcp`
   （MCP 服务器登记态）、`/compact`（诚实信息条：**自动压缩运行中，无需手动**）。
   未知命令 → 消息流红字「未知命令 /xx，/help 查看」；命令结果面板 = dsh Menu/Modal
   表面（r12、shadow-lv3、标题+X、Escape/外点关闭）；命令面板/下拉锚于输入卡上缘。
3. **停止按钮**：34px 圆形（同发送钮几何），**danger 红底** + 白 stop 图标
   （深 #f25a5a / 浅 #ec1313，hover brightness 0.92），贴发送按钮左侧、间距 8px；
   runActive（含工具执行/审批等待）时始终可见 —— 顶栏停止按钮已移除。
4. **思考强度选择器**：composer 输入卡上方右侧分段 pill（关闭/低/中/高，缺省中）；
   点击即选 + 防抖 300ms POST `/api/settings {reasoning}`，失败回滚重读 + toast
   「思考强度保存失败，已还原」；启动/打开设置时 GET 回显。
5. **上下文窗口占用环**：composer 与 stats 行之间 28px 环形（dsh ContextMeter 几何：
   track = border-l3 2px、fill = label-tertiary 2px round、弧起点 12 点），右侧
   百分比文本；占用量 = usage `contextEstimateTokens` / settings `window`（无窗 →
   「—」+ tooltip「模型窗口未配置（估算模式）」）；更新随 usage 事件；>80% 琥珀
   （`--warn`）、>95% 红（`--danger`）；纯逻辑 = `meter.js`（ratio/tier/aria 可单测）。
   说明：`window` 缺省按供应商 preset 估算（服务端契约；前端只消费，不推荐覆盖）。

## 审批改版（2026-08-29 · dsh 式权限预设 + 内嵌审批卡）

1. **权限预设三档**（服务端 `permission` 字段；缺省 `workspace-write` —— 表序即 chip 菜单序）：
   `read-only` 只读（写/危险命令逐一问询）/ `workspace-write` 工作区写入（写文件直接
   执行；ask 级问询、deny 级自动拒绝回注）/ `full-access` 全部访问（命令直接执行，
   不再问询）。判定矩阵在服务端 `decidePermission`；前端只消费 `permission` +
   `permissionConfirmedAt`。纯逻辑单一来源 = `permissions.js`（归一/标签/风险门）。
2. **PermissionSelect chip**（composer 输入卡 footer 左置；dsh InputBar `.tools`）：
   盾形 glyph 16 + 当前档标签 + chevron（`aria-label="访问模式，当前：{档}"`）；点击
   展开三选菜单（dsh Menu 表面：glyph + 档标签 + 描述，当前档高亮；定位 = menu.js
   `menuPosition` 视口钳制，外点/Esc/pointer-leave 关闭）。**切换即 POST**
   `/api/settings {permission}`（防抖 300ms；失败回滚重读 + toast「访问模式保存失败，
   已还原」—— 思考强度同步同纪律）。`read-only`/`workspace-write` 一键切换零确认；
   **切 `full-access` 且无 `permissionConfirmedAt` → 一次性风险确认门**（复用删除确认
   modal 视觉：危险说明 + 取消/确认；确认后 POST —— permissionConfirmedAt 由服务端
   记录；已确认过 → 下次直接生效）。会话不可用（未配置密钥）时 chip 锁定。
3. **内嵌审批卡**（替换旧居中 modal）：收到 approval-request 在 **run-strip 与
   composer 卡之间的 dock** 渲染 dsh ApprovalPanel —— 等待审批 strip（warn 底 +
   8px 状态点 +「等待你的批准」）+ 理由 headline（`{工具名} 请求执行命令`）+ 命令预览
   mono 卡（JSON `cmd`/`command`/`path` 提取）+ 右下 **拒绝(outline)/允许(primary)**
   双钮。**无附注框**（dsh 并无）；Esc = 该次拒绝；队列一次一个；已同意后卡收起、
   tool 卡继续流式。审批中 composer 保留可输入、发送仍由 runActive 管制（dsh 语义是
   pending 接管 composer 槽 —— 我们决策为内嵌 dock 不夺焦点，与单流模型一致，注明
   于此）。旧 modal 的 DOM/CSS（`#approval`/`#approval-scrim`/`.approval`/.ap-sub/
   .ap-command/.field-row）与相关 app.js 路径已移除；焦点陷阱（Tab 循环）不再适用
   （非 modal），Esc 语义保留到新内嵌卡。

## 停止/发送/思考强度/命令/上下文环的接线速记

- 停止：`renderHeader` 统一按 `snap.runActive` 显隐（元素已移入 composer-foot）；
- 思考强度：`ui.settings.reasoning` 为单一权威态；`saveReasoning` 只上行 `{reasoning}`
  补丁字段（服务端其余字段保持现值）；
- 上下文环：`ui.settings.windowTokens`（GET `window` 字段归一）+ 快照
  `usage.contextEstimateTokens`；无估算 → 整行隐藏（不装假值）。

## 消息区保真（2026-08-29 · Wave 2：行级 meta / Think 思考行 / ToolRow 变体）

1. **消息行 anatomy（dsh MessageItem 对齐）**：用户/助手行删除旧「作者标题行」
   （`DevMate · 工作中/完成 + 时间` 恒显 top meta）—— **行级 meta** 移至正文下、
   行尾弱化 caption，**hover（含 :focus-within）显现**：时钟（`formatMessageClock`
   分日模板：同日 `HH:mm` / 今年 `M月d日 HH:mm` / 跨年 `yyyy/M/d HH:mm`；时刻只认
   number / Date）+ icon-actions **复制**（clipboard API → 隐藏 textarea+execCommand
   兜底；成功换对勾 1s 复原，`CLIPBOARD_FEEDBACK_MS=1000`）。复制载荷 = 正文纯文本
   （`messageCopyText`）。**Ran-for**：助手行 done 后追加 `· Ran for 15s`
   （`ranForCaption(formatDurationMs)`；数据 = 钟差 —— messages.js 每气泡
   `startedAt→doneAt`，事件 duration 在 run-status 是 run 级、不落消息级，注明）。
   行 meta 由 `buildMessageMeta` 装配，`updateRowChrome` 增量（时钟/Ran-for/思考）。
   消息时刻锚 `at`（user/assistant 快照新增；session-user/addUser 入 item）。
2. **Think 思考行（dsh ReasoningRow 折叠行）**：`reasoning` 协议帧（{text} 增量；
   **服务端 emit.ts 尚未生产 —— 前端已前置消费，协议演进即点即亮**；mock 链路与
   纯逻辑测试覆盖）→ messages.js 累积进当前回合助手气泡 `reasoning/thinkDone`，
   done 折算 `ranForMs`。app.js：助手气泡顶部「思考」Disclosure 行（14px 灯 icon +
   caption 12/18 + 单行摘要：**定稿=首行 / 流式=最新一行**，`thinkSummary` 截 120）+
   chevron；**默认收起**；点击展开全文（惰性 textContent；`THINK_TEXT_CAP` 20k 护栏）；
   流式展开即跟随增量；**done 收尾自动收起**（dsh 定稿收起语义）。纯逻辑 = format.js
   `thinkSummary/thinkBodyText`，DOM 折叠态由 CDP 截图验证。
3. **ToolRow 变体（dsh classifyTool / toolviews 对齐）**：`classifyTool` 六变体
   （bash=run_command；read=read_file/list_dir；write=write_file；edit=edit_file；
   search=grep/glob/web_search；其余 generic 原形态兜底）。行 anatomy = **变体 14px 图标
   （失败/拒绝/中断 → StateDot 红）+ 变体标题（`TOOL_VARIANT_TITLES` 非 mono）
   - 状态 + 单行摘要 + 结果首行 + chevron**；摘要变体源 = `toolSummaryArgs`：
     bash = args.**description** ?? command 首 60；文件变体 = 路径；search = pattern；
     generic = 原压平。展开块：bash/read → **单块 mono 滚动**（失败红字首行压平 + 全文；
     TerminalBlock/ReadBlock 粗版）；write/edit → **DiffBlock 红-删/绿+加**（edit_file:
     search→`- `行 / replace→`+ `行；空 replace=纯删除；write_file: content 全`+`行）；
     search → **SearchBlock 命中行明黄**（含 pattern 大小写不敏感判定，`--`/上下文行
     不标）。**全部惰性**（展开才渲染；单块 `BLOCK_MAX_CHARS=2000` 截断+「…（截断）」）。
4. **StatsLine 分组**（B 节 statsline 对齐）：composer-dock 统计行改为 **组间 `|` /
   组内 `·`** 分组：`5 步 | 15s | 入 48.2k · 出 1.4k · 总 49.6k | ≈$0.0042`
   （组1 步数、组2 耗时、组3 入/出/总、组4 ≈成本）。**数据缺口注明**：turns/LLM-工具
   耗时拆分/TTFT/tok/s/缓存命中 需 run-status 协议与 usage 缓存字段扩展 —— 现状保留
   可得项，溢出省略 + hover tooltip 全文（CSS 原已有 ellipsis + `title`）。
5. **空态语言（B6 EmptyHero 对齐局部）**：hero 标题改纯品牌 `DevMate` + 「**预览版**」
   badge（r6 小字 chip）；三步引导保留（DevMate 本地差异化，见下方差异清单）。

### 与 dsh 仍存差异（Wave 2 后）

- thinking 数据源：`reasoning` 帧由协议/服务端生产（emit.ts 目前丢弃 reasoning 存储
  事件 —— 不在本次范围；前端就绪即点即亮）。
- 无 branch/fork 操作、无 inspect 跳转、文件路径 OS 打开（点击落 OS 需服务端握手）。
- 复杂 diff（多 hunk 分组/DiffBlock 上下文行染色）未做 —— 两色整块粗版（搜索块为
  命中行明黄）。
- `Ran for` 为消息级钟差，非 run 级 duration 事件（run-status 无每消息时长）。
- TurnNavigator / turn-process 折叠 / turn-tail 用量 Disclosure 未做（P2 之外）。
