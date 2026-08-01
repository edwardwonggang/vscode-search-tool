import * as posixPath from 'path/posix';
import { shellEscape } from '../core/shell';

export const TAGS_FILE_NAME = 'tags';
export const TAGS_TMP_FILE_NAME = 'tags.tmp';
export const TAGS_META_FILE_NAME = 'tags.meta.json';
export const TAG_INDEX_SCHEMA_VERSION = 1;
export const TAG_INDEX_CTAGS_ARGS_KEY = '--tag-relative=yes --fields=+n --c-kinds=+defgmpstuv --c++-kinds=+cdefgmpstuv --exclude=tags --exclude=tags.tmp --exclude=tags.meta.json';
export const DEFAULT_TAG_AUTO_REFRESH_MINUTES = 30;

export const CTAGS_EXCLUDE_PATTERNS = [
  '*.a',
  '*.bin',
  '*.bmp',
  '*.bz2',
  '*.dll',
  '*.elf',
  '*.exe',
  '*.gif',
  '*.gz',
  '*.hex',
  '*.iso',
  '*.jpg',
  '*.jpeg',
  '*.lib',
  '*.o',
  '*.obj',
  '*.pdf',
  '*.png',
  '*.so',
  '*.tar',
  '*.tgz',
  '*.zip',
  '*.7z',
  'node_modules'
] as const;

export type TagIndexPaths = {
  tagsDir: string;
  tagsPath: string;
  tmpPath: string;
  metaPath: string;
};

export type TagIndexMeta = {
  schemaVersion: number;
  gitTop: string;
  gitHead: string;
  ctagsVersion: string;
  ctagsArgsKey: string;
  builtAtMs: number;
};

export type TagIndexRefreshInput = {
  tagsExists: boolean;
  meta?: TagIndexMeta;
  gitTop: string;
  gitHead: string;
  ctagsVersion: string;
  ctagsArgsKey: string;
  refreshIntervalMs: number;
  nowMs: number;
};

export type TagIndexRefreshDecision = {
  refresh: boolean;
  reason: string;
};

export function getTagIndexPaths(gitTop: string): TagIndexPaths {
  const tagsDir = gitTop.replace(/\/+$/u, '');
  return {
    tagsDir,
    tagsPath: posixPath.join(tagsDir, TAGS_FILE_NAME),
    tmpPath: posixPath.join(tagsDir, TAGS_TMP_FILE_NAME),
    metaPath: posixPath.join(tagsDir, TAGS_META_FILE_NAME)
  };
}

export function createTagIndexMeta(input: Omit<TagIndexMeta, 'schemaVersion' | 'builtAtMs'>, nowMs = Date.now()): TagIndexMeta {
  return {
    schemaVersion: TAG_INDEX_SCHEMA_VERSION,
    gitTop: input.gitTop,
    gitHead: input.gitHead,
    ctagsVersion: input.ctagsVersion,
    ctagsArgsKey: input.ctagsArgsKey,
    builtAtMs: nowMs
  };
}

export function parseTagIndexMeta(text: string): TagIndexMeta | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<TagIndexMeta>;
    if (
      typeof parsed.schemaVersion !== 'number' ||
      typeof parsed.gitTop !== 'string' ||
      typeof parsed.gitHead !== 'string' ||
      typeof parsed.ctagsVersion !== 'string' ||
      typeof parsed.ctagsArgsKey !== 'string' ||
      typeof parsed.builtAtMs !== 'number'
    ) {
      return undefined;
    }
    return {
      schemaVersion: parsed.schemaVersion,
      gitTop: parsed.gitTop,
      gitHead: parsed.gitHead,
      ctagsVersion: parsed.ctagsVersion,
      ctagsArgsKey: parsed.ctagsArgsKey,
      builtAtMs: parsed.builtAtMs
    };
  } catch {
    return undefined;
  }
}

export function decideTagIndexRefresh(input: TagIndexRefreshInput): TagIndexRefreshDecision {
  if (!input.tagsExists) {
    return { refresh: false, reason: 'tags-missing' };
  }
  if (!input.meta) {
    return { refresh: true, reason: 'meta-missing' };
  }
  if (input.meta.schemaVersion !== TAG_INDEX_SCHEMA_VERSION) {
    return { refresh: true, reason: 'schema-changed' };
  }
  if (input.meta.gitTop !== input.gitTop) {
    return { refresh: true, reason: 'git-root-changed' };
  }
  if (input.meta.gitHead !== input.gitHead) {
    return { refresh: true, reason: 'git-head-changed' };
  }
  if (input.meta.ctagsVersion !== input.ctagsVersion) {
    return { refresh: true, reason: 'ctags-version-changed' };
  }
  if (input.meta.ctagsArgsKey !== input.ctagsArgsKey) {
    return { refresh: true, reason: 'ctags-args-changed' };
  }
  if (input.refreshIntervalMs > 0 && input.nowMs - input.meta.builtAtMs >= input.refreshIntervalMs) {
    return { refresh: true, reason: 'refresh-interval' };
  }
  return { refresh: false, reason: 'fresh' };
}

export function buildGitHeadCommand(gitTop: string): string {
  return `cd ${shellEscape(gitTop)} && git rev-parse HEAD`;
}

export function buildReadTagIndexMetaCommand(metaPath: string): string {
  return `if test -f ${shellEscape(metaPath)}; then cat ${shellEscape(metaPath)}; fi`;
}

export function buildCtagsRebuildCommand(ctagsPath: string, gitTop: string, paths: TagIndexPaths, meta: TagIndexMeta): string {
  const excludes = [
    ...CTAGS_EXCLUDE_PATTERNS,
    TAGS_FILE_NAME,
    TAGS_TMP_FILE_NAME,
    TAGS_META_FILE_NAME
  ].map((pattern) => `--exclude=${shellEscape(pattern)}`).join(' ');
  const metaJson = JSON.stringify(meta);
  return [
    `cd ${shellEscape(gitTop)}`,
    `rm -f ${shellEscape(paths.tmpPath)}`,
    `${shellEscape(ctagsPath)} -R -f ${shellEscape(paths.tmpPath)} --tag-relative=yes --fields=+n --c-kinds=+defgmpstuv --c++-kinds=+cdefgmpstuv ${excludes} .`,
    `mv -f ${shellEscape(paths.tmpPath)} ${shellEscape(paths.tagsPath)}`,
    `printf %s ${shellEscape(metaJson)} > ${shellEscape(paths.metaPath)}`
  ].join(' && ');
}
