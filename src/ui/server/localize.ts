/**
 * # ui/server/localize：供应商报错 → 用户友好中文（P2-6/P2-8 图片/认证/网络）
 *
 * 只做「识别已知模式 → 中文一行 + 下一步指引」，未命中返回原文（不冒充解释）。
 * 面：run-error 事件（run 首轮失败，如上游 400「You have uploaded an unsupported
 * image…」裸露英文）；浏览器侧镜像见 ui/web/format.js 的 friendlyProviderError
 * （展示层只读镜像 —— 服务端为权威，协议向前兼容旧帧原文）。
 *
 * 纯函数、零依赖、零 I/O —— 单测直接可测（test/ui-server/localize.test.ts）。
 */

/** 图片被供应商拒收：非图像 / 数量超 / 超限（dsh 三数对应服务端限额口径）。 */
export function friendlyImageError(raw: string): string | null {
  const s = String(raw ?? '');
  if (/unsupported image|invalid image|bad image|not a valid image|image.*format/i.test(s)) {
    return '图片未被接受：请换用 png / jpg(jpeg) / webp / gif 格式的图片重发（可在附件预览中移除这张后重试）';
  }
  // 体积/尺寸超限要在「数量超限」之前判 —— “total size of images exceeds the limit” 含
  // “images … limit” 字样，会被数量模式优先误吞
  if (/total size|too large|too many pixels|image.*size|payload.*large|size.*exceeds/i.test(s)) {
    return '图片体积/尺寸超出供应商上限：请压缩或换小图后重发';
  }
  if (/too many images|maximum.*images|too many.*image|image.*too many/i.test(s)) {
    return '图片数量超出一次发送上限：请分批发送（发送前可在附件预览中先移除几张）';
  }
  return null;
}

/** 通用供应商/连接层报错本地化（未命中 → null：保留原文，零信息损失）。 */
export function friendlyProviderError(raw: string): string | null {
  const s = String(raw ?? '');
  const image = friendlyImageError(s);
  if (image !== null) return `图片请求被拒：${image}`;
  if (/authentication|auth\s*fail|auth error|governor|invalid[ _]api[ _]?key|401/i.test(s)) {
    return '认证失败：请检查 API Key（设置→模型接口）是否有效、模型名是否正确';
  }
  if (/rate limit|too many requests|429/i.test(s)) {
    return '请求频繁被限流：稍等片刻再试（服务端自动重试已尽力）';
  }
  if (/network|econnrefused|fetch failed|timeout|timed ?out|unreachable/i.test(s)) {
    return '网络连接失败：检查网络后重试';
  }
  return null;
}
