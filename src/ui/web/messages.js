/**
 * # messages.js — SSE 事件 → 消息状态机（纯逻辑，node 可直接 import）
 *
 * 输入是 sse.js 产出的事件 `{event, data}`（协议见 sse.js 头注释），输出是
 * 可序列化的「视图快照（snapshot）」，DOM 层唯一消费入口 —— 渲染只读快照，
 * 所有先序条件（去重、累积、工具卡生命周期、审批挂起、用量/运行状态）在此收敛。
 *
 * ## 流模型（S13 单流契约）
 * 会话的流唯一且长活（app.js ensureStream）：连接先于 run 建立，SSE 不再按 run
 * 反复重开 —— 重放只在「重连/恢复」时发生（SessionBroker 全量回放同序），
 * 同会话第二条消息的流事件为实时帧（不再重放 → 无重复气泡）。
 * runActive 反映「服务端是否还有任务在跑」：startStream() 置 true，仅终态
 * run-status（8 个终态，见 format.js RUN_STATUS_SEMANTICS / TERMINAL_STATUSES）后置 false；
 * assistant-done 不代表 run 结束（还有工具/审批/下一轮）。发送门禁与停止按钮都由它驱动。
 *
 * ## 状态机规则（与 S12 协议一一对应）
 * - session-user    ：追加用户气泡。发送渲染单一来源（CS-001「双行同样」修复）——
 *                     「POST 响应后的乐观 addUser」与「SSE 回声帧」按**发送事一次对账**收口：
 *                     回声帧命中本地乐观气泡 → 原地合并（id 稳定，DOM 行不重建）；
 *                     SSE 帧先落地（长活流直投快于 POST 响应返回）→ 该帧即唯一渲染，
 *                     后续 addUser 消费竞态标记（awaitEcho）不再追加。**不做**「与最后
 *                     一条用户文本相同即去重」的尾比较 —— 那会把「连续两条同文本的合法
 *                     用户消息」当重放误吞；重放重复由 createReplayGuard 在 app.js 的
 *                     onEvent 上游统一丢弃。**无论以何种顺序收口都重置轮次边界**（run
 *                     之间 activeAssistantId 必须重新开始 —— 见 addUser/session-user）。
 *                     哨兵帧（R2-S2：data.system===true = 评审哨兵注入的系统样式消息）
 *                     作为**独立消息项**（kind 'sys'，系统样式渲染）追加——**不算新用户
 *                     回合**：不重置轮次边界、不打断 delta 累加、不触碰 runActive；系统
 *                     样式单行显示在消息流中（服务端自然收尾前注入，锚定上下文有据）。
 * - 恢复历史回放去重：GET /api/sessions/:id 逐帧 dispatch 后，长活流重放窗（SessionBroker
 *                     「后进回放」）会把同序事务帧再投一遍 —— app.js 经 createReplayGuard
 *                     逐段丢弃（覆盖回合段直到覆盖过的最后一条 assistant-done / 新序外
 *                     用户帧即解防放行实时流）。本模块产出快照的份数恒 = 事务真实份数。
 * - assistant-delta ：就地累积当前助手气泡文本（流式光标只在此态闪烁）。
 * - assistant-done  ：定稿；content 以其为准（delta 千字万句不如服务端权威值），
 *                     工具调用列表并卡（已存在的不重复）；回合结束（下一轮 delta 由
 *                     run-status/session-user 边界或本事件结束 —— 定稿即收流）。
 *                     思考定稿（thinkDone=true）+ Ran-for 钟差折算（doneAt-startedAt）。
 * - reasoning       ：思考增量（**Wave 2 新增协议帧；服务端 emit 尚未发 —— 前端先行
 *                     具备，协议演进即点即亮**）。就地累积到当前回合助手气泡的
 *                     reasoning 字段（Think Disclosure 折叠行数据源）；无活动气泡时
 *                     先建（reasoning 常先于正文 delta 到达）；assistant-done 后到达的
 *                     迟到帧并入最后一条助手气泡（不回退新建 —— 防御）。
 * - tool-start      ：生成/复位工具卡（执行中）。可在无 delta 时先到（独立成卡）。
 * - tool-result     ：工具卡落定 成功/失败；preview 供列表 + content 全量供展开详情
 *                     （服务端 64KB 缓冲上限，超出已由服务端截断）。
 * - 审查标记（B）   ：工具卡 review 标志 = spawn_subagent 且 arguments.prompt 含
 *                     审查|review（isReviewSubagent 纯函数；tool-start / tool-result /
 *                     assistant-done(toolCalls) / approval-request 皆在名称参数已知时
 *                     即标即走，与事件时序无关）—— 快照工具卡携带 review:boolean，
 *                     渲染层据此输出独立审查块（.review-block，不混入工具卡）。
 * - approval-request：工具卡挂起（待审批）并进入审批队列（内嵌审批卡一次呈现一个，
 *                     快照按队列保序，渲染层只取第一个等待项）。**协议演进（本轮）：
 *                     仅 ask 类需问询时到来；权限矩阵 deny 直拒不再产生本帧** ——
 *                     permission-denied 回注是普通 tool-result(ok:false)，模型继续。
 * - usage           ：覆盖式保存（服务端语义：本次运行累计），取最新调用值；
 *                    可带 contextEstimateTokens（run 内最后一次投影估算，缺省不带键）；
 *                    成本按 run 边界增量累入 costUsdCum（/cost 面板数据源）。
 * - run-status      ：覆盖式保存；8 个终态同时收流 + runActive 置 false；
 *                     user-interrupted 时把所有 pending 审批卡置「已中断」终态
 *                     （无理由拒绝的终态落定 —— 不再永脉冲）。
 * - run-error       ：置顶错误条；若有活动助手气泡则附着其错误徽标（runActive 仍由
 *                     随后的终态 run-status 落定，服务端恒成对发送）。
 * - compaction      ：上下文压缩披露（dsh context-injection-disclosure 理念）；消息流中
 *                     插入折叠小记（kind 'compaction'）。服务端已下发该帧（emit.ts 序列化
 *                     + 流内观察器/历史回放同一合成规则），本帧天然点亮。
 * - 未知事件        ：防御性忽略（协议演进上层可自行扩展）。
 * - 方法论线（R2-S1）：用户回合后首个助手气泡文本按行首提取 `方法线：<skillId>`
 *                     （format.js methodologyLine，纯函数）；delta 流式增量提取、
 *                     assistant-done 以权威定稿再提取一次；用户消息（session-user/
 *                     addUser）与 reset 清空 —— run-strip 小牌「方法线 tdd」数据源。
 *
 * 纯函数边界：所有变更经 dispatch/actions 汇入；无 setTimeout、无 DOM、无 fetch。
 */

/** run-status 终态清单（S12 RunStatus 八值；terminal 后 runActive=false），
 *  由 format.js 的 RUN_STATUS_SEMANTICS 导出（终态/标签/tone 三处镜像已合并为这一份表；
 *  dispatch 用它判定「run 落幕」，防漂移测试见 format.test.ts）。 */
import { TERMINAL_STATUSES, methodologyLine, isReviewSubagent } from './format.js';

/** 长会话 DOM 轻量化（任务书 C）：保留消息数上限，超出裁剪最旧为摘要行。 */
export const DEFAULT_MAX_ITEMS = 200;

/**
 * 消息渲染形态裁决（纯函数，渲染层唯一分类入口 —— 单测锚点）：
 * 快照消息项 → 渲染 kind。哨兵（R2-S2）在状态机侧已归一为 kind 'sys'；
 * 本函数同时兼容原始形状（kind 'user' + system:true → 'sys'）与未知 kind
 * 兜底 'system'（防御：渲染层永不因新 kind 落入空洞分支）。
 * 返回 'user' | 'assistant' | 'sys' | 'compaction' | 'system' 闭集。
 */
export function msgKind(item) {
  if (!item || typeof item !== 'object') return 'system';
  if (item.kind === 'sys') return 'sys';
  if (item.kind === 'user' && item.system === true) return 'sys';
  if (
    item.kind === 'user' ||
    item.kind === 'assistant' ||
    item.kind === 'compaction' ||
    item.kind === 'system'
  ) {
    return item.kind;
  }
  return 'system';
}

/**
 * 恢复历史回放去重守卫（纯逻辑；app.js 接在长活流 onEvent 上游）。
 *
 * 问题（CS-001「恢复历史产生重复」）：restoreSession 先用 GET /api/sessions/:id 把
 * 会话事务逐帧 dispatch（store 已是全量视图），随后 ensureStream 接入 /api/stream ——
 * SessionBroker 的「后进回放」会把同序事务帧（含直播合成的 delta 帧，与 GET 的
 * done 帧形状不同）**再投一遍** → user/assistant 双份。boot 恢复没有 GET（store 为空，
 * 重放即是历史本体）—— 不需要守卫；只在 GET 先行后接流的那一条路径上 arm。
 *
 * 覆盖判定：broker 重放窗 ⊆ GET 覆盖（窗是「服务端本进程内存缓冲」，GET 是「会话事件
 * 最近窗口」，窗内容恒为后者的子序）。按「回合段」跳过：session-user 帧命中期望序
 * （GET 覆盖的用户文本序列，有序）→ 该回合整段（delta/done/tool/usage/run-status…）
 * 丢弃；段终判据（解防）：
 * - 已丢完覆盖过的最后一条 assistant-done（doneSeen >= coveredDone）→ 其后为实时帧；
 * - 出现与期望序不匹配的用户帧（新一轮实时消息 / 实时消息先到）→ 解防并放行该帧。
 * 哨兵帧（system:true 的 session-user 不做序匹配 —— 状态机自身有「最后一条 sys 同文本
 * 即跳过」的尾去重；本守卫既不打乱覆盖序，也不因哨兵提前解防。
 *
 * 纯函数边界：无 DOM / 定时器；consume() 返回 true = 回放重复（调用方丢弃，不 dispatch）。
 */
export function createReplayGuard() {
  let armed = false;
  let expectedUsers = [];
  let idx = 0;
  let inSegment = false;
  let coveredDone = 0;
  let doneSeen = 0;

  return {
    /** arm 守卫：users = GET 覆盖的用户文本（有序；哨兵帧除外）；doneCount = GET 覆盖的
     *  assistant-done 帧数（覆盖段终止判据）。 */
    arm(users, doneCount) {
      expectedUsers = Array.isArray(users) ? users.filter((u) => typeof u === 'string') : [];
      idx = 0;
      inSegment = false;
      doneSeen = 0;
      coveredDone = Number.isFinite(Number(doneCount)) ? Number(doneCount) : 0;
      armed = true;
    },
    /** 解防（切换会话/GET 失败等路径显式调用；序列不匹配时亦自动解防）。 */
    clear() {
      armed = false;
      idx = 0;
      inSegment = false;
      doneSeen = 0;
      coveredDone = 0;
      expectedUsers = [];
    },
    isActive() {
      return armed;
    },
    consume(ev) {
      if (!armed) return false;
      const event = ev?.event;
      if (event === 'session-user') {
        const isSentinel = ev?.data?.system === true;
        if (isSentinel) {
          // 哨兵：不参与序匹配、不触发解防（状态机侧自行尾去重）；
          // 段内（覆盖回合的收尾注入）直接随段丢弃，段外（回放前导）放行交给状态机。
          return inSegment;
        }
        const text = ev?.data?.text;
        if (idx < expectedUsers.length && text === expectedUsers[idx]) {
          idx += 1;
          inSegment = true;
          return true; // 覆盖回合的用户帧：丢弃
        }
        armed = false; // 期望序外的新用户帧 = 实时开始：解防（本帧放行）
        return false;
      }
      if (event === 'assistant-done') {
        doneSeen += 1;
        if (doneSeen >= coveredDone) armed = false; // 覆盖段耗尽：其后为实时帧（本帧仍丢）
        return inSegment;
      }
      // 段内同伴帧（delta / tool / usage / run-status / compaction …）→ 随段丢弃
      return inSegment;
    },
  };
}

export function createMessageStore({ maxItems = DEFAULT_MAX_ITEMS } = {}) {
  const state = {
    sessionId: null,
    title: '',
    seq: 0,
    items: [], // {id,kind:'user'|'assistant'|'sys'|'system'|'compaction', text|content…}
    activeAssistantId: null,
    // 最近一次定稿的助手气泡 id（reasoning 迟到帧归属判定：同 turn 内 done 后到达的
    // 思考并入该气泡；session-user/addUser 开新 turn 即清 —— 绝不跨 turn 归并）。
    lastDoneAssistantId: null,
    approvals: [], // {toolCallId,name,arguments,state:'waiting'|'decided',approved?,reason?}
    usage: null,
    runStatus: null,
    lastError: null,
    streaming: false,
    runActive: false,
    // run 起始墙钟（展示层估算「运行中耗时」；终态/失败/重置时清空为 null）
    runStartedAt: null,
    foldedCount: 0, // 因超限被裁剪的最旧消息数（渲染为「（前 N 条消息已折叠）」）
    // 会话累计成本（/cost 命令面板数据源）：由 usage 事件累积（run 边界感知 ——
    // session-user（addUser 同理）后第一条 usage 按「新 run 全额」累加，此后同类
    // 事件按与前值增量累加，兼容「run 内多次 usage（覆盖式）」与「每次 run 一条」）。
    costUsdCum: 0,
    usageRunStarted: false, // 当前 run 是否已收到第一条 usage（run 边界标记）
    usagePrevCost: null, // 上一条 usage 的成本（增量基准）
    // R2-S1：方法论线（当前用户回合声明的方法技能 id；run-strip 小牌「方法线 tdd」数据源）。
    // 时机 = 用户回合后**首个**助手气泡（delta 流式增量提取，done 时以定稿全文本定值）；
    // 用户消息/reset 清空；同回合后续助手气泡（工具往返后的下一轮文字）不参与提取。
    methodLine: null,
    methodTrackedId: null, // 当前回合首个助手气泡 id（提取目标；回合边界清空）
    // R2-S2：评审哨兵系统样式消息（kind 'sys'）计数（本会话累计；reset 清零 ——
    // 快照暴露 systemUser 供测试锚点与统计；不受长会话裁剪影响）。
    systemUser: 0,
    // 发送竞态收口（CS-001「先两条同样、随后消失一条」：一条消息恒一条用户气泡）——
    // - localUserId：乐观气泡（POST 响应先回，addUser）id；回声帧同文本命中 → 原地合并定稿。
    // - awaitedEcho：SSE 帧先落地（长活流直投快于 POST 响应返回）的竞态兜底标记
    //   （文本）；addUser 命中即不再追加（回声帧已渲染该消息的唯一气泡）。
    //   两项均由 startStream / reset 清空 —— 恢复回放（GET 逐帧 dispatch 不带 addUser）
    //   的残留绝不误吞下一次发送（见 addUser 竞态收口）。
    localUserId: null,
    awaitedEcho: null, // { text: string }
  };

  const listeners = new Set();

  function emit() {
    state.seq += 1;
    for (const fn of listeners) fn(snapshot());
  }

  /**
   * 长会话上限：裁剪**最旧**（front）消息到 maxItems，计数进 foldedCount。
   * 活动助手气泡恒为最新（append-only），从前面裁永不伤及 activeAssistantId ——
   * 防御性兜底：万一裁中则重置轮次边界（activeAssistantId 失效后绝不悬垂）。
   */
  function trim() {
    if (state.items.length <= maxItems) return;
    const excess = state.items.length - maxItems;
    state.items.splice(0, excess);
    state.foldedCount += excess;
    if (
      state.activeAssistantId !== null &&
      !state.items.some((it) => it.id === state.activeAssistantId)
    ) {
      state.activeAssistantId = null;
    }
  }

  function nextId() {
    state.idCounter = (state.idCounter ?? 0) + 1;
    return String(state.idCounter);
  }

  // ---------------------------------------------------------------------
  // 助手气泡运行时
  // ---------------------------------------------------------------------

  /** 当前回合的助手气泡（无则新建）；轮次边界由调用方按 run 重置。
   *  Wave 2：at = 消息时刻锚（行 meta 时钟）；startedAt = 本气泡首事件时刻（Ran-for 钟差，
   *  done 时折算 ranForMs —— 详见 assistant-done）；reasoning/thinkDone = 思考折叠行数据。 */
  function activeAssistant() {
    if (!state.activeAssistantId) {
      const now = Date.now();
      const item = {
        id: nextId(),
        kind: 'assistant',
        text: '',
        done: false,
        error: null,
        tools: [],
        at: now,
        startedAt: now,
        reasoning: '',
        thinkDone: false,
        doneAt: null,
        ranForMs: null,
      };
      state.items.push(item);
      state.activeAssistantId = item.id;
    }
    return state.items.find((it) => it.id === state.activeAssistantId);
  }

  /** 按 toolCallId 全量找卡（审批/回执落点；与 activeAssistant 无关）。 */
  function findToolCard(id) {
    for (const it of state.items) {
      if (it.kind !== 'assistant') continue;
      const exist = it.tools.find((t) => t.id === id);
      if (exist) return exist;
    }
    return null;
  }

  function toolCard(id) {
    // 先全量查找：late tool-result（如定稿后回执）必须落到原气泡的卡上
    const exist = findToolCard(id);
    if (exist) return exist;
    const holder = activeAssistant();
    const card = { id, name: '', arguments: '', state: 'running', result: null, review: false };
    holder.tools.push(card);
    return card;
  }

  /** 审查标记（B：spawn_subagent 且 arguments.prompt 含 审查|review → 独立审查块）。
   *  判定只依赖调用形状（name+arguments），与事件时序无关 —— 工具卡无论由
   *  tool-start / tool-result / assistant-done(toolCalls) / approval-request 任何路径
   *  建立或更新，都在名称/参数已知时即标即走（isReviewSubagent 纯函数，见 format.js）。 */
  function maybeReview(card) {
    if (card.review) return;
    if (isReviewSubagent({ name: card.name, arguments: card.arguments })) card.review = true;
  }

  // ---------------------------------------------------------------------
  // 事件分派
  // ---------------------------------------------------------------------
  function dispatch({ event, data }) {
    if (!event || typeof event !== 'string') return;
    switch (event) {
      case 'session-user': {
        // R2-S2：评审哨兵帧（system:true）→ 独立系统样式消息项。与普通用户帧关键差异：
        // **不算新用户回合** —— 不重置轮次边界 / 方法论线 / usage run 标记、不打断
        // 当前助手气泡的 delta 累加（哨兵注入发生在自然收尾前，不算用户发言）；
        // 也从不设置 title（无关于会话首句；哨兵只出现在有实质变更的会话里）。
        // 去重规则（重连非刷新场景：broker 重放历史帧，哨兵同文本 = 同一事件的重复投递）：
        // 与用户帧同款「最后一条同文本即跳过」——哨兵不增量（计数也不变）。
        if (data?.system === true) {
          const text = String(data?.text ?? '');
          if (findLastKind('sys')?.text === text) break;
          state.items.push({ id: nextId(), kind: 'sys', text, at: Date.now() });
          state.systemUser += 1;
          break;
        }
        const text = String(data?.text ?? '');
        // 轮次边界与去重解耦：无论回放是否去重，新 run 的 delta 必须进新气泡。
        // 同时置 run 边界标记（下一条 usage = 新 run 全额 —— /cost 累计正确性前提）。
        // R2-S1 方法论线同边界：新回合清空（旧 run 的小牌不再持续显示）。
        state.activeAssistantId = null;
        state.lastDoneAssistantId = null;
        state.usageRunStarted = false;
        state.methodLine = null;
        state.methodTrackedId = null;
        // 单一事实渲染（CS-001）：本帧必为「本次发送的消息」的回声，与乐观 addUser
        // 按一次发送对账 —— 绝不并存两条同文本用户气泡；同时**不设**「与最后一条用户
        // 同文本即跳过」的尾去重（会把「连续两条同文本的合法用户消息」当重放误吞；
        // 重放重复由下方 createReplayGuard 在 app.js 的事件上游统一丢弃）。
        // ① 乐观气泡先行（POST 响应短于直投）：原地合并（id 稳定 —— DOM 行不重建）；
        if (state.localUserId !== null) {
          const local = state.items.find(
            (it) => it.id === state.localUserId && it.kind === 'user' && it.local === true,
          );
          if (local && local.text === text) {
            local.local = false;
            state.localUserId = null;
            state.awaitedEcho = null;
            break; // 边界重置已在上面完成
          }
        }
        // ② SSE 帧先落地（长活流直投快于 POST 响应）：本帧即该消息的唯一渲染 —
        //    记 awaitedEcho 供接下来的 addUser 消费（追加被吞，不产生第二行）。
        state.awaitedEcho = { text };
        state.items.push({
          id: nextId(),
          kind: 'user',
          text,
          at: Date.now(),
          // 多模态（ADR-0015）：图像卡数据源（与协议帧 images 同形；缺省无键）
          ...(data?.images?.length > 0 ? { images: data.images } : {}),
        });
        if (!state.title) state.title = text.slice(0, 24);
        break;
      }
      case 'assistant-delta': {
        const a = activeAssistant();
        a.text += String(data?.text ?? '');
        a.done = false;
        state.streaming = true;
        // R2-S1：方法论线增量提取（流式期间值随 delta 校正，如 't' → 'tdd'；
        // 只认本轮首个助手气泡 —— 后续气泡（工具往返后的文字）不复采）
        if (state.methodTrackedId === null) state.methodTrackedId = a.id;
        if (state.methodTrackedId === a.id) state.methodLine = methodologyLine(a.text);
        break;
      }
      case 'assistant-done': {
        const a = activeAssistant();
        if (typeof data?.content === 'string' && data.content !== '') a.text = data.content;
        a.done = true;
        // R2-S1：定稿后以服务端权威 content 再提取一次（delta 半截/回放契约的最终修正）
        if (a.id === state.methodTrackedId) state.methodLine = methodologyLine(a.text);
        // 思考收尾（dsh ReasoningRow 定稿态）：首行摘要 + 行收起（app.js 消费 thinkDone）
        a.thinkDone = true;
        // Ran-for 钟差：done 时刻 = 本气泡首事件时刻（首 delta/reasoning/tool 已设 startedAt）
        a.doneAt = Date.now();
        if (Number.isFinite(a.startedAt) && a.startedAt !== null) {
          a.ranForMs = Math.max(0, a.doneAt - a.startedAt);
        }
        for (const tc of data?.toolCalls ?? []) {
          if (!a.tools.some((t) => t.id === tc.id)) {
            const card = {
              id: tc.id,
              name: String(tc.name ?? ''),
              arguments: String(tc.arguments ?? ''),
              state: 'done-waiting-result', // 服务端告知但未回 result（常见顺序），静待
              result: null,
              review: false,
            };
            maybeReview(card);
            a.tools.push(card);
          }
        }
        state.streaming = false;
        state.activeAssistantId = null; // 定稿：后续事件不再并入（延迟回执按 id 找卡）
        state.lastDoneAssistantId = a.id; // 同 turn 迟到 reasoning 的归并目标
        break;
      }
      case 'reasoning': {
        // 思考增量帧（同上注释）：入当前回合（或最后一条）助手气泡；纯累积，无流态变化。
        const text = String(data?.text ?? '');
        if (!text) break;
        // 归属裁决：turn 内定稿后到达的迟到帧并入刚定稿气泡（不回退新建）；
        // 新 turn（session-user 已清 lastDoneAssistantId）→ activeAssistant() 新开。
        let a = null;
        if (state.activeAssistantId === null && state.lastDoneAssistantId !== null) {
          const last = findLastKind('assistant');
          if (last && last.id === state.lastDoneAssistantId) a = last;
        }
        if (!a) a = activeAssistant();
        a.reasoning = (a.reasoning ?? '') + text;
        break;
      }
      case 'tool-start': {
        const card = toolCard(String(data?.id));
        card.name = String(data?.name ?? card.name);
        if (data?.arguments !== undefined) card.arguments = String(data.arguments);
        card.state = 'running';
        card.result = null;
        maybeReview(card);
        break;
      }
      case 'tool-result': {
        const card = toolCard(String(data?.id));
        if (data?.name !== undefined) card.name = String(data.name);
        if (data?.arguments !== undefined) card.arguments = String(data.arguments);
        card.state = data?.ok === false ? 'failed' : 'success';
        card.result = {
          ok: data?.ok !== false,
          preview: String(data?.contentPreview ?? ''),
          // 全量内容（服务端 64KB 缓冲上限内完整）；缺失时回落预览（协议旧帧兼容）
          content: data?.content != null ? String(data.content) : null,
          error: data?.error != null ? String(data.error) : null,
        };
        maybeReview(card);
        break;
      }
      case 'approval-request': {
        const toolCallId = String(data?.toolCallId ?? '');
        const card = toolCard(toolCallId);
        card.name = String(data?.name ?? card.name);
        if (data?.arguments !== undefined) card.arguments = String(data.arguments);
        maybeReview(card);
        card.state = 'pending';
        // 同一工具只挂一次等待
        if (!state.approvals.some((ap) => ap.toolCallId === toolCallId)) {
          state.approvals.push({
            toolCallId,
            name: card.name,
            arguments: card.arguments,
            state: 'waiting',
          });
        }
        break;
      }
      case 'usage': {
        // C 档：usage 帧可携带 contextEstimateTokens（run 内最后一次投影估算；
        // 缺省不带键 —— 上下文中占环在无估算时隐藏）。
        const contextEstimateTokens = numOr(data?.contextEstimateTokens);
        state.usage = {
          promptTokens: numOr(data?.promptTokens),
          completionTokens: numOr(data?.completionTokens),
          totalTokens: numOr(data?.totalTokens),
          costUsd: numOr(data?.costUsd),
          estimated: Boolean(data?.estimated),
          ...(contextEstimateTokens !== null ? { contextEstimateTokens } : {}),
        };
        if (data?.costUsd == null && data?.totalTokens == null) {
          state.usage = null; // 空壳事件（如纯 estimated 无值）不值得展示
        } else {
          // 会话累计成本（/cost）：run 边界感知增量（见 state 字段注释）——
          // 新 run 首条 usage 全额累加；此后按与前值增量（>= 基准才取差，防御
          // 服务端回退式数据）；基准缺失同首条处理。
          const cost = numOr(data?.costUsd);
          if (cost !== null) {
            const prev = state.usagePrevCost;
            let delta = cost;
            if (state.usageRunStarted && prev !== null && cost >= prev) delta = cost - prev;
            state.costUsdCum = (state.costUsdCum ?? 0) + delta;
            state.usageRunStarted = true;
            state.usagePrevCost = cost;
          }
        }
        break;
      }
      case 'run-status': {
        state.runStatus = {
          status: String(data?.status ?? ''),
          steps: numOr(data?.steps),
          durationMs: numOr(data?.durationMs),
        };
        const status = state.runStatus.status;
        if (status === 'running') {
          state.streaming = true;
          state.runActive = true;
          // 时刻锚点只由 startStream 设立（发送瞬间才算起跑）；run-status 帧只落终态
        } else if (TERMINAL_STATUSES.includes(status)) {
          state.streaming = false;
          state.runActive = false;
          state.runStartedAt = null;
          if (status === 'user-interrupted') settleInterruptedApprovals();
        }
        break;
      }
      case 'compaction': {
        // 上下文压缩披露（dsh context-injection-disclosure 理念的本地形态）：
        // 历史被压缩处插入折叠小记；summary 全文仅在展开时渲染（懒惰，见 app.js）。
        state.items.push({
          id: nextId(),
          kind: 'compaction',
          tokensBefore: numOr(data?.tokensBefore),
          tokensAfter: numOr(data?.tokensAfter),
          summary: typeof data?.summary === 'string' ? data.summary : '',
        });
        break;
      }
      case 'run-error': {
        const message = String(data?.message ?? '未知错误');
        state.lastError = message;
        const a = activeAssistant();
        if (a) a.error = message;
        state.streaming = false;
        break;
      }
      default:
        return; // 未知事件：忽略（防御）
    }
    trim(); // 裁剪恒在 emit 之前：快照任何时刻都满足上限不变量
    emit();
  }

  /** 无理由拒绝/中断本轮：pending 审批卡 → 终态「已中断」，审批队列清空（内嵌卡收起）。 */
  function settleInterruptedApprovals() {
    for (const ap of state.approvals) {
      if (ap.state === 'waiting') {
        ap.state = 'decided';
        ap.approved = false;
        ap.reason = '';
      }
    }
    for (const it of state.items) {
      if (it.kind !== 'assistant') continue;
      for (const card of it.tools) {
        if (card.state === 'pending') {
          card.state = 'interrupted';
          card.result = {
            ok: false,
            preview: '',
            content: null,
            error: '用户未批准执行，本轮已中断',
          };
        }
      }
    }
  }

  function findLastKind(kind) {
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      if (state.items[i].kind === kind) return state.items[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // 主动作（UI 层调用）
  // ---------------------------------------------------------------------
  function addUser(text, images) {
    const t = String(text);
    // 竞态收口（CS-001）：echo 帧（session-user）先落地（长活流直投快于 /api/chat 响应
    // 返回）而 send() 的乐观渲染尚未执行时，该消息的唯一渲染已由回声完成 —— 消费标记，
    // 绝不追加第二份（同文本的**连续第二条**消息经 startStream/上一 Echo 消费归零后照常落一行）。
    const echo = state.awaitedEcho;
    if (echo !== null && echo.text === t) {
      state.awaitedEcho = null;
      return;
    }
    const item = {
      id: nextId(),
      kind: 'user',
      text: t,
      at: Date.now(),
      local: true,
      // 多模态（ADR-0015）：乐观气泡同形状携带（回声合并保留本地数据——不入空）
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
    };
    state.items.push(item);
    state.localUserId = item.id;
    state.awaitedEcho = null;
    if (!state.title) state.title = t.slice(0, 24);
    // 轮次边界：乐观渲染的用户消息也是新 run 的起点（下一轮 delta 开新气泡）；
    // 并置 run 边界标记（同上 —— 本次发送产出的 usage 按新 run 全额累计）。
    // R2-S1 方法论线同边界清空（新用户回合即清小牌 —— 与 session-user 对称）。
    state.activeAssistantId = null;
    state.lastDoneAssistantId = null;
    state.usageRunStarted = false;
    state.methodLine = null;
    state.methodTrackedId = null;
    trim();
    emit();
  }

  /** 本地即时系统气泡（网络错误/中断提示；不参与协议重放）。 */
  function addSystem(text, level = 'error') {
    state.items.push({ id: nextId(), kind: 'system', level, text: String(text) });
    trim();
    emit();
  }

  function setSessionId(id) {
    state.sessionId = id ?? null;
    emit();
  }

  /** 历史恢复的标题（GET /api/sessions/:id 的 title 字段；不覆盖已有首句标题之外的逻辑）。 */
  function setTitle(title) {
    state.title = String(title ?? '').slice(0, 120);
    emit();
  }

  /** 清空会话视图（切换会话时调用；sessionId 由调用方随后设置）。 */
  function reset() {
    state.items.length = 0;
    state.approvals.length = 0;
    state.activeAssistantId = null;
    state.lastDoneAssistantId = null;
    state.usage = null;
    state.runStatus = null;
    state.lastError = null;
    state.title = '';
    state.streaming = false;
    state.runActive = false;
    state.runStartedAt = null;
    state.foldedCount = 0;
    state.costUsdCum = 0;
    state.usageRunStarted = false;
    state.usagePrevCost = null;
    state.methodLine = null;
    state.methodTrackedId = null;
    state.systemUser = 0;
    state.localUserId = null;
    state.awaitedEcho = null;
    emit();
  }

  /**
   * 开一次 run（发送门禁）：run 进行中返回 false —— 调用方提示
   * 「上一条任务仍在运行，请等待或按停止」（不再静默吞）。
   * 每轮发送前清竞态标记：恢复回放（GET 逐帧 dispatch 不带 addUser）留下的
   * awaitedEcho / localUserId 残留绝不误吞本次发送（见 addUser 竞态收口）。
   */
  function startStream() {
    if (state.runActive) return false;
    state.runActive = true;
    state.streaming = true;
    state.lastError = null;
    state.runStartedAt = Date.now();
    state.awaitedEcho = null;
    state.localUserId = null;
    emit();
    return true;
  }

  /** SSE 连接关闭（长活流断开/切换）：只影响流态；runActive 仍由终态 run-status 落定。 */
  function endStream() {
    state.streaming = false;
    emit();
  }

  /** run 未启动即失败（POST 未达/被拒）：显式结束 runActive，避免界面卡「运行中」。 */
  function endRun() {
    state.runActive = false;
    state.streaming = false;
    state.runStartedAt = null;
    emit();
  }

  /**
   * 审批应答（用户点了内嵌审批卡的 允许/拒绝，或按 Esc）。
   * - approve：工具卡回到 running（服务端后续会补 tool-result 落色；若没有则以兜底收场）；
   * - deny 带理由：卡直接落「已拒绝（denied）」终态并带拒因（服务端随后补 tool-result 失败回执）；
   * - deny 无理由（内嵌卡现状：无附注框 —— 拒绝即无备注拒绝）：卡保持 pending
   *   （服务端不落 tool 事件）；终态 run-status=user-interrupted 到达时统一置「已中断」。
   */
  function decideApproval(toolCallId, approve, reason) {
    const ap = state.approvals.find((x) => x.toolCallId === toolCallId);
    if (ap) {
      ap.state = 'decided';
      ap.approved = approve;
      ap.reason = String(reason ?? '');
    }
    const card = findToolCard(toolCallId);
    if (!card) {
      emit();
      return;
    }
    if (approve) {
      card.state = 'running';
      card.result = null;
    } else if (reason) {
      card.state = 'denied';
      card.result = {
        ok: false,
        preview: '',
        content: null,
        error: `用户拒绝执行（理由：${reason}）`,
      };
    }
    // 无理由拒绝：此处不落卡，等待终态 run-status 统一处理
    emit();
  }

  // ---------------------------------------------------------------------
  // 快照（纯数据，可 JSON.stringify —— 测试断言与 DOM 渲染共用）
  // ---------------------------------------------------------------------
  function snapshot() {
    return {
      sessionId: state.sessionId,
      title: state.title,
      seq: state.seq,
      streaming: state.streaming,
      runActive: state.runActive,
      runStartedAt: state.runStartedAt,
      methodLine: state.methodLine,
      items: state.items.map((it) => {
        if (it.kind === 'assistant') {
          return {
            id: it.id,
            kind: 'assistant',
            text: it.text,
            done: it.done,
            error: it.error,
            at: it.at,
            ranForMs: it.ranForMs,
            reasoning: it.reasoning,
            thinkDone: it.thinkDone,
            tools: it.tools.map((t) => ({
              id: t.id,
              name: t.name,
              arguments: t.arguments,
              state: t.state,
              result: t.result ? { ...t.result } : null,
              review: t.review === true,
            })),
          };
        }
        if (it.kind === 'user') {
          return {
            id: it.id,
            kind: 'user',
            text: it.text,
            at: it.at,
            // 多模态（ADR-0015）：图像卡数据（无图不带键——旧快照形状不变）
            ...(Array.isArray(it.images) && it.images.length > 0 ? { images: it.images } : {}),
          };
        }
        if (it.kind === 'sys') return { id: it.id, kind: 'sys', text: it.text, at: it.at };
        if (it.kind === 'compaction') {
          return {
            id: it.id,
            kind: 'compaction',
            tokensBefore: it.tokensBefore,
            tokensAfter: it.tokensAfter,
            summary: it.summary,
          };
        }
        return { id: it.id, kind: 'system', level: it.level, text: it.text };
      }),
      // 审批队列：只暴露「等待中」的项（保序；内嵌审批卡渲染层只取第一个 —— 一次一个）
      approvals: state.approvals.filter((a) => a.state === 'waiting'),
      usage: state.usage ? { ...state.usage } : null,
      costUsdCum: state.costUsdCum,
      runStatus: state.runStatus ? { ...state.runStatus } : null,
      lastError: state.lastError,
      foldedCount: state.foldedCount,
      // R2-S2：评审哨兵系统样式消息计数（测试锚点；0 = 未注入过）
      systemUser: state.systemUser,
    };
  }

  return {
    dispatch,
    addUser,
    addSystem,
    setSessionId,
    setTitle,
    reset,
    startStream,
    endStream,
    endRun,
    decideApproval,
    snapshot,
    subscribe(fn) {
      listeners.add(fn);
      fn(snapshot());
      return () => listeners.delete(fn);
    },
  };
}

function numOr(v) {
  if (v === null || v === undefined) return null; // null 不能经 Number(null)=0 泄漏成“0 步”
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
