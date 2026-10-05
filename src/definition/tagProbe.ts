import { shellEscape } from '../core/shell';
import { parseTagIndexMeta, type TagIndexMeta } from './TagIndex';

export const TAG_PROBE_PREFIX = 'PROBE:';
export const TAG_PROBE_CD_FAIL_LINE = 'PROBE:cd=fail';

export type TagProbeResult = {
  gitTop: string;
  insideWorkTree: string;
  rgVersion: string;
  ctagsVersion: string;
  tagsExists: boolean;
  gitHead: string;
  /** 工作区是否有未提交改动（git 工作区脏）。 */
  dirty: boolean;
  /** tags.meta.json 解析结果；tags 不存在或元数据缺失/损坏时为 undefined。 */
  meta?: TagIndexMeta;
};

/**
 * 构建单条远端探针命令：一次 SSH exec 同时探测 git 根、工作树状态、远端
 * rg/ctags 版本、tags 文件存在性与 git HEAD，替代原来 5~6 次串行 exec。
 * 输出为以 PROBE: 前缀开头的 key=value 行，便于客户端解析。
 */
export function buildTagProbeCommand(remoteCwd: string, rgPath: string, ctagsPath: string): string {
  const lines = [
    `cd ${shellEscape(remoteCwd)} || { printf '%s\\n' ${TAG_PROBE_CD_FAIL_LINE}; exit 0; }`,
    `top=$(git rev-parse --show-toplevel 2>/dev/null) || top=""`,
    `inside=$(git rev-parse --is-inside-work-tree 2>/dev/null) || inside=""`,
    `head=$(test -n "$top" && git -C "$top" rev-parse HEAD 2>/dev/null) || head=""`,
    `if test -n "$top" && test -f "$top/tags"; then tags=y; else tags=n; fi`,
    `dirty=$(test -n "$top" && git -C "$top" status --porcelain 2>/dev/null | grep -q . && echo y || echo n) || dirty=n`,
    `if test "$tags" = y && test -f "$top/tags.meta.json"; then printf 'PROBE:meta=%s\\n' "$(cat "$top/tags.meta.json" 2>/dev/null)"; fi`,
    `rgv=$(${shellEscape(rgPath)} --version 2>/dev/null | head -n 1) || rgv=""`,
    `ctv=$(${shellEscape(ctagsPath)} --version 2>/dev/null | head -n 1) || ctv=""`,
    `printf 'PROBE:gitTop=%s\\nPROBE:insideWorkTree=%s\\nPROBE:rgVersion=%s\\nPROBE:ctagsVersion=%s\\nPROBE:tags=%s\\nPROBE:gitHead=%s\\nPROBE:dirty=%s\\n' "$top" "$inside" "$rgv" "$ctv" "$tags" "$head" "$dirty"`
  ];
  return lines.join('\n');
}

/**
 * 解析探针命令输出；cd 失败或输出为空时返回 undefined（表示探针本身失败，
 * 与“不是 git 根”区分开，后者由调用方根据 gitTop/insideWorkTree 判断）。
 */
export function parseTagProbe(output: string): TagProbeResult | undefined {
  if (!output || output.includes(TAG_PROBE_CD_FAIL_LINE)) {
    return undefined;
  }
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(TAG_PROBE_PREFIX)) {
      continue;
    }
    const body = trimmed.slice(TAG_PROBE_PREFIX.length);
    const eq = body.indexOf('=');
    if (eq < 0) {
      continue;
    }
    values[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return {
    gitTop: values.gitTop ?? '',
    insideWorkTree: values.insideWorkTree ?? '',
    rgVersion: values.rgVersion ?? '',
    ctagsVersion: values.ctagsVersion ?? '',
    tagsExists: (values.tags ?? 'n') === 'y',
    gitHead: values.gitHead ?? '',
    dirty: (values.dirty ?? 'n') === 'y',
    meta: parseTagIndexMeta(values.meta ?? '')
  };
}
