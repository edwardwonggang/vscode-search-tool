import { shellEscape } from '../core/shell';
import { hasFileWildcard, normalizeSearchPath } from '../core/glob';

export function buildRemoteCommand(executablePath: string, remoteCwd: string, args: string[]): string {
  const escapedArgs = args.map((arg) => shellEscape(arg)).join(' ');
  return `cd ${shellEscape(remoteCwd)} && ${shellEscape(executablePath)} ${escapedArgs}`;
}

export function buildRemoteFileNameSearchCommand(
  executablePath: string,
  remoteCwd: string,
  args: string[],
  fileQuery: string,
  caseSensitive: boolean
): string {
  // 在 rg 内部用 basename glob 剪枝，替代原先全量 `--files | awk` 管道，
  // 让 rg 在目录遍历时就跳过不匹配的文件；客户端仍保留 matcher 过滤兜底。
  const globArgs = buildFileSearchGlobArgs(fileQuery, caseSensitive);
  return buildRemoteCommand(executablePath, remoteCwd, [...args, ...globArgs]);
}

/**
 * 文件名搜索的 rg 内部 glob：无通配符时按 basename 子串剪枝（** 加 *query* 前缀后缀），
 * 含通配符时把 query 当作 glob 模式（** 加 query），与客户端 basename 匹配语义一致。
 */
export function buildFileSearchGlobArgs(fileQuery: string, caseSensitive: boolean): string[] {
  if (hasFileWildcard(fileQuery)) {
    const glob = `**/${normalizeSearchPath(fileQuery)}`;
    return caseSensitive ? ['-g', glob] : ['--iglob', glob];
  }
  const needle = escapeGlobLiteral(fileQuery);
  const glob = `**/*${needle}*`;
  return caseSensitive ? ['-g', glob] : ['--iglob', glob];
}

function escapeGlobLiteral(value: string): string {
  // 花括号也是 rg glob 的备选组元字符（{a,b}），同样需按字面量转义。
  return value.replace(/[\\*?[\]{}]/gu, (char) => `\\${char}`);
}

export function buildGitTopCommand(remoteCwd: string): string {
  return `cd ${shellEscape(remoteCwd)} && git rev-parse --show-toplevel`;
}

export function buildGitInsideWorkTreeCommand(remoteCwd: string): string {
  return `cd ${shellEscape(remoteCwd)} && git rev-parse --is-inside-work-tree`;
}

export function buildRemoteFileExistsCommand(remotePath: string): string {
  return `if test -f ${shellEscape(remotePath)}; then echo y; else echo n; fi`;
}

export function buildMkdirCommand(remotePath: string): string {
  return `mkdir -p ${shellEscape(remotePath)}`;
}

export function buildChmodExecutableCommand(remotePath: string): string {
  return `chmod +x ${shellEscape(remotePath)}`;
}

export function buildExecutableVersionCommand(remotePath: string): string {
  return `${shellEscape(remotePath)} --version 2>/dev/null | head -n 1 || true`;
}
