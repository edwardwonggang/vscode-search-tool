import * as vscode from 'vscode';
import { normalizeSearchPath } from '../core/glob';
import {
  inferRemoteWorkspacePath,
  isPosixAbsolutePath,
  normalizeRemotePath
} from '../core/paths';
import type { SearchSettings } from '../core/types';
import { joinFileWorkspaceFsPath, joinRemoteWorkspacePath } from './uriPaths';

export type WorkspaceInfo = {
  displayPath: string;
  gitRootOk: boolean;
  gitError?: string;
};

export type SearchTarget = {
  uri: vscode.Uri;
  uriString: string;
  legacyPath: string;
  relativePath: string;
};

export type WorkspaceResolverTranslations = {
  workspaceNone: string;
  gitRootRequired: string;
  remoteSearchPathRequired: string;
};

export class WorkspaceResolver {
  public async getWorkspaceInfo(translations: WorkspaceResolverTranslations): Promise<WorkspaceInfo> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return {
        displayPath: translations.workspaceNone,
        gitRootOk: false,
        gitError: translations.gitRootRequired
      };
    }

    const gitRootOk = await this.isWorkspaceGitRoot(workspaceFolder.uri);
    return {
      displayPath: formatWorkspaceDisplayPath(workspaceFolder.uri),
      gitRootOk,
      gitError: gitRootOk ? undefined : translations.gitRootRequired
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

  public createWorkspaceTarget(workspaceFolder: vscode.WorkspaceFolder, remoteRelativePath: string): SearchTarget {
    const relativePath = normalizeSearchPath(remoteRelativePath);
    const uri = joinWorkspaceUri(workspaceFolder.uri, relativePath);
    return {
      uri,
      uriString: uri.toString(),
      legacyPath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
      relativePath
    };
  }

  private async isWorkspaceGitRoot(workspaceUri: vscode.Uri): Promise<boolean> {
    try {
      const gitUri = vscode.Uri.joinPath(workspaceUri, '.git');
      await vscode.workspace.fs.stat(gitUri);
      return true;
    } catch {
      return false;
    }
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
