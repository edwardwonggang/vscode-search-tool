import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { normalizeSettings } from './core/settings';
import { inferRemoteWorkspacePath, normalizeRemotePath, sameLocalPath } from './core/paths';
import { resolveTargetUri } from './core/targetUri';
import { escapeHtml } from './core/text';
import type { SearchMatch, SearchOptions, SearchSettings } from './core/types';
import { buildIconUris, renderFallbackHtml, renderSearchViewHtml } from './webview/SearchViewHtml';
import { createServices, type Services } from './session/ServiceFactory';
import { resolveMatchSelection } from './search/MatchNavigation';
import type { SearchRepository, WorkspaceInfo } from './workspace/WorkspaceResolver';
import { RipgrepDefinitionProvider } from './definition/RipgrepDefinitionProvider';
import type { QuickFileEntry } from './search/QuickFileSearch';

const SEARCH_VIEW_HTML_RELATIVE_PATH = 'media/search-view.html';
const SEARCH_VIEW_CSS_RELATIVE_PATH = 'media/search-view.css';
const SEARCH_RESULTS_RENDERER_JS_RELATIVE_PATH = 'media/search-results-renderer.js';
const SEARCH_HISTORY_JS_RELATIVE_PATH = 'media/search-history.js';
const SEARCH_SETTINGS_PANEL_JS_RELATIVE_PATH = 'media/search-settings-panel.js';
const SEARCH_ICONS_JS_RELATIVE_PATH = 'media/search-icons.js';
const SEARCH_VIEW_JS_RELATIVE_PATH = 'media/search-view.js';
const SSH_KEEPALIVE_CHECK_MS = 60000;
// 定义提供器覆盖的语言：远端 ctags 索引的 C/C++ 家族（避免干扰其他语言的语言服务器）。
const DEFINITION_LANGUAGE_SELECTOR: vscode.DocumentSelector = [
  { language: 'c' },
  { language: 'cpp' },
  { language: 'cxx' },
  { language: 'cc' },
  { language: 'h' },
  { language: 'hpp' },
  { language: 'hh' },
  { language: 'hxx' },
  { language: 'cuda-cpp' },
  { language: 'objective-c' },
  { language: 'objective-cpp' }
];
const CODICON_ICON_RELATIVE_PATHS = {
  caseSensitive: 'media/icons/codicons/case-sensitive.svg',
  wholeWord: 'media/icons/codicons/whole-word.svg',
  regex: 'media/icons/codicons/regex.svg',
  settings: 'media/icons/codicons/settings-gear.svg',
  chevronRight: 'media/icons/codicons/chevron-right.svg',
  chevronDown: 'media/icons/codicons/chevron-down.svg',
  eye: 'media/icons/codicons/eye.svg',
  eyeClosed: 'media/icons/codicons/eye-closed.svg',
  close: 'media/icons/codicons/close.svg',
  definition: 'media/icons/codicons/symbol-definition.svg'
};
const FILE_TYPE_ICON_RELATIVE_PATHS: Record<string, string> = {
  c: 'media/icons/filetypes/c.svg',
  h: 'media/icons/filetypes/h.svg',
  cpp: 'media/icons/filetypes/cpp.svg',
  cxx: 'media/icons/filetypes/cpp.svg',
  cc: 'media/icons/filetypes/cpp.svg',
  hpp: 'media/icons/filetypes/hpp.svg',
  hh: 'media/icons/filetypes/hpp.svg',
  hxx: 'media/icons/filetypes/hpp.svg',
  sh: 'media/icons/filetypes/sh.svg',
  bash: 'media/icons/filetypes/sh.svg',
  md: 'media/icons/filetypes/md.svg',
  json: 'media/icons/filetypes/json.svg',
  yml: 'media/icons/filetypes/yaml.svg',
  yaml: 'media/icons/filetypes/yaml.svg',
  xml: 'media/icons/filetypes/xml.svg',
  js: 'media/icons/filetypes/js.svg',
  mjs: 'media/icons/filetypes/js.svg',
  cjs: 'media/icons/filetypes/js.svg',
  ts: 'media/icons/filetypes/ts.svg',
  tsx: 'media/icons/filetypes/ts.svg',
  jsx: 'media/icons/filetypes/js.svg',
  py: 'media/icons/filetypes/py.svg',
  java: 'media/icons/filetypes/java.svg',
  ps1: 'media/icons/filetypes/ps1.svg',
  default: 'media/icons/filetypes/default.svg'
};

/**
 * 规范化 uri 字符串用于同文件比较：忽略斜杠数量、尾部斜杠与大小写差异。
 */
function normalizeUriForCompare(value: string): string {
  return value
    .replace(/^file:\/\/+\/?/u, 'file://')
    .replace(/\/+$/u, '')
    .toLowerCase();
}

class RipgrepSearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ripgrepTool.searchView';
  // 工作区信息（含 Git 根发现）的缓存时长：避免每次搜索/连接前重复遍历目录树。
  private static readonly workspaceInfoTtlMs = 5000;

  private view?: vscode.WebviewView;
  private services!: Services;
  private workspaceInfo?: WorkspaceInfo;
  private searchResultViewColumn?: vscode.ViewColumn;
  private queuedOpenMatch?: SearchMatch;
  private queuedOpenMatchNewTab = false;
  private workspaceInfoCache?: { at: number; info: WorkspaceInfo };
  private openingMatch = false;
  private keepaliveTimer?: NodeJS.Timeout;
  private autoConnectInFlight = false;
  private latestSearchRequestId = 0;
  private inFlightDefinitionLookup?: { key: string; promise: Promise<SearchMatch[]> };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.services = createServices(context);
    this.context.subscriptions.push(this.services.logger);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.services.messageRouter.setView(webviewView);
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.context.asAbsolutePath('media'))]
    };

    void this.renderWebview(webviewView).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.services.logger.log(`webview render failed: ${message}`);
      webviewView.webview.html = renderFallbackHtml(`Failed to load Ripgrep Tool view: ${escapeHtml(message)}`);
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          await this.postBootstrap();
          void this.autoConnectIfReady('view ready');
          break;
        case 'search':
          if (await this.ensureWorkspaceUsable()) {
            const payload = message.payload as SearchOptions;
            const requestId = Number.isFinite(payload.requestId) ? Number(payload.requestId) : 0;
            if (requestId && requestId < this.latestSearchRequestId) {
              this.services.logger.log(`drop stale search request ${requestId}, latest=${this.latestSearchRequestId}`);
              break;
            }
            this.latestSearchRequestId = Math.max(this.latestSearchRequestId, requestId);
            await this.services.searchCoordinator.executeSearch(
              payload,
              this.getSettings(),
              vscode.workspace.workspaceFolders![0],
              this.workspaceInfo?.repositories ?? [],
              this.services.messageRouter
            );
          }
          break;
        case 'rebuildTags':
          if (await this.ensureWorkspaceUsable() && this.workspaceInfo?.hasGit) {
            await this.services.searchCoordinator.executeRebuildTags(
              this.getSettings(),
              vscode.workspace.workspaceFolders![0],
              this.workspaceInfo?.repositories ?? [],
              this.services.messageRouter
            );
          } else if (this.workspaceInfo && !this.workspaceInfo.hasGit) {
            this.services.messageRouter.postState({
              type: 'state',
              running: false,
              error: await this.services.translationService.translate('definition_requires_git')
            });
          }
          break;
        case 'open':
          this.enqueueOpenMatch(message.payload as SearchMatch);
          break;
        case 'trace':
          this.logWebviewTrace(message.payload);
          break;
        case 'saveSettings':
          if (await this.ensureWorkspaceUsable()) {
            await this.saveSettings(message.payload as SearchSettings);
          }
          break;
        case 'connect':
          if (await this.ensureWorkspaceUsable()) {
            await this.services.connectionController.checkConnection(
              normalizeSettings(message.payload as SearchSettings),
              this.workspaceInfo?.repositories ?? [],
              (ok, msg, cwd) => this.services.messageRouter.postConnectionResult({ ok, message: msg, cwd })
            );
          }
          break;
        default:
          break;
      }
    });
  }

  public focus(): void {
    this.view?.show?.(true);
    this.services.messageRouter.postFocus();
  }

  public async focusSearch(): Promise<void> {
    this.focus();
  }

  /**
   * 判断当前打开的工作区是否为“Linux 远端项目”：
   * 已配置 SSH（remoteHost/username/password）且能从 UNC 或映射盘路径推断出远端路径。
   * 只有满足时才把 Ctrl+P 覆盖为插件的快速文件搜索，其余工作区保持原生行为。
   */
  public async refreshWorkspaceContext(): Promise<void> {
    const settings = this.getSettings();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const isLinuxRemote =
      Boolean(workspaceFolder) &&
      this.services.connectionController.isRemoteSearchConfigured(settings) &&
      Boolean(settings.inferredRemoteSearchPath);
    await vscode.commands.executeCommand('setContext', 'ripgrepTool.workspaceIsRemote', isLinuxRemote);
    this.services.logger.debug(`workspace context linuxRemote=${isLinuxRemote ? 'true' : 'false'} path="${settings.inferredRemoteSearchPath || ''}"`);
  }

  /**
   * 用 showQuickPick 实现的快速文件搜索，替代原生 Ctrl+P（Go to File）：
   * 输入即通过远端 ripgrep 搜文件名，回车打开对应本地文件。
   */
  public async quickOpenFile(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }
    const settings = this.getSettings();
    if (!this.services.connectionController.isRemoteSearchConfigured(settings)) {
      void vscode.window.showInformationMessage(await this.services.translationService.translate('connection_required'));
      return;
    }

    const quickPick = vscode.window.createQuickPick<QuickFileEntry>();
    quickPick.placeholder = '输入文件名，回车打开（远端 ripgrep）';
    // 与原生 Ctrl+P 一致：点击其他位置或切换焦点即自动关闭，无需按 Esc。
    quickPick.ignoreFocusOut = false;
    quickPick.busy = false;
    let debounceTimer: NodeJS.Timeout | undefined;

    const openEntry = (entry: QuickFileEntry): void => {
      quickPick.hide();
      if (entry.uri) {
        void vscode.window.showTextDocument(entry.uri, { preview: true });
      }
    };
    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        openEntry(selected);
      }
    });
    quickPick.onDidChangeValue((value) => {
      const query = value.trim();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      if (!query) {
        quickPick.items = [];
        return;
      }
      quickPick.busy = true;
      debounceTimer = setTimeout(() => {
        void this.runQuickFileSearch(query, settings, workspaceFolder, quickPick);
      }, 300);
    });
    quickPick.show();
  }

  private async runQuickFileSearch(
    query: string,
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    quickPick: vscode.QuickPick<QuickFileEntry>
  ): Promise<void> {
    try {
      const result = await this.services.quickFileSearch.searchFiles(query, settings, workspaceFolder);
      if (result.error && result.entries.length === 0) {
        quickPick.items = [{ label: `搜索失败: ${result.error}`, description: '' }];
      } else {
        quickPick.items = result.entries;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      quickPick.items = [{ label: `搜索失败: ${message}`, description: '' }];
    } finally {
      quickPick.busy = false;
    }
  }

  /**
   * 右键“转到定义”：取光标下的标识符，在 Linux 远端 ctags 索引中查找定义。
   */
  public async goToDefinitionCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(await this.services.translationService.translate('goto_def_no_symbol'));
      return;
    }
    const position = editor.selection.active;
    const range = editor.document.getWordRangeAtPosition(position);
    const symbol = range ? editor.document.getText(range).trim() : '';
    if (!range || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(symbol)) {
      void vscode.window.showInformationMessage(await this.services.translationService.translate('goto_def_no_symbol'));
      return;
    }

    // 系统进度通知：命令一开始就显示，阶段信息随远端执行实时更新。
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Ripgrep: ${symbol}` },
      async (progress) => {
        progress.report({ message: 'Searching definitions…' });
        try {
          const workspaceInfo = await this.getCachedWorkspaceInfo();
          if (!workspaceInfo.workspaceOk) {
            void vscode.window.showErrorMessage(workspaceInfo.workspaceError || await this.services.translationService.translate('workspace_none'));
            return;
          }
          if (!workspaceInfo.hasGit) {
            void vscode.window.showInformationMessage(await this.services.translationService.translate('definition_requires_git'));
            return;
          }
          if (!this.services.connectionController.isRemoteSearchConfigured(this.getSettings())) {
            void vscode.window.showInformationMessage(await this.services.translationService.translate('connection_required'));
            return;
          }
          const uniqueMatches = await this.lookupDefinitionMatches(
            symbol,
            (phase) => progress.report({ message: phase })
          );
          if (uniqueMatches.length === 0) {
            void vscode.window.showInformationMessage(
              await this.services.translationService.format('goto_def_not_found', { symbol })
            );
            return;
          }
          if (uniqueMatches.length === 1) {
            this.enqueueOpenMatch(uniqueMatches[0], true);
            return;
          }

          await this.showDefinitionQuickPick(symbol, uniqueMatches);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(await this.services.translationService.format('goto_def_failed', { message }));
        }
      }
    );
  }

  /**
   * 创建定义提供器：内置 Ctrl+点击 / F12 通过 VS Code 原生定义入口复用远端 ctags 查找。
   */
  public createDefinitionProvider(): RipgrepDefinitionProvider {
    return new RipgrepDefinitionProvider((symbol, onPhase) =>
      this.lookupDefinitionMatches(symbol, onPhase)
    );
  }

  /**
   * 执行远端 ctags 定义查找：校验工作区/Git/SSH 配置后返回去重后的匹配。
   * 供右键命令与内置 DefinitionProvider（Ctrl+点击 / F12）共用。
   */
  private async lookupDefinitionMatches(
    symbol: string,
    onPhase?: (phase: string) => void
  ): Promise<SearchMatch[]> {
    const workspaceInfo = await this.getCachedWorkspaceInfo();
    if (!workspaceInfo.workspaceOk || !workspaceInfo.hasGit) {
      return [];
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }
    const settings = this.getSettings();
    if (!this.services.connectionController.isRemoteSearchConfigured(settings)) {
      return [];
    }
    // 同一符号的重复触发（如连续 Ctrl+点击 / F12）复用同一个在途查找，
    // 避免并发多次远端搜索叠加 SSH 负载导致抖动。
    const key = `${symbol}|${settings.remoteHost}|${settings.remotePort}|${settings.remoteUsername}|${settings.remoteSearchPath}`;
    if (this.inFlightDefinitionLookup && this.inFlightDefinitionLookup.key === key) {
      this.services.logger.debug(`definition lookup reused in-flight symbol=${symbol}`);
      return await this.inFlightDefinitionLookup.promise;
    }
    const search = this.services.searchCoordinator
      .lookupDefinitions(symbol, settings, workspaceFolder, workspaceInfo.repositories, onPhase)
      .then((matches) => dedupeMatches(matches));
    const tracked = search.finally(() => {
      if (this.inFlightDefinitionLookup && this.inFlightDefinitionLookup.promise === tracked) {
        this.inFlightDefinitionLookup = undefined;
      }
    });
    this.inFlightDefinitionLookup = {
      key,
      promise: tracked
    };
    return await tracked;
  }

  public async openLogFileInEditor(): Promise<void> {
    const logPath = await this.services.logger.getLogFilePath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const fileHandle = await fs.open(logPath, 'a');
    await fileHandle.close();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  public async revealLogFileInExplorer(): Promise<void> {
    const logPath = await this.services.logger.getLogFilePath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const fileHandle = await fs.open(logPath, 'a');
    await fileHandle.close();
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logPath));
  }

  public dispose(): void {
    this.stopKeepalive();
    this.services.session.dispose();
    this.services.connectionController.close('provider disposed');
  }

  private async renderWebview(webviewView: vscode.WebviewView): Promise<void> {
    const nonce = getNonce();
    const iconUris = buildIconUris(
      this.context,
      webviewView.webview,
      CODICON_ICON_RELATIVE_PATHS,
      FILE_TYPE_ICON_RELATIVE_PATHS
    );
    webviewView.webview.html = await renderSearchViewHtml(
      this.context,
      webviewView,
      {
        html: SEARCH_VIEW_HTML_RELATIVE_PATH,
        css: SEARCH_VIEW_CSS_RELATIVE_PATH,
        resultsRendererJs: SEARCH_RESULTS_RENDERER_JS_RELATIVE_PATH,
        searchHistoryJs: SEARCH_HISTORY_JS_RELATIVE_PATH,
        settingsPanelJs: SEARCH_SETTINGS_PANEL_JS_RELATIVE_PATH,
        iconsJs: SEARCH_ICONS_JS_RELATIVE_PATH,
        js: SEARCH_VIEW_JS_RELATIVE_PATH
      },
      nonce,
      iconUris
    );
  }

  private async postBootstrap(): Promise<void> {
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? 'No workspace';
    const workspaceInfo = await this.getWorkspaceInfo();
    this.services.messageRouter.postBootstrap({
      workspaceName,
      workspacePath: workspaceInfo.displayPath,
      workspaceOk: workspaceInfo.workspaceOk,
      workspaceError: workspaceInfo.workspaceError,
      hasGit: workspaceInfo.hasGit,
      repositories: workspaceInfo.repositories.map(toRepositoryPayload),
      settings: this.getSettings(),
      translations: await this.services.translationService.getTranslations(),
      state: this.services.messageRouter.getState(),
      results: this.services.messageRouter.getResults()
    });
  }

  /**
   * 激活时后台预热 SSH 连接：配置了远端搜索就提前建连并复用，
   * 避免用户未打开侧边栏时首次右键跳转定义还要等待建连。
   * 失败静默，不影响激活；与 autoConnectIfReady 共用同一连接复用逻辑。
   */
  public async warmUpConnection(): Promise<void> {
    try {
      const settings = this.getSettings();
      if (!this.services.connectionController.isRemoteSearchConfigured(settings)) {
        return;
      }
      await this.services.connectionController.getOrCreateClient(settings);
      this.services.logger.debug('ssh warm-up connection ready');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.services.logger.log(`ssh warm-up connection failed: ${message}`);
    }
  }

  private async autoConnectIfReady(reason: string): Promise<void> {
    if (this.autoConnectInFlight) {
      return;
    }
    const settings = this.getSettings();
    if (!this.services.connectionController.isRemoteSearchConfigured(settings)) {
      this.stopKeepalive();
      return;
    }
    const workspaceInfo = await this.getWorkspaceInfo();
    if (!workspaceInfo.workspaceOk) {
      this.stopKeepalive();
      return;
    }

    this.autoConnectInFlight = true;
    this.services.logger.debug(`auto-connect start reason=${reason}`);
    try {
      await this.services.connectionController.checkConnection(
        settings,
        workspaceInfo.repositories,
        (ok, msg, cwd) => this.services.messageRouter.postConnectionResult({ ok, message: msg, cwd })
      );
      this.startKeepalive();
      this.services.tagIndexAutoRefresh.refreshIfDue(settings, vscode.workspace.workspaceFolders?.[0], workspaceInfo.repositories);
    } finally {
      this.autoConnectInFlight = false;
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) {
      return;
    }
    this.keepaliveTimer = setInterval(() => {
      void this.keepConnectionWarm();
    }, SSH_KEEPALIVE_CHECK_MS);
  }

  private stopKeepalive(): void {
    if (!this.keepaliveTimer) {
      return;
    }
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  private async keepConnectionWarm(): Promise<void> {
    const settings = this.getSettings();
    if (!this.services.connectionController.isRemoteSearchConfigured(settings)) {
      this.stopKeepalive();
      return;
    }
    try {
      await this.services.connectionController.getOrCreateClient(settings);
      this.services.logger.debug('ssh keepalive check ok');
      const workspaceInfo = await this.getWorkspaceInfo();
      this.services.tagIndexAutoRefresh.refreshIfDue(settings, vscode.workspace.workspaceFolders?.[0], workspaceInfo.repositories);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.services.logger.log(`ssh keepalive check failed: ${message}`);
    }
  }

  /**
   * 工作区信息（含 Git 根发现）：短 TTL 缓存，避免每次搜索/连接前都重复遍历
   * 目录树（网络盘工作区可能很慢）；force=true 时强制重新发现。
   */
  private async getWorkspaceInfo(force = false): Promise<WorkspaceInfo> {
    const now = Date.now();
    if (
      !force &&
      this.workspaceInfoCache &&
      now - this.workspaceInfoCache.at < RipgrepSearchViewProvider.workspaceInfoTtlMs
    ) {
      return this.workspaceInfoCache.info;
    }
    const info = await this.services.workspaceResolver.getWorkspaceInfo({
      workspaceNone: await this.services.translationService.translate('workspace_none'),
      remoteWorkspaceUnsupported: await this.services.translationService.translate('remote_workspace_unsupported'),
      remoteSearchPathRequired: await this.services.translationService.translate('err_remote_search_path_required')
    });
    this.workspaceInfo = info;
    this.workspaceInfoCache = { at: now, info };
    return info;
  }

  /**
   * 工作区结构可能变化（如新增/移除 Git 根、切换文件夹）时使缓存失效。
   */
  public invalidateWorkspaceInfoCache(): void {
    this.workspaceInfoCache = undefined;
  }

  /**
   * 转到定义前的工作区信息：复用 getWorkspaceInfo 的短 TTL 缓存，
   * 避免每次 Ctrl+点击都重复遍历网络目录发现 Git。
   */
  private async getCachedWorkspaceInfo(): Promise<WorkspaceInfo> {
    return await this.getWorkspaceInfo();
  }

  /**
   * 定义搜索多候选悬浮窗：点击跳转、↑↓ 移动、Enter 跳转、Esc 关闭。
   */
  private async showDefinitionQuickPick(symbol: string, matches: SearchMatch[]): Promise<void> {
    const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { match?: SearchMatch }>();
    picker.title = `Ripgrep: ${symbol}`;
    picker.placeholder = await this.services.translationService.translate('goto_def_select');
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.items = matches.map((match) => ({
      label: match.symbolName || symbol,
      description: `${match.relativePath || match.path}:${match.line}:${match.column}`,
      detail: match.preview,
      match
    }));
    const close = (): void => picker.dispose();
    picker.onDidChangeSelection((selected) => {
      const item = selected[0];
      if (item?.match) {
        close();
        this.enqueueOpenMatch(item.match, true);
      }
    });
    picker.onDidAccept(() => {
      const item = picker.activeItems[0];
      if (item?.match) {
        close();
        this.enqueueOpenMatch(item.match, true);
      }
    });
    picker.onDidHide(() => close());
    picker.show();
  }

  private async ensureWorkspaceUsable(): Promise<boolean> {
    const workspaceInfo = await this.getWorkspaceInfo();
    if (workspaceInfo.workspaceOk) {
      return true;
    }
    const message = workspaceInfo.workspaceError || await this.services.translationService.translate('workspace_none');
    this.services.session.cancelActiveSearch();
    this.services.resultStore.clear();
    this.services.messageRouter.postResults('content', []);
    this.services.messageRouter.postWorkspaceBlocked(message, workspaceInfo.displayPath);
    this.services.messageRouter.postState({ type: 'state', running: false, error: message });
    return false;
  }

  private async saveSettings(payload: SearchSettings): Promise<void> {
    const normalized = normalizeSettings(payload);
    this.services.logger.log(
      `save-settings host=${normalized.remoteHost || '<empty>'}:${normalized.remotePort} user=${normalized.remoteUsername || '<empty>'} passwordPresent=${normalized.remotePassword ? 'true' : 'false'}`
    );
    await this.services.settingsStore.saveSshSettings(normalized);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const inferredPath = this.inferProjectRemotePath(normalized.remoteUsername, workspaceFolder);
    const projectPath = inferredPath || normalizeRemotePath(normalized.remoteSearchPath);
    if (projectPath) {
      await this.services.settingsStore.saveProjectSettings(projectPath, {
        remoteSearchPath: normalized.remoteSearchPath,
        includeGlobs: normalized.includeGlobs,
        excludeGlobs: normalized.excludeGlobs
      });
    }
    const inferredForMessage = this.inferProjectRemotePath(normalized.remoteUsername, workspaceFolder);
    this.services.messageRouter.postMessage({
      type: 'settings',
      payload: { ...normalized, inferredRemoteSearchPath: inferredForMessage || '' }
    } as any);
    this.services.messageRouter.postState({ type: 'state', running: false, summary: 'Settings saved' });
    // SSH 配置变化可能改变“是否 Linux 远端项目”的判定，重算 Ctrl+P 接管条件。
    void this.refreshWorkspaceContext();
    void this.autoConnectIfReady('settings saved');
  }

  private getSettings(): SearchSettings {
    const ssh = this.services.settingsStore.getSshSettings();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const inferredPath = this.inferProjectRemotePath(ssh.remoteUsername, workspaceFolder);
    const project = inferredPath
      ? this.services.settingsStore.getProjectSettings(inferredPath)
      : { remoteSearchPath: '', includeGlobs: [], excludeGlobs: [] };
    const normalizedProject = normalizeSettings({
      ...ssh,
      remoteSearchPath: project.remoteSearchPath,
      includeGlobs: project.includeGlobs,
      excludeGlobs: project.excludeGlobs
    });
    return {
      ...ssh,
      remoteSearchPath: normalizedProject.remoteSearchPath,
      includeGlobs: normalizedProject.includeGlobs,
      excludeGlobs: normalizedProject.excludeGlobs,
      inferredRemoteSearchPath: inferredPath || ''
    };
  }

  private inferProjectRemotePath(remoteUsername: string, workspaceFolder: vscode.WorkspaceFolder | undefined): string {
    if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
      return '';
    }
    return inferRemoteWorkspacePath(workspaceFolder.uri.fsPath, remoteUsername) ?? '';
  }

  private enqueueOpenMatch(match: SearchMatch, newTab = false): void {
    if (!match || (!match.uri && !match.path)) {
      this.services.logger.log('open ignored: missing match uri/path');
      return;
    }
    this.queuedOpenMatch = match;
    this.queuedOpenMatchNewTab = newTab;
    if (this.openingMatch) {
      return;
    }
    void this.drainOpenMatchQueue();
  }

  private logWebviewTrace(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      this.services.logger.log('webview trace invalid');
      return;
    }
    const trace = payload as { event?: unknown; requestId?: unknown; details?: unknown };
    const event = String(trace.event || 'unknown');
    const requestId = Number.isFinite(trace.requestId) ? Number(trace.requestId) : 0;
    const details = trace.details && typeof trace.details === 'object'
      ? JSON.stringify(trace.details).slice(0, 800)
      : '{}';
    this.services.logger.log(`webview ${event} requestId=${requestId} details=${details}`);
  }

  private async drainOpenMatchQueue(): Promise<void> {
    this.openingMatch = true;
    try {
      while (this.queuedOpenMatch) {
        const match = this.queuedOpenMatch;
        const newTab = this.queuedOpenMatchNewTab;
        this.queuedOpenMatch = undefined;
        this.queuedOpenMatchNewTab = false;
        await this.openMatch(match, newTab);
      }
    } finally {
      this.openingMatch = false;
      if (this.queuedOpenMatch) {
        void this.drainOpenMatchQueue();
      }
    }
  }

  private async openMatch(match: SearchMatch, newTab = false): Promise<void> {
    const nextUri = resolveTargetUri(match.uri, match.path);
    const startedAt = Date.now();
    this.services.logger.log(`open start uri=${nextUri.toString()} path=${match.path} line=${match.line} column=${match.column}`);
    try {
      // 转到定义且目标就在当前文件中：直接在当前编辑器跳转，不新开 Tab。
      if (newTab && this.tryJumpInActiveEditor(nextUri, match, startedAt)) {
        return;
      }
      const visibleEditor = this.findVisibleEditor(nextUri);
      const document = visibleEditor?.document ?? await vscode.workspace.openTextDocument(nextUri);
      const selection = this.createSelection(document, match);
      this.services.logger.log(
        `open selection uri=${nextUri.toString()} line=${selection.start.line + 1} column=${selection.start.character + 1}`
      );
      const showOptions: vscode.TextDocumentShowOptions = {
        preview: !newTab,
        preserveFocus: false,
        selection
      };
      if (newTab) {
        // 转到定义新 Tab：在同一编辑组内打开普通新标签，不做左右拆分。
        showOptions.viewColumn = vscode.ViewColumn.Active;
      } else {
        this.invalidateSearchResultViewColumnIfEmpty();
        if (this.searchResultViewColumn !== undefined) {
          showOptions.viewColumn = this.searchResultViewColumn;
        }
      }
      const editor = visibleEditor
        ? await vscode.window.showTextDocument(visibleEditor.document, showOptions)
        : await vscode.window.showTextDocument(document, showOptions);
      if (!newTab) {
        this.searchResultViewColumn = editor.viewColumn;
      }
      editor.selection = selection;
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
      this.services.logger.log(`open done elapsed=${Date.now() - startedAt} ms uri=${nextUri.toString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.services.logger.log(`open failed uri=${nextUri.toString()} path=${match.path} error=${message}`);
      void vscode.window.showWarningMessage(
        await this.services.translationService.format('open_failed', { message })
      );
    }
  }

  /**
   * 目标文件与当前活动编辑器相同（转到定义）时，直接在当前编辑器内跳转到定义位置。
   * @returns 已在当前编辑器内跳转返回 true，否则返回 false。
   */
  private tryJumpInActiveEditor(targetUri: vscode.Uri, match: SearchMatch, startedAt: number): boolean {
    const activeEditor = vscode.window.activeTextEditor;
    if (
      !activeEditor ||
      activeEditor.document.uri.scheme !== targetUri.scheme ||
      (!sameLocalPath(activeEditor.document.uri.fsPath, targetUri.fsPath) &&
        normalizeUriForCompare(activeEditor.document.uri.toString()) !== normalizeUriForCompare(targetUri.toString()))
    ) {
      return false;
    }
    const selection = this.createSelection(activeEditor.document, match);
    activeEditor.selection = selection;
    activeEditor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    this.services.logger.log(
      `open in current editor uri=${targetUri.toString()} line=${selection.start.line + 1} column=${selection.start.character + 1}`
    );
    return true;
  }

  private findVisibleEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
    const uriString = uri.toString();
    return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uriString);
  }

  private createSelection(document: vscode.TextDocument, match: SearchMatch): vscode.Selection {
    const range = resolveMatchSelection(
      document.lineCount,
      (lineIndex) => document.lineAt(lineIndex).text,
      match
    );
    return new vscode.Selection(
      range.lineIndex,
      range.startCharacter,
      range.lineIndex,
      range.endCharacter
    );
  }

  private invalidateSearchResultViewColumnIfEmpty(): void {
    if (this.searchResultViewColumn === undefined) {
      return;
    }
    const columnOpen = vscode.window.visibleTextEditors.some(
      (e) => e.viewColumn === this.searchResultViewColumn
    );
    if (!columnOpen) {
      this.searchResultViewColumn = undefined;
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // 该插件只在 Windows 侧使用：通过 ssh2 连到 Linux 服务器执行搜索。
  // 非 Windows 环境不注册任何命令/提供器，避免误用。
  if (process.platform !== 'win32') {
    return;
  }
  const provider = new RipgrepSearchViewProvider(context);
  // 激活即预热 SSH，右键跳转定义/定义提供器不再等待首次建连。
  void provider.warmUpConnection();
  // 初始化工作区上下文，决定 Ctrl+P 是否被插件接管。
  void provider.refreshWorkspaceContext();
  context.subscriptions.push(
    provider,
    vscode.languages.registerDefinitionProvider(
      DEFINITION_LANGUAGE_SELECTOR,
      provider.createDefinitionProvider()
    ),
    vscode.window.registerWebviewViewProvider(RipgrepSearchViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('ripgrepTool.focusSearch', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.ripgrepTool');
      await provider.focusSearch();
    }),
    vscode.commands.registerCommand('ripgrepTool.goToDefinition', () => void provider.goToDefinitionCommand()),
    vscode.commands.registerCommand('ripgrepTool.quickOpenFile', () => void provider.quickOpenFile()),
    vscode.commands.registerCommand('ripgrepTool.openLogFile', async () => {
      try {
        await provider.openLogFileInEditor();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to open log file: ${message}`);
      }
    }),
    vscode.commands.registerCommand('ripgrepTool.revealLogFile', async () => {
      try {
        await provider.revealLogFileInExplorer();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to reveal log file: ${message}`);
      }
    }),
    // 切换工作区文件夹后旧的 Git 发现结果立即失效，同时重算 Ctrl+P 覆盖条件。
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.invalidateWorkspaceInfoCache();
      void provider.refreshWorkspaceContext();
    })
  );
}

export function deactivate(): void {}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 16; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function toRepositoryPayload(repository: SearchRepository): { name: string; relativePath: string; displayPath: string } {
  return {
    name: repository.name,
    relativePath: repository.workspaceRelativePath,
    displayPath: repository.displayPath
  };
}

function dedupeMatches(matches: SearchMatch[]): SearchMatch[] {
  const seen = new Set<string>();
  const unique: SearchMatch[] = [];
  for (const match of matches) {
    const key = `${match.uri ?? match.path}|${match.line}|${match.column}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(match);
    }
  }
  return unique;
}
