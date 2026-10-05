import { normalizeExcludeGlobForSearch, splitUserGlobs } from '../core/glob';
import type { SearchOptions, SearchSettings } from '../core/types';
import { TAGS_FILE_NAME, TAGS_META_FILE_NAME, TAGS_TMP_FILE_NAME } from '../definition/TagIndex';

export type ContentSearchArgOptions = {
  contextLines: number;
  threads: number;
};

// 定义搜索在远端 git 根生成的索引文件（大仓库可达数百 MB 的单行密集文本）。
// 内置排除，避免内容/文件搜索全文扫描这些文件；不放进用户可改的 excludeGlobs 设置。
const TAG_INDEX_EXCLUDE_GLOBS = [TAGS_FILE_NAME, TAGS_TMP_FILE_NAME, TAGS_META_FILE_NAME];

function appendTagIndexExcludes(args: string[]): void {
  for (const name of TAG_INDEX_EXCLUDE_GLOBS) {
    args.push('--glob', `!${name}`);
  }
}

export function buildContentSearchArgs(
  options: SearchOptions,
  settings: SearchSettings,
  argOptions: ContentSearchArgOptions
): string[] {
  const args = ['--json', '--line-buffered', '--line-number', '--column', '--hidden', '--no-ignore-vcs'];

  if (argOptions.threads > 0) {
    args.push('--threads', String(argOptions.threads));
  }
  if (!options.caseSensitive) {
    args.push('--ignore-case');
  }
  if (options.wholeWord) {
    args.push('--word-regexp');
  }
  if (!options.useRegex) {
    args.push('--fixed-strings');
  }
  if (argOptions.contextLines > 0) {
    args.push('--context', String(argOptions.contextLines));
  }

  appendTagIndexExcludes(args);
  appendSettingsGlobs(args, settings);
  appendUserExcludeGlobs(args, options.exclude);
  args.push(options.query);
  args.push('.');
  return args;
}

export function buildFileSearchArgs(options: SearchOptions, settings: SearchSettings): string[] {
  const args = ['--files', '--line-buffered', '--hidden', '--no-ignore-vcs'];
  appendTagIndexExcludes(args);
  appendSettingsGlobs(args, settings);
  appendUserIncludeGlobs(args, options.include);
  appendUserExcludeGlobs(args, options.exclude);
  return args;
}

function appendSettingsGlobs(args: string[], settings: SearchSettings): void {
  for (const glob of settings.includeGlobs) {
    args.push('--glob', glob);
  }
  for (const glob of settings.excludeGlobs) {
    appendExcludeGlob(args, glob);
  }
}

function appendUserIncludeGlobs(args: string[], include: string): void {
  if (!include.trim()) {
    return;
  }
  for (const glob of splitUserGlobs(include)) {
    args.push('--glob', glob);
  }
}

function appendUserExcludeGlobs(args: string[], exclude: string): void {
  if (!exclude.trim()) {
    return;
  }
  for (const glob of splitUserGlobs(exclude)) {
    appendExcludeGlob(args, glob);
  }
}

function appendExcludeGlob(args: string[], glob: string): void {
  const normalized = normalizeExcludeGlobForSearch(glob);
  if (normalized) {
    args.push('--glob', `!${normalized}`);
  }
}
