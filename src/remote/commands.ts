import { shellEscape } from '../core/shell';

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
 * 文件名搜索的 rg 内部 glob：basename 包含 query 的文件才会被 rg 遍历输出。
 * 大小写敏感用 -g，否则用 --iglob；query 中的 glob 元字符按字面量转义，
 * 保证与客户端子串匹配语义一致。
 */
export function buildFileSearchGlobArgs(fileQuery: string, caseSensitive: boolean): string[] {
  const needle = escapeGlobLiteral(fileQuery);
  const glob = `**/*${needle}*`;
  return caseSensitive ? ['-g', glob] : ['--iglob', glob];
}

function escapeGlobLiteral(value: string): string {
  return value.replace(/[\\*?[\]]/gu, (char) => `\\${char}`);
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
