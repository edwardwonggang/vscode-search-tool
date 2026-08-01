import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { normalizeSettings } from './core/settings';
import { inferRemoteWorkspacePath, normalizeRemotePath } from './core/paths';
import { escapeHtml } from './core/text';
import type { SearchMatch, SearchOptions, SearchSettings } from './core/types';
import { buildIconUris, renderFallbackHtml, renderSearchViewHtml } from './webview/SearchViewHtml';
import { createServices, type Services } from './session/ServiceFactory';
import { resolveMatchSelection } from './search/MatchNavigation';
import type { SearchRepository, WorkspaceInfo } from './workspace/WorkspaceResolver';

const SEARCH_VIEW_HTML_RELATIVE_PATH = 'media/search-view.html';
const SEARCH_VIEW_CSS_RELATIVE_PATH = 'media/search-view.css';
const SEARCH_RESULTS_RENDERER_JS_RELATIVE_PATH = 'media/search-results-renderer.js';
const SEARCH_HISTORY_JS_RELATIVE_PATH = 'media/search-history.js';
const SEARCH_SETTINGS_PANEL_JS_RELATIVE_PATH = 'media/search-settings-panel.js';
const SEARCH_ICONS_JS_RELATIVE_PATH = 'media/search-icons.js';
const SEARCH_VIEW_JS_RELATIVE_PATH = 'media/search-view.js';
const SSH_KEEPALIVE_CHECK_MS = 60000;
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

class RipgrepSearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ripgrepTool.searchView';

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
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) {
            return;
          }
          if (!workspaceInfo.hasGit) {
            void vscode.window.showInformationMessage(await this.services.translationService.translate('definition_requires_git'));
            return;
          }
          const settings = this.getSettings();
          if (!this.services.connectionController.isRemoteSearchConfigured(settings)) {
            void vscode.window.showInformationMessage(await this.services.translationService.translate('connection_required'));
            return;
          }

          const matches = await this.services.searchCoordinator.lookupDefinitions(
            symbol,
            settings,
            workspaceFolder,
            workspaceInfo.repositories,
            (phase) => progress.report({ message: phase })
          );

          const uniqueMatches = dedupeMatches(matches);
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

  private async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    const info = await this.services.workspaceResolver.getWorkspaceInfo({
      workspaceNone: await this.services.translationService.translate('workspace_none'),
      remoteWorkspaceUnsupported: await this.services.translationService.translate('remote_workspace_unsupported'),
      remoteSearchPathRequired: await this.services.translationService.translate('err_remote_search_path_required')
    });
    this.workspaceInfo = info;
    return info;
  }

  /**
   * 转到定义前的工作区信息：5 秒内复用，避免每次 Ctrl+点击都重复遍历网络目录发现 Git。
   */
  private async getCachedWorkspaceInfo(): Promise<WorkspaceInfo> {
    const now = Date.now();
    if (this.workspaceInfoCache && now - this.workspaceInfoCache.at < 5000) {
      return this.workspaceInfoCache.info;
    }
    const info = await this.getWorkspaceInfo();
    this.workspaceInfoCache = { at: now, info };
    return info;
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
    const nextUri = match.uri ? vscode.Uri.parse(match.uri, true) : vscode.Uri.file(match.path);
    const startedAt = Date.now();
    this.services.logger.log(`open start uri=${nextUri.toString()} path=${match.path} line=${match.line} column=${match.column}`);
    try {
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
        showOptions.viewColumn = vscode.ViewColumn.Beside;
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
  const provider = new RipgrepSearchViewProvider(context);
  context.subscriptions.push(
    provider,
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
