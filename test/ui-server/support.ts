/**
 * # test/ui-server/support：SSE 集成测试夹具
 *
 * 真端口（listen(0)）+ 全局 fetch：与浏览器同款链路（上行 POST JSON / 下行 SSE 帧），
 * 帧解析按权威协议（event: X / data: JSON / 空行；`: ping` 只计数不进事件流）。
 * 测试目标：createDevmateServer 的服务端行为；诊断接口：服务端 4xx 统一 {error} 形状。
 */
import { createDevmateServer } from '../../src/ui/server/index.js';
import type { DevmateServer, DevmateServerDeps } from '../../src/ui/server/index.js';
import type { SseEventData } from '../../src/ui/server/emit.js';

export interface TestServerHandle {
  base: string;
  server: DevmateServer;
  port: number;
}

export async function startServer(deps: DevmateServerDeps, port = 0): Promise<TestServerHandle> {
  const server = createDevmateServer(deps);
  const addr = await server.listen(port);
  return { base: `http://${addr.host}:${addr.port}`, server, port: addr.port };
}

export async function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export class SseClient {
  private readonly controller = new AbortController();
  private readonly queue: SseEventData[] = [];
  private readonly waiters: Array<(value: boolean) => void> = [];
  private buffer = '';
  private closed = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  private constructor(readonly url: URL) {}

  /** 帧序列（收到即追加；回放帧也在其中——服务端对连入更晚的客户端做缓冲回放）。 */
  readonly frames: SseEventData[] = [];

  /** `: ping` 心跳注释行计数（不进 frames）。 */
  pingCount = 0;

  static async connect(base: string, sessionId: string): Promise<SseClient> {
    const url = new URL(`/api/stream?sessionId=${encodeURIComponent(sessionId)}`, base);
    const client = new SseClient(url);
    const res = await fetch(url, { signal: client.controller.signal });
    if (res.status !== 200) {
      const text = await res.text();
      throw new Error(`SseClient: stream open failed ${res.status}: ${text}`);
    }
    if (res.body === null) {
      throw new Error('SseClient: response body is null');
    }
    client.reader = res.body.getReader();
    void client.pump();
    return client;
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await this.reader!.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = this.buffer.indexOf('\n\n');
          if (idx < 0) break;
          const block = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 2);
          this.dispatch(block);
        }
      }
    } catch {
      // 客户端 abort 关闭：正常路径
    } finally {
      this.closed = true;
      this.wake();
    }
  }

  private dispatch(block: string): void {
    if (block.trim() === '') return;
    if (block.startsWith(':')) {
      this.pingCount += 1;
      return;
    }
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) data += line.slice('data: '.length);
    }
    if (event === '') return;
    const frame = { event, data: JSON.parse(data) } as SseEventData;
    this.frames.push(frame);
    this.queue.push(frame);
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake(true);
  }

  /** 取下一帧；在 timeoutMs 内无帧返回 null（流未关闭也不阻塞测试）。 */
  async next(timeoutMs = 5000): Promise<SseEventData | null> {
    if (this.queue.length > 0) return this.queue.shift() as SseEventData;
    if (this.closed) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 唤醒与超时用不同值区分：wake(wake 到 = 有帧可达/已入队) → true；超时 → false。
    // （旧形状两者都 resolve(true)：有帧送达时也会误判超时返回 null——下一帧丢失竞态）
    const awake = new Promise<boolean>((resolve) => {
      this.waiters.push(() => resolve(true));
    });
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const woken = await Promise.race([awake, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    if (!woken) return null;
    return this.queue.length > 0 ? (this.queue.shift() as SseEventData) : null;
  }

  /** 排空待取队列（保留 frames 全量：waitForFrames 与 next 混用时不会漏帧重复）。 */
  drain(): void {
    this.queue.splice(0);
  }

  close(): void {
    this.controller.abort();
  }
}

/** 等到至少 n 帧（含回放）；超时抛错并给出已收帧清单。 */
export async function waitForFrames(
  client: SseClient,
  count: number,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (client.frames.length < count) {
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    const frame = await client.next(remain);
    if (frame === null) break;
  }
  if (client.frames.length < count) {
    throw new Error(
      `expected ${count} frames, got ${client.frames.length}: ${JSON.stringify(client.frames)}`,
    );
  }
  client.drain();
}
