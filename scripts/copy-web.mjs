// 构建后将零依赖前端静态资源复制到 dist（tsc 不处理非 TS 资产）
// 运行时 devmate-cli web 从 dist 同级服务；npm 包 files:["dist"] 需要它
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'ui', 'web');
const dst = join(root, 'dist', 'ui', 'web');

mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.error(
  `assets copied: src/ui/web -> dist/ui/web (${
    existsSync(join(dst, 'index.html')) ? 'ok' : 'MISSING'
  })`,
);
