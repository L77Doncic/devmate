#!/usr/bin/env node
/**
 * devmate-cli 二进制入口（package.json `bin: devmate-cli` -> dist/cli/index.js）。
 *
 * 占位实现：真实入口后续将解析命令行参数、初始化会话并驱动 core 主循环。
 * 领域术语见 CONTEXT.md（主循环 / Turn / Step / 会话 / 终止条件 / 保险丝）。
 */

const main = (): void => {
  // 占位输出，仅用于验证 dist 产物可执行。
  process.stdout.write('devmate-cli: scaffold placeholder\n');
};

void main();
