import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { ExtensionLogger } from '../logging/ExtensionLogger';
import { TranslationService } from '../i18n/TranslationService';
import { SettingsStore } from '../core/SettingsStore';
import { SshClientManager } from '../remote/SshClientManager';
import { RemoteExecutor } from '../remote/RemoteExecutor';
import { RemoteToolInstaller, bundledLinuxRgPath } from '../remote/RemoteToolInstaller';
import { DEFAULT_DEFINITION_EXCLUDE_GLOBS } from '../core/defaults';
import { WorkspaceResolver } from '../workspace/WorkspaceResolver';
import { SearchResultStore } from '../search/SearchResultStore';
import { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import { SearchSession } from './SearchSession';
import { ConnectionController } from './ConnectionController';
import { SearchCoordinator } from './SearchCoordinator';
import { TagIndexAutoRefresh } from '../definition/TagIndexAutoRefresh';

const DEFAULT_REMOTE_RG_PATH = '/tmp/ripgreptool-rg';
const DEFAULT_REMOTE_CTAGS_PATH = '/tmp/ripgreptool-ctags';
const BUNDLED_CTAGS_RELATIVE_PATH = 'assets/bin/ctags';
const SEARCH_VIEW_I18N_RELATIVE_PATH = 'media/i18n/search-view.csv';

export type Services = {
  logger: ExtensionLogger;
  settingsStore: SettingsStore;
  translationService: TranslationService;
  workspaceResolver: WorkspaceResolver;
  resultStore: SearchResultStore;
  messageRouter: WebviewMessageRouter;
  session: SearchSession;
  connectionController: ConnectionController;
  searchCoordinator: SearchCoordinator;
  tagIndexAutoRefresh: TagIndexAutoRefresh;
};

export function createServices(context: ExtensionContext): Services {
  const logger = new ExtensionLogger(context);
  const settingsStore = new SettingsStore(context.globalState);
  const translationService = new TranslationService(context, SEARCH_VIEW_I18N_RELATIVE_PATH);
  const workspaceResolver = new WorkspaceResolver();
  const resultStore = new SearchResultStore();
  const messageRouter = new WebviewMessageRouter();
  const config = vscode.workspace.getConfiguration('ripgrepTool');
  const resultRefreshMs = Math.max(4, config.get<number>('resultRefreshMs', 80));
  const definitionExcludeGlobs = config.get<string[]>('definitionExcludeGlobs', DEFAULT_DEFINITION_EXCLUDE_GLOBS);

  const session = new SearchSession({
    refreshMs: resultRefreshMs,
    onStateChange: (message) => messageRouter.postState(message),
    onResultsPush: (results) => messageRouter.postResults(
      results.mode,
      results.items,
      results.replace === true,
      results.requestId
    )
  }, resultStore);

  const sshClientManager = new SshClientManager(logger);
  const remoteExecutor = new RemoteExecutor({
    logger,
    setActiveChannel: (channel, previous) => session.setActiveChannel(channel, previous)
  });
  const remoteToolInstaller = new RemoteToolInstaller({
    asAbsolutePath: (relativePath) => context.asAbsolutePath(relativePath),
    executor: remoteExecutor,
    logger,
    bundledRgRelativePath: bundledLinuxRgPath(),
    remoteRgPath: DEFAULT_REMOTE_RG_PATH,
    bundledCtagsRelativePath: BUNDLED_CTAGS_RELATIVE_PATH,
    remoteCtagsPath: DEFAULT_REMOTE_CTAGS_PATH
  });

  const connectionController = new ConnectionController(
    sshClientManager,
    remoteExecutor,
    remoteToolInstaller,
    logger
  );

  connectionController.setOptions({
    workspaceResolver,
    getWorkspaceFolder: () => vscode.workspace.workspaceFolders?.[0]
  });

  const searchCoordinator = new SearchCoordinator(
    session,
    resultStore,
    connectionController,
    workspaceResolver,
    translationService,
    remoteExecutor,
    remoteToolInstaller,
    logger,
    {
      contextLines: Math.max(0, config.get<number>('contextLines', 0)),
      threads: Math.max(0, config.get<number>('threads', 0)),
      resultRefreshMs,
      definitionExcludeGlobs
    },
    {
      resultRefreshMs
    }
  );

  const tagIndexAutoRefresh = new TagIndexAutoRefresh(
    connectionController,
    workspaceResolver,
    translationService,
    remoteExecutor,
    remoteToolInstaller,
    logger
  );

  return {
    logger,
    settingsStore,
    translationService,
    workspaceResolver,
    resultStore,
    messageRouter,
    session,
    connectionController,
    searchCoordinator,
    tagIndexAutoRefresh
  };
}
