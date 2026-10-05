import { shellEscape } from '../core/shell';
import { buildTagProbeCommand } from './tagProbe';
import { TAG_INDEX_SAMPLE_BYTES } from './TagIndex';

/**
 * BRE 字面量转义：定义搜索的名称通常是 C 标识符，但侧边栏输入允许任意文本；
 * 只转义 POSIX BRE 的特殊字符，且不生成 \? \+ 等 GNU 扩展形式，保证可移植。
 */
export function escapeBreString(value: string): string {
  return value.replace(/[.\[\]\\^*$]/gu, (char) => `\\${char}`);
}

/**
 * 构建“有界”tags 搜索命令（readtags 缺失时的最差回退）：universal-ctags
 * 生成的 tags 文件按名称排序，同一符号的所有条目连续排列。先 grep -n -m1
 * 定位首条匹配行的行号（-m1 在首条命中即停止，避免全量扫描数百 MB 的 tags
 * 文件），再 tail 从该行号起读取，awk 打印以 query 开头的连续块后立即退出。
 * 与全量 rg 相比只读取匹配块附近的字节，耗时从“文件大小相关”降为“符号位置
 * 相关”。优先走 tags.sidx 稀疏索引快速路径，只有 sidx 缺失/定位失败时才落
 * 到本回退。
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
 * 否则若有 tags.sidx 稀疏索引，先用它定位符号所在块再做有界 dd 扫描；两者都
 * 不可用时才回退到 grep -m1 + tail + awk 的线性扫描。tagsPathArg / sidxPathArg
 * 是 shell 引用的路径表达式（可以是 "$top/tags" 这样的变量展开）。
 */
function buildTagScanBlock(tagsPathArg: string, sidxPathArg: string, query: string): string {
  const escapedQuery = shellEscape(query);
  const anchoredPrefixPattern = `^${escapeBreString(query)}[[:space:]]`;
  const grepFallback = [
    `first=$(grep -n -m1 ${shellEscape(anchoredPrefixPattern)} ${tagsPathArg} | head -n 1 | cut -d: -f1)`,
    `if test -n "$first"; then`,
    `  tail -n +"$first" ${tagsPathArg} | awk -F '\\t' -v n=${escapedQuery} '$1==n{print;next}{exit}'`,
    `fi`
  ];
  // 稀疏索引快速路径：sidx 记录每个 split 块的首个符号名，块按符号名排序，
  // 用 awk 找到最后一个“首符号 <= query”的块号，再对该块做有界 dd 扫描，
  // 避免从 tags 头部线性读取。块 0 含头部注释行，块 >0 首行为上一块的跨边界
  // 残行，读取窗口统一多取 2 块并跳过首行以覆盖边界。
  const sidxFallback = [
    `if test -f ${sidxPathArg}; then`,
    `  block=$(LC_ALL=C awk -F '\\t' -v q=${escapedQuery} '$2<=q{last=$1} $2>q{print last; exit} END{if(last!="")print last}' ${sidxPathArg})`,
    `  if test -n "$block"; then`,
    `    start=$((block * ${TAG_INDEX_SAMPLE_BYTES}))`,
    `    count=$((3 * ${TAG_INDEX_SAMPLE_BYTES}))`,
    `    out=$(LC_ALL=C dd if=${tagsPathArg} bs=1 skip=$start count=$count 2>/dev/null | LC_ALL=C awk -F '\\t' -v n=${escapedQuery} -v skip=$block 'skip>0 && NR==1{next} $1==n{print;f=1;next} f && $1!=n{exit}')`,
    `    if test -n "$out"; then`,
    `      printf '%s\\n' "$out"`,
    `    else`,
    ...grepFallback.map((line) => `      ${line}`),
    `    fi`,
    `  else`,
    ...grepFallback.map((line) => `    ${line}`),
    `  fi`,
    `else`,
    ...grepFallback.map((line) => `  ${line}`),
    `fi`
  ];
  return [
    // 远端 readtags 版本/行为差异会导致静默无输出：只有确认支持所需的
    // --extension-fields 参数才使用二分查找，空输出或命令失败一律回退 grep。
    `if command -v readtags >/dev/null 2>&1 && readtags --help 2>&1 | grep -q -e '--extension-fields'; then`,
    `  out=$(readtags -E -ne -t ${tagsPathArg} - ${escapedQuery} 2>/dev/null) || out=""`,
    `  if test -n "$out"; then`,
    `    printf '%s\\n' "$out"`,
    `  else`,
    ...sidxFallback.map((line) => `    ${line}`),
    `  fi`,
    `else`,
    ...sidxFallback.map((line) => `  ${line}`),
    `fi`
  ].join('\n');
}

/**
 * 构建重建 tags 后使用的纯扫描命令：从 tagsDir 进入后执行 readtags 二分或 grep 有界扫描。
 */
export function buildTagSearchCommand(tagsDir: string, tagsBase: string, query: string): string {
  return [
    `cd ${shellEscape(tagsDir)}`,
    buildTagScanBlock(shellEscape(`${tagsDir}/${tagsBase}`), shellEscape(`${tagsDir}/tags.sidx`), query)
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
  const scanBlock = buildTagScanBlock('"$top/tags"', '"$top/tags.sidx"', query);
  return [
    probe,
    `if test "$tags" = y && test -n "$top"; then`,
    scanBlock.split('\n').map((line) => `  ${line}`).join('\n'),
    `fi`
  ].join('\n');
}
