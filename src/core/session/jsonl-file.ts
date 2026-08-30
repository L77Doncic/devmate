import { chmodSync, createReadStream, mkdirSync, readdirSync } from 'node:fs';
import { access, copyFile, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  ATTACH_REF_RE,
  EVENT_KINDS,
  SESSION_SCHEMA_VERSION,
  type EventKind,
  type SessionEvent,
  type SessionEventInput,
} from '../../shared/session-types.js';
import {
  assertValidSessionId,
  BaseSessionStore,
  buildSavedEvent,
  type SessionFileHealth,
} from './base.js';
// 存储层脱敏（VT-3 修复 b）：kind==='tool' 的 result content 落盘前过同一 redactSecrets——
// 磁盘永远不出现模式命中的凭据（与 registry 层的回注前脱敏同实现，幂等；存储层是最终口径）
import { redactSecrets } from '../tools/redact.js';
import { SessionExistsError, SessionNotFoundError, SessionSeqConflictError } from './errors.js';

export interface JsonlFileAdapterOptions {
  /** 会话文件所在目录（每个会话一个 <id>.jsonl 文件）。 */
  dir: string;
  /** 容错读的告警通道（坏行/半行被跳过时调用）；缺省走 console.warn。 */
  warn?: (message: string) => void;
  /**
   * 存储层脱敏开关（VT-3 修复 b；缺省 true）：
   * kind==='tool' 的 payload.content 在落盘前过 redactSecrets（掩码即最终口径——append
   * 返回值、磁盘、resume/回放全部为掩码形式，真实凭据不出现在模型可见上下文两次）。
   * 只作用于 tool 事件（user/assistant/reasoning/event 不脱敏——刻录面按「工具结果」收敛）。
   */
  redactToolContent?: boolean;
}

/**
 * JSONL 文件适配器：append-only 事件流落盘为 `<dir>/<id>.jsonl`，每行一个事件。
 *
 * 崩溃一致性（ADR-0004 / research §3.2）：每次 append 以单次 write 写入整行（以 \n 结尾）并 fsync 后再返回，
 * 因此任意时刻崩溃只留下「完整合法行 + 可能的一个截断尾行」。写端在追加前做尾部归一化
 * （normalizeTail）：尾行可解析为完整事件 → 补 \n（保留）；不可解析（撕裂半行）→ 截断 + 告警。
 * 读端逐行容错，半行/坏行跳过并告警。
 *
 * 单写者假设（ADR-0004 注释保留）：每个会话同一时刻只有一个写入实例。本类的落地方式 —
 * 1) 同实例并发 append 按会话串行化（进程内单写：appendQueues，seq 严格递增无重复）；
 * 2) seq 每写前从磁盘实际尾部冗余推导（lastSeqOnDisk+1），nextSeqBySession 缓存降级为
 *    纯提示：缓存与磁盘不一致时以磁盘为准（告警诊断后继续写），绝不因缓存陈旧把「另一次
 *    续写」变成用户可见的硬错；跨进程双写不由本类防御（端口/会话级锁已防，见 ADR-0004）。
 */
export class JsonlFileAdapter extends BaseSessionStore {
  private readonly dir: string;
  private readonly warn: (message: string) => void;
  /** 纯提示缓存（hint）：记录本实例上次分配的下一个 seq，只用于不一致诊断，不作裁决依据。 */
  private readonly nextSeqBySession = new Map<string, number>();
  /** 每会话 append 串行队列（进程内单写者的执行体）：前一个 append 完成才放行下一个。 */
  private readonly appendQueues = new Map<string, Promise<void>>();
  /** 存储层脱敏开关（VT-3 修复 b；缺省 true——见选项注）。 */
  private readonly redactToolContent: boolean;

  constructor(options: JsonlFileAdapterOptions) {
    super();
    this.dir = options.dir;
    this.warn = options.warn ?? ((message: string) => console.warn(`[session] ${message}`));
    this.redactToolContent = options.redactToolContent ?? true;
    // VT-3 修复 a：会话存储目录 0700、会话文件 0600（新文件按位；存量一次性纠正——
    // 会话文件可被同机其它用户读出的历史 0644/0755 形态在构造函数里收敛）。
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    healDirectoryPermissions(this.dir);
  }

  async create(id: string): Promise<void> {
    const path = this.fileFor(id);
    let fh: FileHandle;
    try {
      fh = await open(path, 'wx', 0o600); // VT-3 修复 a：新会话文件 0600（不随 umask 走 0644）
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new SessionExistsError(id);
      }
      throw err;
    }
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await syncDir(this.dir);
    this.nextSeqBySession.set(id, 1);
  }

  async exists(id: string): Promise<boolean> {
    return existsOnDisk(this.fileFor(id));
  }

  async append<K extends EventKind>(
    id: string,
    input: SessionEventInput<K>,
  ): Promise<SessionEvent<K>> {
    return this.enqueueAppend(id, input);
  }

  /** per-session 串行化：同一会话的 append 严格按调用序执行（seq 分配/写入的排队互斥）。 */
  private enqueueAppend<K extends EventKind>(
    id: string,
    input: SessionEventInput<K>,
  ): Promise<SessionEvent<K>> {
    const prev = this.appendQueues.get(id);
    const task =
      prev === undefined
        ? this.doAppend(id, input)
        : prev.then(
            () => this.doAppend(id, input),
            () => this.doAppend(id, input), // 前序失败不阻断本序（错误只传给各自调用方）
          );
    // 队列尾部存「已收敛」的结束哨兵：下一个 append 不管本序成败都能继续。
    this.appendQueues.set(
      id,
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
    return task;
  }

  private async doAppend<K extends EventKind>(
    id: string,
    input: SessionEventInput<K>,
  ): Promise<SessionEvent<K>> {
    const path = this.fileFor(id);
    if (!(await existsOnDisk(path))) {
      throw new SessionNotFoundError(id);
    }
    await normalizeTail(path, this.warn);
    const seq = await this.reserveNextSeq(id, path);
    const saved = buildSavedEvent(input, seq);
    // 存储层脱敏（VT-3 修复 b；默认为最终口径）：tool 结果 content 落盘前掩码——
    // append 返回的 saved 即掩码（UI 投影/resume 回放与磁盘同真值，真实凭据不出现两次）。
    // 只作用于 kind==='tool'；掩码产物是合法文本（`[REDACTED:*]` 无引号/换行），JSON 仍可解析。
    if (this.redactToolContent) {
      const wide = saved as unknown as SessionEvent; // 泛型 K 收宽后再判型（与 UI 层同规）
      if (wide.kind === 'tool') {
        wide.payload.content = redactSecrets(wide.payload.content);
      }
    }
    await writeDurable(path, `${JSON.stringify(saved)}\n`);
    this.nextSeqBySession.set(id, seq + 1);
    return saved;
  }

  /**
   * 会话文件行健康统计（VT-8 损坏展示语义；纯读无副作用，失败/不存在 → null）：
   * totalLines = 文件全部行数（含撕裂尾行）；parseableLines = 可解析为合法事件的行数。
   * 全损坏（不可解析行 > SESSION_CORRUPTION_RATIO，emit.ts 常量）→ 列表/详情标记「（会话损坏）」。
   */
  async fileHealthFor(id: string): Promise<SessionFileHealth | null> {
    const path = this.fileFor(id);
    if (!(await existsOnDisk(path))) return null;
    let totalLines = 0;
    let parseableLines = 0;
    for await (const line of readLines(path)) {
      totalLines += 1;
      if (parseEventLine(line).ok) parseableLines += 1;
    }
    return { totalLines, parseableLines };
  }

  events(id: string): AsyncIterable<SessionEvent> {
    return this.streamEvents(id);
  }

  /**
   * 会话分叉（fork）：把源会话历史逐字节复制到新 id，原文件不动（CONTEXT「会话分叉」）。
   * 实现为「临时文件 + fsync + 原子 rename」：分叉结果要么完整存在、要么不存在
   * （copyFile 直接写目标会被崩溃撕成半成品——其尾部若恰好在行边界则无坏行可告警）。
   */
  async fork(fromId: string, newId: string): Promise<void> {
    const source = this.fileFor(fromId);
    const target = this.fileFor(newId);
    if (!(await existsOnDisk(source))) {
      throw new SessionNotFoundError(fromId);
    }
    if (await existsOnDisk(target)) {
      throw new SessionExistsError(newId);
    }
    const tmp = join(this.dir, `.fork-${newId}.tmp`);
    try {
      await copyFile(source, tmp);
      const fh = await open(tmp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    await syncDir(this.dir);
    this.nextSeqBySession.set(newId, await this.computeNextSeq(newId));
  }

  private async computeNextSeq(id: string): Promise<number> {
    let max = 0;
    for await (const ev of this.events(id)) {
      if (ev.seq > max) {
        max = ev.seq;
      }
    }
    return max + 1;
  }

  private fileFor(id: string): string {
    assertValidSessionId(id);
    return join(this.dir, `${id}.jsonl`);
  }

  /** 逐行流式读取（readline 会在流结束时把无 \n 的残尾作为最后一行交给解析器）。 */
  private async *streamEvents(id: string): AsyncGenerator<SessionEvent> {
    const path = this.fileFor(id);
    if (!(await existsOnDisk(path))) {
      throw new SessionNotFoundError(id);
    }
    let lineNo = 0;
    let lastSeq = 0;
    for await (const line of readLines(path)) {
      lineNo += 1;
      const parsed = parseEventLine(line);
      if (!parsed.ok) {
        // 崩溃一致性：撕裂半行/坏行/结构不符行一律跳过 + 告警，绝不因单行脏数据拒绝载入整个会话。
        this.warn(`${id}.jsonl line ${lineNo}: dropped corrupted line (${parsed.reason})`);
        continue;
      }
      const event = parsed.event;
      // seq 用于幂等去重（research §3.3）：回退/重复的合法行也被判为脏。
      if (event.seq <= lastSeq) {
        this.warn(
          `${id}.jsonl line ${lineNo}: dropped out-of-order line (seq ${event.seq} <= ${lastSeq})`,
        );
        continue;
      }
      lastSeq = event.seq;
      yield event;
    }
  }

  /**
   * 预订下一个 seq：以磁盘实际尾部的最后一个完整合法事件的 seq 为准 +1（每写前冗余读取，
   * 不信任缓存——resume 后另一实例可能已续写）。nextSeqBySession 只是纯提示：
   * - 缓存与磁盘不一致（通常是另一实例/resume 续写了更多行，磁盘在前）→ 以磁盘为准继续写，
   *   并告警诊断（含 id/cached/derived）；缓存不一致绝不演变为用户可见的硬错；
   * - 仅当磁盘回退（lastSeqOnDisk < 缓存-1，即本实例已写入的 seq 从磁盘消失——文件被
   *   另一进程替换/截断的病态场景，概率≈0）仍抛 SessionSeqConflictError 兜底。
   */
  private async reserveNextSeq(id: string, path: string): Promise<number> {
    const last = await lastEventSeqOnDisk(path);
    const next = last + 1;
    const cached = this.nextSeqBySession.get(id);
    if (cached !== undefined) {
      if (next < cached) {
        throw new SessionSeqConflictError(id, cached, next);
      }
      if (next > cached) {
        this.warn(
          `${id}.jsonl seq cache stale: cached next=${cached}, disk-derived next=${next}; ` +
            'disk truth wins (another writer may have appended this session; ' +
            'single-writer per session is assumed per ADR-0004, cache kept as hint only)',
        );
      }
    }
    this.nextSeqBySession.set(id, next);
    return next;
  }
}

/**
 * 写端尾部归一化（ADR-0004「崩溃残留处理条款」）：先把「文件尾非 \n」的状态收敛为干净行尾，
 * 再追加新事件（否则会与残行粘连成新坏行）。
 * - 尾行可解析为完整事件 → 补一个 '\n'：它对读端已是承诺事实（占 seq），保留、seq 不变；
 * - 尾行不可解析（撕裂半行）→ 截断：它从未成为事件，允许删除，并以告警可见。
 * 快路径：末字节已是 '\n'（常规写手流每行必以 '\n' 结尾），不做任何事。
 */
async function normalizeTail(path: string, warn: (message: string) => void): Promise<void> {
  const fh = await open(path, 'r+');
  try {
    const { size } = await fh.stat();
    if (size === 0) {
      return;
    }
    const last = Buffer.alloc(1);
    const { bytesRead } = await fh.read(last, 0, 1, size - 1);
    if (bytesRead === 1 && last[0] === 0x0a) {
      return;
    }
    const tailLine = await readTailLine(fh, size);
    if (tailLine !== null && parseEventLine(tailLine).ok) {
      await writeDurable(path, '\n');
      return;
    }
    await truncateToLastNewline(fh, size);
    warn(`${path} torn tail truncated (partially written line never became an event)`);
  } finally {
    await fh.close();
  }
}

/** 读最后一个 '\n' 之后到 EOF 的字节（文件尾无 '\n' 时的整条尾行）；无任何 '\n' 时返回整个文件。 */
async function readTailLine(fh: FileHandle, size: number): Promise<string | null> {
  let pos = size;
  const WINDOW = 64 * 1024;
  while (pos > 0) {
    const start = Math.max(0, pos - WINDOW);
    const chunk = Buffer.alloc(pos - start);
    await fh.read(chunk, 0, chunk.length, start);
    const nl = chunk.lastIndexOf(0x0a);
    if (nl >= 0) {
      const lineStart = start + nl + 1;
      const line = Buffer.alloc(size - lineStart);
      await fh.read(line, 0, line.length, lineStart);
      return line.toString('utf8');
    }
    pos = start;
  }
  const whole = Buffer.alloc(size);
  await fh.read(whole, 0, size, 0);
  return whole.toString('utf8');
}

/** 把文件截断到最后一个 '\n'（含）；整个文件无 '\n' 则清空。调用前确认末字节非 '\n'（normalizeTail 已检）。 */
async function truncateToLastNewline(fh: FileHandle, size: number): Promise<void> {
  let pos = size;
  const WINDOW = 64 * 1024;
  while (pos > 0) {
    const start = Math.max(0, pos - WINDOW);
    const chunk = Buffer.alloc(pos - start);
    await fh.read(chunk, 0, chunk.length, start);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl >= 0) {
      await fh.truncate(start + lastNl + 1);
      return;
    }
    pos = start;
  }
  await fh.truncate(0);
}

/**
 * 磁盘最后一个「完整可解析为合法事件」行的 seq（用于派生下一个 seq；坏行/残行从后向前跳过）。
 * 空文件或没有任何可解析事件行时返回 0。调用前提：文件以 '\n' 结尾（normalizeTail 已保证）。
 *
 * 无 64KB 窗口截断（VT-1 修复）：反向块扫描**只用于定位行边界**（找 '\n' 的位置、逐行向前跳），
 * 候选行本身按 [行首, 行尾 '\n'] 全量读取（任意长度）——>64KB 的单事件行（b:1000/b:2800
 * 复现路径）的 seq 推导与短行一致；绝不用「扫描窗口终点」代替文件行终点，否则长行被
 * 截断成不完整 JSON → 误判 seq（500 冲突 / 重启后重复 seq 数据丢失）。
 * 同文件其它逆向扫描（readTailLine / truncateToLastNewline）不受此缺陷影响：它们定位到
 * 边界后按文件真实终点读取/截断（readTailLine 读 [lineStart, size)；truncate 只到定位的 '\n'）。
 */
async function lastEventSeqOnDisk(path: string): Promise<number> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= 1) {
      return 0; // 空文件或只有一个孤 '\n'：没有完整行
    }
    // 文件尾是 '\n'（契约）：最后一行 = [上一个 '\n' + 1, 文件尾 '\n')。
    // 候选区段右端（右开）初始 = size（含文件尾 '\n'——它才是末行终止符）；
    // 坏行被跳过时收缩到该行行首 lineLeft（= 上一行行尾 '\n' 的位置）。
    let regionEnd = size;
    for (;;) {
      const nl = await findLastNewlineBefore(fh, regionEnd);
      if (nl < 0) {
        // [0, regionEnd) 内没有任何 '\n'：该区间就是候选内容（无终止符单行）
        const line = Buffer.alloc(regionEnd);
        await fh.read(line, 0, regionEnd, 0);
        const parsed = parseEventLine(line.toString('utf8'));
        return parsed.ok ? parsed.event.seq : 0;
      }
      // 行右端 = nl 处的 '\n'（终止符）；行左端 = 其上一位 '\n' + 1（无则 0）；
      // 行内容 [lineLeft, nl) 全量读取（任意长度——无 64KB 截断）。
      const lineLeft = (await findLastNewlineBefore(fh, nl)) + 1;
      const line = Buffer.alloc(nl - lineLeft);
      await fh.read(line, 0, line.length, lineLeft);
      const parsed = parseEventLine(line.toString('utf8'));
      if (parsed.ok) {
        return parsed.event.seq;
      }
      regionEnd = lineLeft; // 该行不可解析：越过它继续向前找（lineLeft 位即是上一行的 '\n'）
    }
  } finally {
    await fh.close();
  }
}

/** 定位 [0, posExclusive) 内最后一个 '\n' 的位置；无 → -1。块反向扫描只找边界，不做行截断。 */
async function findLastNewlineBefore(fh: FileHandle, posExclusive: number): Promise<number> {
  const WINDOW = 64 * 1024;
  let pos = posExclusive;
  while (pos > 0) {
    const start = Math.max(0, pos - WINDOW);
    const chunk = Buffer.alloc(pos - start);
    await fh.read(chunk, 0, chunk.length, start);
    const idx = chunk.lastIndexOf(0x0a);
    if (idx >= 0) {
      return start + idx;
    }
    pos = start;
  }
  return -1;
}

/** 以单次 write 写入并 fsync（写序不变量：落盘后才对调用方返回）。 */
async function writeDurable(path: string, text: string): Promise<void> {
  const fh = await open(path, 'a');
  try {
    await fh.write(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function* readLines(path: string): AsyncGenerator<string> {
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    yield line;
  }
}

/**
 * 解析并校验一行事件：
 * - 非法 JSON / 结构不符（v、seq、ts、kind、payload 形状、meta 契约）→ 返回失败原因；
 * - 只理解本版本 schema（v === SESSION_SCHEMA_VERSION），未来版本行判为脏。
 * payload 按 kind 校验形状（user/assistant/tool/system/reasoning/event 各自的声明类型），
 * 缺字段/类型不符的行判为脏（读端跳过 + 告警），保证下游（pairing 等）拿到的形状可信。
 */
function parseEventLine(
  line: string,
): { ok: false; reason: string } | { ok: true; event: SessionEvent } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return { ok: false, reason: `invalid JSON (${(err as Error).message})` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not an object' };
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.v !== SESSION_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schema version v=${String(candidate.v)}` };
  }
  if (!Number.isInteger(candidate.seq) || (candidate.seq as number) < 1) {
    return { ok: false, reason: 'invalid seq' };
  }
  if (typeof candidate.ts !== 'number' || !Number.isFinite(candidate.ts)) {
    return { ok: false, reason: 'invalid ts' };
  }
  if (
    typeof candidate.kind !== 'string' ||
    !(EVENT_KINDS as readonly string[]).includes(candidate.kind)
  ) {
    return { ok: false, reason: 'invalid kind' };
  }
  if (typeof candidate.payload !== 'object' || candidate.payload === null) {
    return { ok: false, reason: 'invalid payload' };
  }
  if (
    candidate.meta !== undefined &&
    (typeof candidate.meta !== 'object' || candidate.meta === null)
  ) {
    return { ok: false, reason: 'invalid meta' };
  }
  const shapeError = payloadShapeError(
    candidate.kind as EventKind,
    candidate.payload as Record<string, unknown>,
  );
  if (shapeError !== null) {
    return { ok: false, reason: shapeError };
  }
  return { ok: true, event: candidate as unknown as SessionEvent };
}

/** 按 kind 校验 payload 形状（与 shared/session-types.ts 的声明类型一致）；不符返回原因。 */
function payloadShapeError(kind: EventKind, payload: Record<string, unknown>): string | null {
  switch (kind) {
    case 'user': {
      if (typeof payload.content !== 'string') return 'payload.content: expected string';
      return userImagesError(payload.images);
    }
    case 'system':
    case 'reasoning':
      return typeof payload.content === 'string' ? null : 'payload.content: expected string';
    case 'assistant':
      if (typeof payload.content !== 'string') {
        return 'payload.content: expected string';
      }
      if (!Array.isArray(payload.toolCalls)) {
        return 'payload.toolCalls: expected array';
      }
      for (const call of payload.toolCalls) {
        const entry = call as Record<string, unknown>;
        if (
          typeof call !== 'object' ||
          call === null ||
          typeof entry.id !== 'string' ||
          typeof entry.name !== 'string' ||
          typeof entry.arguments !== 'string'
        ) {
          return 'payload.toolCalls: malformed ToolCall entry';
        }
      }
      return null;
    case 'tool':
      if (typeof payload.toolCallId !== 'string') {
        return 'payload.toolCallId: expected string';
      }
      if (typeof payload.content !== 'string') {
        return 'payload.content: expected string';
      }
      return null;
    case 'event':
      return typeof payload.type === 'string' ? null : 'payload.type: expected string';
  }
}

/**
 * user 消息 images 校验（ADR-0015 · dsh 管线落地）：缺省/空数组视为无图；
 * 提供时必须是数组，逐项为**ref 形**（新协议：{ref: sha256/<sha>.<ext>}——slim 存储）
 * 或**url 形**（旧协议：{url: data:image/... dataURL}——旧事件兼容），width?/height?:
 * 正整数。返回错误原因；合法 → null。
 */
function userImagesError(images: unknown): string | null {
  if (images === undefined) return null;
  if (!Array.isArray(images)) return 'payload.images: expected array';
  if (images.length === 0) return null;
  for (const img of images) {
    if (typeof img !== 'object' || img === null) {
      return 'payload.images: malformed image entry';
    }
    const entry = img as Record<string, unknown>;
    const ok =
      (typeof entry.ref === 'string' && ATTACH_REF_RE.test(entry.ref)) ||
      (typeof entry.url === 'string' && entry.url.startsWith('data:image/'));
    if (!ok) {
      return 'payload.images: expected sha256/<sha>.<ext> ref or data:image/... dataURL';
    }
    for (const dim of ['width', 'height'] as const) {
      const value = entry[dim];
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
      ) {
        return `payload.images: ${dim} expected positive integer`;
      }
    }
  }
  return null;
}

async function existsOnDisk(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 会话存储目录/文件权限纠正（VT-3 修复 a；POSIX 语义，Windows chmod 为近似实现——
 * 与 cli/config.ts 的 saveConfig 0600/0700 同口径）：
 * - 目录 0700（含历史 0755 存量——会话文件名/存在性不再对同机其它用户可读）；
 * - 全部存量 `<id>.jsonl` 0600（历史 0644 文件一次性收敛——shell 越界读出的 key
 *   不再以明文摆在同机可读的会话文件里，存储层还有掩码兜底，见 doAppend）。
 * 同步执行（构造时一次；文件数受会话上限约束）。任何失败静默（不可强制的平台）。
 */
function healDirectoryPermissions(dir: string): void {
  try {
    chmodSync(dir, 0o700);
  } catch {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      chmodSync(join(dir, name), 0o600);
    } catch {
      // 中途被删/不可读：跳过不致命
    }
  }
}

/** 新目录项落盘才可能在断电后仍然存在；仅 POSIX 支持目录 fsync，其余平台静默跳过。 */
async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // best effort（Windows 对目录 fsync 会失败）
  }
}
