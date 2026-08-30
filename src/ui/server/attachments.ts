/**
 * # ui/server/attachments：内容寻址附件存储（dsh 管线落地；ADR-0015）
 *
 * dsh 对照（research/deepseek-vision.md §12-C/D；deepseek-harness attachment-local）：
 * 服务端保存图片字节（content-defined 本地附件存储），消息/事件只存 durable ref——
 * dsh 的 ImageAttachmentRef{attachmentId(sha256), mediaType, bytes, width, height}，
 * 本实现的 ref = `sha256/<sha>.<ext>`（sha = 字节 sha256 hex；ext 由 mediaType 推导）。
 * 限额（dsh attachment-local 缺省三数）：20MiB/单图、20 图/消息、200MiB/单会话累计。
 *
 * 零运行时依赖硬约束（CTO 2026-08-30）：**不做归一化/缩放**——无图像库（无 EXIF 定向、
 * 无 normalizedImageMaxPixels/质量阶梯）。原字节直存直发：DeepSeek 模型侧自行缩放
 * （deepseek-vision.md §2 每图 384 token 上限），无暂存管线修正码。ADR-0015 注明裁决。
 *
 * 形状与协议：
 * - receive(input)：input = {sessionId, dataUrl, width?, height?}（dataURL 形）或
 *   {sessionId, data, mediaType, width?, height?}（纯 base64 + 类型形）；
 *   校验 → 字节 ≤20MiB（否则 AttachmentStoreError attach-too-large/413）→ sha256 →
 *   以内容寻址写入 <dir>/<sha>.<ext>（已存在则复用——全局去重）→ 会话 manifest
 *   <dir>/<sessionId>.manifest.json（{bytes, refs}——累计限额与引用扫描的数据源；
 *   同会话同 ref 只计一次）→ 返回 {ref, width?, height?}。
 * - resolve(ref) → dataURL | null：读文件 + `data:<mime>;base64,` 组装（wire 展开面——
 *   DeepSeek 协议仍旧）；sha 校验（内容寻址自校验——篡改/缺失 → null = 该图降级文本提示）。
 * - deleteSession(sessionId)：引用扫描删除——先删 manifest，再对 manifest 引用的每个文件
 *   检查是否被**其它**会话的 manifest 引用；无引用 → 删文件（共享附件保留；会话删除联动）。
 *   （正常会话删除的全部文件即本会话 manifest——事件引用的 ref 必然先经 receive 落 manifest；
 *   崩溃中途的孤儿文件由启动清理兜底——P2。）
 * - 目录 0700、文件 0600（与服务端会话文件同隐私面——图像与工具输出同属用户本地内容）。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ATTACH_REF_RE } from '../../shared/session-types.js';

/** 附件限额（dsh attachment-local 缺省三数；ADR-0015 服务端权威；浏览器镜像见 ui/web/attachments.js）。 */
export const ATTACH_LIMITS = Object.freeze({
  /** 单文件字节上限（20 MiB）。 */
  maxImageBytes: 20 * 1024 * 1024,
  /** 每消息最多图片数（20；/api/chat 计数面）。 */
  maxCount: 20,
  /** 单会话附件累计字节上限（200 MiB；manifest 记账）。 */
  maxSessionBytes: 200 * 1024 * 1024,
  /** 单次 POST /api/attachments 载荷上限（20MiB 文件 × base64 膨胀 4/3 ≈ 27.9MiB + JSON 余量）。 */
  maxUploadBodyBytes: 32 * 1024 * 1024,
});

/** ref 的媒体类型（唯一白名单：DeepSeek 官方 JPEG/PNG/GIF/WebP，deepseek-vision.md §3）。 */
const MEDIA_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});
const EXT_BY_MEDIA: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
});

/**
 * 附件 ref 合法形态（单一权威来源 = shared/session-types.ts；此处 re-export——
 * 防路径逃逸的判定根：sha256 整段白名单 + 白名单 ext，任何域外字符不会进入路径拼接）。
 */
export { ATTACH_REF_RE } from '../../shared/session-types.js';

/** ref 形态判定（纯函数；UI 镜像同规则）。 */
export function isAttachmentRef(value: unknown): value is string {
  return typeof value === 'string' && ATTACH_REF_RE.test(value);
}

/** ref → sha hex（非法 → null；纯函数）。 */
export function refSha(ref: string): string | null {
  const match = ATTACH_REF_RE.exec(ref);
  return match !== null ? (match[1] as string) : null;
}

/** 上传/限额错误（路由层映射状态码；code = 原因码——400/413 语义分离）。 */
export class AttachmentStoreError extends Error {
  constructor(
    readonly code: 'attach-too-large' | 'attach-session-quota' | 'attach-invalid',
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentStoreError';
  }
}

export interface AttachmentUploadInput {
  sessionId: string;
  /** 单图素材（dataURL 形 OR data+mediaType 形——兼容两种上传协议）。 */
  dataUrl?: string;
  /** 纯 base64 字节串（与 dataUrl 二选一；data 恒有 mediaType 伴随）。 */
  data?: string;
  /** MIME 类型（配合 data；image/png|jpg|jpeg|gif|webp）。 */
  mediaType?: string;
  /** 原图像素宽（客户端测量；服务端校验正整数——仅用于 token 估算，不进文件）。 */
  width?: number;
  /** 原图像素高（同上）。 */
  height?: number;
}

/** 会话附件账本（manifest 内容形状——累计限额与引用扫描删除的数据源）。 */
export interface SessionAttachmentUsage {
  bytes: number;
  refs: string[];
}

/** 内容寻址附件存储（零依赖 fs 实现；路径恒由 ref 白名单构造）。 */
export class AttachmentStore {
  constructor(
    /** 附件目录（<sessionsDir>/attachments）；懒建（0700）。 */
    readonly dir: string,
    private readonly limits: { maxImageBytes?: number; maxSessionBytes?: number } = {},
  ) {}

  private get maxImageBytes(): number {
    return this.limits.maxImageBytes ?? ATTACH_LIMITS.maxImageBytes;
  }

  private get maxSessionBytes(): number {
    return this.limits.maxSessionBytes ?? ATTACH_LIMITS.maxSessionBytes;
  }

  private manifestPath(sessionId: string): string {
    return join(this.dir, `${sessionId}.manifest.json`);
  }

  /**
   * 接收一张图：校验 → 解码 → sha256 → 内容寻址落盘（去重）→ 会话 manifest 记账。
   * 超限抛 AttachmentStoreError（413 语义；形状非法 → attach-invalid/400）。
   */
  async receive(input: AttachmentUploadInput): Promise<{ ref: string; width?: number; height?: number }> {
    // 素材归一：dataURL（data:image/<fmt>;base64,...）或 data base64 + mediaType
    let bytes: Buffer;
    let ext: string;
    if (typeof input.dataUrl === 'string' && input.dataUrl !== '') {
      const parsed = parseImageDataUrl(input.dataUrl);
      if (parsed === null) throw new AttachmentStoreError('attach-invalid', 400, 'dataUrl must be a data:image/... dataURL');
      bytes = parsed.bytes;
      ext = parsed.ext;
    } else if (typeof input.data === 'string' && typeof input.mediaType === 'string') {
      const extByType = EXT_BY_MEDIA[input.mediaType.toLowerCase()];
      if (extByType === undefined) {
        throw new AttachmentStoreError('attach-invalid', 400, `unsupported mediaType: ${input.mediaType}`);
      }
      let decoded: Buffer;
      try {
        decoded = Buffer.from(input.data, 'base64');
      } catch {
        throw new AttachmentStoreError('attach-invalid', 400, 'data must be a base64 string');
      }
      bytes = decoded;
      ext = extByType;
    } else {
      throw new AttachmentStoreError(
        'attach-invalid',
        400,
        'body must be {dataUrl,...} or {data, mediaType,...}',
      );
    }

    if (bytes.length > this.maxImageBytes) {
      throw new AttachmentStoreError(
        'attach-too-large',
        413,
        `image exceeds maximum size of ${Math.round(this.maxImageBytes / 1024 / 1024)} MiB`,
      );
    }

    const sha = createHash('sha256').update(bytes).digest('hex');
    const ref = `sha256/${sha}.${ext}`;
    const filePath = join(this.dir, `${sha}.${ext}`);

    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // 内容寻址去重：文件已存在（他会话/本会话先前上传）→ 不复写
    if (!(await exists(filePath))) {
      await writeFile(filePath, bytes, { mode: 0o600 });
    }

    // 会话 manifest 记账（dedupe：同 ref 只计一次字节——重复上传同图不加额）
    const usage = await this._readManifest(input.sessionId);
    if (!usage.refs.includes(ref)) {
      if (usage.bytes + bytes.length > this.maxSessionBytes) {
        throw new AttachmentStoreError(
          'attach-session-quota',
          413,
          `session attachment storage exceeds maximum of ${Math.round(this.maxSessionBytes / 1024 / 1024)} MiB`,
        );
      }
      usage.bytes += bytes.length;
      usage.refs.push(ref);
      await this._writeManifest(input.sessionId, usage);
    }

    const out: { ref: string; width?: number; height?: number } = { ref };
    for (const dim of ['width', 'height'] as const) {
      const value = input[dim];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1) out[dim] = value;
    }
    return out;
  }

  /**
   * ref → dataURL（wire 展开面：读文件 + `data:<mime>;base64,` 组装——DeepSeek
   * 协议仍旧，deepseek-vision.md §1）。sha 自校验（内容与 ref 不符 = 缺失→null）；
   * 缺失/非法 → null（投影层降级文本提示，绝不 400）。
   */
  async resolve(ref: string): Promise<string | null> {
    const file = await this._readRefFile(ref);
    if (file === null) return null;
    const { bytes, mediaType } = file;
    return `data:${mediaType};base64,${bytes.toString('base64')}`;
  }

  /** ref → 原始字节（GET /api/attachments/<ref> 展示面）；缺失/非法 → null。 */
  async raw(ref: string): Promise<{ bytes: Buffer; mediaType: string } | null> {
    return this._readRefFile(ref);
  }

  /** 会话附件账本（manifest；无记录 → 零账）。 */
  async refsOfSession(sessionId: string): Promise<SessionAttachmentUsage> {
    return this._readManifest(sessionId);
  }

  /**
   * 会话删除联动（引用扫描删除）：清 manifest；其引用的附件文件仅当
   * **其它**会话的 manifest 不再引用时才删除（内容寻址共享——同字节一文件）。
   * 返回删除的文件数。幂等（会话不存在 → 0）。
   */
  async deleteSession(sessionId: string): Promise<number> {
    const usage = await this._readManifest(sessionId);
    if (usage.refs.length === 0) {
      await rm(this.manifestPath(sessionId), { force: true });
      return 0;
    }
    // 其余会话的引用集（引用扫描范围 = 其它 manifest——receive 恒先记 manifest 再回 ref）
    const others = new Set<string>();
    for (const manifest of await this._listManifests().catch(() => [])) {
      if (!manifest.endsWith(`${sessionId}.manifest.json`)) {
        const other = await this._readManifest(manifest.slice(0, -'.manifest.json'.length)).catch(
          () => ({ bytes: 0, refs: [] as string[] }),
        );
        for (const ref of other.refs) others.add(ref);
      }
    }
    let removed = 0;
    for (const ref of usage.refs) {
      if (!others.has(ref)) {
        const sha = refSha(ref);
        if (sha !== null) {
          await rm(join(this.dir, shaWithExtOf(ref)), { force: true });
          removed += 1;
        }
      }
    }
    await rm(this.manifestPath(sessionId), { force: true });
    return removed;
  }

  // -- 内部实现（文件字节/清单读写；路径恒由白名单构造，无外部输入进路径） --

  private async _readRefFile(ref: string): Promise<{ bytes: Buffer; mediaType: string } | null> {
    const sha = refSha(ref);
    if (sha === null) return null;
    const name = shaWithExtOf(ref);
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.dir, name));
    } catch {
      return null;
    }
    const mediaType = MEDIA_BY_EXT[extOf(ref)];
    if (mediaType === undefined) return null;
    // 内容寻址自校验：字节 sha256 ≠ ref → 视为缺失（防篡改误发；绝不把坏字节送模型）
    const shaNow = createHash('sha256').update(bytes).digest('hex');
    if (shaNow !== sha) return null;
    return { bytes, mediaType };
  }

  private async _readManifest(sessionId: string): Promise<SessionAttachmentUsage> {
    try {
      const raw = await readFile(this.manifestPath(sessionId), 'utf8');
      const parsed = JSON.parse(raw) as SessionAttachmentUsage;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.bytes === 'number' &&
        typeof parsed.refs === 'object' &&
        Array.isArray(parsed.refs)
      ) {
        return { bytes: parsed.bytes, refs: parsed.refs.filter(isAttachmentRef) };
      }
    } catch {
      // 缺失/损坏 → 零账（限额面保守方向由「损坏即清零」不得越权——损坏 manifest 的概率极低，
      // 且攻击面本地；宁可零账也不让会话因 manifest 损坏而 5xx）
    }
    return { bytes: 0, refs: [] };
  }

  private async _writeManifest(sessionId: string, usage: SessionAttachmentUsage): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.manifestPath(sessionId), JSON.stringify(usage), { mode: 0o600 });
  }

  private async _listManifests(): Promise<string[]> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    return entries.filter((name) => name.endsWith('.manifest.json'));
  }
}

/** 解码 dataURL（data:image/<fmt>;base64,...）→ 字节 + 白名单 ext；非 image/非 base64 → null。 */
function parseImageDataUrl(dataUrl: string): { bytes: Buffer; ext: string } | null {
  const m = /^data:(image\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (m === null) return null;
  const ext = EXT_BY_MEDIA[m[1]!.toLowerCase()];
  if (ext === undefined) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(m[2]!, 'base64');
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  return { bytes, ext };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function extOf(ref: string): string {
  const idx = ref.lastIndexOf('.');
  return idx >= 0 ? ref.slice(idx + 1) : '';
}

function shaWithExtOf(ref: string): string {
  const sha = refSha(ref);
  return sha === null ? '' : `${sha}.${extOf(ref)}`;
}
