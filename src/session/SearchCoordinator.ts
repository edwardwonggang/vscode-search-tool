import * as vscode from 'vscode';
import type { SearchMatch, SearchOptions, SearchSettings } from '../core/types';
import { SearchResultStore } from '../search/SearchResultStore';
import { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import type { ConnectionController } from './ConnectionController';
import type { WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { TranslationService } from '../i18n/TranslationService';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import { SearchSession } from './SearchSession';
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
      if (plan.kind === 'search' && plan.mode === 'definition') {
        resolvedRepositories = await this.remoteSearchPreflight.prepareDefinitionRepositories(
          settings,
          workspaceFolder,
          repositories,
          token,
          messageRouter
        );
      } else {
        const searchRoot = await this.remoteSearchPreflight.prepareSearchRoot(settings, workspaceFolder, messageRouter, token);
        resolvedRepositories = [searchRoot];
      }
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

  /**
   * 右键“转到定义”使用的独立定义查找：隔离会话与结果存储，不干扰侧边栏搜索。
   * 返回跨 Git 根合并后的匹配，已应用定义搜索默认排除项。
   */
  public async lookupDefinitions(
    symbol: string,
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    repositories: SearchRepository[],
    onPhase?: (phase: string) => void
  ): Promise<SearchMatch[]> {
    const query = String(symbol).trim();
    if (!query || repositories.length === 0) {
      return [];
    }
    onPhase?.('Searching definitions…');

    const lookupStore = new SearchResultStore();
    const lookupSession = new SearchSession({
      refreshMs: 50,
      onStateChange: (state) => {
        if (onPhase && state.summary) {
          onPhase(state.summary);
        }
      },
      onResultsPush: () => undefined
    }, lookupStore);
    const token = lookupSession.begin();
    const silentRouter = new WebviewMessageRouter();
    // 定义搜索使用与 lookupSession 绑定的独立 preflight：复用它绑定主 session 的
    // preflight 时，postPhase 会走从未 begin 的主 session，elapsedMs 变成当前时间戳，
    // webview 计时器会用该值反推 startedAt 为 0 并持续累加显示。
    const lookupPreflight = new RemoteSearchPreflight(
      this.workspaceResolver,
      this.translationService,
      this.remoteGitRootGuard,
      lookupSession
    );
    const lookupDefinitionSearch = new DefinitionSearch(
      lookupSession,
      lookupStore,
      this.connectionController,
      this.workspaceResolver,
      this.translationService,
      this.remoteExecutor,
      this.remoteToolInstaller,
      this.logger,
      this.contentSearchConfig
    );

    try {
      const resolved = await lookupPreflight.prepareDefinitionRepositories(
        settings,
        workspaceFolder,
        repositories,
        token,
        silentRouter
      );
      const options: SearchOptions = {
        query,
        include: '',
        exclude: '',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        definitionMode: true,
        triggerSource: 'context-menu'
      };
      // 多 Git 根并行查找定义：每个仓库独立的探针+扫描共享同一 SSH 连接，
      // 总耗时从串行累加降为最慢仓库，避免多个根时跳转等待线性增长。
      await Promise.all(resolved.map((repository) => lookupDefinitionSearch.execute(
        token,
        options,
        settings,
        repository,
        silentRouter,
        true,
        Date.now()
      )));
    } catch (error) {
      this.logger.log(`lookup-definition error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return lookupStore.snapshot('content').items.flatMap((item) => item.matches);
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
      // 与右键“转到定义”一致：多 Git 根并行探针+扫描共享同一 SSH 连接，
      // 总耗时从串行累加降为最慢仓库。全部完成后统一收尾推送 summary。
      const results = await Promise.all(repositories.map((repository) => this.definitionSearch.execute(
        token,
        options,
        settings,
        repository,
        messageRouter,
        false,
        startedAt
      )));
      if (!this.session.isCurrent(token)) {
        return;
      }
      if (results.every(Boolean)) {
        await this.definitionSearch.finalizeSearch(startedAt);
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
