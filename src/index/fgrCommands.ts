import { shellEscape } from '../core/shell';

/** fast-grep 索引目录名（默认建在搜索根下）。 */
export const FGR_INDEX_DIR_NAME = '.fgr';

export function getFgrIndexDir(remoteCwd: string): string {
  return `${remoteCwd.replace(/\/+$/u, '')}/${FGR_INDEX_DIR_NAME}`;
}

/** 构建索引：全量建立一次，输出目录是远端 .fgr。 */
export function buildFgrIndexCommand(fgrPath: string, remoteCwd: string): string {
  const indexDir = getFgrIndexDir(remoteCwd);
  // --no-ignore 与内容搜索的 rg 行为（--no-ignore-vcs）对齐：索引也覆盖被 gitignore 的文件。
  return `cd ${shellEscape(remoteCwd)} && ${shellEscape(fgrPath)} index --no-ignore ${shellEscape(remoteCwd)} --output ${shellEscape(indexDir)}`;
}

/** 增量刷新索引：文件变化后对已有索引做快速更新。 */
export function buildFgrUpdateCommand(fgrPath: string, remoteCwd: string): string {
  const indexDir = getFgrIndexDir(remoteCwd);
  return `cd ${shellEscape(remoteCwd)} && ${shellEscape(fgrPath)} update --no-ignore ${shellEscape(remoteCwd)} --index ${shellEscape(indexDir)}`;
}

/** 输出索引统计（文档数、trigram、postings 大小），用于测试与日志。 */
export function buildFgrStatsCommand(fgrPath: string, indexDir: string): string {
  return `${shellEscape(fgrPath)} stats --index ${shellEscape(indexDir)}`;
}

/** 判断远端索引目录是否存在。 */
export function buildFgrIndexExistsCommand(indexDir: string): string {
  return `if test -d ${shellEscape(indexDir)}; then echo y; else echo n; fi`;
}

/** 构建内容搜索命令：fgr 输出 path:line:content，流式读取。 */
export function buildFgrSearchCommand(
  fgrPath: string,
  remoteCwd: string,
  indexDir: string,
  args: string[],
  query: string
): string {
  const escapedArgs = args.map((arg) => shellEscape(arg)).join(' ');
  return [
    `cd ${shellEscape(remoteCwd)}`,
    `${shellEscape(fgrPath)} ${escapedArgs} ${shellEscape(query)} . --index ${shellEscape(indexDir)}`
  ].join(' && ');
}
