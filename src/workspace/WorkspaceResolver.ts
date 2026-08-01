import { promises as nodeFs, type Dirent, type Stats } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeSearchPath } from '../core/glob';
import {
  inferRemoteWorkspacePath,
  isPosixAbsolutePath,
  normalizeRemotePath,
  joinRemotePath
} from '../core/paths';
import type { SearchSettings } from '../core/types';
import { joinFileWorkspaceFsPath, joinRemoteWorkspacePath } from './uriPaths';
import {
  MAX_GIT_DISCOVERY_DEPTH,
  discoverGitRepositories,
  isGitFileMarkerText,
  isDirectoryFileType,
  type DiscoveredGitRepository
} from './gitDiscovery';

export type WorkspaceInfo = {
  displayPath: string;
  gitRootOk: boolean;
  gitError?: string;
  repositories: SearchRepository[];
};

export type SearchRepository = {
  name: string;
  workspaceRelativePath: string;
  localUri: vscode.Uri;
  displayPath: string;
};

export type SearchTarget = {
  uri: vscode.Uri;
  uriString: string;
  legacyPath: string;
  relativePath: string;
  repositoryRelativePath?: string;
};

export type ResolvedSearchRepository = SearchRepository & {
  remoteCwd: string;
};

export type WorkspaceResolverTranslations = {
  workspaceNone: string;
  gitRootRequired: string;
  remoteSearchPathRequired: string;
};

export class WorkspaceResolver {
  public static readonly maxGitDiscoveryDepth = MAX_GIT_DISCOVERY_DEPTH;

  public async getWorkspaceInfo(translations: WorkspaceResolverTranslations): Promise<WorkspaceInfo> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return {
        displayPath: translations.workspaceNone,
        gitRootOk: false,
        gitError: translations.gitRootRequired,
        repositories: []
      };
    }

    const repositories = await this.discoverGitRepositories(workspaceFolder.uri);
    const gitRootOk = repositories.length > 0;
    return {
      displayPath: formatWorkspaceDisplayPath(workspaceFolder.uri),
      gitRootOk,
      gitError: gitRootOk ? undefined : translations.gitRootRequired,
      repositories
    };
  }

  public async resolveRemoteCwd(
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    remoteSearchPathRequiredMessage: string
  ): Promise<string> {
    const userConfiguredPath = settings.remoteSearchPath.trim();
    if (userConfiguredPath) {
      return normalizeRemotePath(userConfiguredPath);
    }
    if (workspaceFolder.uri.scheme === 'vscode-remote' && workspaceFolder.uri.path) {
      return normalizeRemotePath(workspaceFolder.uri.path);
    }
    if (vscode.env.remoteName && isPosixAbsolutePath(workspaceFolder.uri.fsPath)) {
      return normalizeRemotePath(workspaceFolder.uri.fsPath);
    }

    const inferredPath = inferRemoteWorkspacePath(workspaceFolder.uri.fsPath, settings.remoteUsername);
    if (inferredPath) {
      return inferredPath;
    }

    throw new Error(remoteSearchPathRequiredMessage);
  }

  public async resolveSearchRepositories(
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    repositories: SearchRepository[],
    remoteSearchPathRequiredMessage: string
  ): Promise<ResolvedSearchRepository[]> {
    const remoteWorkspaceRoot = await this.resolveRemoteCwd(settings, workspaceFolder, remoteSearchPathRequiredMessage);
    return repositories.map((repository) => ({
      ...repository,
      remoteCwd: repository.workspaceRelativePath
        ? joinRemotePath(remoteWorkspaceRoot, repository.workspaceRelativePath)
        : remoteWorkspaceRoot
    }));
  }

  public createWorkspaceTarget(repository: SearchRepository, remoteRelativePath: string): SearchTarget {
    const relativePath = normalizeSearchPath(remoteRelativePath);
    const uri = joinWorkspaceUri(repository.localUri, relativePath);
    const displayRelativePath = repository.workspaceRelativePath
      ? normalizeSearchPath(`${repository.workspaceRelativePath}/${relativePath}`)
      : relativePath;
    return {
      uri,
      uriString: uri.toString(),
      legacyPath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
      relativePath: displayRelativePath,
      repositoryRelativePath: relativePath
    };
  }

  public async discoverGitRepositories(
    workspaceUri: vscode.Uri,
    maxDepth = WorkspaceResolver.maxGitDiscoveryDepth
  ): Promise<SearchRepository[]> {
    const discovered = await discoverGitRepositories({
      isGitRepository: async (relativePath) => await this.isGitRepository(workspaceUri, relativePath),
      readDirectory: async (relativePath) => await this.readDiscoveryDirectory(workspaceUri, relativePath)
    }, maxDepth);
    return discovered.map((repository) => this.toSearchRepository(workspaceUri, repository));
  }

  private async isGitRepository(workspaceUri: vscode.Uri, relativePath: string): Promise<boolean> {
    const repositoryUri = joinWorkspaceUri(workspaceUri, relativePath);
    if (repositoryUri.scheme === 'file') {
      return isLocalGitRepository(repositoryUri.fsPath);
    }
    return this.isWorkspaceFsGitRepository(repositoryUri);
  }

  private async isWorkspaceFsGitRepository(repositoryUri: vscode.Uri): Promise<boolean> {
    const gitUri = vscode.Uri.joinPath(repositoryUri, '.git');
    try {
      const stat = await vscode.workspace.fs.stat(gitUri);
      if (isDirectoryFileType(stat.type, vscode.FileType.Directory)) {
        return await this.hasWorkspaceGitDirectoryShape(gitUri);
      }
      if (isDirectoryFileType(stat.type, vscode.FileType.File)) {
        const marker = await vscode.workspace.fs.readFile(gitUri);
        return isGitFileMarkerText(Buffer.from(marker).toString('utf8'));
      }
      return false;
    } catch {
      return false;
    }
  }

  private async hasWorkspaceGitDirectoryShape(gitUri: vscode.Uri): Promise<boolean> {
    const hasHead = await this.workspacePathExists(vscode.Uri.joinPath(gitUri, 'HEAD'));
    const hasObjects = await this.workspacePathExists(vscode.Uri.joinPath(gitUri, 'objects'));
    const hasRefs = await this.workspacePathExists(vscode.Uri.joinPath(gitUri, 'refs'));
    return hasHead && (hasObjects || hasRefs);
  }

  private async workspacePathExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async readDiscoveryDirectory(workspaceUri: vscode.Uri, relativePath: string) {
    const directoryUri = joinWorkspaceUri(workspaceUri, relativePath);
    if (directoryUri.scheme === 'file') {
      return readLocalDiscoveryDirectory(directoryUri.fsPath);
    }
    const entries = await vscode.workspace.fs.readDirectory(directoryUri);
    return entries.map(([name, fileType]) => ({
      name,
      isDirectory: isDirectoryFileType(fileType, vscode.FileType.Directory)
    }));
  }

  private toSearchRepository(workspaceUri: vscode.Uri, repository: DiscoveredGitRepository): SearchRepository {
    const localUri = joinWorkspaceUri(workspaceUri, repository.workspaceRelativePath);
    return {
      name: repository.name || formatWorkspaceDisplayPath(workspaceUri),
      workspaceRelativePath: repository.workspaceRelativePath,
      localUri,
      displayPath: formatWorkspaceDisplayPath(localUri)
    };
  }
}

async function isLocalGitRepository(repositoryFsPath: string): Promise<boolean> {
  const gitPath = path.join(repositoryFsPath, '.git');
  const stat = await statLocalPath(gitPath);
  if (!stat) {
    return false;
  }
  if (stat.isDirectory()) {
    return await hasLocalGitDirectoryShape(gitPath);
  }
  if (stat.isFile()) {
    const marker = await nodeFs.readFile(gitPath, 'utf8').catch(() => '');
    return isGitFileMarkerText(marker);
  }
  return false;
}

async function hasLocalGitDirectoryShape(gitPath: string): Promise<boolean> {
  const hasHead = await localPathExists(path.join(gitPath, 'HEAD'));
  const hasObjects = await localPathExists(path.join(gitPath, 'objects'));
  const hasRefs = await localPathExists(path.join(gitPath, 'refs'));
  return hasHead && (hasObjects || hasRefs);
}

async function readLocalDiscoveryDirectory(fsPath: string) {
  const entries = await nodeFs.readdir(fsPath, { withFileTypes: true });
  return await Promise.all(entries.map(async (entry) => ({
    name: entry.name,
    isDirectory: await isLocalDirectoryEntry(fsPath, entry)
  })));
}

async function isLocalDirectoryEntry(parentPath: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  const stat = await statLocalPath(path.join(parentPath, entry.name));
  return stat?.isDirectory() ?? false;
}

async function localPathExists(fsPath: string): Promise<boolean> {
  return (await statLocalPath(fsPath)) !== undefined;
}

async function statLocalPath(fsPath: string): Promise<Stats | undefined> {
  try {
    return await nodeFs.stat(fsPath);
  } catch {
    return undefined;
  }
}

export function formatWorkspaceDisplayPath(uri: vscode.Uri): string {
  if (uri.scheme === 'file') {
    return uri.fsPath;
  }
  if ((uri.scheme === 'vscode-remote' || vscode.env.remoteName) && uri.path) {
    return uri.path;
  }
  return uri.toString();
}

export function joinWorkspaceUri(workspaceUri: vscode.Uri, relativePath: string): vscode.Uri {
  const normalizedRelativePath = normalizeSearchPath(relativePath);
  if (workspaceUri.scheme === 'file') {
    return vscode.Uri.file(joinFileWorkspaceFsPath(workspaceUri.fsPath, normalizedRelativePath));
  }

  return workspaceUri.with({
    path: joinRemoteWorkspacePath(workspaceUri.path, normalizedRelativePath)
  });
}
