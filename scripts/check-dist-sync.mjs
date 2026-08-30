// # scripts/check-dist-sync：构建后一致性校验——dist/ui/web 必须与 src/ui/web 的资产集一致。
//
// VT-6（暴力测试）约束：**源为基准、dist 为镜像**——两者文件清单一致且逐字节一致：
// - src 白名单资产（*.html/*.js/*.css/*.svg，见 copy-web.mjs 的 WEB_ASSET_EXTS）在 dist 缺失
//   → missing（镜像欠拷贝/构建未跑全链）；
// - dist 独有文件 → extra：
//   · 白名单扩展名 → 旧资产残留、源已删（stale dist 服役）；
//   · 非白名单扩展名 → src 泄漏（index.ts/README-UI.md/*.map/*.png——运行时被原样提供）；
// - 同名异字节 → mismatch（旧版本残留，如 index.html/app.js 曾是旧拷贝）；
// - dist 整体不存在 → 全部 missing（CI 未 build 照跑也更直观）。
//
// 通过 → stdout 摘要 + exit 0；失败 → stderr 明细 + process.exitCode = 1（CI Verify 步退红）。
// 无 `process.exit`（vitest spawn 视其为崩溃——同 copy-skills 约定）。
// 用法：node scripts/check-dist-sync.mjs（env DEV_MATE_WEB_SRC / DEV_MATE_WEB_DST 覆盖——
// test/build/copy-web.test.ts 的 fixture；缺省校验真实 repo 的 src/ui/web ↔ dist/ui/web）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_ASSET_EXTS, isWebAssetPath, listWebAssets } from './copy-web.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const srcDefault = join(root, 'src', 'ui', 'web');
const dstDefault = join(root, 'dist', 'ui', 'web');

/** 目录下全部文件的相对路径（相对目录根，任何扩展名——dist 侧的泄漏/残留也必须暴露）。 */
export function listAllFiles(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(dir, full));
    }
  };
  walk(dir);
  files.sort();
  return files;
}

/** 逐字节相等（先比尺寸短路）。 */
export function filesEqual(a, b) {
  if (statSync(a).size !== statSync(b).size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

/**
 * 一致性差异（全量）：
 * - missing:  src 白名单资产在 dist 缺失的相对路径；
 * - extra:    dist 独有文件 [{ path, leaked }]（leaked=true = 非白名单扩展名 → src 泄漏/残留）；
 * - mismatch: 同名异字节 [{ path, srcSize, dstSize }]。
 */
export function diffWebAssets(srcDir, dstDir) {
  const srcAssets = listWebAssets(srcDir);
  const srcSet = new Set(srcAssets);
  let dstFiles = [];
  try {
    dstFiles = listAllFiles(dstDir);
  } catch {
    // dist 不存在 → 视为空镜像：全部 missing（不 throw——可读的报告 > 崩溃）。
  }
  const missing = srcAssets.filter((rel) => !dstFiles.includes(rel));
  const extra = dstFiles
    .filter((rel) => !srcSet.has(rel))
    .map((path) => ({ path, leaked: !isWebAssetPath(path) }));
  const mismatch = [];
  for (const rel of srcAssets) {
    if (!dstFiles.includes(rel)) continue;
    if (!filesEqual(join(srcDir, rel), join(dstDir, rel))) {
      mismatch.push({
        path: rel,
        srcSize: statSync(join(srcDir, rel)).size,
        dstSize: statSync(join(dstDir, rel)).size,
      });
    }
  }
  return { missing, extra, mismatch };
}

/** 一致性检查 + 文本报告（ok / lines）。 */
export function checkWebAssetsSync(srcDir, dstDir) {
  const srcAssets = listWebAssets(srcDir);
  const diff = diffWebAssets(srcDir, dstDir);
  // 全量 src 文件集（含 .ts/.md/.png——判定 dist 多出的 .js 是否为 tsc 派生 emission）
  let srcAll = [];
  try {
    srcAll = listAllFiles(srcDir);
  } catch {
    // src 不存在 → diffWebAssets 已按空镜像报告；此处仅用于 extra 归类，忽略。
  }
  const stemOf = (p) => p.slice(0, p.length - extname(p).length);
  const lines = [];
  for (const rel of diff.missing) lines.push(`missing in dist: ${rel}`);
  for (const { path, leaked } of diff.extra) {
    const kind = leaked
      ? `非白名单扩展名——src 泄漏/残留（index.ts/README-UI.md/.map/.png… 不得进 dist）`
      : srcAll.some((s) => s !== path && stemOf(s) === stemOf(path))
        ? `白名单扩展名——tsc 派生 emission（src 侧为 .ts 源，非浏览器资产，不得服役）`
        : `白名单扩展名——旧资产残留（源已删 → stale dist 服役）`;
    lines.push(`extra in dist: ${path} (${kind})`);
  }
  for (const m of diff.mismatch) {
    lines.push(`mismatch: ${m.path} (src ${m.srcSize}B vs dist ${m.dstSize}B)`);
  }
  const ok = diff.missing.length === 0 && diff.extra.length === 0 && diff.mismatch.length === 0;
  return {
    ok,
    lines,
    summary:
      `dist/ui/web 镜像：${WEB_ASSET_EXTS.size} 种白名单扩展名 × ${srcAssets.length} 个资产 — ` +
      (ok
        ? `一致（清单 + 字节全等，exit 0）`
        : `不一致（${diff.missing.length} missing / ${diff.extra.length} extra / ${diff.mismatch.length} mismatch）`),
  };
}

/** CLI 主流程（直接运行 node scripts/check-dist-sync.mjs 时执行；被 import 时仅定义）。 */
export function main() {
  const src = process.env.DEV_MATE_WEB_SRC ?? srcDefault;
  const dst = process.env.DEV_MATE_WEB_DST ?? dstDefault;
  const { ok, lines, summary } = checkWebAssetsSync(src, dst);
  if (ok) {
    console.log(summary);
  } else {
    console.error(summary);
    for (const line of lines) console.error(`  - ${line}`);
  }
  process.exitCode = ok ? 0 : 1;
}

// 直接运行（node scripts/check-dist-sync.mjs）→ 执行主流程；被 import（vitest 直测）→ 仅定义。
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
