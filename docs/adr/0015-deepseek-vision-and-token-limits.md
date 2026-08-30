---
Status: accepted
---

# 图像多模态（DeepSeek vision · 服务端附件管线）+ 请求侧输入/输出上限（A 档）

两点能力一期交付：① 用户消息可携带图片（**服务端内容寻址附件**——POST /api/attachments 上传 → 事件/会话文件只存 `{ref: sha256/<sha>.<ext>}`，请求时展开为 dataURL），仅 DeepSeek vision 模型（`deepseek-v4-flash-vision-exp`）放行，其余供应商/模型在适配层**降级为纯文本**（绝不 400、绝不崩溃）；② 设置页可配置请求侧 `max_input_tokens`（仅白名单供应商发送）与 `max_tokens`（输出上限）。依据 = .scratch/coding-agent/research/deepseek-vision.md（官方五页抓取 + 三方实测；下称「研究」）。

## 已知事实（官方一手）

- content 块数组语法（OpenAI 兼容 Chat Completions）：`[{type:'text',text},{type:'image_url',image_url:{url}}]`；url 支持 `data:image/<fmt>;base64,<...>` 内联（「本地文件最简单的方式」）与外部 http(s) URL；另有 Files API `file` 块（本项目不用）。
- 每图 token：进入模型前自动缩放——<≈384×384 面积放大、更大缩至 ≈800×800 面积（恒保比例）；**每图上限 384 token**；多图每张独立计算；「逐尺寸公式」官方计算器闭源 = 未证实。
- 限制（逐字）：格式 JPEG/PNG/GIF/WebP（按文件内容判）；外链 ≤8192 字符、≤32MiB、60s 下载；**请求体 48MiB**；单图（base64/URL）≤32MiB；单请求 ≤600 图；**单边 ≤8192px（≥15 图 → 4096px）**；图仅允许出现在 **user** 消息（system/assistant 带图 → 400）；仅视觉模型接受图片（其余 → 400 "This model does not support image"）；保留占位 token 拒绝。
- **tools 兼容**：pricing 页功能表——vision-exp 行 Tool Calls 支持（Json Output/Responses/Anthropic 同支持；FIM 不支持）→ 主循环工具零改动；思考模式默认支持（思考下 temperature/top_p 静默无效——沿用既有 preset 口径）。
- `max_input_tokens`：DeepSeek 官方**无此参数**（未证实）→ 仅 DashScope/Qwen 发送（兼容模式，走 extra_body）；DeepSeek 侧请求输入上限 = 模型固有上下文（1M）。

## 决策

1. **协议（dsh 管线落地后修订）**：`session-user` 帧 data 增可选 `images?: [{ref, width?, height?}]`；会话事件 `payload.images` 同形（`UserPayload.images`）；`/api/chat` 上行 `images`（同形）。**ref = `sha256/<sha>.<ext>`（内容寻址）**——图片字节在 `<sessionsDir>/attachments/`（服务端附件存储），**事件/帧/会话文件只存 ref（slim）**；请求时经注入 `attachmentResolver(ref)→dataURL` 展开（DeepSeek wire 协议仍旧 dataURL）。**向后兼容**：读侧 `resolveImageContent(images)`/投影层兼容旧 `{url: data:image/...}` dataURL 事件（直通，绝不 400）；`/api/chat` 上行也接受旧 url 形（旧客户端不断链）。旧 dataURL 形态恒不出现在本语义的主流路径（客户端先 POST /api/attachments 换 ref 再发送）。
2. **降级纪律（核心崩溃防线）**：Provider Adapter 在 buildRequest 内裁决——`preset.vision===true ∧ sanitizeProviderModel(model) 匹配 /vision/i` 才放行图像；否则带图用户消息降级为纯文本（原文本 + 「图像未能处理：当前模型不支持图像输入」+ 图片数），meta `degradedImages` 记录。**绝不把模型/供应商不接受的字段发出去**（400 是官方行为，本地预案先降级）。附件侧同纪律：ref 缺失（文件被删/篡改自校验失败）→ 该图降级文本提示（不 400）；展开后超 40MiB → 保序前缀保留、超额图降级文本提示（诚实路径——消息文本明说「N 张图未发送」）。
3. **估算**：`estimateImageTokens(w,h)`——官方缩放规则 + 512px 瓦片 × 96 token/瓦片，`min(384, tiles×96)`；每图下限 96（≥ OpenAI 常识口径 85）；宽高缺省按上限档 384（保守）——ref 形宽高由客户端测量传入（上传时服务端校验正整数）；多模态消息 token 计入 `parts.imageTokens`（独立分量）→ 参与窗口预算（windowTokens/压缩阈值/contextEstimateTokens——**含图预算**）。
4. **限额（dsh 三数对齐；2026-08-30 定案）**：单图 ≤20MiB、每消息 ≤20 张、单会话附件累计 ≤200MiB——上传面（POST /api/attachments）对 20MiB/200MiB 强制（超 413 带原因码 `attach-too-large`/`attach-session-quota`），消息面（/api/chat）对 20 张强制（超 413 `image-count-limit`）。**请求维度展开后校验**：单请求 dataURL 总量 ≤40MiB（DeepSeek 48MiB 请求体留 8MiB 裕量——20×20MiB 最坏 400MiB 情形被投影层拦下，超额图降级）。UI 镜像：≤20MiB、≤20 张（展示层只读镜像；服务端 413 兜底）。附件在 composer 左置钮（imagePlus 图标）选择 → 上传 → 预览卡（dsh AttachmentRail 几何：单图 240 长边/多图 64px tile/hover 移除/单击 lightbox）→ 发送（refs）→ 成功清空（失败保留重试）。
5. **A 档上限**：`/api/settings` 增 `maxInputTokens?/maxOutputTokens?`（严格正整数；未设不传；补丁持久化同 reasoning）→ `StoredConfig`/`CliConfig`/`DevmateConfig` 全链；`maxOutputTokens → runOptions.maxTokens`（未设 → 既有 DEFAULT_MAX_TOKENS 估价/不发送）；`maxInputTokens → ChatRequest.maxInputTokens`（preset `maxInputTokensField` 白名单：**仅 dashscope** 发 extra_body.max_input_tokens；其余剔除并记 meta.strippedParams）。**最小契约**：输入上限不参与窗口预算结算（不钳制 windowTokens——文案与请求字段层面生效）。
6. **来源与未证实项**：逐尺寸公式未公开（本实现标注 approximate，落 estimator 注释）→ 官方真值以 usage.prompt_tokens 为准。

## Considered Options

- **附图像时主循环改传空工具集**（「vision 模式不支持 tools」的常见猜测）：官方功能表明说 Tool Calls 支持（研究 §7）→ 否决，不引入 `visionToolsDisabled` 分支。
- **发送外部 URL 而非 dataURL**：需要公开可达主机、URL ≤8192 字符限制——本地文件场景不现实；dataURL 是官方明示的「本地文件最简单方式」→ 采用 dataURL。
- **UI 图像上限跟随官方 600 张**：48MiB 请求体在内联 dataURL 下 600 张（~4GB）第一个即超——单条消息上限由请求体推导（6 张），600 张是官方对多请求/虚拟化场景的上限项。
- **max_input_tokens 发给所有供应商（DeepSeek 也可能悄悄接受）**：未证实 → 违反「绝不发送未核实字段」纪律（ADR-0002 同源）→ 白名单裁。

## dsh 对照（2026-08-30 追加；研究 §12 一手源码，CTO 指令）

### A. 管线落地对照表（dsh → 我们 → 状态；本轮交付）

| 维度 | dsh（deepseek-harness cd5ef81） | DevMate 本实现 | 状态 |
|---|---|---|---|
| wire 到模型 | `image_url.url = data:<mediaType>;base64,<...>`（llm-deepseek/src/serialize.ts 逐字） | 同（展开后同形；展开面 = 注入 attachResolver：读附件文件 + dataURL 组装） | **一致**（官方 OpenAI 兼容形状；字节都 base64 内联） |
| 消息存储 | durable ref（sha256 内容寻址 + 授权 loader） | **同**：事件/帧只存 `{ref: sha256/<sha>.<ext>, width?, height?}`；字节在 `<sessionsDir>/attachments/`（dir 0700/文件 0600）| **落地**（+旧 dataURL 事件读侧兼容：resolveImageContent/投影层直通，绝不 400） |
| 内容寻址 | attachmentId(sha256)、content-defined 存储 | sha256（字节本体哈希）+ 白名单 ext 落盘；全局去重（同字节一文件）；会话 manifest（{bytes,refs}）记累计限额 | **落地**（dsh 同构；manifest 为限额/引用扫描的数据源） |
| 图片归一化 | EXIF 定向 + 归一化（≤2048² / ≤4MiB 质量阶梯） | **明确不做**（零运行时依赖硬约束——无图像库；不缩放不重编码，原字节直存直发；DeepSeek 模型侧自行缩放 ≤384t/图，上限档 800×800 在 44MiB 展开预算内） | **裁决：不做**（ADR 注明；归一化/缩放是未来升级项——引入图像库前提下的独立范围） |
| 输入路径 | 文件选择 + 文档级拖放（DropOverlay）+ 粘贴（keymap intakeFiles） | 同（既有）：文件选择 + document 级拖放（dragDepth 计数/遮罩）+ 粘贴 intake（同管线） | **已同**（第 1 轮补齐；本轮未动） |
| 预览 | AttachmentRail（横滚/箭头/hover 移除/单击原图→ImageLightbox） | attach-strip：hover 揭示移除 + 单击 lightbox + 单图 240 长边/多图 64px tile（imageFitSingle——与消息卡同几何）；横滚箭头简化（≤20 张 wrap 行）——保留差异注明 | **已对齐**（几何微调：单图长边 240/多图 tile；横滚箭头简化保留） |
| 消息渲染 | 单图长边 240px + 比例钳制 [0.25,4] + cover 裁剪锚；多图 64px tile；无尺寸文字 | 同（dsh MessageImage.singleFit 移植 + lightbox；无尺寸文字——lightbox 呈现）| **已同**（第 1 轮） |
| 限额 | 20MiB / 20 张 / 200MiB 累计 / 8192px | **20MiB/单图、20 张/消息、200MiB/会话累计**（413 带原因码）；8200px 官方限制项不作存储前置（模型侧自行拒绝）→ 请求维度 ≤40MiB 展开后校验（48MiB 留 8MiB）| **已对齐**（dsh 三数全用；40MiB 为本实现的 DeepSeek 请求体推导值——dsh 无此维度因其服务端整型 4MiB） |
| 降级 | 文本替身 + describe_image 工具；**原图不进日志** | vision 模型裁决降级（既有）+ **ref 缺失/超 40MiB 的投影层降级**（文本提示并入消息——诚实路径）；「另一模型描述」重路由不做（超范围，注明）；「图不进日志」差异保留：本实现会话含 ref（字节在附件目录 0600），隐私面同普通附件 | **覆盖**（新增两类降级路径；原件不进会话文件——slim 后的会话文件内容为 ref，字节在附件目录） |
| 附件展示读回 | `/attach` 授权端点（loader） | `GET /api/attachments/<ref>` 同源 raw（内容寻址 sha256 恒等 → immutable 缓存；缺失 404） | **落地**（同源假面；零授权面——本地单用户 + 127.0.0.1） |
| 会话删除联动 | （harness 同源回收） | DELETE /api/sessions → 引用扫描删除（manifest 引用集 × 其它会话引用集；共享保留；幂等） | **落地**（孤儿扫描 P2——启动时未引用文件清扫，本波不做） |
| 能力探测 | adapter 声明 + 插件 capability probe（多端点轮换） | preset.vision ∧ 模型名 /vision/i | 保守对等；端点轮换 = 未来升级项 |

### B. 协议面（服务端附件管线）

- `POST /api/attachments`：`{sessionId, dataUrl, width?, height?}`（dataURL 形）或 `{sessionId, data, mediaType, width?, height?}`（纯 base64+类型形——两形兼容）→ `{ref, width?, height?}`。上限：单图 20MiB（413 `attach-too-large`）、单会话累计 200MiB（413 `attach-session-quota`）；sessionId 必填（累计记账键；客户端在首条消息前生成 `s-<uuid>`）；载荷上限 32MiB（路由级 body limit——20MiB 文件 × 1.37 base64 + JSON 余量）。
- `GET /api/attachments/<ref>`：原始字节（内容类型按 ext；immutable 缓存）；ref 非法/缺失 404。
- `/api/chat` 上行 images：ref 形（主路）或旧 url 形（兼容）；>20 张 → 413。
- 展开时机：**投影层构建前**（project 的 pre-pass，注入 resolver；所有下流——估算（含图预算）/适配器 wire/压缩——消费展开后的 url 形；DeepSeek 协议零改动）。展开后全请求 dataURL 总和 ≤40MiB（保序前缀），超图 + 缺失图并入消息文本提示（`（图像未能处理：……）`），`projection.stats.degradedImages` 计数。

## Consequences

- vision 会话照常走 agents 主循环（tools/reasoning/压缩全兼容）；每图请求内 token 真实计费（1.5 元/百万未命中输入 × ≤384t ≈ ≤0.0006 元/图——冒烟成本 ≤$0.01 预算宽裕）。
- **会话文件 slim**：`~/.devmate/sessions/*.jsonl` 只含 ref（图片字节在 `<sessionsDir>/attachments/<sha>.<ext>`，dir 0700/文件 0600——VT-3 同隐私面）；旧会话 dataURL 事件读侧兼容（绝不 400、不做数据迁移）。
- **broker 4MiB 缓冲边界解除**：refs 是短串——session-user 帧不再随图变大（旧边界「6 图 × ~7MiB 可能超缓冲」随 slim 协议消失）；乐观气泡仍作正常兜底。
- 展示面：ref 形图的渲染经同源 `GET /api/attachments/<ref>`（内容寻址 immutable 缓存；缺失 404 → 图区空/自然失败态——旧 dataURL 事件直渲不受影响）。
- 删除联动：DELETE /api/sessions 引用扫描删除附件（共享保留）；孤儿附件扫描（启动时清理未引用文件）标注 P2——本波不做（最小路径达成：会话删除即回收）。
- `maxOutputTokens` 同时影响闸门 A 输出侧估价（请求带该值时以其计；否则 DEFAULT_MAX_TOKENS=8192 预留）。
- 清除已设上限：API 不提供撤销（与 windowTokens 同口径）——手改 ~/.devmate/config.json 删除相应键。
