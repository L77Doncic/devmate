/**
 * # attachments.js — 附件（图像多模态，ADR-0015 · dsh 管线落地）纯逻辑
 *
 * 浏览器零构建模块（同 settings.js 口径，node 单测可直接 import）：
 * - ATTACH_LIMITS：上限常量（镜像自服务端 ui/server/attachments.ts —— 浏览器不能
 *   import .ts，此处为展示层只读镜像，权威来源 = ADR-0015 + 服务端校验；两边同值漂移
 *   会被服务端 413 兜底（fail-closed））；
 * - attachmentErrorFor(file)：类型/大小预检（纯函数，超限返回错误码——进上传管线前）；
 * - attachmentsFull(count)：每消息 ≤20 张（dsh 上限；服务端 /api/chat 计数面同值）；
 * - attachmentRefValid(ref)：ref 形态判定（sha256/<sha>.<ext> 白名单——渲染/上传共用）；
 * - normalizeAttachment(entry)：协议形状归一（ref 形与旧 url 形双兼容——新协议发 ref，
 *   旧客户端 dataURL 直通兼容；两者宽高都只保留正整数）；
 * - resolveImageContent(images)：事件 images → 渲染描述（url 形 src 原样、ref 形
 *   src = 同源 /api/attachments/<ref>；兼容读旧 dataURL 事件——协议不回退）；
 * - imageFitSingle / IMAGE_TILE_DIMENSION：dsh MessageImage 几何（单图 240 长边 /
 *   多图 64px tile —— 预览卡与消息卡共用）。
 *
 * 纯函数边界：无 DOM / 无 FileReader（FileReader/Image 尺寸探测与上传装配在 app.js）。
 */

/** 附件上限（与 ui/server/attachments.ts 的校验同值；服务端 413 兜底）。
 *  三数为 dsh attachment-local 缺省（research/deepseek-vision.md §12-D）：20MiB/单图、
 *  20 图/消息、200MiB/单会话累计——ADR-0015 与本实现同步启用（2026-08-30 CTO 指令）。 */
export const ATTACH_LIMITS = Object.freeze({
  /** 单文件字节上限（20 MiB —— dsh attachment-local 缺省）。 */
  maxImageBytes: 20 * 1024 * 1024,
  /** 单消息最多图片数（20 —— dsh attachment-local 缺省）。 */
  maxCount: 20,
  /** 单会话附件累计字节上限（200 MiB —— dsh attachment-local 缺省；服务端 manifest 记账）。 */
  maxSessionBytes: 200 * 1024 * 1024,
  /** 旧 url 形单图 dataURL 字符串上限（旧协议 5MiB 文件 ≈ 6.99MiB base64 + 前缀；
   *  新协议走 /api/attachments 的字节上限——本值只约束 legacy 直通）。 */
  maxDataUrlChars: 8 * 1024 * 1024,
});

/** ref 形态（与服务端 ui/server/attachments.ts 的 ATTACH_REF_RE 同规则）。 */
const ATTACH_REF_RE = /^sha256\/[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

/** ref 判定（纯函数；渲染/上传/归一共用）。 */
export function attachmentRefValid(value) {
  return typeof value === 'string' && ATTACH_REF_RE.test(value);
}

/**
 * 文件预检（纯函数）：返回错误码 —— 'too-large'（> maxImageBytes）/
 * 'not-image'（type 声明非 image/*，且无 type 声明时按扩展名兜底拒绝）/ null（可收）。
 * 纪律：类型声明缺失的系统（部分浏览器/截图工具给空 type）按 file.type === ''
 * 时接受扩展名 image.* —— 服务端校验只认 image/*（解码/白名单双保险失败即拒）。
 */
export function attachmentErrorFor(file) {
  if (!file || typeof file.size !== 'number') return 'not-image';
  if (file.size > ATTACH_LIMITS.maxImageBytes) return 'too-large';
  const type = String(file.type ?? '').toLowerCase();
  if (type.startsWith('image/')) return null;
  const name = String(file.name ?? '').toLowerCase();
  if (type === '' && /\.(png|jpe?g|gif|webp)$/.test(name)) return null;
  return 'not-image';
}

/** 数量超限（追加前检查；达到上限不允许再加）。 */
export function attachmentsFull(count) {
  return count >= ATTACH_LIMITS.maxCount;
}

/** 形状归一（纯函数；不抛错）：{ref,...}（新协议）或 {url,...}（旧 dataURL 直通）。
 *  宽高缺省/非法 → 取掉。null = 非法（渲染层丢弃、上传层拒绝）。 */
export function normalizeAttachment(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const out = {};
  if (typeof entry.ref === 'string' && attachmentRefValid(entry.ref)) {
    out.ref = entry.ref;
  } else if (typeof entry.url === 'string' && entry.url.startsWith('data:image/')) {
    if (entry.url.length > ATTACH_LIMITS.maxDataUrlChars) return null;
    out.url = entry.url;
  } else {
    return null;
  }
  for (const dim of ['width', 'height']) {
    const value = entry[dim];
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 1
    ) {
      out[dim] = value;
    }
  }
  return out;
}

/**
 * 事件 images → 渲染描述（纯函数；向后兼容两种形状——resolveImageContent 契约）：
 * - url 形（旧 dataURL 事件）→ src = 原 dataURL（不经网络——本地内容直渲）；
 * - ref 形（新协议 slim 事件）→ src = `/api/attachments/<ref>`（同源 raw 端点；
 *   服务端内容寻址 → 缺失 404 自然渲染失败态）。
 * 非法条目（非对象/外部 URL/ref 破形）→ 丢弃（不渲染坏图）。返回 [{src,width?,height?,ref?}]。
 */
export function resolveImageContent(images) {
  const entries = Array.isArray(images) ? images : [];
  const out = [];
  for (const img of entries) {
    if (!img || typeof img !== 'object') continue;
    let src = null;
    if (typeof img.ref === 'string' && attachmentRefValid(img.ref)) {
      src = `/api/attachments/${img.ref}`;
    } else if (typeof img.url === 'string' && img.url.startsWith('data:image/')) {
      if (img.url.length > ATTACH_LIMITS.maxDataUrlChars) continue;
      src = img.url;
    }
    if (src === null) continue;
    const rendered = { src };
    if (Number.isInteger(img.width) && img.width >= 1) rendered.width = img.width;
    if (Number.isInteger(img.height) && img.height >= 1) rendered.height = img.height;
    if (typeof img.ref === 'string') rendered.ref = img.ref;
    out.push(rendered);
  }
  return out;
}

// ---------------------------------------------------------------------------
// dsh 同款图像几何（deepseek-harness MessageImage.tsx singleFit 逐字移植；纯函数）
// ---------------------------------------------------------------------------

/** 单图渲染：长边固定 240px；宽高比钳制 [0.25, 4]；object-fit: cover；
 *  高图裁剪锚 center top、宽图 left center、其余 center；不放大超过自然尺寸。 */
export function imageFitSingle(dimensions) {
  if (!dimensions || !(dimensions.width >= 1) || !(dimensions.height >= 1)) {
    // 尺寸未知：240 方框（dsh preview 未探明尺寸的 square crop 语义）
    return { width: 240, height: 240, objectPosition: 'center' };
  }
  const natural = dimensions.width / dimensions.height;
  const ratio = Math.min(4, Math.max(0.25, natural));
  const box =
    ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 };
  const scale = Math.min(1, dimensions.width / box.width, dimensions.height / box.height);
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
  };
}

/** 多图（≥2）时固定 64px 方 tile（dsh ImageGallery tile 语义）。 */
export const IMAGE_TILE_DIMENSION = 64;

/** 拖放遮罩文案（dsh DropOverlay 简化单态：可接受时）。 */
export const DROP_OVERLAY_TEXT = '松开以添加图片';
export const DROP_OVERLAY_TEXT_RESTRICTED = '运行中/未解锁：暂不可添加图片';
