import { splitUserGlobs } from '../core/glob';
import type { SearchOptions, SearchSettings } from '../core/types';

export type ContentSearchArgOptions = {
  contextLines: number;
  threads: number;
};

export function buildContentSearchArgs(
  options: SearchOptions,
  settings: SearchSettings,
  argOptions: ContentSearchArgOptions
): string[] {
  const args = ['--json', '--line-buffered', '--line-number', '--column', '--hidden'];

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

  appendSettingsGlobs(args, settings);
  appendUserExcludeGlobs(args, options.exclude);
  args.push(options.query);
  args.push('.');
  return args;
}

export function buildFileSearchArgs(options: SearchOptions, settings: SearchSettings): string[] {
  const args = ['--files', '--line-buffered', '--hidden'];
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
    args.push('--glob', `!${glob}`);
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
    args.push('--glob', `!${glob}`);
  }
}
