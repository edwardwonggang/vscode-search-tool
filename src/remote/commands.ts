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
  const command = buildRemoteCommand(executablePath, remoteCwd, args);
  const needle = shellEscape(fileQuery);
  const awk = caseSensitive
    ? `awk -v needle=${needle} '{ name=$0; sub(/^.*\\//, "", name); if (index(name, needle) > 0) print }'`
    : `awk -v needle=${needle} 'BEGIN { needle=tolower(needle) } { name=$0; sub(/^.*\\//, "", name); if (index(tolower(name), needle) > 0) print }'`;
  return `${command} | ${awk}`;
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
