import * as vscode from 'vscode';
import type { SearchSettings } from '../core/types';
import type { WorkspaceResolver } from '../workspace/WorkspaceResolver';
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
    token: number,
    messageRouter: WebviewMessageRouter
  ): Promise<string> {
    this.session?.postPhase('Resolving remote search path...');
    const remoteCwd = await this.workspaceResolver.resolveRemoteCwd(
      settings,
      workspaceFolder,
      await this.translationService.translate('err_remote_search_path_required')
    );
    if (!this.session?.isCurrent(token)) {
      return remoteCwd;
    }
    this.session?.postPhase(`Checking remote Git root: ${remoteCwd}`);
    await this.remoteGitRootGuard.ensureGitRoot(settings, remoteCwd, token);
    if (!this.session?.isCurrent(token)) {
      return remoteCwd;
    }
    messageRouter.postConnectionResult({ ok: true, message: `Current SSH path: ${remoteCwd}`, cwd: remoteCwd });
    return remoteCwd;
  }
}
