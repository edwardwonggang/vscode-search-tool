import * as vscode from 'vscode';
import type { SearchSettings } from '../core/types';
import type { ResolvedSearchRepository, SearchRepository, WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { TranslationService } from '../i18n/TranslationService';
import type { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import type { RemoteGitRootGuard } from './RemoteGitRootGuard';

export type RemoteSearchPreflightSession = {
  isCurrent(token: number): boolean;
  postPhase(summary: string): void;
};

export class RemoteSearchPreflight {
  constructor(
    private readonly workspaceResolver: WorkspaceResolver,
    private readonly translationService: TranslationService,
    private readonly remoteGitRootGuard: RemoteGitRootGuard,
    private readonly session?: RemoteSearchPreflightSession
  ) {}

  public async prepare(
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    repositories: SearchRepository[],
    token: number,
    messageRouter: WebviewMessageRouter
  ): Promise<ResolvedSearchRepository[]> {
    this.session?.postPhase('Resolving remote search paths...');
    const resolvedRepositories = await this.workspaceResolver.resolveSearchRepositories(
      settings,
      workspaceFolder,
      repositories,
      await this.translationService.translate('err_remote_search_path_required')
    );
    if (!this.session?.isCurrent(token)) {
      return resolvedRepositories;
    }

    for (const repository of resolvedRepositories) {
      this.session?.postPhase(`Checking remote Git root: ${repository.remoteCwd}`);
      await this.remoteGitRootGuard.ensureGitRoot(settings, repository.remoteCwd, token);
      if (!this.session?.isCurrent(token)) {
        return resolvedRepositories;
      }
    }

    const message = resolvedRepositories.length === 1
      ? `Current SSH path: ${resolvedRepositories[0].remoteCwd}`
      : `Search repositories: ${resolvedRepositories.length}`;
    messageRouter.postConnectionResult({ ok: true, message, cwd: resolvedRepositories.map((repository) => repository.remoteCwd).join('\n') });
    return resolvedRepositories;
  }
}
