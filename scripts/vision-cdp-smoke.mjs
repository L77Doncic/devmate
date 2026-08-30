#!/usr/bin/env node
/**
 * 图像多模态 CDP 冒烟（ADR-0015 · dsh 管线落地验收）：mock 服务 + 无头 Chromium 驱动真实 UI。
 *
 * 链路（与真环境同款浏览器路径）：
 *   composer 附件钮（imagePlus）→ 页面侧构造 PNG File（change 事件）→ FileReader 探测
 *   → **POST /api/attachments**（{sessionId,dataUrl,width,height} — mock sha256 内容寻址
 *   落内存 → 回 {ref:"sha256/<sha>.png"}）→ 预览条（单图 240 长边几何）→ 输入文本发送
 *   → mock /api/chat 收到 {text, images:[{ref,…}]}（grep mock 会话日志：**无 dataURL 大串**）
 *   → SSE 回显 session-user(同形 refs) → 用户气泡图像卡（img.src=/api/attachments/<ref>
 *   经同源 raw 读回渲染）→ assistant 完成卡 → 单击卡 → lightbox（Esc 关闭）。
 *
 * 零真实密钥：mock 只服务本机（/api/attachments 上传+raw 读回 + 内存 ref 表）；
 * 浏览器进程组用毕即杀。
 */
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEB_ROOT = resolve(new URL('../src/ui/web', import.meta.url).pathname);

// ---------------------------------------------------------------------------
// 8×8 红色三角 PNG（纯手造：IHDR/IDAT(zlib)/IEND + CRC32——零依赖）
// ---------------------------------------------------------------------------

function crc32(buf) {
  let table = crc32.table;
  if (table === undefined) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makeTrianglePng() {
  // 8×8 RGBA：红色三角（x >= y 的下三角为红，其余白）
  const w = 8;
  const h = 8;
  const raw = Buffer.alloc((w * 4 + 1) * h); // filter byte 0 per row
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x += 1) {
      const p = row + 1 + x * 4;
      const inTriangle = x >= y;
      raw[p] = 255; // R
      raw[p + 1] = inTriangle ? 30 : 255; // G
      raw[p + 2] = inTriangle ? 40 : 255; // B
      raw[p + 3] = 255; // A
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// ---------------------------------------------------------------------------
// mock 服务：静态 UI + 最小 API + 附件表（内容寻址）+ SSE 回放
// ---------------------------------------------------------------------------

function startMock(staticRoot, sessionLogPath) {
  /** 服务端附件表（内容寻址）：ref → {bytes, mime}——mock 版 AttachmentStore（仅内存）。 */
  const attachments = new Map();
  let lastChat = null; // {text, images}

  const mime = {
    html: 'text/html',
    js: 'text/javascript',
    css: 'text/css',
    svg: 'image/svg+xml',
    png: 'image/png',
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash-vision-exp',
          apiKey: 'sk-****mock****', // 掩码存在即 keyConfigured=true（输入解锁）
          reasoning: 'medium',
          permission: 'workspace-write',
          methodFirst: false,
          reviewMode: false,
          window: 128000,
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/workspaces') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ workspaces: ['/tmp'], defaultRoot: '/tmp' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ rssMb: 1, heapMb: 1, sessions: 0, activeShells: 0, mcpServers: 0 }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tools') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([]));
      return;
    }
    // 内容寻址上传（ADR-0015）：dataURL → sha256 ref（mock 只内存——与真服务端同协议）
    if (req.method === 'POST' && url.pathname === '/api/attachments') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      const { sessionId, dataUrl, width, height } = body ?? {};
      if (typeof sessionId !== 'string' || typeof dataUrl !== 'string') {
        res.setHeader('content-type', 'application/json');
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'sessionId and dataUrl are required' }));
        return;
      }
      const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
      if (m === null) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'dataUrl must be data:image/...' }));
        return;
      }
      const bytes = Buffer.from(m[2], 'base64');
      const ext = PNG_EXT_BY_MIME[m[1]];
      if (ext === undefined || bytes.length > 20 * 1024 * 1024) {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'image exceeds limits', code: 'attach-too-large' }));
        return;
      }
      const sha = createHash('sha256').update(bytes).digest('hex');
      const ref = `sha256/${sha}.${ext}`;
      if (!attachments.has(ref)) attachments.set(ref, { bytes, mime: m[1] });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ref, ...(Number.isInteger(width) && width >= 1 ? { width } : {}), ...(Number.isInteger(height) && height >= 1 ? { height } : {}) }));
      return;
    }
    // raw 读回（用户气泡/lightbox 的图像 src——ref slim 事件的展示面）
    if (req.method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
      const ref = url.pathname.slice('/api/attachments/'.length);
      const entry = attachments.get(ref);
      if (entry === undefined) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('content-type', entry.mime);
      res.setHeader('content-length', entry.bytes.length);
      res.end(entry.bytes);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      lastChat = JSON.parse(raw || '{}');
      // mock「会话日志」：写入收到的聊天体——断言面（grep 无 dataURL 大串）
      try {
        writeFileSync(sessionLogPath, JSON.stringify(lastChat) + '\n');
      } catch {
        // 测试临时目录：忽略
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sessionId: 's-demo-vision' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const frame = (event, data) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // 回显会话用户帧（images 与 /api/chat 上行同形 = refs——协议断言面）
      const user = lastChat ?? { text: '（无）', images: [] };
      frame('session-user', {
        text: user.text ?? '',
        ...(Array.isArray(user.images) && user.images.length > 0 ? { images: user.images } : {}),
      });
      const reply = '图片里有一个红色三角形（mock 回复）。';
      frame('assistant-delta', { text: reply });
      frame('assistant-done', { content: reply, toolCalls: [] });
      frame('usage', {
        promptTokens: 6,
        completionTokens: 4,
        totalTokens: 10,
        costUsd: 0,
        estimated: false,
      });
      frame('run-status', { status: 'completed', steps: 1, durationMs: 5 });
      return;
    }
    // 静态资源
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    try {
      const abs = join(staticRoot, rel);
      const buf = await readFile(abs);
      const ext = abs.slice(abs.lastIndexOf('.') + 1);
      res.writeHead(200, { 'content-type': mime[ext] ?? 'text/javascript' });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () =>
      resolvePromise({ server, port: server.address().port, attachments }),
    );
  });
}

// ---------------------------------------------------------------------------
// CDP 驱动器（零依赖：node ≥22 全局 WebSocket；直连 page target 的 ws URL）
// ---------------------------------------------------------------------------

const CHROME = process.env.CHROME_BIN || 'chromium';

async function launchChrome() {
  const profile = `/tmp/devmate-vision-cdp-${process.pid}-${Date.now() % 100000}`;
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0', // 随机端口（零冲突；从 banner 拿实际端口）
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  );
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += String(d);
  });
  const wsBanner = await new Promise((resolveReady, reject) => {
    const t = setTimeout(
      () => reject(new Error('chrome devtools timeout: ' + stderr.slice(0, 300))),
      15000,
    );
    proc.stderr.on('data', (d) => {
      const m = String(d).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(t);
        resolveReady(m[1]);
      }
    });
  });
  const debugPort = Number(new URL(wsBanner).port);
  if (!Number.isInteger(debugPort) || debugPort < 1)
    throw new Error('chrome devtools 端口解析失败');
  return { proc, debugPort };
}

async function pageWsUrl(debugPort) {
  for (let i = 0; i < 20; i += 1) {
    try {
      const list = await awaitFetch(`http://127.0.0.1:${debugPort}/json/list`);
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // 未就绪重试
    }
  }
  return null;
}

function awaitFetch(url, tries = 30) {
  return new Promise((resolvePromise, reject) => {
    let left = tries;
    const attempt = () => {
      left -= 1;
      fetch(url)
        .then((r) => r.json())
        .then(resolvePromise)
        .catch(() => {
          if (left <= 0) reject(new Error(`fetch ${url} 失败`));
          else setTimeout(attempt, 250);
        });
    };
    attempt();
  });
}

function cdpConnect(wsUrl) {
  return new Promise((resolveSession, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolveSession({
        send(method, params = {}) {
          return new Promise((r, j) => {
            const id = ++seq;
            pending.set(id, { r, j, method });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { r, j, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(`${method}：${msg.error.message}`));
        else r(msg.result);
      }
    };
    ws.onerror = () => reject(new Error('page ws 连接失败'));
  });
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'devmate-vision-smoke-'));
  const sessionLogPath = join(tmp, 's-demo-vision.jsonl');
  const pngPath = join(tmp, 'triangle8x8.png');
  const png = makeTrianglePng();
  writeFileSync(pngPath, png);
  const { server, port, attachments } = await startMock(WEB_ROOT, sessionLogPath);
  const appUrl = `http://127.0.0.1:${port}/`;
  console.log(`mock 起：${appUrl}（png ${png.length} 字节）`);

  const chrome = await launchChrome();
  const cdp = await cdpConnect(await pageWsUrl(chrome.debugPort));
  if (!cdp) throw new Error('page ws url 未取到');
  try {
    const evalJs = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails)
        throw new Error(`evaluate 异常: ${JSON.stringify(r.exceptionDetails)}`);
      return r.result?.value;
    };

    await cdp.send('Page.navigate', { url: appUrl });
    await sleep(1200);
    // 等待 UI 装配（boot 网络请求完成）
    for (let i = 0; i < 40; i += 1) {
      const ready = await evalJs(
        `Boolean(document.getElementById('btn-attach') && document.getElementById('hero-default-workspace'))`,
      );
      if (ready) break;
      await sleep(250);
    }

    // ① 选工作区（解锁 composer，A 档门禁路径）
    await evalJs(`document.getElementById('hero-default-workspace').click()`);
    await sleep(500);
    const unlocked = await evalJs(
      `!document.getElementById('composer').classList.contains('composer-locked')`,
    );
    if (!unlocked) throw new Error('composer 未解锁（工作区选择未生效）');

    // 页面侧自检：FileReader/Image 在 headless chrome 中的可用性（排除注入文件加载路径的疑点）
    const probeExpression =
      '(async () => {' +
      "  const bytes = atob('" +
      png.toString('base64') +
      "');" +
      '  const buf = new Uint8Array(bytes.length);' +
      '  for (let i = 0; i < bytes.length; i += 1) buf[i] = bytes.charCodeAt(i);' +
      "  const file = new File([buf], 'probe.png', { type: 'image/png' });" +
      '  const url = await new Promise((res) => {' +
      '    const rd = new FileReader();' +
      '    rd.onload = () => res(String(rd.result));' +
      "    rd.onerror = () => res('READER_ERROR');" +
      '    rd.readAsDataURL(file);' +
      '  });' +
      "  if (typeof url !== 'string' || !url.startsWith('data:image/')) return 'reader-failed';" +
      '  const dims = await new Promise((res) => {' +
      '    const img = new Image();' +
      "    img.onload = () => res(img.naturalWidth + 'x' + img.naturalHeight);" +
      "    img.onerror = () => res('IMG_ERROR');" +
      '    img.src = url;' +
      '  });' +
      "  return 'ok:' + dims;" +
      '})()';
    const probeResult = await evalJs(probeExpression);
    console.log('page 自检（FileReader/Image）：', probeResult);

    // ② 注入 PNG：页面侧 DataTransfer（snap chromium AppArmor 沙箱读不了 /tmp 注入路径——
    //    页面内构造 File 走完全相同的 change 监听 + FileReader/Image 路径，链路等真）
    const injectExpression =
      '(async () => {' +
      "  const bytes = atob('" +
      png.toString('base64') +
      "');" +
      '  const buf = new Uint8Array(bytes.length);' +
      '  for (let i = 0; i < bytes.length; i += 1) buf[i] = bytes.charCodeAt(i);' +
      "  const file = new File([buf], 'triangle8x8.png', { type: 'image/png' });" +
      '  const dt = new DataTransfer();' +
      '  dt.items.add(file);' +
      "  const input = document.getElementById('attach-input');" +
      '  input.files = dt.files;' +
      "  input.dispatchEvent(new Event('change'));" +
      '  return input.files.length;' +
      '})()';
    await evalJs(injectExpression);
    await sleep(800);

    // ③ 预览条断言：单图 = 240 长边（dsh AttachmentRail 几何；缩略图 src 为内存 dataURL
    //   ——仅预览，不进协议）
    const previewCount = await evalJs(
      `document.querySelectorAll('#attach-strip .attach-card').length`,
    );
    const thumbOk = await evalJs(
      `Boolean(document.querySelector('#attach-strip img.attach-thumb')?.src.startsWith('data:image/png'))`,
    );
    const cardSize = await evalJs(
      `(() => { const c = document.querySelector('#attach-strip .attach-card'); return c ? c.style.width + 'x' + c.style.height : ''; })()`,
    );
    if (previewCount !== 1 || !thumbOk) {
      throw new Error(`预览卡断言失败：cards=${previewCount} thumbOk=${thumbOk}`);
    }
    // dsh singleFit：「长边 240 但**不放大超过自然尺寸**」——8×8 源图卡 = 8×8（钳到自然尺寸）
    if (cardSize !== '8pxx8px') {
      throw new Error(`单图几何断言失败（imageFitSingle 8×8 → 自然尺寸钳制 8×8）：${cardSize}`);
    }
    console.log(
      `① 预览卡出现（${previewCount} 张，缩略图 dataURL ✓，卡片 ${cardSize}——dsh 自然尺寸钳制）`,
    );

    // ④ 输入文本 + 发送
    await evalJs(
      `(() => { const i = document.getElementById('input'); i.value = '描述图片'; i.dispatchEvent(new Event('input')); })()`,
    );
    await sleep(300);
    await evalJs(`document.getElementById('btn-send').click()`);
    await sleep(1800);

    // ⑤ 服务端收到 attachment（mock 附件表含 ref）+ /api/chat 上行 refs（无 dataURL）
    const chatBody = JSON.parse(readFileSync(sessionLogPath, 'utf8'));
    const chatImages = Array.isArray(chatBody.images) ? chatBody.images : [];
    const refs = chatImages.map((i) => i.ref).filter((r) => typeof r === 'string');
    if (refs.length !== 1) throw new Error(`chat images 应为 1 个 ref：${JSON.stringify(chatImages)}`);
    if (attachments.has(refs[0]) === false) {
      throw new Error(`服务端附件表未收到 attachment：${refs[0]}`);
    }
    if (JSON.stringify(chatBody).includes('data:image')) {
      throw new Error('协议泄漏：/api/chat 上行含 dataURL（应只有 ref）');
    }
    // 会话日志（mock .jsonl）grep：无 dataURL 大串（会话文件 slim 铁证）
    const logText = readFileSync(sessionLogPath, 'utf8');
    if (logText.includes('data:image')) {
      throw new Error('会话日志泄漏：mock 会话记录含 dataURL（slim 失败）');
    }
    if (!logText.includes('sha256/')) throw new Error('会话日志缺 sha256 ref');
    console.log(`② 服务端收到 attachment（${refs[0]}）；chat 上行 refs ✓；会话日志 slim ✓`);

    // ⑥ 用户消息图像卡：img.src = /api/attachments/<ref>（ref slim 事件的展示面；
    //    mock raw 端点读回 200 image/png）→ 渲染成功
    const userImgOk = await evalJs(
      `Boolean(document.querySelector('.msg-row.user .user-image-card img')?.src.includes('/api/attachments/sha256/'))`,
    );
    const rawOk = await fetch(new URL(refs[0], `http://127.0.0.1:${port}/api/attachments/`));
    if (!userImgOk) throw new Error('用户消息卡未按 ref 端点渲染');
    if (rawOk.status !== 200) throw new Error(`raw 读回失败：${rawOk.status}`);
    if ((await rawOk.arrayBuffer()).byteLength !== png.length) {
      throw new Error('raw 读回字节与上传不符');
    }
    const imageLoaded = await evalJs(
      `(() => { const img = document.querySelector('.msg-row.user .user-image-card img'); return Boolean(img && img.complete && img.naturalWidth > 0); })()`,
    );
    if (!imageLoaded) throw new Error('用户消息卡图片未加载（404/坏图）');
    const assistantOk = await evalJs(
      `Boolean([...document.querySelectorAll('.msg-row.assistant')].some((n) => n.textContent.includes('三角形')))`,
    );
    if (!assistantOk) throw new Error('助手完成卡缺失');
    console.log(`③ 用户消息图像卡（ref 端点渲染 + 图片已加载）✓；助手完成卡 ✓`);

    // ⑦ dsh 对照：单击消息图像卡 → lightbox 打开（ref 原图）；关闭钮关闭
    await evalJs(`document.querySelector('.msg-row.user .user-image-btn').click()`);
    const lightboxOpen = await evalJs(`!document.getElementById('image-lightbox').hidden`);
    const lightboxSrc = await evalJs(
      `document.getElementById('image-lightbox-img').src.includes('/api/attachments/sha256/')`,
    );
    if (!lightboxOpen || !lightboxSrc) {
      throw new Error(`lightbox 断言失败：open=${lightboxOpen} src=${lightboxSrc}`);
    }
    await evalJs(`document.getElementById('image-lightbox-close').click()`);
    const lightboxClosed = await evalJs(`document.getElementById('image-lightbox').hidden`);
    if (!lightboxClosed) throw new Error('lightbox 关闭断言失败');
    console.log(`④ 消息图像卡 lightbox 打开/关闭 ✓`);
  } finally {
    try {
      process.kill(-chrome.proc.pid, 'SIGKILL');
    } catch {
      // 已退出
    }
    rmSync(tmp, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
  console.log('CDP 冒烟：全部断言通过（选图→上传 ref→发送→ref 卡渲染→lightbox；会话日志 slim）');
}

main().catch(async (err) => {
  console.error('CDP 冒烟失败：', err instanceof Error ? err.message : String(err));
  try {
    execSync('pkill -9 -f devmate-vision-cdp-', { stdio: 'ignore' });
  } catch {
    // 无残留
  }
  process.exitCode = 1;
});
