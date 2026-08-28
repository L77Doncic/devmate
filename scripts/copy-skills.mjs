// 构建后将 mattpocock-skills 插件工程技能资产复制到 dist/assets/skills（tsc 不处理非 TS 资产）。
// 来源：~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/<version>/skills/engineering/
// - 每个 skill 目录整目录保留（SKILL.md + 附注 md/json 等文本；server 端按 <id>/SKILL.md 索引）；
// - 插件 LICENSE/README 聚合为 dist/assets/skills/LICENSE-mattpocock-skills.txt（第三方资产属性声明）；
// - src 侧不复制：dev 模式服务端在 dist 上跑——统一 dist 路径（静态 dev 可选）。
// 插件未安装 → 警告并跳过（dist 无 skills 资产，服务端 GET /api/skills 走空列表降级）。
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dst = join(root, 'dist', 'assets', 'skills');

const pluginBase = join(
  homedir(),
  '.claude',
  'plugins',
  'cache',
  'claude-plugins-official',
  'mattpocock-skills',
);

/** 插件缓存里存放的可选版本目录（semver 升序取最新；目录名为版本号）。 */
function latestVersion(base) {
  if (!existsSync(base)) return null;
  const versions = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
  return versions.length > 0 ? join(base, versions[versions.length - 1]) : null;
}

function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else count += 1;
  }
  return count;
}

const pluginDir = latestVersion(pluginBase);
const src = pluginDir !== null ? join(pluginDir, 'skills', 'engineering') : null;

if (src === null || !existsSync(src)) {
  console.error(`skills assets NOT copied (plugin not installed under ${pluginBase})`);
  process.exit(0);
}

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

let styleDirs = 0;
for (const entry of readdirSync(src, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
  cpSync(join(src, entry.name), join(dst, entry.name), { recursive: true });
  styleDirs += 1;
}

// 属性声明：插件 LICENSE + README 聚合单文件（dist 不复制源码仓库，许可与出处须随包声明）
const licensePath = join(pluginDir, 'LICENSE');
const readmePath = join(pluginDir, 'README.md');
if (existsSync(licensePath) || existsSync(readmePath)) {
  const version = pluginDir.split('/').pop();
  const parts = [
    'DevMate 第三方技能资产声明（mattpocock-skills）',
    `来源: ${pluginDir}/skills/engineering/（版本 ${version}）`,
    '以下技能目录（含 SKILL.md 与附注）为第三方资产，许可与出处（README）随本文件一并发布：',
    '',
    '============================== LICENSE ==============================',
  ];
  if (existsSync(licensePath)) parts.push(readFileSync(licensePath, 'utf8').trim());
  parts.push('', '============================== README ==============================', '');
  if (existsSync(readmePath)) parts.push(readFileSync(readmePath, 'utf8').trim());
  writeFileSync(join(dst, 'LICENSE-mattpocock-skills.txt'), `${parts.join('\n')}\n`);
}

const fileCount = countFiles(dst);
console.error(
  `skills assets copied: ${src} -> ${dst} (${styleDirs} skills, ${fileCount} files, LICENSE-mattpocock-skills.txt ${
    existsSync(join(dst, 'LICENSE-mattpocock-skills.txt')) ? 'ok' : 'MISSING'
  })`,
);
