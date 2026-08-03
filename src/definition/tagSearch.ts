import { shellEscape } from '../core/shell';

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
