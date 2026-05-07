import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as posixPath from 'path/posix';
import type { Client, ConnectConfig, ClientChannel, SFTPWrapper } from 'ssh2';

type SearchOptions = {
  query: string;
  fileQuery?: string;
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
  remoteSearchPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
};

type SearchMatch = {
  path: string;
  uri?: string;
  relativePath?: string;
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

type SearchTarget = {
  uri: vscode.Uri;
  uriString: string;
  legacyPath: string;
  relativePath: string;
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
  mode: 'content' | 'file';
  items: Array<{
    path: string;
    relativePath: string;
    count: number;
    matches: SearchMatch[];
  }>;
};

type RemoteConnectionResult = {
  ok: boolean;
  message: string;
};

type WorkspaceInfo = {
  displayPath: string;
  gitRootOk: boolean;
  gitError?: string;
};

type TranslationRow = {
  key: string;
  en: string;
  zhCN: string;
};

const SEARCH_SETTINGS_KEY = 'ripgrepTool.searchSettings';
const LOG_FILE_NAME = 'ripgreptool.log';
const MAX_LOG_FILE_BYTES = 1024 * 1024;
const LOG_TRIM_TARGET_BYTES = 768 * 1024;
const DEFAULT_REMOTE_PORT = 22;
const REMOTE_HOME_ROOT = '/home';
const DEFAULT_REMOTE_RG_PATH = '/tmp/ripgreptool-rg';
const SSH_KEEPALIVE_INTERVAL_MS = 15000;
const SSH_KEEPALIVE_COUNT_MAX = 3;
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
  private static readonly LOG_SNIPPET_MAX_CHARS = 500;

  private view?: vscode.WebviewView;
  private readonly outputChannel: vscode.OutputChannel;
  private logWriteQueue: Promise<void> = Promise.resolve();
  private activeRemoteClient?: Client;
  private activeRemoteChannel?: ClientChannel;
  private remoteConnectionPromise?: Promise<Client>;
  private remoteConnectionSignature?: string;
  private remoteRgReadySignature?: string;
  private searchToken = 0;
  private readonly resultCache = new Map<string, SearchFileResult>();
  private refreshTimer?: NodeJS.Timeout;
  private pendingResultPush = false;
  private lastResults: SearchResultMessage = { type: 'results', mode: 'content', items: [] };
  private lastStateMessage: SearchStateMessage = { type: 'state', running: false, summary: '' };
  private workspaceInfo?: WorkspaceInfo;
  private translationsCache?: Record<string, string>;
  private searchResultViewColumn?: vscode.ViewColumn;
  private queuedOpenMatch?: SearchMatch;
  private openingMatch = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Ripgrep Tool');
    this.context.subscriptions.push(this.outputChannel);
    void this.getLogFilePath()
      .then((logPath) => {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] [log-file] ${logPath}`);
      })
      .catch(() => {
        // ignore log path init failure here; normal logging path will report errors later
      });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.context.asAbsolutePath('media'))]
    };

    void this.renderWebview(webviewView).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`webview render failed: ${message}`);
      webviewView.webview.html = this.renderFallbackHtml(`Failed to load Ripgrep Tool view: ${escapeHtml(message)}`);
    });
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          await this.postBootstrap();
          break;
        case 'search':
          if (await this.ensureWorkspaceGitRootForFeature()) {
            await this.runSearch(message.payload as SearchOptions);
          }
          break;
        case 'rebuildTags':
          if (await this.ensureWorkspaceGitRootForFeature()) {
            await this.rebuildTags();
          }
          break;
        case 'open':
          if (await this.ensureWorkspaceGitRootForFeature()) {
            this.enqueueOpenMatch(message.payload as SearchMatch);
          }
          break;
        case 'saveSettings':
          if (await this.ensureWorkspaceGitRootForFeature()) {
            await this.saveSettings(message.payload as SearchSettings);
          }
          break;
        case 'connect':
          if (await this.ensureWorkspaceGitRootForFeature()) {
            await this.connectFromSettings(message.payload as SearchSettings);
          }
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

  public async focusIfWorkspaceGitRoot(): Promise<void> {
    if (!await this.ensureWorkspaceGitRootForFeature()) {
      return;
    }

    this.focus();
  }

  public async openLogFileInEditor(): Promise<void> {
    const logPath = await this.getLogFilePath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const fileHandle = await fs.open(logPath, 'a');
    await fileHandle.close();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  public async revealLogFileInExplorer(): Promise<void> {
    const logPath = await this.getLogFilePath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const fileHandle = await fs.open(logPath, 'a');
    await fileHandle.close();
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logPath));
  }

  public dispose(): void {
    this.searchToken += 1;
    this.cancelActiveSearch();
    this.closeRemoteConnection('provider disposed');
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

  private renderFallbackHtml(message: string): string {
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head><meta charset="UTF-8" /></head>',
      '<body>',
      `<p>${message}</p>`,
      '</body>',
      '</html>'
    ].join('');
  }

  private async postBootstrap(): Promise<void> {
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? 'No workspace';
    const workspaceInfo = await this.getWorkspaceInfo();
    this.view?.webview.postMessage({
      type: 'bootstrap',
      payload: {
        workspaceName,
        workspacePath: workspaceInfo.displayPath,
        gitRootOk: workspaceInfo.gitRootOk,
        gitError: workspaceInfo.gitError,
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

  private async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return {
        displayPath: await this.translate('workspace_none'),
        gitRootOk: false,
        gitError: await this.translate('git_root_required')
      };
    }

    const displayPath = formatWorkspaceDisplayPath(workspaceFolder.uri);
    const gitRootOk = await this.isWorkspaceGitRoot(workspaceFolder.uri);
    const info: WorkspaceInfo = {
      displayPath,
      gitRootOk,
      gitError: gitRootOk ? undefined : await this.translate('git_root_required')
    };
    this.workspaceInfo = info;
    return info;
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

  private async postGitRootRequired(workspaceInfo = this.workspaceInfo): Promise<void> {
    const info = workspaceInfo ?? await this.getWorkspaceInfo();
    const message = info.gitError || await this.translate('git_root_required');
    this.cancelActiveSearch();
    this.resultCache.clear();
    this.lastResults = { type: 'results', mode: 'content', items: [] };
    this.view?.webview.postMessage({ type: 'gitRootRequired', payload: { message, workspacePath: info.displayPath } });
    this.postState({ type: 'state', running: false, error: message });
  }

  private async ensureWorkspaceGitRootForFeature(): Promise<boolean> {
    const workspaceInfo = await this.getWorkspaceInfo();
    if (workspaceInfo.gitRootOk) {
      return true;
    }

    await this.postGitRootRequired(workspaceInfo);
    return false;
  }

  private async runSearch(options: SearchOptions): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.postState({ type: 'state', running: false, error: 'Open a workspace folder first.' });
      return;
    }
    const workspaceInfo = await this.getWorkspaceInfo();
    if (!workspaceInfo.gitRootOk) {
      await this.postGitRootRequired(workspaceInfo);
      return;
    }

    const fileQuery = options.fileQuery?.trim() ?? '';
    const query = options.query.trim();
    if (!query && !fileQuery) {
      const previousToken = this.searchToken;
      this.searchToken += 1;
      this.cancelActiveSearch(previousToken);
      this.resultCache.clear();
      this.lastResults = { type: 'results', mode: 'content', items: [] };
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

    const previousToken = this.searchToken;
    const token = previousToken + 1;
    this.searchToken = token;
    this.cancelActiveSearch(previousToken);
    this.resultCache.clear();
    this.lastResults = { type: 'results', mode: fileQuery ? 'file' : 'content', items: [] };
    this.view?.webview.postMessage(this.lastResults);

    let remoteCwd: string;
    try {
      remoteCwd = await this.resolveRemoteCwd(settings, workspaceFolder);
      await this.ensureRemoteGitRoot(settings, remoteCwd, token);
    } catch (error) {
      this.postState({ type: 'state', running: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (fileQuery) {
      await this.runFileSearch(token, fileQuery, options, settings, workspaceFolder, remoteCwd);
      return;
    }

    const config = vscode.workspace.getConfiguration('ripgrepTool');
    const maxResultsRaw = config.get<number>('maxResults', 0);
    const maxCountPerFile = maxResultsRaw <= 0 ? 0 : Math.max(1, Math.floor(maxResultsRaw));
    const contextLines = Math.max(0, config.get<number>('contextLines', 0));
    const refreshMs = Math.max(4, config.get<number>('resultRefreshMs', 80));
    const threads = Math.max(0, config.get<number>('threads', 0));
    const args = this.buildArgs(options, settings, maxCountPerFile, contextLines, threads);
    const resultPathFilter = createResultPathFilter(options, settings);

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
      const target = this.createWorkspaceTarget(workspaceFolder, filePath);
      const relativePath = target.relativePath;
      if (!resultPathFilter(relativePath)) {
        return;
      }
      const submatches = data.submatches as Array<{ start: number; end: number }>;
      const lines = data.lines.text as string;
      const lineText = lines.replace(/\r?\n$/, '');
      const lineNumber = data.line_number as number;

      let bucket = this.resultCache.get(target.uriString);
      if (!bucket) {
        bucket = {
          path: target.legacyPath,
          relativePath,
          matches: []
        };
        this.resultCache.set(target.uriString, bucket);
      }

      for (const submatch of submatches) {
        totalMatches += 1;
        const start = utf8ByteOffsetToUtf16Index(lineText, submatch.start);
        const end = utf8ByteOffsetToUtf16Index(lineText, submatch.end);
        bucket.matches.push({
          path: target.legacyPath,
          uri: target.uriString,
          relativePath: target.relativePath,
          line: lineNumber,
          column: start + 1,
          endColumn: end + 1,
          preview: lineText
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
      if (token === this.searchToken) {
        this.postState({ type: 'state', running: false, error: message });
      }
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
      const client = await this.getRemoteClient(settings);
      if (token !== this.searchToken) {
        return undefined;
      }
      this.log(`search#${token} ssh connected (${Date.now() - connectStartedAt} ms)`);

    const prepareStartedAt = Date.now();
    await this.uploadBundledRg(client, DEFAULT_REMOTE_RG_PATH);
    if (token !== this.searchToken) {
      return undefined;
    }
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
          if (this.activeRemoteChannel === stream) {
            this.activeRemoteChannel = undefined;
          }
          resolve(code);
        });
        stream.on('error', (streamError: Error) => {
          reject(streamError);
        });
      });
    });
  }

  private async runFileSearch(
    token: number,
    fileQuery: string,
    options: SearchOptions,
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    remoteCwd: string
  ): Promise<void> {
    const startedAt = Date.now();
    let stderr = '';
    let totalFiles = 0;

    this.log(`file-search#${token} start`);
    this.log(`file-search#${token} query="${fileQuery}" cwd="${workspaceFolder.uri.fsPath}"`);
    this.log(`file-search#${token} remote cwd="${remoteCwd}"`);
    this.postState({ type: 'state', running: true, summary: 'Searching files...' });

    try {
      const client = await this.getRemoteClient(settings);
      if (token !== this.searchToken) {
        return;
      }
      this.log(`file-search#${token} ssh connected (${Date.now() - startedAt} ms)`);

      await this.uploadBundledRg(client, DEFAULT_REMOTE_RG_PATH);
      if (token !== this.searchToken) {
        return;
      }
      this.log(`file-search#${token} rg prepared (${Date.now() - startedAt} ms)`);

      const args = this.buildFileSearchArgs(options, settings);
      const command = this.buildRemoteCommand(DEFAULT_REMOTE_RG_PATH, remoteCwd, args);
      this.log(`file-search#${token} remote command=${command}`);

      const result = await this.execRemoteCommandWithExitCode(client, command, true);
      if (token !== this.searchToken) {
        return;
      }
      stderr = result.stderr;

      if (result.code !== 0 && result.code !== 1) {
        this.log(`file-search#${token} failed code=${result.code ?? 'unknown'} stderr=${stderr.trim()}`);
        this.postState({
          type: 'state',
          running: false,
          error: stderr.trim() || `ripgrep exited with code ${result.code ?? 'unknown'}.`
        });
        return;
      }

      const resultPathFilter = createResultPathFilter(options, settings);
      const matcher = createFileQueryMatcher(fileQuery, options.caseSensitive);
      const lines = result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);

      this.resultCache.clear();
      for (const remoteRelativePath of lines) {
        const relativePath = remoteRelativePath.replace(/\\/gu, '/');
        if (!resultPathFilter(relativePath) || !matcher(relativePath)) {
          continue;
        }
        const target = this.createWorkspaceTarget(workspaceFolder, relativePath);
        const displayPath = target.relativePath;
        this.resultCache.set(target.uriString, {
          path: target.legacyPath,
          relativePath: displayPath,
          matches: [{
            path: target.legacyPath,
            uri: target.uriString,
            relativePath: target.relativePath,
            line: 1,
            column: 1,
            endColumn: 2,
            preview: displayPath
          }]
        });
        totalFiles += 1;
      }

      this.pushResults('file');
      const elapsedMs = Date.now() - startedAt;
      this.log(`file-search#${token} done code=${result.code} total=${elapsedMs} ms, files=${totalFiles}`);
      const summary = totalFiles === 0
        ? `No files (${elapsedMs} ms)`
        : `${totalFiles} files (${elapsedMs} ms)`;
      this.postState({ type: 'state', running: false, summary, elapsedMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`file-search#${token} exception: ${message}`);
      if (token === this.searchToken) {
        this.postState({ type: 'state', running: false, error: message });
      }
    } finally {
      if (token === this.searchToken) {
        this.activeRemoteChannel = undefined;
      }
    }
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
    if (options.exclude.trim()) {
      for (const glob of splitUserGlobs(options.exclude)) {
        args.push('--glob', `!${glob}`);
      }
    }

    args.push(options.query);
    args.push('.');
    return args;
  }

  private buildFileSearchArgs(options: SearchOptions, settings: SearchSettings): string[] {
    const args = ['--files', '--hidden'];
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
    return args;
  }

  private createWorkspaceTarget(workspaceFolder: vscode.WorkspaceFolder, remoteRelativePath: string): SearchTarget {
    const relativePath = normalizeSearchPath(remoteRelativePath);
    const uri = joinWorkspaceUri(workspaceFolder.uri, relativePath);
    return {
      uri,
      uriString: uri.toString(),
      legacyPath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
      relativePath
    };
  }

  private pushResults(mode: 'content' | 'file' = 'content'): void {
    this.pendingResultPush = false;
    this.lastResults = {
      type: 'results',
      mode,
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

  private enqueueOpenMatch(match: SearchMatch): void {
    this.queuedOpenMatch = match;
    if (this.openingMatch) {
      return;
    }
    void this.drainOpenMatchQueue();
  }

  private async drainOpenMatchQueue(): Promise<void> {
    this.openingMatch = true;
    try {
      while (this.queuedOpenMatch) {
        const match = this.queuedOpenMatch;
        this.queuedOpenMatch = undefined;
        await this.openMatch(match);
      }
    } finally {
      this.openingMatch = false;
      if (this.queuedOpenMatch) {
        void this.drainOpenMatchQueue();
      }
    }
  }

  private async openMatch(match: SearchMatch): Promise<void> {
    const nextUri = this.getMatchUri(match);
    const selection = this.createMatchSelection(match);
    const showOptions: vscode.TextDocumentShowOptions = {
      preview: true,
      preserveFocus: false,
      selection
    };
    this.invalidateSearchResultViewColumnIfEmpty();
    if (this.searchResultViewColumn !== undefined) {
      showOptions.viewColumn = this.searchResultViewColumn;
    }

    const startedAt = Date.now();
    this.debugLog(`open start uri=${nextUri.toString()} line=${match.line}`);
    try {
      const editor = await vscode.window.showTextDocument(nextUri, showOptions);
      this.searchResultViewColumn = editor.viewColumn;
      editor.selection = selection;
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
      this.debugLog(`open done elapsed=${Date.now() - startedAt} ms uri=${nextUri.toString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`open failed uri=${nextUri.toString()} path=${match.path} error=${message}`);
      void vscode.window.showWarningMessage(await this.formatTranslation('open_failed', { message }));
    }
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

  private updateEditorSelection(editor: vscode.TextEditor, match: SearchMatch): void {
    const selection = this.createMatchSelection(match);
    editor.selection = selection;
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  }

  private createMatchSelection(match: SearchMatch): vscode.Selection {
    const selection = new vscode.Selection(
      match.line - 1,
      match.column - 1,
      match.line - 1,
      Math.max(match.column, match.endColumn - 1)
    );
    return selection;
  }

  private getMatchUri(match: SearchMatch): vscode.Uri {
    if (match.uri) {
      return vscode.Uri.parse(match.uri, true);
    }
    return vscode.Uri.file(match.path);
  }

  private cancelActiveSearch(token: number = this.searchToken): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.pendingResultPush = false;
    if (this.activeRemoteChannel) {
      this.log(`search#${token} remote command cancel requested`);
      this.activeRemoteChannel.close();
      this.activeRemoteChannel = undefined;
    }
  }

  private shouldUseRemoteSearch(settings: SearchSettings): boolean {
    return Boolean(settings.remoteHost && settings.remoteUsername && settings.remotePassword);
  }

  private async resolveRemoteCwd(settings: SearchSettings, workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
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

    throw new Error(await this.translate('err_remote_search_path_required'));
  }

  private async getRemoteClient(settings: SearchSettings): Promise<Client> {
    const signature = this.getRemoteConnectionSignature(settings);
    if (this.activeRemoteClient && this.remoteConnectionSignature === signature) {
      return this.activeRemoteClient;
    }
    if (this.remoteConnectionPromise && this.remoteConnectionSignature === signature) {
      return await this.remoteConnectionPromise;
    }

    this.closeRemoteConnection('ssh settings changed');
    this.remoteConnectionSignature = signature;
    const connectionPromise = this.connectRemote(settings)
      .then((client) => {
        if (this.remoteConnectionPromise !== connectionPromise || this.remoteConnectionSignature !== signature) {
          client.end();
          throw new Error('SSH connection was replaced.');
        }
        this.activeRemoteClient = client;
        client.once('end', () => {
          this.debugLog('ssh connection ended by remote');
          this.clearRemoteConnection(client, signature);
        });
        client.once('close', () => {
          this.debugLog('ssh connection closed');
          this.clearRemoteConnection(client, signature);
        });
        client.on('error', (error) => {
          this.debugLog(`ssh connection error: ${error.message}`);
          this.clearRemoteConnection(client, signature);
        });
        return client;
      })
      .catch((error) => {
        if (this.remoteConnectionPromise === connectionPromise) {
          this.clearRemoteConnection();
        }
        throw error;
      });
    this.remoteConnectionPromise = connectionPromise;
    return await connectionPromise;
  }

  private getRemoteConnectionSignature(settings: SearchSettings): string {
    return JSON.stringify({
      host: settings.remoteHost,
      port: settings.remotePort,
      username: settings.remoteUsername,
      password: settings.remotePassword
    });
  }

  private clearRemoteConnection(client?: Client, signature?: string): void {
    if (signature && this.remoteConnectionSignature !== signature) {
      return;
    }
    if (client && this.activeRemoteClient && this.activeRemoteClient !== client) {
      return;
    }
    this.activeRemoteClient = undefined;
    this.remoteConnectionPromise = undefined;
    this.remoteConnectionSignature = undefined;
    this.remoteRgReadySignature = undefined;
  }

  private closeRemoteConnection(reason: string): void {
    const client = this.activeRemoteClient;
    this.activeRemoteClient = undefined;
    this.remoteConnectionPromise = undefined;
    this.remoteConnectionSignature = undefined;
    this.remoteRgReadySignature = undefined;
    if (!client) {
      return;
    }
    this.debugLog(`ssh connection closing: ${reason}`);
    try {
      client.end();
    } catch {
      // ignore close failures
    }
  }

  private async connectRemote(settings: SearchSettings): Promise<Client> {
    this.debugLog(
      `ssh connect start host=${settings.remoteHost || '<empty>'}:${settings.remotePort} user=${settings.remoteUsername || '<empty>'}`
    );
    const startedAt = Date.now();
    const ssh2 = await import('ssh2');
    const connectConfig: ConnectConfig = {
      host: settings.remoteHost,
      port: settings.remotePort,
      username: settings.remoteUsername,
      password: settings.remotePassword,
      readyTimeout: 20000,
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX
    };

    return await new Promise<Client>((resolve, reject) => {
      const client = new ssh2.Client();
      client.on('ready', () => {
        this.debugLog(`ssh connect ready (${Date.now() - startedAt} ms)`);
        resolve(client);
      });
      client.on('error', (error) => {
        this.debugLog(`ssh connect error: ${error.message}`);
        reject(error);
      });
      client.connect(connectConfig);
    });
  }

  private async uploadBundledRg(client: Client, remoteRgPath: string): Promise<void> {
    const signature = this.remoteConnectionSignature;
    const localRgPath = this.context.asAbsolutePath(BUNDLED_REMOTE_RG_RELATIVE_PATH);
    const localRgStat = await fs.stat(localRgPath);
    const bundledSignature = `${remoteRgPath}|${localRgStat.size}|${localRgStat.mtimeMs}`;
    const readySignature = signature ? `${signature}|${bundledSignature}` : undefined;
    if (readySignature && this.remoteRgReadySignature === readySignature) {
      this.debugLog(`remote rg readiness cache hit at ${remoteRgPath}`);
      return;
    }

    this.log(`checking bundled rg at ${localRgPath}`);
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
    if (readySignature) {
      this.remoteRgReadySignature = readySignature;
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
    this.debugLog(`remote exec start: ${command}`);
    const startedAt = Date.now();
    return await new Promise<{ stdout: string; stderr: string; code: number | undefined }>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          this.debugLog(`remote exec spawn error: ${error.message}`);
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
          this.debugLog(
            `remote exec done code=${code ?? 'unknown'} elapsed=${Date.now() - startedAt} ms stdout="${this.summarizeLogText(stdout)}" stderr="${this.summarizeLogText(stderr)}"`
          );
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

  private async connectFromSettings(payload: SearchSettings): Promise<void> {
    const settings = normalizeSettings(payload);
    this.log(
      `connection payload host=${settings.remoteHost || '<empty>'}:${settings.remotePort} user=${settings.remoteUsername || '<empty>'} passwordPresent=${settings.remotePassword ? 'true' : 'false'}`
    );
    if (!this.shouldUseRemoteSearch(settings)) {
      this.postConnectionResult({ ok: false, message: await this.translate('connection_required') });
      return;
    }

    const startedAt = Date.now();
    try {
      const reused = Boolean(this.activeRemoteClient && this.remoteConnectionSignature === this.getRemoteConnectionSignature(settings));
      const client = await this.getRemoteClient(settings);
      const elapsedMs = Date.now() - startedAt;
      this.log(`connect ok (${elapsedMs} ms) reused=${reused ? 'true' : 'false'} clientReady=${client ? 'true' : 'false'}`);
      this.postConnectionResult({
        ok: true,
        message: await this.formatTranslation(reused ? 'connection_reused' : 'connection_ready', { elapsedMs })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`connection failed: ${message}`);
      this.postConnectionResult({ ok: false, message });
    }
  }

  private postState(message: SearchStateMessage): void {
    this.lastStateMessage = message;
    this.view?.webview.postMessage(message);
  }

  private postConnectionResult(result: RemoteConnectionResult): void {
    this.view?.webview.postMessage({ type: 'connectionResult', payload: result });
  }

  private log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.outputChannel.appendLine(line);
    this.enqueueLogWrite(`${line}\n`);
  }

  private enqueueLogWrite(text: string): void {
    this.logWriteQueue = this.logWriteQueue
      .then(async () => {
        const logPath = await this.getLogFilePath();
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        await fs.appendFile(logPath, text, 'utf8');
        await this.trimLogFileIfNeeded(logPath);
      })
      .catch((error) => {
        this.outputChannel.appendLine(
          `[${new Date().toISOString()}] [log-file-error] ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  private async getLogFilePath(): Promise<string> {
    const storageUri = this.context.globalStorageUri;
    const storagePath = storageUri.scheme === 'file' ? storageUri.fsPath : this.context.globalStoragePath;
    return path.join(storagePath, LOG_FILE_NAME);
  }

  private async trimLogFileIfNeeded(logPath: string): Promise<void> {
    const stat = await fs.stat(logPath).catch(() => undefined);
    if (!stat || stat.size <= MAX_LOG_FILE_BYTES) {
      return;
    }

    const handle = await fs.open(logPath, 'r');
    try {
      const start = Math.max(0, stat.size - LOG_TRIM_TARGET_BYTES);
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let text = buffer.toString('utf8');
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0 && start > 0) {
        text = text.slice(firstNewline + 1);
      }
      await fs.writeFile(logPath, text, 'utf8');
    } finally {
      await handle.close();
    }
  }

  private debugLog(message: string): void {
    if (!this.isVerboseLoggingEnabled()) {
      return;
    }
    this.log(`[verbose] ${message}`);
  }

  private isVerboseLoggingEnabled(): boolean {
    return vscode.workspace.getConfiguration('ripgrepTool').get<boolean>('verboseLogging', true);
  }

  private summarizeLogText(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }
    if (normalized.length <= RipgrepSearchViewProvider.LOG_SNIPPET_MAX_CHARS) {
      return normalized;
    }
    return `${normalized.slice(0, RipgrepSearchViewProvider.LOG_SNIPPET_MAX_CHARS)}...`;
  }

  private async translate(key: string): Promise<string> {
    const map = await this.getTranslations();
    return map[key] || key;
  }

  private async formatTranslation(key: string, values: Record<string, string | number>): Promise<string> {
    let text = await this.translate(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }

  private createTargetFromRemotePath(
    workspaceFolder: vscode.WorkspaceFolder,
    remoteFileAbs: string,
    remoteCwd: string
  ): SearchTarget {
    const relativePath = getRelativeRemotePath(remoteFileAbs, remoteCwd);
    if (relativePath !== undefined) {
      return this.createWorkspaceTarget(workspaceFolder, relativePath);
    }

    throw new Error(`Remote path is outside the workspace root.`);
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

  private async ensureRemoteGitRoot(settings: SearchSettings, remoteCwd: string, token: number): Promise<void> {
    const client = await this.getRemoteClient(settings);
    if (token !== this.searchToken) {
      return;
    }
    const cmd = `cd ${shellEscape(remoteCwd)} && git rev-parse --show-toplevel`;
    const r = await this.execRemoteCommandWithExitCode(client, cmd);
    if (token !== this.searchToken) {
      return;
    }
    const top = r.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
    if (r.code != null && r.code !== 0 || !top || normalizeRemotePath(top) !== normalizeRemotePath(remoteCwd)) {
      throw new Error(await this.translate('git_root_required'));
    }
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
    command: string,
    trackAsActive = false
  ): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
    this.debugLog(`remote exec(exitcode) start: ${command}`);
    const startedAt = Date.now();
    return await new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          this.debugLog(`remote exec(exitcode) spawn error: ${error.message}`);
          reject(error);
          return;
        }
        if (trackAsActive) {
          this.activeRemoteChannel = stream;
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
          if (trackAsActive && this.activeRemoteChannel === stream) {
            this.activeRemoteChannel = undefined;
          }
          this.debugLog(
            `remote exec(exitcode) done code=${code ?? 'unknown'} elapsed=${Date.now() - startedAt} ms stdout="${this.summarizeLogText(stdout)}" stderr="${this.summarizeLogText(stderr)}"`
          );
          resolve({ stdout, stderr, code: code == null ? undefined : code });
        });
        stream.on('error', (streamError: Error) => {
          if (trackAsActive && this.activeRemoteChannel === stream) {
            this.activeRemoteChannel = undefined;
          }
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
            summary: tail.trim() ? `${buildSummary} - ${tail.trim()}` : buildSummary
          });
        };
        stream.on('data', (c: Buffer | string) => {
          pushChunk(Buffer.isBuffer(c) ? c.toString('utf8') : c);
        });
        stream.stderr.on('data', (c: Buffer | string) => {
          pushChunk(Buffer.isBuffer(c) ? c.toString('utf8') : c);
        });
        stream.on('close', (c: number | undefined) => {
          if (this.activeRemoteChannel === stream) {
            this.activeRemoteChannel = undefined;
          }
          resolve({ code: c, logText: acc });
        });
        stream.on('error', (e: Error) => {
          if (this.activeRemoteChannel === stream) {
            this.activeRemoteChannel = undefined;
          }
          reject(e);
        });
      });
    });
  }

  private parseTagResultLine(
    line: string,
    query: string,
    workspaceFolder: vscode.WorkspaceFolder,
    remoteCwd: string,
    tagsBaseRemote: string
  ): SearchMatch | null {
    this.debugLog(`parseTagResultLine query="${query}" line="${line.substring(0, 80)}..."`);
    const firstTab = line.indexOf('\t');
    if (firstTab <= 0) {
      this.debugLog('parseTagResultLine skipped: no first tab');
      return null;
    }
    const name = line.slice(0, firstTab);
    if (name !== query) {
      this.debugLog(`parseTagResultLine skipped: name="${name}"`);
      return null;
    }
    const rest = line.slice(firstTab + 1);
    const secondTab = rest.indexOf('\t');
    if (secondTab <= 0) {
      this.debugLog('parseTagResultLine skipped: no second tab');
      return null;
    }
    const fileRel = rest.slice(0, secondTab);
    const after = rest.slice(secondTab + 1);
    const lineNumMatch = /line:(\d+)/u.exec(after);
    const lineNo = lineNumMatch ? Number.parseInt(lineNumMatch[1] ?? '1', 10) : 1;
    const semi = after.indexOf(';"');
    const excmd = semi >= 0 ? after.slice(0, semi) : after;
    const preview = excmd.length > 200 ? excmd.slice(0, 200) + '...' : excmd;
    // ctags `--tag-relative=yes` writes file paths relative to the tags file directory.
    // Resolve against that directory so preview/open works even when the tags file is not
    // stored inside the repo root.
    const remoteFileAbs = fileRel.startsWith('/')
      ? fileRel
      : posixPath.resolve(tagsBaseRemote, fileRel);
    let target: SearchTarget;
    try {
      target = this.createTargetFromRemotePath(workspaceFolder, remoteFileAbs, remoteCwd);
    } catch (error) {
      this.debugLog(`parseTagResultLine skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const result = {
      path: target.legacyPath,
      uri: target.uriString,
      relativePath: target.relativePath,
      line: lineNo,
      column: 1,
      endColumn: 2,
      preview: preview || name
    };
    return result;
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
    const definitionPathFilter = createResultPathFilter(options, settings);
    this.postState({
      type: 'state',
      running: true,
      summary: await this.translate('def_searching'),
      ctagsInProgress: false
    });

    try {
      const client = await this.getRemoteClient(settings);
      if (token !== this.searchToken) {
        return;
      }
      this.log(`def-search#${token} ssh connected`);
      await this.uploadBundledRg(client, DEFAULT_REMOTE_RG_PATH);
      if (token !== this.searchToken) {
        return;
      }
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
        const m = this.parseTagResultLine(line, query, workspaceFolder, remoteCwd, tagsDir);
        if (!m) {
          continue;
        }
        const relativePath = m.relativePath ?? vscode.workspace.asRelativePath(m.path, false);
        if (!definitionPathFilter(relativePath)) {
          continue;
        }
        const cacheKey = m.uri ?? m.path;
        let bucket = this.resultCache.get(cacheKey);
        if (!bucket) {
          bucket = {
            path: m.path,
            relativePath,
            matches: [] as SearchMatch[]
          };
          this.resultCache.set(cacheKey, bucket);
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
      if (token === this.searchToken) {
        this.postState({ type: 'state', running: false, error: message, ctagsInProgress: false });
      }
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
    const previousToken = this.searchToken;
    const token = previousToken + 1;
    this.searchToken = token;
    this.cancelActiveSearch(previousToken);
    let remoteCwd: string;
    try {
      remoteCwd = await this.resolveRemoteCwd(settings, workspaceFolder);
    } catch (error) {
      this.postState({ type: 'state', running: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.postState({ type: 'state', running: true, summary: await this.translate('rebuild_tags_start'), ctagsInProgress: false });
    try {
      const client = await this.getRemoteClient(settings);
      if (token !== this.searchToken) {
        return;
      }
      await this.uploadBundledRg(client, DEFAULT_REMOTE_RG_PATH);
      if (token !== this.searchToken) {
        return;
      }
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
      if (token === this.searchToken) {
        this.postState({ type: 'state', running: false, error: message, ctagsInProgress: false });
      }
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
    provider,
    vscode.window.registerWebviewViewProvider(RipgrepSearchViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('ripgrepTool.focusSearch', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.ripgrepTool');
      await provider.focusIfWorkspaceGitRoot();
    }),
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

function normalizeSettings(value?: SearchSettings): SearchSettings {
  const remoteHost = String(value?.remoteHost ?? '').trim();
  const remotePortValue = Number(value?.remotePort ?? DEFAULT_REMOTE_PORT);
  const remotePort = Number.isFinite(remotePortValue) && remotePortValue > 0 ? remotePortValue : DEFAULT_REMOTE_PORT;
  const remoteUsername = String(value?.remoteUsername ?? '').trim();
  const remotePassword = String(value?.remotePassword ?? '');
  const remoteSearchPath = String(value?.remoteSearchPath ?? '').trim();
  const includeGlobs = Array.isArray(value?.includeGlobs) ? value.includeGlobs : DEFAULT_INCLUDE_GLOBS;
  const excludeGlobs = Array.isArray(value?.excludeGlobs) ? value.excludeGlobs : DEFAULT_EXCLUDE_GLOBS;

  return {
    remoteHost,
    remotePort,
    remoteUsername,
    remotePassword,
    remoteSearchPath,
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

function createResultPathFilter(
  options: SearchOptions,
  settings: SearchSettings
): (relativePath: string) => boolean {
  const settingsIncludeGlobs = settings.includeGlobs;
  const userIncludeGlobs = splitUserGlobs(options.include);
  const excludeGlobs = [...settings.excludeGlobs, ...splitUserGlobs(options.exclude)];

  return (relativePath: string): boolean => {
    const normalizedPath = normalizeSearchPath(relativePath);
    const matchesSettingsInclude =
      settingsIncludeGlobs.length === 0 || settingsIncludeGlobs.some((glob) => matchSearchGlob(normalizedPath, glob));
    if (!matchesSettingsInclude) {
      return false;
    }
    const matchesUserInclude =
      userIncludeGlobs.length === 0 || userIncludeGlobs.some((glob) => matchSearchGlob(normalizedPath, glob));
    if (!matchesUserInclude) {
      return false;
    }
    return !excludeGlobs.some((glob) => matchSearchGlob(normalizedPath, glob));
  };
}

function createFileQueryMatcher(query: string, caseSensitive: boolean): (relativePath: string) => boolean {
  const normalizedQuery = normalizeSearchPath(query);
  if (!normalizedQuery) {
    return () => true;
  }

  const needle = caseSensitive ? normalizedQuery : normalizedQuery.toLowerCase();
  return (relativePath: string): boolean => {
    const normalizedPath = normalizeSearchPath(relativePath);
    const haystack = caseSensitive ? normalizedPath : normalizedPath.toLowerCase();
    const baseName = haystack.slice(haystack.lastIndexOf('/') + 1);
    return haystack.includes(needle) || baseName.includes(needle);
  };
}

function matchSearchGlob(relativePath: string, glob: string): boolean {
  const normalizedPath = normalizeSearchPath(relativePath);
  const normalizedGlob = normalizeSearchPath(glob);
  if (!normalizedPath || !normalizedGlob) {
    return false;
  }

  if (!normalizedGlob.includes('/')) {
    const segmentRegex = globSegmentToRegex(normalizedGlob);
    return normalizedPath.split('/').some((segment) => segmentRegex.test(segment));
  }

  if (!/[?*\[]/.test(normalizedGlob)) {
    return normalizedPath === normalizedGlob || normalizedPath.startsWith(`${normalizedGlob}/`);
  }

  return globPathToRegex(normalizedGlob).test(normalizedPath);
}

function normalizeSearchPath(value: string): string {
  return String(value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function inferRemoteWorkspacePath(localWorkspacePath: string, remoteUsername: string): string | undefined {
  return inferRemotePathFromUnc(localWorkspacePath) ?? inferRemotePathFromDrive(localWorkspacePath, remoteUsername);
}

function inferRemotePathFromUnc(localWorkspacePath: string): string | undefined {
  const normalized = String(localWorkspacePath).trim().replace(/\\/gu, '/');
  if (!normalized.startsWith('//')) {
    return undefined;
  }

  const parts = normalized.replace(/^\/+/u, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  const shareName = parts[1] ?? '';
  return buildRemoteHomePath(shareName, parts.slice(2).join('/'));
}

function inferRemotePathFromDrive(localWorkspacePath: string, remoteUsername: string): string | undefined {
  const match = /^([a-zA-Z]):[\\/]*(.*)$/u.exec(String(localWorkspacePath).trim());
  if (!match) {
    return undefined;
  }

  return buildRemoteHomePath(remoteUsername, match[2] ?? '');
}

function buildRemoteHomePath(userName: string, relativePath: string): string | undefined {
  const normalizedUserName = normalizeSearchPath(userName);
  if (!normalizedUserName || normalizedUserName.includes('/')) {
    return undefined;
  }

  const homePath = posixPath.join(REMOTE_HOME_ROOT, normalizedUserName);
  const normalizedRelativePath = normalizeSearchPath(relativePath);
  return normalizedRelativePath ? posixPath.join(homePath, normalizedRelativePath) : homePath;
}

function formatWorkspaceDisplayPath(uri: vscode.Uri): string {
  if (uri.scheme === 'file') {
    return uri.fsPath;
  }
  if ((uri.scheme === 'vscode-remote' || vscode.env.remoteName) && uri.path) {
    return uri.path;
  }
  return uri.toString();
}

function joinWorkspaceUri(workspaceUri: vscode.Uri, relativePath: string): vscode.Uri {
  const normalizedRelativePath = normalizeSearchPath(relativePath);
  if (workspaceUri.scheme === 'file') {
    return vscode.Uri.file(path.join(workspaceUri.fsPath, normalizedRelativePath.replace(/\//gu, path.sep)));
  }

  const workspacePath = workspaceUri.path.replace(/\/+$/u, '');
  return workspaceUri.with({
    path: normalizedRelativePath ? `${workspacePath}/${normalizedRelativePath}` : workspacePath
  });
}

function getRelativeRemotePath(remotePath: string, remoteBase: string): string | undefined {
  const normalizedPath = normalizeRemotePath(remotePath);
  const normalizedBase = normalizeRemotePath(remoteBase);
  if (!normalizedPath || !normalizedBase) {
    return undefined;
  }
  if (normalizedPath === normalizedBase) {
    return '';
  }
  if (!normalizedPath.startsWith(`${normalizedBase}/`)) {
    return undefined;
  }
  return normalizedPath.slice(normalizedBase.length + 1);
}

function normalizeRemotePath(value: string): string {
  return String(value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/u, '');
}

function isPosixAbsolutePath(value: string): boolean {
  return value.replace(/\\/g, '/').startsWith('/');
}

function globSegmentToRegex(glob: string): RegExp {
  return new RegExp(`^${globToRegexSource(glob, false)}$`, 'i');
}

function globPathToRegex(glob: string): RegExp {
  return new RegExp(`^${globToRegexSource(glob, true)}$`, 'i');
}

function globToRegexSource(glob: string, allowPathSeparator: boolean): string {
  let result = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];

    if (char === '*') {
      if (allowPathSeparator && next === '*') {
        const afterNext = glob[index + 2];
        if (afterNext === '/') {
          result += '(?:.*/)?';
          index += 2;
          continue;
        }
        result += '.*';
        index += 1;
        continue;
      }
      result += allowPathSeparator ? '[^/]*' : '.*';
      continue;
    }

    if (char === '?') {
      result += allowPathSeparator ? '[^/]' : '.';
      continue;
    }

    if (char === '[') {
      const closing = glob.indexOf(']', index + 1);
      if (closing > index + 1) {
        result += glob.slice(index, closing + 1);
        index = closing;
        continue;
      }
    }

    result += escapeRegExpString(char);
  }
  return result;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function utf8ByteOffsetToUtf16Index(text: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }

  let utf8Bytes = 0;
  let utf16Index = 0;
  while (utf16Index < text.length && utf8Bytes < byteOffset) {
    const codePoint = text.codePointAt(utf16Index);
    if (codePoint === undefined) {
      break;
    }

    const char = String.fromCodePoint(codePoint);
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (utf8Bytes + charBytes > byteOffset) {
      return utf16Index;
    }

    utf8Bytes += charBytes;
    utf16Index += char.length;
  }

  return utf16Index;
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
