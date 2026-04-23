import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as posixPath from 'path/posix';
import { Client, ConnectConfig, ClientChannel, SFTPWrapper } from 'ssh2';

type SearchOptions = {
  query: string;
  include: string;
  exclude: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  definitionMode?: boolean;
};

type SearchSettings = {
  remoteHost: string;
  remotePort: number;
  remoteUsername: string;
  remotePassword: string;
  includeGlobs: string[];
  excludeGlobs: string[];
};

type SearchMatch = {
  path: string;
  line: number;
  column: number;
  endColumn: number;
  preview: string;
};

type SearchFileResult = {
  path: string;
  relativePath: string;
  matches: SearchMatch[];
};

type SearchStateMessage = {
  type: 'state';
  running: boolean;
  error?: string;
  summary?: string;
  elapsedMs?: number;
  ctagsInProgress?: boolean;
};

type SearchResultMessage = {
  type: 'results';
  items: Array<{
    path: string;
    relativePath: string;
    count: number;
    matches: SearchMatch[];
  }>;
};

type RemoteConnectionTestResult = {
  ok: boolean;
  message: string;
};

type TranslationRow = {
  key: string;
  en: string;
  zhCN: string;
};

const SEARCH_SETTINGS_KEY = 'ripgrepTool.searchSettings';
const DEFAULT_REMOTE_PORT = 22;
const DEFAULT_LOCAL_ROOT = 'x:/src';
const DEFAULT_REMOTE_ROOT = '/home/wanggang/src';
const DEFAULT_REMOTE_RG_PATH = '/tmp/ripgreptool-rg';
const BUNDLED_REMOTE_RG_RELATIVE_PATH = path.join(
  'assets',
  'bin',
  'ripgrep-14.1.0-x86_64-unknown-linux-musl',
  'rg'
);
const DEFAULT_REMOTE_CTAGS_PATH = '/tmp/ripgreptool-ctags';
const BUNDLED_CTAGS_RELATIVE_PATH = path.join('assets', 'bin', 'ctags');
const CTAGS_EXCLUDE_DIRS = ['build', 'out', 'rom'] as const;
const SEARCH_VIEW_HTML_RELATIVE_PATH = path.join('media', 'search-view.html');
const SEARCH_VIEW_CSS_RELATIVE_PATH = path.join('media', 'search-view.css');
const SEARCH_VIEW_JS_RELATIVE_PATH = path.join('media', 'search-view.js');
const SEARCH_VIEW_I18N_RELATIVE_PATH = path.join('media', 'i18n', 'search-view.csv');
const CODICON_ICON_RELATIVE_PATHS = {
  caseSensitive: path.join('media', 'icons', 'codicons', 'case-sensitive.svg'),
  wholeWord: path.join('media', 'icons', 'codicons', 'whole-word.svg'),
  regex: path.join('media', 'icons', 'codicons', 'regex.svg'),
  settings: path.join('media', 'icons', 'codicons', 'settings-gear.svg'),
  chevronRight: path.join('media', 'icons', 'codicons', 'chevron-right.svg'),
  chevronDown: path.join('media', 'icons', 'codicons', 'chevron-down.svg'),
  eye: path.join('media', 'icons', 'codicons', 'eye.svg'),
  eyeClosed: path.join('media', 'icons', 'codicons', 'eye-closed.svg'),
  close: path.join('media', 'icons', 'codicons', 'close.svg'),
  definition: path.join('media', 'icons', 'codicons', 'symbol-definition.svg')
};
const FILE_TYPE_ICON_RELATIVE_PATHS: Record<string, string> = {
  c: path.join('media', 'icons', 'filetypes', 'c.svg'),
  h: path.join('media', 'icons', 'filetypes', 'h.svg'),
  cpp: path.join('media', 'icons', 'filetypes', 'cpp.svg'),
  cxx: path.join('media', 'icons', 'filetypes', 'cpp.svg'),
  cc: path.join('media', 'icons', 'filetypes', 'cpp.svg'),
  hpp: path.join('media', 'icons', 'filetypes', 'hpp.svg'),
  hh: path.join('media', 'icons', 'filetypes', 'hpp.svg'),
  hxx: path.join('media', 'icons', 'filetypes', 'hpp.svg'),
  sh: path.join('media', 'icons', 'filetypes', 'sh.svg'),
  bash: path.join('media', 'icons', 'filetypes', 'sh.svg'),
  md: path.join('media', 'icons', 'filetypes', 'md.svg'),
  json: path.join('media', 'icons', 'filetypes', 'json.svg'),
  yml: path.join('media', 'icons', 'filetypes', 'yaml.svg'),
  yaml: path.join('media', 'icons', 'filetypes', 'yaml.svg'),
  xml: path.join('media', 'icons', 'filetypes', 'xml.svg'),
  js: path.join('media', 'icons', 'filetypes', 'js.svg'),
  mjs: path.join('media', 'icons', 'filetypes', 'js.svg'),
  cjs: path.join('media', 'icons', 'filetypes', 'js.svg'),
  ts: path.join('media', 'icons', 'filetypes', 'ts.svg'),
  tsx: path.join('media', 'icons', 'filetypes', 'ts.svg'),
  jsx: path.join('media', 'icons', 'filetypes', 'js.svg'),
  py: path.join('media', 'icons', 'filetypes', 'py.svg'),
  java: path.join('media', 'icons', 'filetypes', 'java.svg'),
  ps1: path.join('media', 'icons', 'filetypes', 'ps1.svg'),
  default: path.join('media', 'icons', 'filetypes', 'default.svg')
};

const DEFAULT_INCLUDE_GLOBS = [
  '**/*.c',
  '**/*.cc',
  '**/*.cpp',
  '**/*.cxx',
  '**/*.h',
  '**/*.hh',
  '**/*.hpp',
  '**/*.hxx',
  '**/*.inl',
  '**/*.ipp',
  '**/*.java',
  '**/*.kt',
  '**/*.kts',
  '**/*.groovy',
  '**/*.gradle',
  '**/*.py',
  '**/*.pyi',
  '**/*.js',
  '**/*.mjs',
  '**/*.cjs',
  '**/*.ts',
  '**/*.tsx',
  '**/*.jsx',
  '**/*.vue',
  '**/*.svelte',
  '**/*.go',
  '**/*.rs',
  '**/*.cs',
  '**/*.php',
  '**/*.rb',
  '**/*.swift',
  '**/*.m',
  '**/*.mm',
  '**/*.sh',
  '**/*.bash',
  '**/*.zsh',
  '**/*.fish',
  '**/*.ps1',
  '**/*.bat',
  '**/*.cmd',
  '**/*.sql',
  '**/*.json',
  '**/*.jsonc',
  '**/*.yaml',
  '**/*.yml',
  '**/*.xml',
  '**/*.toml',
  '**/*.ini',
  '**/*.cfg',
  '**/*.conf',
  '**/*.properties',
  '**/*.cmake',
  '**/*.mak',
  '**/*.mk',
  '**/*.txt',
  '**/*.md',
  '**/*.rst',
  '**/*.csv',
  '**/*.tsv',
  '**/*.log'
];

const DEFAULT_EXCLUDE_GLOBS = [
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.*/**',
  '**/node_modules/**',
  '**/bower_components/**',
  '**/build/**',
  '**/Build/**',
  '**/out/**',
  '**/dist/**',
  '**/target/**',
  '**/Debug/**',
  '**/Release/**',
  '**/x64/**',
  '**/x86/**',
  '**/bin/**',
  '**/obj/**',
  '**/lib/**',
  '**/libs/**',
  '**/packages/**',
  '**/vendor/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/__pycache__/**',
  '**/.gradle/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.vs/**',
  '**/.settings/**',
  '**/.DS_Store',
  '**/*.7z',
  '**/*.a',
  '**/*.apk',
  '**/*.bin',
  '**/*.bz2',
  '**/*.class',
  '**/*.dll',
  '**/*.dmg',
  '**/*.ear',
  '**/*.exe',
  '**/*.gz',
  '**/*.ico',
  '**/*.jar',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.lib',
  '**/*.min.js.map',
  '**/*.min.css.map',
  '**/*.mp3',
  '**/*.mp4',
  '**/*.o',
  '**/*.obj',
  '**/*.otf',
  '**/*.pdf',
  '**/*.pdb',
  '**/*.png',
  '**/*.pyc',
  '**/*.rar',
  '**/*.so',
  '**/*.svgz',
  '**/*.tar',
  '**/*.tgz',
  '**/*.ttf',
  '**/*.war',
  '**/*.webp',
  '**/*.woff',
  '**/*.woff2',
  '**/*.xz',
  '**/*.zip'
];

class RipgrepSearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ripgrepTool.searchView';

  private view?: vscode.WebviewView;
  private readonly outputChannel: vscode.OutputChannel;
  private activeRemoteClient?: Client;
  private activeRemoteChannel?: ClientChannel;
  private searchToken = 0;
  private readonly resultCache = new Map<string, SearchFileResult>();
  private refreshTimer?: NodeJS.Timeout;
  private pendingResultPush = false;
  private lastResults: SearchResultMessage = { type: 'results', items: [] };
  private lastStateMessage: SearchStateMessage = { type: 'state', running: false, summary: '' };
  private translationsCache?: Record<string, string>;
  private searchResultViewColumn?: vscode.ViewColumn;
  private lastSearchResultUri?: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Ripgrep Tool');
    this.context.subscriptions.push(this.outputChannel);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.context.asAbsolutePath('media'))]
    };

    void this.renderWebview(webviewView);
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          await this.postBootstrap();
          break;
        case 'search':
          await this.runSearch(message.payload as SearchOptions);
          break;
        case 'rebuildTags':
          await this.rebuildTags();
          break;
        case 'open':
          await this.openMatch(message.payload as SearchMatch);
          break;
        case 'saveSettings':
          await this.saveSettings(message.payload as SearchSettings);
          break;
        case 'testConnection':
          await this.testConnection(message.payload as SearchSettings);
          break;
        default:
          break;
      }
    });
  }

  public focus(): void {
    this.view?.show?.(true);
    this.view?.webview.postMessage({ type: 'focus' });
  }

  private async renderWebview(webviewView: vscode.WebviewView): Promise<void> {
    const nonce = getNonce();
    const htmlTemplate = await fs.readFile(this.context.asAbsolutePath(SEARCH_VIEW_HTML_RELATIVE_PATH), 'utf8');
    const cssUri = webviewView.webview.asWebviewUri(vscode.Uri.file(this.context.asAbsolutePath(SEARCH_VIEW_CSS_RELATIVE_PATH)));
    const jsUri = webviewView.webview.asWebviewUri(vscode.Uri.file(this.context.asAbsolutePath(SEARCH_VIEW_JS_RELATIVE_PATH)));
    const iconUris = buildIconUris(this.context, webviewView.webview);
    const csp = [
      `default-src 'none'`,
      `style-src ${webviewView.webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webviewView.webview.cspSource} data: blob:`,
      `connect-src ${webviewView.webview.cspSource}`
    ].join('; ');

    webviewView.webview.html = htmlTemplate
      .split('__CSP__').join(csp)
      .split('__NONCE__').join(nonce)
      .split('__CSS_URI__').join(cssUri.toString())
      .split('__JS_URI__').join(jsUri.toString())
      .split('__DEFAULT_REMOTE_PORT__').join(String(DEFAULT_REMOTE_PORT))
      .split('__DEFAULT_INCLUDE_GLOBS__').join(JSON.stringify(DEFAULT_INCLUDE_GLOBS))
      .split('__DEFAULT_EXCLUDE_GLOBS__').join(JSON.stringify(DEFAULT_EXCLUDE_GLOBS))
      .split('__ICON_URIS__').join(JSON.stringify(iconUris));
  }

  private async postBootstrap(): Promise<void> {
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? 'No workspace';
    this.view?.webview.postMessage({
      type: 'bootstrap',
      payload: {
        workspaceName,
        settings: this.getSettings(),
        translations: await this.getTranslations(),
        state: this.lastStateMessage,
        results: this.lastResults
      }
    });
  }

  private async getTranslations(): Promise<Record<string, string>> {
    if (this.translationsCache) {
      return this.translationsCache;
    }

    const csvText = await fs.readFile(this.context.asAbsolutePath(SEARCH_VIEW_I18N_RELATIVE_PATH), 'utf8');
    const rows = parseTranslationCsv(csvText);
    const language = vscode.env.language.toLowerCase().startsWith('zh') ? 'zhCN' : 'en';
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = language === 'zhCN' ? row.zhCN : row.en;
    }
    this.translationsCache = map;
    return map;
  }

  private async runSearch(options: SearchOptions): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.postState({ type: 'state', running: false, error: 'Open a workspace folder first.' });
      return;
    }

    const query = options.query.trim();
    if (!query) {
      this.resultCache.clear();
      this.lastResults = { type: 'results', items: [] };
      this.view?.webview.postMessage(this.lastResults);
      this.postState({ type: 'state', running: false, summary: '' });
      return;
    }

    const settings = this.getSettings();
    if (!this.shouldUseRemoteSearch(settings)) {
      this.postState({
        type: 'state',
        running: false,
        error: 'Remote search is required. Configure SSH host, username, and password in Settings.'
      });
      return;
    }

    this.cancelActiveSearch();
    this.resultCache.clear();
    this.lastResults = { type: 'results', items: [] };
    this.view?.webview.postMessage(this.lastResults);

    const token = ++this.searchToken;
    const config = vscode.workspace.getConfiguration('ripgrepTool');
    const maxResultsRaw = config.get<number>('maxResults', 0);
    const maxCountPerFile = maxResultsRaw <= 0 ? 0 : Math.max(1, Math.floor(maxResultsRaw));
    const contextLines = Math.max(0, config.get<number>('contextLines', 0));
    const refreshMs = Math.max(4, config.get<number>('resultRefreshMs', 80));
    const threads = Math.max(0, config.get<number>('threads', 0));
    const args = this.buildArgs(options, settings, maxCountPerFile, contextLines, threads);
    const remoteCwd = this.mapWorkspacePath(workspaceFolder.uri.fsPath);

    if (options.definitionMode === true) {
      await this.runDefinitionSearch(token, options, workspaceFolder, remoteCwd, settings);
      return;
    }

    const startedAt = Date.now();
    let firstResultAt: number | undefined;
    let lastPushAt: number | undefined;
    let pushCount = 0;
    let parsedEvents = 0;
    let stderr = '';
    let totalMatches = 0;

    this.log(`search#${token} start`);
    this.log(`search#${token} mode=remote`);
    this.log(`search#${token} query="${query}" cwd="${workspaceFolder.uri.fsPath}"`);
    this.log(`search#${token} remote cwd="${remoteCwd}"`);
    this.log(
      `search#${token} maxCountPerFile=${maxCountPerFile === 0 ? 'none (omitted --max-count)' : String(maxCountPerFile)} args=${JSON.stringify(args)}`
    );
    this.postState({ type: 'state', running: true, summary: 'Searching...' });

    const lineBuffer = new JsonLineBuffer((entry) => {
      if (token !== this.searchToken || entry.type !== 'match') {
        return;
      }

      parsedEvents += 1;
      if (firstResultAt === undefined) {
        firstResultAt = Date.now();
        this.log(`search#${token} first match event (${firstResultAt - startedAt} ms)`);
      }

      const data = entry.data;
      const filePath = data.path.text as string;
      const absolutePath = path.join(workspaceFolder.uri.fsPath, filePath.replace(/\//g, path.sep));
      const relativePath = vscode.workspace.asRelativePath(absolutePath, false);
      const submatches = data.submatches as Array<{ start: number; end: number }>;
      const lines = data.lines.text as string;
      const lineNumber = data.line_number as number;

      let bucket = this.resultCache.get(absolutePath);
      if (!bucket) {
        bucket = {
          path: absolutePath,
          relativePath,
          matches: []
        };
        this.resultCache.set(absolutePath, bucket);
      }

      for (const submatch of submatches) {
        totalMatches += 1;
        bucket.matches.push({
          path: absolutePath,
          line: lineNumber,
          column: submatch.start + 1,
          endColumn: submatch.end + 1,
          preview: lines.replace(/\r?\n$/, '')
        });
      }

      this.scheduleResultPush(refreshMs, () => {
        pushCount += 1;
        lastPushAt = Date.now();
      });
    });

    try {
      const code = await this.runRemoteSearch(token, settings, remoteCwd, args, lineBuffer, {
        onStderr: (text) => {
          stderr += text;
        },
        onSpawned: (elapsedMs) => {
          this.log(`search#${token} remote exec ok (${elapsedMs} ms)`);
        }
      }, startedAt);

      if (token !== this.searchToken) {
        return;
      }

      this.flushResults(() => {
        pushCount += 1;
        lastPushAt = Date.now();
      });

      if (code === 0 || code === 1) {
        const fileCount = this.resultCache.size;
        const elapsedMs = Date.now() - startedAt;
        this.log(
          `search#${token} done code=${code} total=${elapsedMs} ms, firstMatch=${
            firstResultAt === undefined ? 'n/a' : `${firstResultAt - startedAt} ms`
          }, pushes=${pushCount}, lastPush=${lastPushAt === undefined ? 'n/a' : `${lastPushAt - startedAt} ms`}, matchEvents=${parsedEvents}, files=${fileCount}, results=${totalMatches}`
        );
        const summary = totalMatches === 0
          ? `No results (${elapsedMs} ms)`
          : `${fileCount} files, ${totalMatches} results (${elapsedMs} ms)`;
        this.postState({ type: 'state', running: false, summary, elapsedMs });
        return;
      }

      this.log(`search#${token} failed code=${code ?? 'unknown'} after ${Date.now() - startedAt} ms stderr=${stderr.trim()}`);
      this.postState({
        type: 'state',
        running: false,
        error: stderr.trim() || `ripgrep exited with code ${code ?? 'unknown'}.`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`search#${token} exception: ${message}`);
      this.postState({ type: 'state', running: false, error: message });
    }
  }

  private async runRemoteSearch(
    token: number,
    settings: SearchSettings,
    remoteCwd: string,
    args: string[],
    lineBuffer: JsonLineBuffer,
    handlers: { onStderr: (text: string) => void; onSpawned: (elapsedMs: number) => void },
    startedAt: number
  ): Promise<number | undefined> {
    const connectStartedAt = Date.now();
    const client = await this.connectRemote(settings);
    this.activeRemoteClient = client;
    this.log(`search#${token} ssh connected (${Date.now() - connectStartedAt} ms)`);

    const prepareStartedAt = Date.now();
    await this.uploadBundledRg(client, DEFAULT_REMOTE_RG_PATH);
    this.log(`search#${token} rg prepared (${Date.now() - prepareStartedAt} ms)`);

    const command = this.buildRemoteCommand(DEFAULT_REMOTE_RG_PATH, remoteCwd, args);
    this.log(`search#${token} remote command=${command}`);

    return await new Promise<number | undefined>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        this.activeRemoteChannel = stream;
        handlers.onSpawned(Date.now() - startedAt);

        stream.on('data', (chunk: Buffer | string) => {
          lineBuffer.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
        });
        stream.stderr.on('data', (chunk: Buffer | string) => {
          handlers.onStderr(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
        });
        stream.on('close', (code: number | undefined) => {
          if (token === this.searchToken) {
            this.activeRemoteChannel = undefined;
            this.activeRemoteClient?.end();
            this.activeRemoteClient = undefined;
          }
          resolve(code);
        });
        stream.on('error', (streamError: Error) => {
          reject(streamError);
        });
      });
    });
  }

  private buildArgs(
    options: SearchOptions,
    settings: SearchSettings,
    maxCountPerFile: number,
    contextLines: number,
    threads: number
  ): string[] {
    const args = ['--json', '--line-number', '--column', '--hidden'];
    if (maxCountPerFile > 0) {
      args.push('--max-count', String(maxCountPerFile));
    }

    if (threads > 0) {
      args.push('--threads', String(threads));
    }
    if (!options.caseSensitive) {
      args.push('--ignore-case');
    }
    if (options.wholeWord) {
      args.push('--word-regexp');
    }
    if (!options.useRegex) {
      args.push('--fixed-strings');
    }
    if (contextLines > 0) {
      args.push('--context', String(contextLines));
    }

    for (const glob of settings.includeGlobs) {
      args.push('--glob', glob);
    }
    for (const glob of settings.excludeGlobs) {
      args.push('--glob', `!${glob}`);
    }
    if (options.include.trim()) {
      for (const glob of splitUserGlobs(options.include)) {
        args.push('--glob', glob);
      }
    }
    if (options.exclude.trim()) {
      for (const glob of splitUserGlobs(options.exclude)) {
        args.push('--glob', `!${glob}`);
      }
    }

    args.push(options.query);
    args.push('.');
    return args;
  }

  private pushResults(): void {
    this.pendingResultPush = false;
    this.lastResults = {
      type: 'results',
      items: Array.from(this.resultCache.values())
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .map((file) => ({
          path: file.path,
          relativePath: file.relativePath,
          count: file.matches.length,
          matches: file.matches
        }))
    };
    this.view?.webview.postMessage(this.lastResults);
  }

  private scheduleResultPush(refreshMs: number, onPush: () => void): void {
    this.pendingResultPush = true;
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.pendingResultPush) {
        onPush();
        this.pushResults();
      }
    }, refreshMs);
  }

  private flushResults(onPush?: () => void): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.pendingResultPush) {
      onPush?.();
      this.pushResults();
    }
  }

  private async openMatch(match: SearchMatch): Promise<void> {
    // preview:false 会创建固定标签，后续 showTextDocument 不会替换，导致每个文件一个新 TAB。
    // 使用 preview:true + 切换文件时关闭上一次的“搜索结果”标签，保证始终只占用一个页签位置。
    const nextUri = vscode.Uri.file(match.path);
    this.invalidateSearchResultViewColumnIfEmpty();

    if (this.lastSearchResultUri && !this.uriPathsEqual(this.lastSearchResultUri, nextUri) && this.searchResultViewColumn !== undefined) {
      await this.tryCloseSearchResultTab(this.lastSearchResultUri, this.searchResultViewColumn);
      this.invalidateSearchResultViewColumnIfEmpty();
    }

    const document = await vscode.workspace.openTextDocument(nextUri);
    const showOptions: vscode.TextDocumentShowOptions = {
      preview: true,
      preserveFocus: false
    };
    if (this.searchResultViewColumn !== undefined) {
      showOptions.viewColumn = this.searchResultViewColumn;
    }
    const editor = await vscode.window.showTextDocument(document, showOptions);
    this.searchResultViewColumn = editor.viewColumn;
    this.lastSearchResultUri = editor.document.uri;
    this.updateEditorSelection(editor, match);
  }

  private uriPathsEqual(a: vscode.Uri, b: vscode.Uri): boolean {
    return path.normalize(a.fsPath) === path.normalize(b.fsPath);
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

  private async tryCloseSearchResultTab(
    fileUri: vscode.Uri,
    targetColumn: vscode.ViewColumn
  ): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      if (group.viewColumn !== targetColumn) {
        continue;
      }
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && this.uriPathsEqual(tab.input.uri, fileUri)) {
          await vscode.window.tabGroups.close(tab, true);
          return;
        }
      }
    }
  }

  private updateEditorSelection(editor: vscode.TextEditor, match: SearchMatch): void {
    const selection = new vscode.Selection(
      match.line - 1,
      match.column - 1,
      match.line - 1,
      Math.max(match.column, match.endColumn - 1)
    );
    editor.selection = selection;
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  }

  private cancelActiveSearch(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.pendingResultPush = false;
    if (this.activeRemoteChannel) {
      this.log(`search#${this.searchToken} remote cancel requested`);
      this.activeRemoteChannel.close();
      this.activeRemoteChannel = undefined;
    }
    if (this.activeRemoteClient) {
      this.activeRemoteClient.end();
      this.activeRemoteClient = undefined;
    }
  }

  private shouldUseRemoteSearch(settings: SearchSettings): boolean {
    return Boolean(settings.remoteHost && settings.remoteUsername && settings.remotePassword);
  }

  private mapWorkspacePath(localWorkspacePath: string): string {
    const normalizedWorkspace = normalizeLocalPath(localWorkspacePath);
    const normalizedLocalRoot = normalizeLocalPath(DEFAULT_LOCAL_ROOT);
    if (!normalizedWorkspace.startsWith(normalizedLocalRoot)) {
      throw new Error(`Workspace path "${localWorkspacePath}" is outside local root "${DEFAULT_LOCAL_ROOT}".`);
    }
    const relative = normalizedWorkspace.slice(normalizedLocalRoot.length).replace(/^\/+/, '');
    return relative ? posixPath.join(DEFAULT_REMOTE_ROOT, relative) : DEFAULT_REMOTE_ROOT;
  }

  private async connectRemote(settings: SearchSettings): Promise<Client> {
    const connectConfig: ConnectConfig = {
      host: settings.remoteHost,
      port: settings.remotePort,
      username: settings.remoteUsername,
      password: settings.remotePassword,
      readyTimeout: 20000
    };

    return await new Promise<Client>((resolve, reject) => {
      const client = new Client();
      client.on('ready', () => resolve(client));
      client.on('error', (error) => reject(error));
      client.connect(connectConfig);
    });
  }

  private async uploadBundledRg(client: Client, remoteRgPath: string): Promise<void> {
    const localRgPath = this.context.asAbsolutePath(BUNDLED_REMOTE_RG_RELATIVE_PATH);
    this.log(`checking bundled rg at ${localRgPath}`);
    await fs.access(localRgPath);
    this.log(`checking remote rg version at ${remoteRgPath}`);
    const remoteVersion = await this.getRemoteRgVersion(client, remoteRgPath);
    this.log(`remote rg version result: ${remoteVersion ?? 'missing'}`);
    if (remoteVersion?.startsWith('ripgrep 14.1.0')) {
      this.log(`remote rg already ready at ${remoteRgPath}`);
      return;
    }
    this.log(`creating remote directory for rg: ${posixPath.dirname(remoteRgPath)}`);
    await this.execRemoteCommand(client, `mkdir -p ${shellEscape(posixPath.dirname(remoteRgPath))}`);
    this.log('opening sftp session');
    const sftp = await this.openSftp(client);
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localRgPath, remoteRgPath, {}, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.log('sftp upload finished');
    sftp.end();
    this.log('setting executable bit on remote rg');
    await this.execRemoteCommand(client, `chmod +x ${shellEscape(remoteRgPath)}`);
  }

  private async getRemoteRgVersion(client: Client, remoteRgPath: string): Promise<string | undefined> {
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        client.exec(`${shellEscape(remoteRgPath)} --version`, (error, stream) => {
          if (error) {
            reject(error);
            return;
          }
          let stdout = '';
          stream.on('data', (chunk: Buffer | string) => {
            stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
          });
          stream.stderr.on('data', () => {
            // Drain stderr to avoid channel stalls.
          });
          stream.on('close', (code: number | undefined) => {
            if (code === 0 || code === undefined) {
              resolve(stdout.split(/\r?\n/)[0]?.trim() || undefined);
              return;
            }
            resolve(undefined);
          });
        });
      });
    } catch {
      return undefined;
    }
  }

  private async openSftp(client: Client): Promise<SFTPWrapper> {
    return await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error || !sftp) {
          reject(error ?? new Error('Failed to open SFTP session.'));
          return;
        }
        resolve(sftp);
      });
    });
  }

  private async execRemoteCommand(client: Client, command: string): Promise<void> {
    await this.execRemoteCommandWithOutput(client, command);
  }

  private async execRemoteCommandWithOutput(
    client: Client,
    command: string
  ): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
    return await new Promise<{ stdout: string; stderr: string; code: number | undefined }>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk: Buffer | string) => {
          stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        });
        stream.stderr.on('data', (chunk: Buffer | string) => {
          stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        });
        stream.on('close', (code: number | undefined) => {
          if (code === 0 || code === undefined) {
            resolve({ stdout, stderr, code });
            return;
          }
          reject(new Error(stderr.trim() || stdout.trim() || `Remote command failed with exit code ${code}.`));
        });
      });
    });
  }

  private buildRemoteCommand(remoteRgPath: string, remoteCwd: string, args: string[]): string {
    const escapedArgs = args.map((arg) => shellEscape(arg)).join(' ');
    return `cd ${shellEscape(remoteCwd)} && ${shellEscape(remoteRgPath)} ${escapedArgs}`;
  }

  private async saveSettings(payload: SearchSettings): Promise<void> {
    const normalized = normalizeSettings(payload);
    this.log(
      `save-settings host=${normalized.remoteHost || '<empty>'}:${normalized.remotePort} user=${normalized.remoteUsername || '<empty>'} passwordPresent=${normalized.remotePassword ? 'true' : 'false'}`
    );
    await this.context.globalState.update(SEARCH_SETTINGS_KEY, normalized);
    this.view?.webview.postMessage({ type: 'settings', payload: normalized });
    this.postState({ type: 'state', running: false, summary: 'Settings saved' });
  }

  private getSettings(): SearchSettings {
    const saved = this.context.globalState.get<SearchSettings>(SEARCH_SETTINGS_KEY);
    return normalizeSettings(saved);
  }

  private async testConnection(payload: SearchSettings): Promise<void> {
    const settings = normalizeSettings(payload);
    this.log(
      `connection-test payload host=${settings.remoteHost || '<empty>'}:${settings.remotePort} user=${settings.remoteUsername || '<empty>'} passwordPresent=${settings.remotePassword ? 'true' : 'false'}`
    );
    if (!this.shouldUseRemoteSearch(settings)) {
      this.postConnectionTest({ ok: false, message: 'Host, username, and password are required.' });
      return;
    }

    const startedAt = Date.now();
    try {
      const client = await this.connectRemote(settings);
      const result = await this.execRemoteCommandWithOutput(client, 'pwd');
      client.end();
      const elapsedMs = Date.now() - startedAt;
      const pwd = result.stdout.split(/\r?\n/)[0]?.trim() || '';
      this.log(`connection-test ok (${elapsedMs} ms) pwd=${pwd}`);
      this.postConnectionTest({ ok: true, message: `Connected in ${elapsedMs} ms${pwd ? `, pwd: ${pwd}` : ''}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`connection-test failed: ${message}`);
      this.postConnectionTest({ ok: false, message });
    }
  }

  private postState(message: SearchStateMessage): void {
    this.lastStateMessage = message;
    this.view?.webview.postMessage(message);
  }

  private postConnectionTest(result: RemoteConnectionTestResult): void {
    this.view?.webview.postMessage({ type: 'connectionTest', payload: result });
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private async translate(key: string): Promise<string> {
    const map = await this.getTranslations();
    return map[key] || key;
  }

  private mapRemoteToLocalRemote(remotePosix: string): string {
    const norm = remotePosix.replace(/\\/g, '/').replace(/\/+$/u, '');
    const base = DEFAULT_REMOTE_ROOT.replace(/\/+$/u, '');
    if (!norm.toLowerCase().startsWith(base.toLowerCase())) {
      throw new Error(`Remote path is outside the mapped server root.`);
    }
    const rel = norm.slice(base.length).replace(/^\/+/u, '');
    return path.join(DEFAULT_LOCAL_ROOT, rel.replace(/\//gu, path.sep));
  }

  private async getRemoteGitTop(client: Client, remoteCwd: string, token: number): Promise<string> {
    const cmd = `cd ${shellEscape(remoteCwd)} && git rev-parse --show-toplevel`;
    const r = await this.execRemoteCommandWithExitCode(client, cmd);
    if (token !== this.searchToken) {
      return '';
    }
    if (r.code != null && r.code !== 0) {
      throw new Error(await this.translate('err_not_git_workspace'));
    }
    const top = r.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
    if (!top) {
      throw new Error(await this.translate('err_not_git_workspace'));
    }
    const tree = await this.execRemoteCommandWithExitCode(
      client,
      `cd ${shellEscape(remoteCwd)} && git rev-parse --is-inside-work-tree`
    );
    if (token !== this.searchToken) {
      return '';
    }
    if (tree.stdout.trim() !== 'true') {
      throw new Error(await this.translate('err_not_git_workspace'));
    }
    return top;
  }

  private async remoteFileExists(client: Client, remotePath: string): Promise<boolean> {
    const r = await this.execRemoteCommandWithExitCode(
      client,
      `if test -f ${shellEscape(remotePath)}; then echo y; else echo n; fi`
    );
    return r.stdout.trim() === 'y' && (r.code == null || r.code === 0);
  }

  private async execRemoteCommandWithExitCode(
    client: Client,
    command: string
  ): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
    return await new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk: Buffer | string) => {
          stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        });
        stream.stderr.on('data', (chunk: Buffer | string) => {
          stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        });
        stream.on('close', (code: number | undefined | null) => {
          resolve({ stdout, stderr, code: code == null ? undefined : code });
        });
        stream.on('error', (streamError: Error) => {
          reject(streamError);
        });
      });
    });
  }

  private async ensureRemoteCtags(client: Client): Promise<string> {
    const localCtags = this.context.asAbsolutePath(BUNDLED_CTAGS_RELATIVE_PATH);
    try {
      await fs.access(localCtags);
      await this.uploadBundledCtags(client, DEFAULT_REMOTE_CTAGS_PATH, localCtags);
      return DEFAULT_REMOTE_CTAGS_PATH;
    } catch {
      this.log('bundled ctags not found; using ctags on remote PATH');
    }
    const r = await this.execRemoteCommandWithExitCode(
      client,
      'command -v ctags 2>/dev/null || command -v universal-ctags 2>/dev/null || true'
    );
    const ctags = r.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
    if (!ctags) {
      throw new Error(await this.translate('err_ctags_missing'));
    }
    return ctags;
  }

  private async uploadBundledCtags(
    client: Client,
    remoteCtagsPath: string,
    localCtagsPath: string
  ): Promise<void> {
    this.log(`checking remote ctags at ${remoteCtagsPath}`);
    const have = await this.getRemoteCtagsVersion(client, remoteCtagsPath);
    if (have) {
      this.log('remote ctags already present');
      return;
    }
    await this.execRemoteCommand(client, `mkdir -p ${shellEscape(posixPath.dirname(remoteCtagsPath))}`);
    const sftp = await this.openSftp(client);
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localCtagsPath, remoteCtagsPath, {}, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    sftp.end();
    await this.execRemoteCommand(client, `chmod +x ${shellEscape(remoteCtagsPath)}`);
  }

  private async getRemoteCtagsVersion(client: Client, remoteCtagsPath: string): Promise<string | undefined> {
    try {
      const r = await this.execRemoteCommandWithExitCode(
        client,
        `${shellEscape(remoteCtagsPath)} --version 2>/dev/null | head -n 1 || true`
      );
      return r.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async runRemoteCtagsBuild(
    client: Client,
    ctagsPath: string,
    gitTop: string,
    tagsPath: string,
    token: number
  ): Promise<void> {
    const buildSummary = await this.translate('ctags_building');
    this.postState({ type: 'state', running: true, summary: buildSummary, ctagsInProgress: true });
    const excludes = CTAGS_EXCLUDE_DIRS.map((d) => `--exclude=${d}`).join(' ');
    const command = `cd ${shellEscape(gitTop)} && ${shellEscape(ctagsPath)} -R -f ${shellEscape(tagsPath)} --tag-relative=yes --fields=+n ${excludes} .`;
    const { code, logText } = await this.execCtagsWithProgress(client, command, token, buildSummary);
    if (token !== this.searchToken) {
      return;
    }
    if (code !== 0 && code !== undefined) {
      throw new Error(
        (logText && logText.trim().slice(0, 500)) || (await this.translate('ctags_build_failed'))
      );
    }
    this.postState({ type: 'state', running: true, ctagsInProgress: false, summary: await this.translate('ctags_build_done') });
  }

  private async execCtagsWithProgress(
    client: Client,
    command: string,
    token: number,
    buildSummary: string
  ): Promise<{ code: number | undefined; logText: string }> {
    return await new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        this.activeRemoteChannel = stream;
        let acc = '';
        const pushChunk = (text: string) => {
          acc += text;
          if (token !== this.searchToken) {
            return;
          }
          const parts = acc.split(/\r?\n/u);
          const last = parts[Math.max(0, parts.length - 2)] || parts[0] || '';
          const tail = last.length > 90 ? last.slice(-90) : last;
          this.postState({
            type: 'state',
            running: true,
            ctagsInProgress: true,
            summary: tail.trim() ? `${buildSummary} — ${tail.trim()}` : buildSummary
          });
        };
        stream.on('data', (c: Buffer | string) => {
          pushChunk(Buffer.isBuffer(c) ? c.toString('utf8') : c);
        });
        stream.stderr.on('data', (c: Buffer | string) => {
          pushChunk(Buffer.isBuffer(c) ? c.toString('utf8') : c);
        });
        stream.on('close', (c: number | undefined) => {
          if (token === this.searchToken) {
            this.activeRemoteChannel = undefined;
          }
          resolve({ code: c, logText: acc });
        });
        stream.on('error', (e: Error) => {
          reject(e);
        });
      });
    });
  }

  private parseTagResultLine(
    line: string,
    query: string,
    workspaceRoot: string,
    gitTopRemote: string
  ): SearchMatch | null {
    const firstTab = line.indexOf('\t');
    if (firstTab <= 0) {
      return null;
    }
    const name = line.slice(0, firstTab);
    if (name !== query) {
      return null;
    }
    const rest = line.slice(firstTab + 1);
    const secondTab = rest.indexOf('\t');
    if (secondTab <= 0) {
      return null;
    }
    const fileRel = rest.slice(0, secondTab);
    const after = rest.slice(secondTab + 1);
    const lineNumMatch = /line:(\d+)/u.exec(after);
    const lineNo = lineNumMatch ? Number.parseInt(lineNumMatch[1] ?? '1', 10) : 1;
    const semi = after.indexOf(';"');
    const excmd = semi >= 0 ? after.slice(0, semi) : after;
    const preview = excmd.length > 200 ? excmd.slice(0, 200) + '...' : excmd;
    const remoteFileAbs = fileRel.startsWith('/')
      ? fileRel
      : posixPath.join(gitTopRemote.replace(/\/+$/u, ''), fileRel);
    let localPath: string;
    try {
      localPath = this.mapRemoteToLocalRemote(remoteFileAbs);
    } catch {
      localPath = path.join(workspaceRoot, fileRel.split('/').join(path.sep));
    }
    return {
      path: localPath,
      line: lineNo,
      column: 1,
      endColumn: 2,
      preview: preview || name
    };
  }

  private async runDefinitionSearch(
    token: number,
    options: SearchOptions,
    workspaceFolder: vscode.WorkspaceFolder,
    remoteCwd: string,
    settings: SearchSettings
  ): Promise<void> {
    const query = options.query.trim();
    const startedAt = Date.now();
    this.postState({
      type: 'state',
      running: true,
      summary: await this.translate('def_searching'),
      ctagsInProgress: false
    });

    let client: Client | undefined;
    try {
      client = await this.connectRemote(settings);
      this.activeRemoteClient = client;
      this.log(`def-search#${token} ssh connected`);
      await this.uploadBundledRg(client, DEFAULT_REMOTE_RG_PATH);
      const ctagsPath = await this.ensureRemoteCtags(client);
      this.log(`def-search#${token} ctags at ${ctagsPath}`);

      const gitTop = await this.getRemoteGitTop(client, remoteCwd, token);
      if (token !== this.searchToken) {
        return;
      }
      if (!gitTop) {
        return;
      }
      const tagsPath = posixPath.join(posixPath.dirname(gitTop), 'tags');
      this.log(`def-search#${token} tagsPath=${tagsPath}`);

      const exists = await this.remoteFileExists(client, tagsPath);
      if (!exists) {
        await this.runRemoteCtagsBuild(client, ctagsPath, gitTop, tagsPath, token);
        if (token !== this.searchToken) {
          return;
        }
      } else {
        this.postState({ type: 'state', running: true, ctagsInProgress: false, summary: await this.translate('def_searching') });
      }

      const pattern = `^${escapeRegExpString(query)}\t`;
      const tagsDir = posixPath.dirname(tagsPath);
      const tagsBase = posixPath.basename(tagsPath);
      const rgLine = `cd ${shellEscape(tagsDir)} && ${shellEscape(DEFAULT_REMOTE_RG_PATH)} -N --pcre2 ${shellEscape(pattern)} ${shellEscape(tagsBase)}`;
      this.log(`def-search#${token} rg cmd`);
      const rg = await this.execRemoteCommandWithExitCode(client, rgLine);
      if (token !== this.searchToken) {
        return;
      }
      if (rg.code !== 0 && rg.code !== 1) {
        throw new Error(
          (rg.stderr && rg.stderr.trim().slice(0, 300)) || `ripgrep exited with code ${String(rg.code)}`
        );
      }

      const lines = rg.stdout
        .split(/\r?\n/u)
        .map((l) => l.trim())
        .filter(Boolean);
      this.resultCache.clear();
      for (const line of lines) {
        if (token !== this.searchToken) {
          return;
        }
        const m = this.parseTagResultLine(line, query, workspaceFolder.uri.fsPath, gitTop);
        if (!m) {
          continue;
        }
        let bucket = this.resultCache.get(m.path);
        if (!bucket) {
          bucket = {
            path: m.path,
            relativePath: vscode.workspace.asRelativePath(m.path, false),
            matches: [] as SearchMatch[]
          };
          this.resultCache.set(m.path, bucket);
        }
        bucket.matches.push(m);
      }

      this.pushResults();
      const elapsedMs = Date.now() - startedAt;
      const fileCount = this.resultCache.size;
      const total = Array.from(this.resultCache.values()).reduce((a, f) => a + f.matches.length, 0);
      const summary =
        total === 0
          ? (await this.translate('def_no_results')) + ` (${elapsedMs} ms)`
          : `${fileCount} files, ${total} results (${elapsedMs} ms)`;
      this.postState({ type: 'state', running: false, summary, elapsedMs, ctagsInProgress: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`def-search#${token} error: ${message}`);
      this.postState({ type: 'state', running: false, error: message, ctagsInProgress: false });
    } finally {
      if (client) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      this.activeRemoteClient = undefined;
    }
  }

  private async rebuildTags(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.postState({ type: 'state', running: false, error: 'Open a workspace folder first.' });
      return;
    }
    const settings = this.getSettings();
    if (!this.shouldUseRemoteSearch(settings)) {
      this.postState({
        type: 'state',
        running: false,
        error: 'Remote search is required. Configure SSH host, username, and password in Settings.'
      });
      return;
    }
    this.cancelActiveSearch();
    const token = ++this.searchToken;
    const remoteCwd = this.mapWorkspacePath(workspaceFolder.uri.fsPath);
    this.postState({ type: 'state', running: true, summary: await this.translate('rebuild_tags_start'), ctagsInProgress: false });
    let client: Client | undefined;
    try {
      client = await this.connectRemote(settings);
      this.activeRemoteClient = client;
      await this.uploadBundledRg(client, DEFAULT_REMOTE_RG_PATH);
      const ctagsPath = await this.ensureRemoteCtags(client);
      const gitTop = await this.getRemoteGitTop(client, remoteCwd, token);
      if (token !== this.searchToken) {
        return;
      }
      if (!gitTop) {
        return;
      }
      const tagsPath = posixPath.join(posixPath.dirname(gitTop), 'tags');
      await this.runRemoteCtagsBuild(client, ctagsPath, gitTop, tagsPath, token);
      if (token !== this.searchToken) {
        return;
      }
      this.postState({
        type: 'state',
        running: false,
        summary: await this.translate('rebuild_tags_done'),
        ctagsInProgress: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postState({ type: 'state', running: false, error: message, ctagsInProgress: false });
    } finally {
      if (client) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      this.activeRemoteClient = undefined;
    }
  }
}

function escapeRegExpString(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

class JsonLineBuffer {
  private buffer = '';

  constructor(private readonly onEntry: (entry: any) => void) {}

  public push(text: string): void {
    this.buffer += text;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.onEntry(JSON.parse(line));
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new RipgrepSearchViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RipgrepSearchViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('ripgrepTool.focusSearch', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.ripgrepTool');
      provider.focus();
    })
  );
}

export function deactivate(): void {}

function normalizeSettings(value?: SearchSettings): SearchSettings {
  const remoteHost = String(value?.remoteHost ?? '').trim();
  const remotePortValue = Number(value?.remotePort ?? DEFAULT_REMOTE_PORT);
  const remotePort = Number.isFinite(remotePortValue) && remotePortValue > 0 ? remotePortValue : DEFAULT_REMOTE_PORT;
  const remoteUsername = String(value?.remoteUsername ?? '').trim();
  const remotePassword = String(value?.remotePassword ?? '');
  const includeGlobs = Array.isArray(value?.includeGlobs) ? value.includeGlobs : DEFAULT_INCLUDE_GLOBS;
  const excludeGlobs = Array.isArray(value?.excludeGlobs) ? value.excludeGlobs : DEFAULT_EXCLUDE_GLOBS;

  return {
    remoteHost,
    remotePort,
    remoteUsername,
    remotePassword,
    includeGlobs: normalizeGlobList(includeGlobs, DEFAULT_INCLUDE_GLOBS),
    excludeGlobs: normalizeGlobList(excludeGlobs, DEFAULT_EXCLUDE_GLOBS)
  };
}

function normalizeGlobList(values: string[], fallback: string[]): string[] {
  const normalized = values
    .map((item) => String(item).trim())
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : [...fallback];
}

function splitUserGlobs(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLocalPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function parseTranslationCsv(csvText: string): TranslationRow[] {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: TranslationRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const columns = parseCsvLine(lines[index]);
    if (columns.length < 3) {
      continue;
    }
    rows.push({
      key: columns[0],
      en: columns[1],
      zhCN: columns[2]
    });
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  result.push(current);
  return result;
}

function buildIconUris(context: vscode.ExtensionContext, webview: vscode.Webview): Record<string, unknown> {
  const codicons = Object.fromEntries(
    Object.entries(CODICON_ICON_RELATIVE_PATHS).map(([key, relativePath]) => [
      key,
      webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(relativePath))).toString()
    ])
  );

  const fileTypes = Object.fromEntries(
    Object.entries(FILE_TYPE_ICON_RELATIVE_PATHS).map(([key, relativePath]) => [
      key,
      webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(relativePath))).toString()
    ])
  );

    return {
      ...codicons,
      fileTypes,
      codiconSvg: codicons
    };
  }

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 16; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
