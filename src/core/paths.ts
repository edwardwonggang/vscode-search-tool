import * as path from 'path';
import * as posixPath from 'path/posix';
import { REMOTE_HOME_ROOT } from './defaults';
import { normalizeSearchPath } from './glob';

export function inferRemoteWorkspacePath(localWorkspacePath: string, remoteUsername: string): string | undefined {
  return inferRemotePathFromUnc(localWorkspacePath) ?? inferRemotePathFromDrive(localWorkspacePath, remoteUsername);
}

export function inferRemotePathFromUnc(localWorkspacePath: string): string | undefined {
  const normalized = String(localWorkspacePath).trim().replace(/\\/gu, '/');
  if (!normalized.startsWith('//')) {
    return undefined;
  }

  const parts = normalized.replace(/^\/+/u, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  const shareName = parts[1] ?? '';
  return buildRemoteHomePath(shareName, parts.slice(2).join('/'));
}

export function inferRemotePathFromDrive(localWorkspacePath: string, remoteUsername: string): string | undefined {
  const match = /^([a-zA-Z]):[\\/]*(.*)$/u.exec(String(localWorkspacePath).trim());
  if (!match) {
    return undefined;
  }

  return buildRemoteHomePath(remoteUsername, match[2] ?? '');
}

export function buildRemoteHomePath(userName: string, relativePath: string): string | undefined {
  const normalizedUserName = normalizeSearchPath(userName);
  if (!normalizedUserName || normalizedUserName.includes('/')) {
    return undefined;
  }

  const homePath = posixPath.join(REMOTE_HOME_ROOT, normalizedUserName);
  const normalizedRelativePath = normalizeSearchPath(relativePath);
  return normalizedRelativePath ? posixPath.join(homePath, normalizedRelativePath) : homePath;
}

export function getRelativeRemotePath(remotePath: string, remoteBase: string): string | undefined {
  const normalizedPath = normalizeRemotePath(remotePath);
  const normalizedBase = normalizeRemotePath(remoteBase);
  if (!normalizedPath || !normalizedBase) {
    return undefined;
  }
  if (normalizedPath === normalizedBase) {
    return '';
  }
  if (!normalizedPath.startsWith(`${normalizedBase}/`)) {
    return undefined;
  }
  return normalizedPath.slice(normalizedBase.length + 1);
}

export function normalizeRemotePath(value: string): string {
  return String(value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/u, '');
}

export function isPosixAbsolutePath(value: string): boolean {
  return value.replace(/\\/g, '/').startsWith('/');
}

export function normalizeLocalPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

export function joinFileWorkspacePath(workspaceFsPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeSearchPath(relativePath);
  return path.join(workspaceFsPath, normalizedRelativePath.replace(/\//gu, path.sep));
}
