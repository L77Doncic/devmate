#!/usr/bin/env node
/**
 * devmate-cli 二进制入口（package.json `bin: devmate-cli` -> dist/cli/index.js）。
 *
 * 命令分发（S14）：
 * - `web [--port N] [--workspace <path>] [--no-open]` → 本地 Web 模式（ADR-0007 同进程 server）；
 * - `--version` / `--help`；无参数视为帮助；未知命令 → 帮助 + 退出码 1。
 *
 * 本文件只做「分发 + node 资产接线」：runWeb 的纯逻辑在 ./web.ts（单测注入假
 * ServerModule 冒烟）；本文件在测试中以 CliIo 注入，不触进程。node asset 部分
 * （spawn/fs/os/child_process）是零依赖运行时 API，ESM 下禁止 require。
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWeb } from './web.js';
import type { RunWebIo, ServerModule } from './web.js';
import { configFilePath } from './config.js';

/** 帮助文本：命令一览 + web 子命令选项说明。 */
export const HELP_TEXT = `devmate-cli — DevMate 编程智能体命令行

用法:
  devmate-cli <命令> [参数]

命令:
  web          启动本地 Web 模式（本地地址 http://127.0.0.1/，自动打开浏览器）
  --version    打印版本号
  --help       显示本帮助

web 参数:
  --port <N>        监听端口 1-65535（缺省 0 = 系统自动分配）
  --workspace <path> 工作区目录（缺省 = 当前目录）
  --no-open         不自动打开浏览器

本地配置: ~/.devmate/config.json（0600；Web 设置页保存即写回本文件）
环境变量: DEV_MATE_BASE_URL / DEV_MATE_MODEL / DEV_MATE_API_KEY（优先于配置文件）`;

/** 入口 IO（测试注入假实现；生产用 process 资产）。 */
export interface CliIo {
  println: (line: string) => void;
  printErr: (line: string) => void;
  runWeb: (args: string[], io: RunWebIo) => Promise<number>;
  version: string;
}

/** 命令分发（纯逻辑；返回退出码）。 */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === '--help') {
    io.println(HELP_TEXT);
    return 0;
  }
  if (cmd === '--version') {
    io.println(io.version);
    return 0;
  }
  if (cmd === 'web') {
    return io.runWeb(rest, makeWebIo());
  }
  io.printErr(`未知命令：${cmd}`);
  io.println(HELP_TEXT);
  return 1;
}

/** 信号注册接缝（VT-2 修复；测试注入假实现，不触真实进程）。 */
export interface SignalIo {
  once(signal: string, handler: () => void): void;
  exit(code: number): never;
}

/**
 * 优雅关闭信号注册（VT-2 修复 a）：SIGINT（Ctrl-C）与 SIGTERM（kill/port-kill/systemd
 * stop 等常见运维动作）走**同一**完整关闭回调并退出 0。SIGTERM 是桌面/服务编排终止的
 * 默认信号——此前只处理 SIGINT，MCP 子进程组（npm→sh→node，命令行含凭据）在父进程
 * 死亡后成为孤儿常驻。关闭回调内含 server.close → deps.dispose（mcpLauncher.dispose +
 * 常驻 shell 全清，见 ui/server）；幂等（信号 once）。
 */
export function installGracefulSignals(
  signals: readonly string[],
  io: SignalIo,
  shutdown: () => void | Promise<void>,
): void {
  for (const signal of signals) {
    io.once(signal, () => {
      // 退出码 0 = 主动优雅关闭（不虚报失败；close 抛错也照样退出——清理只可能错过不致命）。
      void Promise.resolve(shutdown()).then(
        () => io.exit(0),
        () => io.exit(0),
      );
    });
  }
}

/** 生产 RunWebIo：node 资产接线（os/fs/path/child_process）。 */
function makeWebIo(): RunWebIo {
  const signalIo: SignalIo = {
    once: (signal, handler) => process.once(signal, handler),
    exit: (code) => process.exit(code),
  };
  return {
    cwd: process.cwd(),
    env: process.env,
    configPath: configFilePath(homedir()),
    platform: process.platform,
    isDir: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    findOnPath: (cmd) => isExecutableOnPath(cmd, process.env.PATH),
    openBrowser: (url, cmd, args) => {
      spawnOpen(url, cmd, args);
    },
    loadServerModule,
    println: (line) => process.stdout.write(`${line}\n`),
    printErr: (line) => process.stderr.write(`${line}\n`),
    setSignalHandler: (cb) => {
      installGracefulSignals(['SIGINT', 'SIGTERM'], signalIo, cb);
    },
  };
}

/**
 * S12 运行时载入：动态 import（不静态依赖；S12 持续迭代中，仅运行期报错）。
 * assembleDeps 在 deps.ts、createDevmateServer 在 index.ts——两个模块分开组装。
 */
async function loadServerModule(): Promise<ServerModule> {
  const [serverModule, depsModule] = await Promise.all([
    import('../ui/server/index.js'),
    import('../ui/server/deps.js'),
  ]);
  return {
    assembleDeps: depsModule.assembleDeps as ServerModule['assembleDeps'],
    createDevmateServer: serverModule.createDevmateServer as ServerModule['createDevmateServer'],
  } as ServerModule;
}

/** PATH 探测（xdg-open / x-www-browser 等）。 */
function isExecutableOnPath(cmd: string, path: string | undefined): boolean {
  const dirs = (path ?? '').split(':').filter((d) => d.length > 0);
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** 零依赖起浏览器：数组传参 spawn（无 shell 注入面），detached + unref，失败不致命。 */
function spawnOpen(url: string, cmd: string, args: string[]): void {
  // cmd = open / xdg-open / x-www-browser / cmd；URL 追加为末位参数。
  const child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // 打开失败不致命：banner 已给出地址，用户可手动访问。
  });
  child.unref();
}

function readVersionFromPackageJson(): string {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── 直跑入口：仅当 node 直接执行本文件（或其 bin 符号链接）时接管进程；
// 测试 import 本模块不触发。realpath 对齐保证 npm bin 的 symlink 场景同样命中。──
function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectEntry()) {
  const io: CliIo = {
    println: (line) => process.stdout.write(`${line}\n`),
    printErr: (line) => process.stderr.write(`${line}\n`),
    runWeb,
    version: readVersionFromPackageJson(),
  };
  void main(process.argv.slice(2), io).then((code) => {
    process.exitCode = code;
  });
}
