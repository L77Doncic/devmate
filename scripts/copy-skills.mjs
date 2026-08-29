// 构建后将 mattpocock-skills 插件工程技能资产复制到 dist/assets/skills（tsc 不处理非 TS 资产）。
// 源目录优先级：env DEV_MATE_SKILLS_SRC > 默认插件路径
//   ~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/<version>/skills/engineering/
//   > 空（无源 → WARN 并保证 dist/assets/skills 为空，服务端 GET /api/skills 空列表降级）。
//   - CI（ubuntu/windows）无 ~/.claude → 走 WARN 分支；构建正常 exit 0；
//   - 本地构建请安装 mattpocock-skills 或设 DEV_MATE_SKILLS_SRC 指向定制源目录。
// - 每个 skill 目录整目录保留（SKILL.md + 附注 md/json 等文本；server 端按 <id>/SKILL.md 索引）；
// - 方法论内化蒸馏（R2-S1）：repo 根 assets/skills-meta.json（Meta 精编产物）合并进每个
//   SKILL.md 的 frontmatter（原字段 + `methodology: {type,trigger,steps,done}` 行——dist 内为
//   合并产物），并生成 dist/assets/skills/methodologies.json（路由器表源；deps 动态读）。
//   - 无 meta 的技能（B 线或用户未来自装）→ 仅生成 {type:'reference'} 缺省；
//   - 脚本对缺失 meta 键不崩（sanitizeSkillMeta 全量容错）。
// - 插件 LICENSE/README 聚合为 dist/assets/skills/LICENSE-mattpocock-skills.txt（第三方资产属性声明）；
// - src 侧不复制：dev 模式服务端在 dist 上跑——统一 dist 路径（静态 dev 可选）。
// - **不存在任何 process.exit**（vitest 视 process.exit 为崩溃）：无源 or 报错路径一律正常返回。
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dst = join(root, 'dist', 'assets', 'skills');

// ---------------------------------------------------------------------------
// 蒸馏纯函数（test/build/copy-skills.test.ts 直测；无 meta 缺键不崩）
// ---------------------------------------------------------------------------

/** 单条 meta 容错清洗：非对象 → null；type 非 'method'|'reference' → 'reference' 缺省；
 *  trigger/steps/done 只收非空字符串。 */
export function sanitizeSkillMeta(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw;
  const type = record.type === 'method' || record.type === 'reference' ? record.type : 'reference';
  const meta = { type };
  for (const key of ['trigger', 'steps', 'done']) {
    if (typeof record[key] === 'string' && record[key] !== '') meta[key] = record[key];
  }
  return meta;
}

/** 有 meta 缺省（B 线/未来自装）：sanitizeSkillMeta(undefined) 的缺省形态 {type:'reference'}。 */
export function defaultSkillMeta() {
  return { type: 'reference' };
}

/**
 * frontmatter 合并：原 frontmatter 字段原样保留，追加一行 `methodology: {json}`（块整体为
 * YAML flow mapping 写法）；无 frontmatter → 生成首行块。body 逐字保存（换行不重排）。
 */
export function mergeSkillFrontmatter(content, rawMeta) {
  const meta = sanitizeSkillMeta(rawMeta) ?? defaultSkillMeta();
  const line = `methodology: ${JSON.stringify(meta)}`;
  const rest = content;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(rest);
  if (m === null) {
    return `---\n${line}\n---\n${content}`;
  }
  const eol = m[1].includes('\r\n') ? '\r\n' : '\n';
  const body = rest.slice(m[0].length);
  return `---${eol}${m[1]}${eol}${line}${eol}---${eol}${body}`;
}

/**
 * 路由器表（methodologies.json 的形状）：给定技能 id 清单与 meta 图 →
 * id → 清洗后 meta（缺失/坏键 → {type:'reference'} 缺省；不崩）。
 * 键序 = Meta 精编撰写序（**路由优先级**——服务端按本文件键序排优先）；未收录技能
 * 按 id 序兜底。
 */
export function buildMethodologiesTable(ids, rawMeta) {
  const map =
    typeof rawMeta === 'object' && rawMeta !== null && !Array.isArray(rawMeta) ? rawMeta : {};
  const known = new Set(ids);
  const ordered = [
    ...Object.keys(map).filter((id) => known.has(id)),
    ...[...new Set(ids)].filter((id) => !(id in map)).sort(),
  ];
  const table = {};
  for (const id of ordered) table[id] = sanitizeSkillMeta(map[id]) ?? defaultSkillMeta();
  return table;
}

// ---------------------------------------------------------------------------
// 复制主流程
// ---------------------------------------------------------------------------

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

/**
 * 主流程（导出供测试直调；直接运行 node scripts/copy-skills.mjs 时由文件底部 gate 触发）。
 * 源目录优先级：env DEV_MATE_SKILLS_SRC > 默认插件路径 > 空。任何分支都不 process.exit——
 * 无源 → WARN 并保证 dist/assets/skills 为空（不残留上次构建的资产），正常返回。
 * meta 源默认 repo 根 assets/skills-meta.json；env DEV_MATE_SKILLS_META 可覆写（确定性 fixture）。
 */
export function main() {
  const envSrc = process.env.DEV_MATE_SKILLS_SRC?.trim() || null;
  const metaPath =
    process.env.DEV_MATE_SKILLS_META?.trim() || join(root, 'assets', 'skills-meta.json');

  const pluginBase = join(
    homedir(),
    '.claude',
    'plugins',
    'cache',
    'claude-plugins-official',
    'mattpocock-skills',
  );

  const pluginDir = latestVersion(pluginBase);
  const src = envSrc ?? (pluginDir !== null ? join(pluginDir, 'skills', 'engineering') : null);

  if (src === null || !existsSync(src)) {
    const reason = envSrc
      ? `DEV_MATE_SKILLS_SRC=${envSrc} not found`
      : `plugin not installed under ${pluginBase}`;
    console.warn(
      `WARN: no skills source; dist/assets/skills will be empty` +
        `（本地构建请安装 mattpocock-skills 或设 DEV_MATE_SKILLS_SRC）— ${reason}`,
    );
    // 清空产物：避免上次构建的 skills 资产残留（server GET /api/skills 空列表降级）
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dst, { recursive: true });
    return;
  }

  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });

  // Meta 精编产物：缺失 → {}（所有技能降级 reference；脚本不崩）
  let metaRaw = {};
  if (existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
      metaRaw =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch {
      metaRaw = {};
    }
  }

  let styleDirs = 0;
  const skillIds = [];
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    cpSync(join(src, entry.name), join(dst, entry.name), { recursive: true });
    styleDirs += 1;
    // 蒸馏：SKILL.md 的 frontmatter 合并版（原字段 + methodology 行；dist 内为合并产物）
    const skillFile = join(dst, entry.name, 'SKILL.md');
    if (existsSync(skillFile)) {
      skillIds.push(entry.name);
      const original = readFileSync(skillFile, 'utf8');
      writeFileSync(skillFile, mergeSkillFrontmatter(original, metaRaw[entry.name]));
    }
  }

  // 路由器表（methodologies.json）：deps compose 的路由节与 loop 前置门 route 的动态读源
  writeFileSync(
    join(dst, 'methodologies.json'),
    `${JSON.stringify(buildMethodologiesTable(skillIds, metaRaw), null, 2)}\n`,
  );

  // 属性声明：插件 LICENSE + README 聚合单文件（dist 不复制源码仓库，许可与出处须随包声明）；
  // 源为 env 覆盖时取其父目录（fixture/定制源可在 src 旁放 LICENSE/README.md）
  const licenseDir = envSrc ? dirname(src) : pluginDir;
  const licensePath = licenseDir === null ? null : join(licenseDir, 'LICENSE');
  const readmePath = licenseDir === null ? null : join(licenseDir, 'README.md');
  if (licensePath !== null && (existsSync(licensePath) || existsSync(readmePath))) {
    const version = licenseDir.split(/[\\/]/).pop();
    const parts = [
      'DevMate 第三方技能资产声明（mattpocock-skills）',
      `来源: ${src}/（版本 ${version}）`,
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
  const methodCount = Object.values(buildMethodologiesTable(skillIds, metaRaw)).filter(
    (m) => m.type === 'method',
  ).length;
  console.error(
    `skills assets copied: ${src} -> ${dst} (${styleDirs} skills, ${fileCount} files, ` +
      `methodologies.json ${existsSync(join(dst, 'methodologies.json')) ? 'ok' : 'MISSING'} ` +
      `(${methodCount} method / ${skillIds.length - methodCount} reference), ` +
      `LICENSE-mattpocock-skills.txt ${
        existsSync(join(dst, 'LICENSE-mattpocock-skills.txt')) ? 'ok' : 'MISSING'
      })`,
  );
}

// 直接运行（node scripts/copy-skills.mjs）→ 执行主流程；被 import（vitest 直测纯函数/导出 main）→ 仅定义。
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
