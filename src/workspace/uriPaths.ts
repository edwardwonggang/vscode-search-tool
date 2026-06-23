import * as path from 'path';
import { normalizeSearchPath } from '../core/glob';

export function joinFileWorkspaceFsPath(workspaceFsPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeSearchPath(relativePath);
  return path.join(workspaceFsPath, normalizedRelativePath.replace(/\//gu, path.sep));
}

export function joinRemoteWorkspacePath(workspacePath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeSearchPath(relativePath);
  const normalizedWorkspacePath = workspacePath.replace(/\/+$/u, '');
  return normalizedRelativePath ? `${normalizedWorkspacePath}/${normalizedRelativePath}` : normalizedWorkspacePath;
}
