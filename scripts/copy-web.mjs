// # scripts/copy-web：构建后将零依赖前端静态资产镜像到 dist（tsc 不处理非 TS 资产）。
//
// VT-6 修复（stale dist 服役 + dist 泄漏 src）：
// - 旧版 cpSync(src, dst, { recursive: true }) 全量复制：`index.ts`/`README-UI.md` 原样进了
//   dist（浏览器 GET /index.ts 直接读到 TS 源码）；tsc 先 emission 的 `index.js`/`index.js.map`
//   与源已删除的文件残留在 dist 且被本地服务器原样提供（stale 服役）。
// - 现在改为**白名单扩展名镜像复制**：只复制浏览器资产（*.html / *.js / *.css / *.svg），
//   `.ts`/`.map`/`.md`/`.png` 等一律拒绝；复制前**清空 dst**——dist/ui/web 是 src/ui/web 的
//   严格镜像（文件清单 + 字节一致；scripts/check-dist-sync.mjs 校验同一契约）。
//
// 可测性：env DEV_MATE_WEB_SRC / DEV_MATE_WEB_DST 覆盖源/目标（test/build/copy-web.test.ts 的
// mkdtemp fixture 与 check-dist-sync.mjs 共用；缺省 = repo src/ui/web → dist/ui/web）。
// 无 `process.exit`（vitest 视其为崩溃——同 copy-skills 约定）：CLI 由 main() 执行，错误路径 throw。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const srcDefault = join(root, 'src', 'ui', 'web');
const dstDefault = join(root, 'dist', 'ui', 'web');

/** 浏览器资产白名单扩展名（小写）；其余（.ts/.map/.md/.png/…）一律不复制。 */
export const WEB_ASSET_EXTS = new Set(['.html', '.js', '.css', '.svg']);

/** 文件路径是否属于白名单浏览器资产（扩展名小写比较——.HTML/.JS 同判）。 */
export function isWebAssetPath(filePath) {
  return WEB_ASSET_EXTS.has(extname(filePath).toLowerCase());
}

/** src 树内所有白名单资产的相对路径清单（递归；排序——清单可 diff、可断言）。 */
export function listWebAssets(srcDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isWebAssetPath(full)) files.push(relative(srcDir, full));
    }
  };
  walk(srcDir);
  files.sort();
  return files;
}

/** 严格镜像同步：清空 dst 后仅复制 src 的白名单资产；返回复制的相对路径清单（= dst 资产集）。 */
export function syncWebAssets(srcDir, dstDir) {
  const files = listWebAssets(srcDir);
  rmSync(dstDir, { recursive: true, force: true });
  mkdirSync(dstDir, { recursive: true });
  for (const rel of files) {
    const to = join(dstDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(srcDir, rel), to);
  }
  return files;
}

/** CLI 主流程（直接运行 node scripts/copy-web.mjs 时执行；被 import 时仅定义）。 */
export function main() {
  const src = process.env.DEV_MATE_WEB_SRC ?? srcDefault;
  const dst = process.env.DEV_MATE_WEB_DST ?? dstDefault;
  const files = syncWebAssets(src, dst);
  console.error(
    `web assets copied: ${src} -> ${dst} (${files.length} files, whitelist .html/.js/.css/.svg; ` +
      `dist/ui/web 已清空重建镜像; index.html ${
        existsSync(join(dst, 'index.html')) ? 'ok' : 'MISSING'
      })`,
  );
}

// 直接运行（node scripts/copy-web.mjs）→ 执行主流程；被 import（vitest 直测纯函数）→ 仅定义。
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
