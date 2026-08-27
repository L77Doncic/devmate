/**
 * # tools：工具面（ADR-0008）
 *
 * 内置 7 个工具中六个文件面在此实现（接缝 S7，见 fs.ts）：
 * read_file / write_file / edit_file / list_dir / glob / grep；
 * run_command（常驻 Shell + 哨兵行）属 S10，不在本模块。
 * 注册形态：createFsTools(ctx) 产出 Tool[]（只实现 Tool 接口），
 * registry 包装由 loop 的 defineRegistry 完成；监狱真判定（checkPath/checkRedirect）
 * 由 S9 实现（接口单一来源：src/core/jail/index.ts，经 types.ts 转导出）。
 */
export { createFsTools, MAX_COLLECTION_BYTES, collectionElideMarker } from './fs.js';
export type { FsToolContext, Jail } from './types.js';
