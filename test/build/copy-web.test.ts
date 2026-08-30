/**
 * # test/build/copy-web：Web 资产镜像构建（scripts/copy-web.mjs）与构建后一致性
 * （scripts/check-dist-sync.mjs）——VT-6 暴力测试。
 *
 * 契约（src 为基准，dist 为镜像）：
 * - 白名单镜像：dst 只含 src 的 *.html/*.js/*.css/*.svg（扩展名小写同判），相对路径清单逐一相等；
 * - 非资产一律拒绝：index.ts / README-UI.md / *.map / *.png / *.jsx… 不进 dist——旧版 cpSync
 *   全量复制把 index.ts 原样带进 dist（浏览器 GET /index.ts 直读 TS 源码，即「dist 泄漏 src」）；
 * - stale 清零：复制前清空 dst——tsc 先 emission 的 dist/ui/web/index.js(.map)、源已删的文件、
 *   任何残留都被移除（旧版复制而不删除 → 「stale dist 服役」）；
 * - 一致性校验：check-dist-sync.mjs 对真镜像 exit 0；missing / extra（含非白名单泄漏与白名单
 *   残留）/ mismatch（字节级——先尺寸短路再 Buffer.equals）全部 exit 1 + stderr 明细；
 * - 字节断言：dist 在 .gitignore（`git diff --stat dist/` 恒空），镜像一致性只能以字节级断言
 *   把守——本文件对真实 dist 产物做 md5 逐文件对照（u5/w 组）。
 *
 * fixture：mkdtemp 建 src（5 个白名单文件 + 5 个非白名单样本）→ spawnSync node 脚本并注入
 * env DEV_MATE_WEB_SRC/DST ——确定性、不依赖真实 dist；真实 dist 的完整性由 w 组（skipIf 兜底
 * CI 无 build 的场景）与 ci.yml 的 Verify dist sync 步在 Build 之后把守。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WEB_ASSET_EXTS,
  isWebAssetPath,
  listWebAssets,
  syncWebAssets,
} from '../../scripts/copy-web.mjs';
import {
  checkWebAssetsSync,
  diffWebAssets,
  filesEqual,
  listAllFiles,
} from '../../scripts/check-dist-sync.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const copyScript = join(repoRoot, 'scripts', 'copy-web.mjs');
const syncScript = join(repoRoot, 'scripts', 'check-dist-sync.mjs');

/** fixture 白名单资产（相对路径，排序即清单序）。 */
const WHITELIST = ['app.js', 'assets/icon.svg', 'index.html', 'logo.svg', 'style.css'];
/** 非白名单样本：旧版全量复制时全部泄漏进 dist。 */
const FORBIDDEN = ['README-UI.md', 'app.js.map', 'assets/logo.png', 'index.ts', 'notes.jsx'];

const md5 = (p: string): string => createHash('md5').update(readFileSync(p)).digest('hex');

type RunResult = { status: number | null; output: string };

/** spawnSync node <script>；显式移除本测试的污染 env（WEB_SRC/WEB_DST）再叠加覆盖。 */
function runScript(script: string, envOverrides: Record<string, string> = {}): RunResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'DEV_MATE_WEB_SRC' || key === 'DEV_MATE_WEB_DST') continue;
    env[key] = value;
  }
  Object.assign(env, envOverrides);
  const res = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(res.error).toBeUndefined();
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** 临时 fixture：src 白名单 ×5 + 非白名单样本 ×5 + 空目录 sub；dst 空。 */
function makeFixture(): {
  root: string;
  src: string;
  dst: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'devmate-copy-web-'));
  const src = join(root, 'src');
  const dst = join(root, 'dist');
  mkdirSync(join(src, 'assets'), { recursive: true });
  mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'index.html'), '<!doctype html><title>devmate</title>\n', 'utf8');
  // 等长（v1→v2 字节数不变）——用于字节级（非尺寸级）差异断言，见 v2
  writeFileSync(join(src, 'app.js'), "export const V = 'v1';\n", 'utf8');
  writeFileSync(join(src, 'style.css'), 'body { margin: 0 }\n', 'utf8');
  writeFileSync(join(src, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n', 'utf8');
  writeFileSync(
    join(src, 'assets', 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    'utf8',
  );
  writeFileSync(join(src, 'index.ts'), 'export {};\n', 'utf8');
  writeFileSync(join(src, 'README-UI.md'), '# devmate ui docs\n', 'utf8');
  writeFileSync(join(src, 'app.js.map'), '{"version":3}\n', 'utf8');
  writeFileSync(join(src, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  writeFileSync(join(src, 'notes.jsx'), 'export const n = 1;\n', 'utf8');
  return { root, src, dst, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('scripts/copy-web：白名单镜像复制', () => {
  it('u1) 判定矩阵：*.html/*.js/*.css/*.svg（含大写扩展名）入白名单；.ts/.map/.md/.png/.jsx 拒绝', () => {
    expect(isWebAssetPath('index.html')).toBe(true);
    expect(isWebAssetPath('index.HTML')).toBe(true);
    expect(isWebAssetPath('app.js')).toBe(true);
    expect(isWebAssetPath('style.css')).toBe(true);
    expect(isWebAssetPath('logo.svg')).toBe(true);
    expect(isWebAssetPath('assets/icon.svg')).toBe(true);
    expect(isWebAssetPath('index.ts')).toBe(false);
    expect(isWebAssetPath('index.js.map')).toBe(false);
    expect(isWebAssetPath('README-UI.md')).toBe(false);
    expect(isWebAssetPath('assets/logo.png')).toBe(false);
    expect(isWebAssetPath('notes.jsx')).toBe(false);
    expect(WEB_ASSET_EXTS).toEqual(new Set(['.html', '.js', '.css', '.svg']));
  });

  it('u2) listWebAssets 递归清单：只列白名单文件（排序、空目录 sub 不计入）', () => {
    const fx = makeFixture();
    try {
      expect(listWebAssets(fx.src)).toEqual(WHITELIST);
    } finally {
      fx.cleanup();
    }
  });

  it('u3) syncWebAssets 严格镜像：dst 清单 = 白名单清单；index.ts/README-UI.md/.map/.png/.jsx 不存在；字节逐一对等', () => {
    const fx = makeFixture();
    try {
      const files = syncWebAssets(fx.src, fx.dst);
      expect(files).toEqual(WHITELIST);
      expect(listAllFiles(fx.dst)).toEqual(WHITELIST);
      for (const rel of WHITELIST) {
        expect(existsSync(join(fx.dst, rel))).toBe(true);
        expect(filesEqual(join(fx.src, rel), join(fx.dst, rel))).toBe(true);
        expect(md5(join(fx.dst, rel))).toBe(md5(join(fx.src, rel)));
      }
      for (const rel of FORBIDDEN) {
        expect(existsSync(join(fx.dst, rel))).toBe(false);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('u4) spawn 全流程：env 注入 fixture → exit 0；dst 精确镜像（清单 + 逐文件 md5 与 src 一致）', () => {
    const fx = makeFixture();
    try {
      const res = runScript(copyScript, {
        DEV_MATE_WEB_SRC: fx.src,
        DEV_MATE_WEB_DST: fx.dst,
      });
      expect(res.status).toBe(0);
      expect(res.output).toContain('5 files');
      expect(res.output).toContain('index.html ok');
      expect(listAllFiles(fx.dst)).toEqual(WHITELIST);
      for (const rel of WHITELIST) {
        expect(md5(join(fx.dst, rel))).toBe(md5(join(fx.src, rel)));
      }
      for (const rel of FORBIDDEN) {
        expect(existsSync(join(fx.dst, rel))).toBe(false);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('u5) stale 清零（暴力测试核心）：dst 预置 tsc emission 与旧泄漏 → 运行后全部消失，镜像精确', () => {
    const fx = makeFixture();
    try {
      // 模拟旧版状态：tsc emission（index.js/.map）、cpSync 全量泄漏（index.ts/README-UI.md/png）、
      // 源已删的旧资产（old-deleted.js）——旧版 cpSync 复制不删除时全部残留并「服役」。
      mkdirSync(join(fx.dst, 'assets'), { recursive: true });
      for (const stale of [
        'index.js',
        'index.js.map',
        'index.ts',
        'README-UI.md',
        'old-deleted.js',
        join('assets', 'logo.png'),
      ]) {
        writeFileSync(join(fx.dst, stale), 'stale', 'utf8');
      }
      const res = runScript(copyScript, {
        DEV_MATE_WEB_SRC: fx.src,
        DEV_MATE_WEB_DST: fx.dst,
      });
      expect(res.status).toBe(0);
      expect(listAllFiles(fx.dst)).toEqual(WHITELIST);
      const leftovers = listAllFiles(fx.dst).filter((rel) => !WHITELIST.includes(rel));
      expect(leftovers).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});

describe('scripts/check-dist-sync：构建后一致性（源为基准、dist 为镜像）', () => {
  it('v1) 真镜像 → 差异空；checkWebAssetsSync ok；spawn exit 0', () => {
    const fx = makeFixture();
    try {
      syncWebAssets(fx.src, fx.dst);
      expect(diffWebAssets(fx.src, fx.dst)).toEqual({ missing: [], extra: [], mismatch: [] });
      const report = checkWebAssetsSync(fx.src, fx.dst);
      expect(report.ok).toBe(true);
      expect(report.lines).toEqual([]);
      expect(report.summary).toContain('一致');

      const res = runScript(syncScript, {
        DEV_MATE_WEB_SRC: fx.src,
        DEV_MATE_WEB_DST: fx.dst,
      });
      expect(res.status).toBe(0);
      expect(res.output).toContain('一致');
    } finally {
      fx.cleanup();
    }
  });

  it('v2) 字节级差异：等长篡改（v1→v2）与超长篡改均报 mismatch + exit 1（same-size 不走尺寸短路）', () => {
    const fx = makeFixture();
    try {
      syncWebAssets(fx.src, fx.dst);
      // 等长篡改：字节数不变，尺寸短路失效，必须走 Buffer.equals 字节比较
      const srcApp = readFileSync(join(fx.src, 'app.js'));
      const tampered = Buffer.from("export const V = 'v2';\n", 'utf8');
      expect(tampered.length).toBe(srcApp.length);
      writeFileSync(join(fx.dst, 'app.js'), tampered);
      // 尺寸不同篡改
      writeFileSync(join(fx.dst, 'style.css'), 'body { margin: 0; background: red; }\n', 'utf8');

      const diff = diffWebAssets(fx.src, fx.dst);
      expect(diff.missing).toEqual([]);
      expect(diff.extra).toEqual([]);
      expect(diff.mismatch.map((m) => m.path)).toEqual(['app.js', 'style.css']);
      expect(diff.mismatch[0]).toEqual({
        path: 'app.js',
        srcSize: srcApp.length,
        dstSize: tampered.length,
      });
      expect(diff.mismatch[1]).toEqual({
        path: 'style.css',
        srcSize: readFileSync(join(fx.src, 'style.css')).length,
        dstSize: readFileSync(join(fx.dst, 'style.css')).length,
      });

      const res = runScript(syncScript, {
        DEV_MATE_WEB_SRC: fx.src,
        DEV_MATE_WEB_DST: fx.dst,
      });
      expect(res.status).toBe(1);
      expect(res.output).toContain('mismatch: app.js');
      expect(res.output).toContain('mismatch: style.css');
      expect(res.output).toContain('2 mismatch');
    } finally {
      fx.cleanup();
    }
  });

  it('v3) dist 多余文件：非白名单（index.ts）标为 src 泄漏、tsc 派生（index.js）与白名单残留标 stale → exit 1', () => {
    const fx = makeFixture();
    try {
      syncWebAssets(fx.src, fx.dst);
      writeFileSync(join(fx.dst, 'index.ts'), 'export {};\n', 'utf8');
      // tsc 单独 emission（npm run dev）落到 dist/ui/web/index.js——与 src/index.ts 同 stem
      writeFileSync(join(fx.dst, 'index.js'), 'export {};\n', 'utf8');
      writeFileSync(join(fx.dst, 'old-deleted.js'), 'stale', 'utf8');

      const diff = diffWebAssets(fx.src, fx.dst);
      expect(diff.missing).toEqual([]);
      expect(diff.mismatch).toEqual([]);
      expect(diff.extra).toEqual([
        { path: 'index.js', leaked: false },
        { path: 'index.ts', leaked: true },
        { path: 'old-deleted.js', leaked: false },
      ]);

      const res = runScript(syncScript, {
        DEV_MATE_WEB_SRC: fx.src,
        DEV_MATE_WEB_DST: fx.dst,
      });
      expect(res.status).toBe(1);
      expect(res.output).toContain('extra in dist: index.ts');
      expect(res.output).toContain('src 泄漏');
      expect(res.output).toContain('extra in dist: index.js');
      expect(res.output).toContain('tsc 派生');
      expect(res.output).toContain('extra in dist: old-deleted.js');
      expect(res.output).toContain('stale dist 服役');
    } finally {
      fx.cleanup();
    }
  });

  it('v4) dist 缺失文件 → missing + exit 1；src 非白名单文件不算 missing（只当源基准）', () => {
    const fx = makeFixture();
    try {
      syncWebAssets(fx.src, fx.dst);
      rmSync(join(fx.dst, 'style.css'));
      rmSync(join(fx.dst, 'index.html'));

      const diff = diffWebAssets(fx.src, fx.dst);
      expect(diff.missing).toEqual(['index.html', 'style.css']);
      expect(diff.extra).toEqual([]);
      expect(diff.mismatch).toEqual([]);

      const res = runScript(syncScript, {
        DEV_MATE_WEB_SRC: fx.src,
        DEV_MATE_WEB_DST: fx.dst,
      });
      expect(res.status).toBe(1);
      expect(res.output).toContain('missing in dist: index.html');
      expect(res.output).toContain('missing in dist: style.css');
    } finally {
      fx.cleanup();
    }
  });

  it('v5) dist 整体不存在 → 全部资产 missing + exit 1（CI 未 build/MVP 降级可读报告，不崩溃）', () => {
    const fx = makeFixture();
    try {
      const diff = diffWebAssets(fx.src, fx.dst);
      expect(diff.missing).toEqual(WHITELIST);
      expect(diff.extra).toEqual([]);
      expect(diff.mismatch).toEqual([]);

      const res = runScript(syncScript, {
        DEV_MATE_WEB_SRC: fx.src,
        DEV_MATE_WEB_DST: fx.dst,
      });
      expect(res.status).toBe(1);
      expect(res.output).toContain('5 missing');
    } finally {
      fx.cleanup();
    }
  });
});

const realSrc = join(repoRoot, 'src', 'ui', 'web');
const realDst = join(repoRoot, 'dist', 'ui', 'web');

// CI 的 Test 步先于 Build（新 checkout 无 dist）→ 本组跳过；dist 完整性由 ci.yml 的
// Verify dist sync（Build 之后）把守——本地请先 `npm run build` 再跑全链。
describe.skipIf(!existsSync(realDst))(
  '构建产物：真实 dist/ui/web 镜像（本地 npm run build 后）',
  () => {
    it('w1) 清单一致 + 逐文件 md5 全等；index.ts/index.js/index.js.map/README-UI.md/assets png 均不在 dist', () => {
      expect(diffWebAssets(realSrc, realDst)).toEqual({ missing: [], extra: [], mismatch: [] });
      const assets = listWebAssets(realSrc);
      expect(assets.length).toBeGreaterThan(0);
      for (const rel of assets) {
        expect(md5(join(realDst, rel))).toBe(md5(join(realSrc, rel)));
      }
      for (const leaked of ['index.ts', 'index.js', 'index.js.map', 'README-UI.md']) {
        expect(existsSync(join(realDst, leaked))).toBe(false);
      }
      expect(existsSync(join(realDst, 'assets'))).toBe(false);
    });

    it('w2) spawn check-dist-sync.mjs（真实 repo、无 env 覆盖）→ exit 0', () => {
      const res = runScript(syncScript);
      expect(res.status).toBe(0);
      expect(res.output).toContain('一致');
    });
  },
);
