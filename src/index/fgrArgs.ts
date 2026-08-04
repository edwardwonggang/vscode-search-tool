import { splitUserGlobs } from '../core/glob';
import type { SearchOptions, SearchSettings } from '../core/types';

export type FgrContentPlan =
  | { usable: true; args: string[] }
  | { usable: false; reason: string };

/**
 * 判断内容搜索是否可以用 fast-grep 索引路径，并构造 fgr 参数。
 * fgr 不支持整词匹配、管道模式不输出上下文行、也不提供 JSON 输出，
 * 这些场景回退到 ripgrep 以保证语义不缺失。
 */
export function planFgrContentSearch(
  options: SearchOptions,
  settings: SearchSettings,
  contextLines: number
): FgrContentPlan {
  if (options.wholeWord) {
    return { usable: false, reason: 'whole-word unsupported by fgr' };
  }
  if (contextLines > 0) {
    return { usable: false, reason: 'context lines are not streamed by fgr' };
  }

  const args = ['-n', '--no-ignore'];
  if (!options.caseSensitive) {
    args.push('-i');
  }
  if (!options.useRegex) {
    args.push('-F');
  }
  for (const glob of settings.includeGlobs) {
    args.push('--include', glob);
  }
  for (const glob of splitUserGlobs(options.include)) {
    args.push('--include', glob);
  }
  for (const glob of settings.excludeGlobs) {
    args.push('--exclude', glob);
  }
  for (const glob of splitUserGlobs(options.exclude)) {
    args.push('--exclude', glob);
  }
  return { usable: true, args };
}
