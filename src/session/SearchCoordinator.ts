import * as vscode from 'vscode';
import type { SearchOptions, SearchSettings } from '../core/types';
import type { SearchResultStore } from '../search/SearchResultStore';
import type { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import type { ConnectionController } from './ConnectionController';
import type { WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { TranslationService } from '../i18n/TranslationService';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import type { SearchSession } from './SearchSession';
import type { SessionLogger } from './SessionLogger';
import { ContentSearchRunner, type ContentSearchConfig } from './ContentSearchRunner';
import { FileSearchRunner, type FileSearchConfig } from './FileSearchRunner';
import { DefinitionSearch } from '../definition/DefinitionSearch';
import { TagsRebuild } from '../definition/TagsRebuild';
import { RemoteGitRootGuard } from './RemoteGitRootGuard';
import { RemoteSearchPreflight } from './RemoteSearchPreflight';
import { planSearchRequest, type SearchRequestPlan } from './SearchRequestPlan';
import type { ResolvedSearchRepository, SearchRepository } from '../workspace/WorkspaceResolver';

export class SearchCoordinator {
  private readonly contentSearchRunner: ContentSearchRunner;
  private readonly fileSearchRunner: FileSearchRunner;
  private readonly definitionSearch: DefinitionSearch;
  private readonly tagsRebuild: TagsRebuild;
  private readonly remoteGitRootGuard: RemoteGitRootGuard;
  private readonly remoteSearchPreflight: RemoteSearchPreflight;

  constructor(
    private readonly session: SearchSession,
    private readonly resultStore: SearchResultStore,
    private readonly connectionController: ConnectionController,
    private readonly workspaceResolver: WorkspaceResolver,
    private readonly translationService: TranslationService,
    private readonly remoteExecutor: RemoteExecutor,
    private readonly remoteToolInstaller: RemoteToolInstaller,
    private readonly logger: SessionLogger,
    private readonly contentSearchConfig: ContentSearchConfig,
    private readonly fileSearchConfig: FileSearchConfig
  ) {
    this.contentSearchRunner = new ContentSearchRunner(
      session,
      resultStore,
      connectionController,
      workspaceResolver,
      remoteExecutor,
      remoteToolInstaller,
      logger,
      contentSearchConfig
    );

    this.fileSearchRunner = new FileSearchRunner(
      session,
      resultStore,
      connectionController,
      workspaceResolver,
      remoteExecutor,
      remoteToolInstaller,
      logger,
      fileSearchConfig
    );

    this.definitionSearch = new DefinitionSearch(
      session,
      resultStore,
      connectionController,
      workspaceResolver,
      translationService,
      remoteExecutor,
      remoteToolInstaller,
      logger,
      contentSearchConfig
    );

    this.tagsRebuild = new TagsRebuild(
      session,
      connectionController,
      workspaceResolver,
      translationService,
      remoteExecutor,
      remoteToolInstaller,
      logger
    );

    this.remoteGitRootGuard = new RemoteGitRootGuard(
      connectionController,
      remoteExecutor,
      translationService,
      session
    );
    this.remoteSearchPreflight = new RemoteSearchPreflight(
      workspaceResolver,
      translationService,
      this.remoteGitRootGuard,
      session
    );
  }

  public async executeSearch(
    options: SearchOptions,
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    repositories: SearchRepository[],
    messageRouter: WebviewMessageRouter
  ): Promise<void> {
    const plan = planSearchRequest(options);
    if (plan.kind === 'empty') {
      this.clearSearchResults(messageRouter, options.requestId);
      return;
    }

    if (!this.connectionController.isRemoteSearchConfigured(settings)) {
      messageRouter.postState({
        type: 'state',
        requestId: options.requestId,
        running: false,
        error: 'Remote search is required. Configure SSH host, username, and password in Settings.'
      });
      return;
    }

    const requestId = options.requestId;
    const token = this.session.begin(requestId);
    this.resultStore.clear();
    messageRouter.postResults(plan.mode === 'file' ? 'file' : 'content', [], true, requestId);
    this.session.postPhase('Preparing remote search...');

    let resolvedRepositories: ResolvedSearchRepository[];
    try {
      resolvedRepositories = await this.remoteSearchPreflight.prepare(settings, workspaceFolder, repositories, token, messageRouter);
    } catch (error) {
      messageRouter.postState({
        type: 'state',
        requestId: options.requestId,
        running: false,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    await this.executePlannedSearch(plan, token, options, settings, resolvedRepositories, messageRouter);
  }

  public async executeRebuildTags(
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    repositories: SearchRepository[],
    messageRouter: WebviewMessageRouter
  ): Promise<void> {
    await this.tagsRebuild.execute(settings, workspaceFolder, repositories, messageRouter);
  }

  private clearSearchResults(messageRouter: WebviewMessageRouter, requestId?: number): void {
    this.session.begin(requestId);
    this.resultStore.clear();
    messageRouter.postResults('content', [], true, requestId);
    this.session.postState({ type: 'state', running: false, summary: '' });
  }

  private async executePlannedSearch(
    plan: Extract<SearchRequestPlan, { kind: 'search' }>,
    token: number,
    options: SearchOptions,
    settings: SearchSettings,
    repositories: ResolvedSearchRepository[],
    messageRouter: WebviewMessageRouter
  ): Promise<void> {
    const startedAt = Date.now();
    if (plan.mode === 'file') {
      for (let index = 0; index < repositories.length; index += 1) {
        if (!this.session.isCurrent(token)) {
          return;
        }
        const ok = await this.fileSearchRunner.execute(
          token,
          plan.fileQuery,
          options,
          settings,
          repositories[index],
          messageRouter,
          index === repositories.length - 1,
          startedAt
        );
        if (!ok) {
          return;
        }
      }
      return;
    }

    if (plan.mode === 'definition') {
      this.logger.log(`search#${token} definition-mode query="${plan.query}"`);
      for (let index = 0; index < repositories.length; index += 1) {
        if (!this.session.isCurrent(token)) {
          return;
        }
        const ok = await this.definitionSearch.execute(
          token,
          options,
          settings,
          repositories[index],
          messageRouter,
          index === repositories.length - 1,
          startedAt
        );
        if (!ok) {
          return;
        }
      }
      this.logger.log(`search#${token} definition-search completed`);
      return;
    }

    for (let index = 0; index < repositories.length; index += 1) {
      if (!this.session.isCurrent(token)) {
        return;
      }
      const ok = await this.contentSearchRunner.execute(
        token,
        options,
        settings,
        repositories[index],
        messageRouter,
        index === repositories.length - 1,
        startedAt
      );
      if (!ok) {
        return;
      }
    }
  }
}
