import { DEFAULT_EXCLUDE_GLOBS, DEFAULT_INCLUDE_GLOBS, DEFAULT_REMOTE_PORT } from './defaults';
import { normalizeSettings } from './settings';
import type { SearchSettings } from './types';

export type SettingsStorage = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
};

export type SshSettings = {
  remoteHost: string;
  remotePort: number;
  remoteUsername: string;
  remotePassword: string;
};

export type ProjectSettings = {
  remoteSearchPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
};

export const SSH_SETTINGS_KEY = 'ripgrepTool.sshSettings';
export const PROJECT_SETTINGS_PREFIX = 'ripgrepTool.projectSettings.';
export const LEGACY_SETTINGS_KEY = 'ripgrepTool.searchSettings';

export function createProjectSettingsKey(remotePath: string): string {
  const normalized = String(remotePath).trim().replace(/\/+$/u, '');
  if (!normalized) {
    throw new Error('Remote project path is required.');
  }
  return `${PROJECT_SETTINGS_PREFIX}${encodeURIComponent(normalized)}`;
}

function normalizePort(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_REMOTE_PORT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REMOTE_PORT;
}

function normalizeProjectGlobs(value?: ProjectSettings): { includeGlobs: string[]; excludeGlobs: string[] } {
  const normalized = normalizeSettings({
    remoteHost: '',
    remotePort: DEFAULT_REMOTE_PORT,
    remoteUsername: '',
    remotePassword: '',
    remoteSearchPath: '',
    includeGlobs: value?.includeGlobs ?? DEFAULT_INCLUDE_GLOBS,
    excludeGlobs: value?.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS
  });
  return {
    includeGlobs: normalized.includeGlobs,
    excludeGlobs: normalized.excludeGlobs
  };
}

/**
 * 设置存储：SSH 连接配置全局一份，远端路径与过滤配置按规范化远端项目路径隔离保存。
 */
export class SettingsStore {
  constructor(private readonly storage: SettingsStorage) {}

  public getSshSettings(): SshSettings {
    const saved = this.storage.get<SshSettings>(SSH_SETTINGS_KEY);
    const legacy = this.storage.get<SearchSettings>(LEGACY_SETTINGS_KEY);
    return {
      remoteHost: String(saved?.remoteHost ?? legacy?.remoteHost ?? '').trim(),
      remotePort: normalizePort(saved?.remotePort ?? legacy?.remotePort),
      remoteUsername: String(saved?.remoteUsername ?? legacy?.remoteUsername ?? '').trim(),
      remotePassword: String(saved?.remotePassword ?? legacy?.remotePassword ?? '')
    };
  }

  public async saveSshSettings(settings: SshSettings): Promise<void> {
    await this.storage.update(SSH_SETTINGS_KEY, {
      remoteHost: String(settings.remoteHost).trim(),
      remotePort: normalizePort(settings.remotePort),
      remoteUsername: String(settings.remoteUsername).trim(),
      remotePassword: String(settings.remotePassword)
    });
  }

  public getProjectSettings(remotePath: string): ProjectSettings {
    const key = createProjectSettingsKey(remotePath);
    const saved = this.storage.get<ProjectSettings>(key);
    const legacy = this.storage.get<SearchSettings>(LEGACY_SETTINGS_KEY);
    const globs = normalizeProjectGlobs(saved ?? legacy);
    return {
      remoteSearchPath: String(saved?.remoteSearchPath ?? legacy?.remoteSearchPath ?? '').trim(),
      ...globs
    };
  }

  public async saveProjectSettings(remotePath: string, settings: ProjectSettings): Promise<void> {
    const key = createProjectSettingsKey(remotePath);
    await this.storage.update(key, {
      remoteSearchPath: String(settings.remoteSearchPath).trim(),
      includeGlobs: settings.includeGlobs,
      excludeGlobs: settings.excludeGlobs
    });
  }
}
