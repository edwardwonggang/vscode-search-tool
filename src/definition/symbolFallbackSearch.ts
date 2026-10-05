import { shellEscape } from '../core/shell';
import { TAGS_FILE_NAME, TAGS_TMP_FILE_NAME, TAGS_META_FILE_NAME } from './TagIndex';

/**
 * 定义搜索的 rg 兜底：当远端 ctags 索引精确匹配无结果时，用 ripgrep 在 git 根做一次
 * 精确单词搜索，把符号出现位置（含引用）返回给用户，避免「明明有定义却提示未找到」。
 *
 * 兜底只覆盖 ctags 可能漏索引/名字不匹配的场景，命中既含定义也可能含引用；
 * 前端用候选列表展示，用户可据此跳转。属于 ctags 精确匹配的补充，不做全文盲搜。
 */

// 兜底搜索必须跳过索引文件本身。
const TAG_INDEX_EXCLUDE = [TAGS_FILE_NAME, TAGS_TMP_FILE_NAME, TAGS_META_FILE_NAME];

export function buildSymbolFallbackSearchCommand(
  rgPath: string,
  gitTop: string,
  symbol: string,
  threads = 0
): string {
  const args = ['--json', '--line-number', '--column', '--hidden', '--no-ignore-vcs', '--word-regexp', '--fixed-strings'];
  if (threads > 0) {
    args.push('--threads', String(threads));
  }
  for (const name of TAG_INDEX_EXCLUDE) {
    args.push('--glob', `!${name}`);
  }
  // 符号名可能含正则特殊字符，但 --fixed-strings 已按字面匹配，无需转义。
  args.push(symbol);
  args.push('.');
  const escaped = args.map((a) => shellEscape(a)).join(' ');
  return `cd ${shellEscape(gitTop)} && ${shellEscape(rgPath)} ${escaped}`;
}
