import { DEFAULT_EXCLUDE_GLOBS, DEFAULT_INCLUDE_GLOBS, DEFAULT_REMOTE_PORT } from './defaults';
import type { SearchSettings } from './types';

const SOURCE_BEARING_DIR_NAMES = new Set(['lib', 'libs', 'vendor', 'build', 'out', 'dist', 'bin', 'obj']);

export function normalizeSettings(value?: SearchSettings): SearchSettings {
  const remoteHost = String(value?.remoteHost ?? '').trim();
  const remotePortValue = Number(value?.remotePort ?? DEFAULT_REMOTE_PORT);
  const remotePort = Number.isFinite(remotePortValue) && remotePortValue > 0 ? remotePortValue : DEFAULT_REMOTE_PORT;
  const remoteUsername = String(value?.remoteUsername ?? '').trim();
  const remotePassword = String(value?.remotePassword ?? '');
  const remoteSearchPath = String(value?.remoteSearchPath ?? '').trim();
  const includeGlobs = Array.isArray(value?.includeGlobs) ? value.includeGlobs : DEFAULT_INCLUDE_GLOBS;
  const excludeGlobs = Array.isArray(value?.excludeGlobs) ? value.excludeGlobs : DEFAULT_EXCLUDE_GLOBS;

  return {
    remoteHost,
    remotePort,
    remoteUsername,
    remotePassword,
    remoteSearchPath,
    includeGlobs: normalizeGlobList(includeGlobs, DEFAULT_INCLUDE_GLOBS),
    excludeGlobs: removeSourceBearingDirectoryExcludes(normalizeGlobList(excludeGlobs, DEFAULT_EXCLUDE_GLOBS))
  };
}

export function normalizeGlobList(values: string[], fallback: string[]): string[] {
  const normalized = values
    .map((item) => String(item).trim())
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : [...fallback];
}

function removeSourceBearingDirectoryExcludes(values: string[]): string[] {
  return values.filter((glob) => !isSourceBearingDirectoryExclude(glob));
}

function isSourceBearingDirectoryExclude(glob: string): boolean {
  const normalized = glob
    .trim()
    .replace(/\\/g, '/')
    .replace(/^!+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  const parts = normalized.split('/').filter((part) => part && part !== '**' && part !== '*');
  return parts.some((part) => SOURCE_BEARING_DIR_NAMES.has(part));
}
