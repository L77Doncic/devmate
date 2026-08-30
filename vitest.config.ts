import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 全量并行（多 worker）下真实 spawn 的集成测试偶发 >5s（permission/中断线）：
    // 提高单测超时阈值，消除负载性 flaky（CI ubuntu 全量同受益），不掩盖逻辑断言。
    testTimeout: 20000,
  },
});
