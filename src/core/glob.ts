import type { SearchOptions, SearchSettings } from './types';

export function splitUserGlobs(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createResultPathFilter(
  options: SearchOptions,
  settings: SearchSettings
): (relativePath: string) => boolean {
  const settingsIncludeGlobs = settings.includeGlobs;
  const userIncludeGlobs = splitUserGlobs(options.include);
  const excludeGlobs = [...settings.excludeGlobs, ...splitUserGlobs(options.exclude)];

  return (relativePath: string): boolean => {
    const normalizedPath = normalizeSearchPath(relativePath);
    const matchesSettingsInclude =
      settingsIncludeGlobs.length === 0 || settingsIncludeGlobs.some((glob) => matchSearchGlob(normalizedPath, glob));
    if (!matchesSettingsInclude) {
      return false;
    }
    const matchesUserInclude =
      userIncludeGlobs.length === 0 || userIncludeGlobs.some((glob) => matchSearchGlob(normalizedPath, glob));
    if (!matchesUserInclude) {
      return false;
    }
    return !excludeGlobs.some((glob) => matchSearchGlob(normalizedPath, glob));
  };
}

export function createFileQueryMatcher(query: string, caseSensitive: boolean): (relativePath: string) => boolean {
  const normalizedQuery = normalizeFileNameQuery(query);
  if (!normalizedQuery) {
    return () => true;
  }

  const needle = caseSensitive ? normalizedQuery : normalizedQuery.toLowerCase();
  return (relativePath: string): boolean => {
    const baseName = getBaseName(relativePath);
    const haystack = caseSensitive ? baseName : baseName.toLowerCase();
    return haystack.includes(needle);
  };
}

export function normalizeFileNameQuery(query: string): string {
  const normalized = normalizeSearchPath(query);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function getBaseName(relativePath: string): string {
  const normalizedPath = normalizeSearchPath(relativePath);
  return normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
}

export function matchSearchGlob(relativePath: string, glob: string): boolean {
  const normalizedPath = normalizeSearchPath(relativePath);
  const normalizedGlob = normalizeSearchPath(glob);
  if (!normalizedPath || !normalizedGlob) {
    return false;
  }

  if (!normalizedGlob.includes('/')) {
    const segmentRegex = globSegmentToRegex(normalizedGlob);
    return normalizedPath.split('/').some((segment) => segmentRegex.test(segment));
  }

  if (!/[?*\[]/.test(normalizedGlob)) {
    return normalizedPath === normalizedGlob || normalizedPath.startsWith(`${normalizedGlob}/`);
  }

  return globPathToRegex(normalizedGlob).test(normalizedPath);
}

export function normalizeSearchPath(value: string): string {
  return String(value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function globSegmentToRegex(glob: string): RegExp {
  return new RegExp(`^${globToRegexSource(glob, false)}$`, 'i');
}

function globPathToRegex(glob: string): RegExp {
  return new RegExp(`^${globToRegexSource(glob, true)}$`, 'i');
}

function globToRegexSource(glob: string, allowPathSeparator: boolean): string {
  let result = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];

    if (char === '*') {
      if (allowPathSeparator && next === '*') {
        const afterNext = glob[index + 2];
        if (afterNext === '/') {
          result += '(?:.*/)?';
          index += 2;
          continue;
        }
        result += '.*';
        index += 1;
        continue;
      }
      result += allowPathSeparator ? '[^/]*' : '.*';
      continue;
    }

    if (char === '?') {
      result += allowPathSeparator ? '[^/]' : '.';
      continue;
    }

    if (char === '[') {
      const closing = glob.indexOf(']', index + 1);
      if (closing > index + 1) {
        result += glob.slice(index, closing + 1);
        index = closing;
        continue;
      }
    }

    result += escapeRegExpString(char);
  }
  return result;
}

export function escapeRegExpString(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
