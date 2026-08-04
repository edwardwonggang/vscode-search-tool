export type RipgrepStderrFilterResult = {
  visibleStderr: string;
  ignoredPermissionDeniedCount: number;
  hasOnlyIgnoredDiagnostics: boolean;
};

const RIPGREP_PERMISSION_DENIED_PATTERN = /^rg:\s+.+:\s+Permission denied\s+\(os error 13\)\s*$/u;

export function filterRipgrepStderr(stderr: string): RipgrepStderrFilterResult {
  const visibleLines: string[] = [];
  let ignoredPermissionDeniedCount = 0;

  for (const line of stderr.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (RIPGREP_PERMISSION_DENIED_PATTERN.test(trimmed)) {
      ignoredPermissionDeniedCount += 1;
      continue;
    }
    visibleLines.push(line.trimEnd());
  }

  return {
    visibleStderr: visibleLines.join('\n').trim(),
    ignoredPermissionDeniedCount,
    hasOnlyIgnoredDiagnostics: ignoredPermissionDeniedCount > 0 && visibleLines.length === 0
  };
}

export function isIgnorableRipgrepFailure(code: number | undefined, stderr: string): boolean {
  if (code === 0 || code === 1 || code === 141 || code === undefined) {
    return false;
  }
  return filterRipgrepStderr(stderr).hasOnlyIgnoredDiagnostics;
}

/**
 * 判断远端命令是否因可执行文件缺失而失败（如 /tmp 被重启清理后 rg 丢失）。
 * shell 对不存在的命令返回 127，并在 stderr 给出 No such file / not found。
 */
export function isRemoteExecutableMissing(result: { code?: number; stderr: string }): boolean {
  if (result.code !== 127) {
    return false;
  }
  return /no such file|command not found|not found/iu.test(result.stderr);
}
