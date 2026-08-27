import { createReadStream, mkdirSync } from 'node:fs';
import { access, copyFile, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  EVENT_KINDS,
  SESSION_SCHEMA_VERSION,
  type EventKind,
  type SessionEvent,
  type SessionEventInput,
} from '../../shared/session-types.js';
import { assertValidSessionId, BaseSessionStore, buildSavedEvent } from './base.js';
import { SessionExistsError, SessionNotFoundError, SessionSeqConflictError } from './errors.js';

export interface JsonlFileAdapterOptions {
  /** 会话文件所在目录（每个会话一个 <id>.jsonl 文件）。 */
  dir: string;
  /** 容错读的告警通道（坏行/半行被跳过时调用）；缺省走 console.warn。 */
  warn?: (message: string) => void;
}

/**
 * JSONL 文件适配器：append-only 事件流落盘为 `<dir>/<id>.jsonl`，每行一个事件。
 *
 * 崩溃一致性（ADR-0004 / research §3.2）：每次 append 以单次 write 写入整行（以 \n 结尾）并 fsync 后再返回，
 * 因此任意时刻崩溃只留下「完整合法行 + 可能的一个截断尾行」。写端在追加前做尾部归一化
 * （normalizeTail）：尾行可解析为完整事件 → 补 \n（保留）；不可解析（撕裂半行）→ 截断 + 告警。
 * 读端逐行容错，半行/坏行跳过并告警。seq 由磁盘实际尾部推导（reserveNextSeq），不允许跨实例静默复用
 * 陈旧缓存（单写者假设，见 ADR-0004）。
 */
export class JsonlFileAdapter extends BaseSessionStore {
  private readonly dir: string;
  private readonly warn: (message: string) => void;
  private readonly nextSeqBySession = new Map<string, number>();

  constructor(options: JsonlFileAdapterOptions) {
    super();
    this.dir = options.dir;
    this.warn = options.warn ?? ((message: string) => console.warn(`[session] ${message}`));
    mkdirSync(this.dir, { recursive: true });
  }

  async create(id: string): Promise<void> {
    const path = this.fileFor(id);
    let fh: FileHandle;
    try {
      fh = await open(path, 'wx');
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
    const path = this.fileFor(id);
    if (!(await existsOnDisk(path))) {
      throw new SessionNotFoundError(id);
    }
    await normalizeTail(path, this.warn);
    const seq = await this.reserveNextSeq(id, path);
    const saved = buildSavedEvent(input, seq);
    await writeDurable(path, `${JSON.stringify(saved)}\n`);
    this.nextSeqBySession.set(id, seq + 1);
    return saved;
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
   * 预订下一个 seq：以磁盘实际尾部的最后一个完整合法事件的 seq 为准 +1——不信任可能
   * 陈旧的 nextSeqBySession 缓存（resume 后另一实例可能已续写）。与本实例缓存比对：
   * 不一致即单写者假设被破坏（两个写入实例），报错而非静默复用陈旧 seq
   * （否则重复 seq 行会被读端静默丢弃，新事件无声消失）。
   */
  private async reserveNextSeq(id: string, path: string): Promise<number> {
    const next = (await lastEventSeqOnDisk(path)) + 1;
    const cached = this.nextSeqBySession.get(id);
    if (cached !== undefined && cached !== next) {
      throw new SessionSeqConflictError(id, cached, next);
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
 */
async function lastEventSeqOnDisk(path: string): Promise<number> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= 1) {
      return 0; // 空文件或只有一个孤 '\n'：没有完整行
    }
    const WINDOW = 64 * 1024;
    let end = size - 1; // 考察区间 (右开)：排除文件尾的 '\n'
    while (true) {
      const start = Math.max(0, end - WINDOW);
      const chunk = Buffer.alloc(end - start);
      await fh.read(chunk, 0, chunk.length, start);
      const nl = chunk.lastIndexOf(0x0a);
      if (nl >= 0) {
        const lineStart = start + nl + 1;
        const line = Buffer.alloc(end - lineStart);
        await fh.read(line, 0, line.length, lineStart);
        const parsed = parseEventLine(line.toString('utf8'));
        if (parsed.ok) {
          return parsed.event.seq;
        }
        end = lineStart - 1; // 该行不可解析：越过它继续向前找
        if (end <= 0) {
          return 0;
        }
      } else if (start === 0) {
        // 已到文件头且该子段无 '\n'：[0, end) 是同一行
        const line = Buffer.alloc(end);
        await fh.read(line, 0, end, 0);
        const parsed = parseEventLine(line.toString('utf8'));
        return parsed.ok ? parsed.event.seq : 0;
      } else {
        end = start;
      }
    }
  } finally {
    await fh.close();
  }
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
    case 'user':
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

async function existsOnDisk(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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
