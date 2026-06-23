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
