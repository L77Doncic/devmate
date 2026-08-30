---
Status: accepted
---

# 请求侧上限钳制（S）与「超限报错 → 压缩/钳制重试」自愈链（M+L）

依据 = .scratch/coding-agent/research/limits-effects-and-overflow.md（2026-08-30 只读审计 +
真实 DeepSeek 边界实测；下称「研究」）。审计结论三条钉死本波范围：
① OUTPUT 真生效（settings → `body.max_tokens` 全链）、INPUT 白名单生效（仅 DashScope
`max_input_tokens`）但**无任何上游钳制**（用户配 1000K 会原样进 wire）；
② DeepSeek 超限 = **400 拒绝且 message 印出合法区间**（`valid range of max_tokens is
[1, 393216]`），不静默 clamp；③ 「超限报错 → 压缩 → 重试」链**从未接线**（`forceLevel`
/`isOverBudget` 只有测试调用；400 不在 RETRYABLE_STATUS；命中态 = fatal）——与调研文档
E7「就算配置错了窗口，run 也不会死」的既有承诺相悖。

## 一手实测（2026-08-30；真实 API，4 请求，≈223 tokens）

| 请求 `max_tokens` | 结果 |
|---|---|
| 16 | 200，`finish_reason:"length"`（截断而非拒绝——64 这类「过小」值不报错） |
| 393216（=384K） | 200（边界值） |
| 393217 | 400 `{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 393216]","type":"invalid_request_error",...}}` |
| 500000 / 1000000 | 400（同 D1 错误体） |

结论：**合法区间 [1, 393216]**（与供应商 pricing 页「输出最大 384K」一致）；上下文 1M
（同页 + 用户模型名 `[1m]` 尾标语义 + dsh `DEFAULT_CONTEXT_WINDOW=1_000_000` 互证）。
OpenAI/Qwen/GLM/Kimi 同款 400 措辞（`context_length_exceeded` / "maximum context length
is N" / "Range of ... should be [1, N]"；API-SPEC §4.4/§5.2 与 Qwen 官方错误页）。

## 决策

### S：上限表（presets.ts）+ 双面钳制（settings POST / adapter wire）

1. **上限表**（Preset 数据，唯一来源）：`ProviderPreset.maxOutputTokens?` —— deepseek
   **393216**（实测）、kimi **131072**（API-SPEC §5.2；文中「最大 1048576」口径未收入——
   取保守档，用户可设置覆盖）、glm **131072**（§5.2 schema 上限）、dashscope/openai
   **无键**（qwen3-coder 上限未核实 / OpenAI 模型各异 → 不钳，注「待实测」——
   绝不本地猜数，由运行时自愈链兜底）。`deepseek.contextWindowTokens` 128000 →
   **1_000_000**（实测过 1M 代际；其余四家保持 128000 = 估算，可在设置覆盖）。
2. **clampLimits 纯函数**（`core/llm/clamp-limits.ts`，preset 数据驱动，零 IO）：
   输出 > `maxOutputTokens`（有据）→ 钳到上限 + `clampedMaxOutput`；输入 >
   `contextWindowTokens` → 钳到窗口 + `clampedMaxInput`；无上限供应商 → 输出不钳。
   **钳制值 = 持久化值**（settings 存钳后值；保存即生效）。GET 回执扩展
   `maxInputTokensClamped`/`maxOutputTokensClamped` 标记（与既有 `*Default` 标记同族）——
   UI「已按 <model> 上限钳制为 N」toast（保存响应 clamped → 提示）+ 回显注记。
   UI 表单另做**软提示**（值 > 窗口预算 → 红字不阻止，服务端钳制兜底——不哑巴也不误拦）。
3. **S5 适配层护栏**：`buildRequest` 对已知 cap 再核一遍（deepseek 393217 → wire 393216）——
   已知上限绝不 400；无 cap 供应商直发（保留运行时链）。
4. **INPUT → 窗口接线**（min）：`startRun` 的窗口预算 =
   `min(三源窗口(effectiveWindow), maxInputTokens)`——输入上限双语义：
   (a) DashScope wire 字段（白名单直发，既有）；(b) 本地预算上限（README 注明）。
   原 index.ts 「最小契约：maxInputTokens 不参与窗口预算结算」注释撤销。

### M：超限自愈链（E7 兑现：400 不再 fatal）

5. **classifyContextError(message)**（`core/llm/error-parse.ts`；M1）：
   词表（B.a 三大家实测/文档 + dsh 分类器等价物）——`context-exceeded`
   （`context_length_exceeded`/`context length`/`maximum context`/`context too long`/
   `prompt is too long`/`too long for the model`/`Range of input length`）与 `output-limit`
   （`valid range of max_tokens`/`Invalid max_tokens`/`maximum output`/`Range of max_tokens`）。
   `hintMax` 解析：`[1, N]`（DeepSeek/Qwen 表单——两区间并存取大者）/ "maximum context
   length is N"（OpenAI 表单）——子类先定，输出区间值绝不冒充窗口。
6. **接线点 = 主循环 run()**（本轮层；`RunOptions.onLimitsError` 通知回调）：
   `runTurn` fatal + 分类命中 → 不再 fatal：升级压缩（`overflowEscalation` 0→1→2 →
   `project()` 的 `forceLevel`）重试同轮；**≤2 次/轮**（升到 2 仍失败 → fatal），
   **跨轮重置**（成功工具轮/续跑轮后归零）。重试计入步数/成本（steps 逐轮 +1、失败轮已
   记账），不触熔断（格式错误计数无关）。同时：`context-exceeded` 的 hintMax →
   本 run 窗口预算 `min(设置窗口, 学习值)`；`output-limit` 的 hintMax → 本 run `maxTokens`
   钳为它（min）后重试——「256K 模型写 1000K」的两面（窗口设错 / 输出超限）都收敛。
   与既有语义接轨：window-unknown 的「超限报错 → 压缩 → 重试」兜底从此真的存在
   （forceLevel=2 + 窗口未知时摘要仍要求窗口判定——此时学习值正好补上窗口；
   无学习值且窗口未知 → 压缩 2 级尝试后 fatal，符合「压缩不收敛即熔断」的另一面）。
7. **L2 上限学习（免费探测）**：解析出的上限经 `RunOptions.onLimitsError` 上报 → 服务端
   记 `learnedLimitCaps`（全局单值——settings 是全局的；**端点/模型/密钥变更即清空**），
   `effectiveWindow()` 用 `min` 钳住窗口并在 `windowDetail` 报「由错误学习：
   N（超限报错 message 解析）」；后续 run 的窗口/`maxTokens` 同样被钳（min）。

### L：输出截断提示（E8）

8. **E8**：主循环消费 `snapshot.finishReason === 'length'` → 注入系统样式 user 消息
   （「上次回复被输出上限截断，请更简洁」）后续跑一次（≤1 次/run）——**纯提示，
   不自动重发**同一请求（模型对提示的自然回应 = 新请求，正常计步计成本）；
   已提示过 → 自然结束。

## dsh 对照（同款链出处）

| 维度 | dsh（deepseek-harness cd5ef81） | DevMate（本波） |
|---|---|---|
| clamp | 无（zod min(1)，默认 256000——偏保守） | **有**（S：preset 上限表 + clampLimits + adapter 护栏；DeepSeek 实测 393216） |
| 400 上下文超限分类 | `isContextWindowExceededError`（error.ts:25,80 正则） | **同款**（classifyContextError——词表平移 + hintMax 数值解析增强） |
| 压缩重试链 | compaction-basic:183（命中码 → 压缩 + 重试） | **同款语义**（forceLevel 0→1→2、≤2 次/轮、跨轮重置；学习值补窗口） |
| 上限来源 | adapter catalog + connection definition | 三源窗口 + **由错误学习**（400 message 免费解析） |

## Consequences

- 已核实的超限（DeepSeek 393216 / 窗口 1M）在设置层即被钳——供应商 400 只在
  未知面（dashscope/openai 无据、模型/端点变更瞬间）出现，且被自愈链收住；
- `maxInputTokens` 从「每请求白付剔除记录」立升为「预算上限」（窗口预算 min）——
  语义变化集中在 startRun 一处，RunOptions/README 注明；
- 失败轮次保留原始错误在 run_result.fatal（升级链竭尽时）；
- 钳制标记为运行时态（重启后仅钳后值持久化；标记随下次 POST 重算——与 Default 标记
  的「重算于 GET」不同，ADR 注明）；
- 未知面（dashscope/openai 真实上限、Kimi 1048576 口径取舍）留「待实测」注记；
  `classifyContextError` 词表可日后再扩（供应商措辞新形态 = 加一行正则）。
