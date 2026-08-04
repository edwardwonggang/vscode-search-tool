import { shellEscape } from '../core/shell';
import { buildTagProbeCommand } from './tagProbe';

/**
 * BRE 字面量转义：定义搜索的名称通常是 C 标识符，但侧边栏输入允许任意文本；
 * 只转义 POSIX BRE 的特殊字符，且不生成 \? \+ 等 GNU 扩展形式，保证可移植。
 */
export function escapeBreString(value: string): string {
  return value.replace(/[.\[\]\\^*$]/gu, (char) => `\\${char}`);
}

/**
 * 构建“有界”tags 搜索命令：universal-ctags 生成的 tags 文件按名称排序，
 * 同一符号的所有条目连续排列。先 grep -n -m1 定位首条匹配行的行号
 * （-m1 在首条命中即停止，避免全量扫描数百 MB 的 tags 文件），再 tail 从
 * 该行号起读取，awk 打印以 query 开头的连续块后立即退出。与全量 rg 相比
 * 只读取匹配块附近的字节，耗时从“文件大小相关”降为“符号位置相关”。
 */
export function buildBoundedTagSearchCommand(
  tagsDir: string,
  tagsBase: string,
  query: string
): string {
  const anchoredPrefixPattern = `^${escapeBreString(query)}[[:space:]]`;
  return [
    `cd ${shellEscape(tagsDir)}`,
    `first=$(grep -n -m1 ${shellEscape(anchoredPrefixPattern)} ${shellEscape(tagsBase)} | head -n 1 | cut -d: -f1)`,
    `if test -n "$first"; then`,
    `  tail -n +$first ${shellEscape(tagsBase)} | awk -F '\\t' -v n=${shellEscape(query)} '$1==n{print;next}{exit}'`,
    `fi`
  ].join('\n');
}

/**
 * 构建“readtags 优先”的扫描片段：远端存在 readtags 时用二分查找（O(log N)），
 * 否则回退到 grep -m1 + tail + awk 的有界扫描。tagsPathArg 是 shell 引用的
 * tags 文件路径表达式（可以是 "$top/tags" 这样的变量展开）。
 */
function buildTagScanBlock(tagsPathArg: string, query: string): string {
  const escapedQuery = shellEscape(query);
  const anchoredPrefixPattern = `^${escapeBreString(query)}[[:space:]]`;
  const grepFallback = [
    `first=$(grep -n -m1 ${shellEscape(anchoredPrefixPattern)} ${tagsPathArg} | head -n 1 | cut -d: -f1)`,
    `if test -n "$first"; then`,
    `  tail -n +"$first" ${tagsPathArg} | awk -F '\\t' -v n=${escapedQuery} '$1==n{print;next}{exit}'`,
    `fi`
  ];
  return [
    `if command -v readtags >/dev/null 2>&1; then`,
    `  readtags -E -ne -t ${tagsPathArg} - ${escapedQuery} 2>/dev/null || {`,
    ...grepFallback.map((line) => `    ${line}`),
    `  }`,
    `else`,
    ...grepFallback.map((line) => `  ${line}`),
    `fi`
  ].join('\n');
}

/**
 * 构建重建 tags 后使用的纯扫描命令：从 tagsDir 进入后执行 readtags 二分或 grep 有界扫描。
 */
export function buildTagSearchCommand(tagsDir: string, tagsBase: string, query: string): string {
  return [
    `cd ${shellEscape(tagsDir)}`,
    buildTagScanBlock(shellEscape(`${tagsDir}/${tagsBase}`), query)
  ].join('\n');
}

/**
 * 构建“探针 + 扫描”合并命令：一次 SSH exec 先输出 PROBE: 元数据，再输出
 * 该符号的 tags 匹配块（tags 存在时），把定义搜索从 2 次往返降到 1 次。
 */
export function buildTagProbeAndSearchCommand(
  remoteCwd: string,
  rgPath: string,
  ctagsPath: string,
  query: string
): string {
  const probe = buildTagProbeCommand(remoteCwd, rgPath, ctagsPath);
  const scanBlock = buildTagScanBlock('"$top/tags"', query);
  return [
    probe,
    `if test "$tags" = y && test -n "$top"; then`,
    scanBlock.split('\n').map((line) => `  ${line}`).join('\n'),
    `fi`
  ].join('\n');
}
