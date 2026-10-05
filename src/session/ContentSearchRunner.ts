import * as vscode from 'vscode';
import type { ContentSearchEntry } from './ContentSearchProcessor';
import type { SearchOptions, SearchSettings } from '../core/types';
import type { SearchResultStore } from '../search/SearchResultStore';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteExecResult } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import type { Client } from 'ssh2';
import type { ResolvedSearchRepository, WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { SessionLogger } from './SessionLogger';
import { ContentSearchProcessor } from './ContentSearchProcessor';
import { buildContentSearchArgs } from './rgArgs';
import { buildRemoteCommand } from '../remote/commands';
import { createResultPathFilter } from '../core/glob';
import type { SearchSession } from './SearchSession';
import type { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import type { ConnectionController } from './ConnectionController';
import { StreamingLineProcessor } from '../search/StreamingLineProcessor';
import { filterRipgrepStderr, isIgnorableRipgrepFailure, isRemoteExecutableMissing } from './rgDiagnostics';

export type ContentSearchConfig = {
  contextLines: number;
  threads: number;
  resultRefreshMs: number;
  definitionExcludeGlobs: string[];
  /** 匹配总数上限，达到后关闭远端通道停止流式输出；0 表示不限制。 */
  maxResults: number;
};

export class ContentSearchRunner {
  constructor(
    private readonly session: SearchSession,
    private readonly resultStore: SearchResultStore,
    private readonly connectionController: ConnectionController,
    private readonly workspaceResolver: WorkspaceResolver,
    private readonly remoteExecutor: RemoteExecutor,
    private readonly remoteToolInstaller: RemoteToolInstaller,
    private readonly logger: SessionLogger,
    private readonly config: ContentSearchConfig
  ) {}

  public async execute(
    token: number,
    options: SearchOptions,
    settings: SearchSettings,
    repository: ResolvedSearchRepository,
    messageRouter: WebviewMessageRouter,
    finalize = true,
    searchStartedAt = Date.now()
  ): Promise<boolean> {
    const startedAt = searchStartedAt;
    let totalMatches = 0;
    const query = options.query.trim();
    this.resultStore.setQuery(query);
    const maxResults = this.config.maxResults;
    let truncated = false;
    const remoteCwd = repository.remoteCwd;
    const args = buildContentSearchArgs(options, settings, {
      contextLines: this.config.contextLines,
      threads: this.config.threads
    });
    const resultPathFilter = createResultPathFilter(options, settings);

    this.logger.log(`search#${token} start`);
    this.logger.log(`search#${token} mode=remote query="${query}"`);
    this.logger.log(`search#${token} requestId=${options.requestId ?? 'none'} trigger=${options.triggerSource ?? 'unknown'}`);
    this.logger.log(`search#${token} repository="${repository.workspaceRelativePath || '.'}" remote cwd="${remoteCwd}"`);
    this.session.postPhase('Connecting to SSH...');

    try {
      const client = await this.connectionController.getOrCreateClient(settings);
      if (!this.session.isCurrent(token)) {
        return false;
      }
      this.session.postPhase('Checking remote ripgrep...');
      await this.remoteToolInstaller.ensureRg(client);

      const command = buildRemoteCommand(this.remoteToolInstaller.remoteRgPath, remoteCwd, args);
      this.logger.debug(`remote command=${command}`);
      this.session.postPhase('Starting ripgrep...');
      let firstResultLogged = false;

      let parsedLines = 0;
      let parseErrors = 0;
      let skippedLines = 0;
      // 同一文件命中多行时复用已构建的 target（Uri/路径拼接），避免每行重建。
      const targetCache = new Map<string, ReturnType<ContentSearchRunner['createTarget']>>();
      const createCachedTarget = (remoteRelativePath: string) => {
        let target = targetCache.get(remoteRelativePath);
        if (!target) {
          target = this.createTarget(repository, remoteRelativePath);
          targetCache.set(remoteRelativePath, target);
        }
        return target;
      };
      // include/exclude glob 判定同样按文件缓存：同一文件的每个匹配行结果一致。
      const filterCache = new Map<string, boolean>();
      const cachedPathFilter = (relativePath: string): boolean => {
        let allowed = filterCache.get(relativePath);
        if (allowed === undefined) {
          allowed = resultPathFilter(relativePath);
          filterCache.set(relativePath, allowed);
        }
        return allowed;
      };
      const lineBuffer = new StreamingLineProcessor({
        shouldContinue: () => this.session.isCurrent(token) && !truncated,
        onLine: (line) => {
          // rg --json 的键序固定（type 在前），begin/end/context/summary 事件行
          // 用一次字符串前缀比较跳过，省掉 JSON.parse。
          if (truncated || !line.startsWith('{"type":"match"')) {
            skippedLines += 1;
            return;
          }
          let entry: ContentSearchEntry;
          try {
            entry = JSON.parse(line) as ContentSearchEntry;
            parsedLines += 1;
          } catch {
            parseErrors += 1;
            return;
          }
          if (!this.session.isCurrent(token) || entry.type !== 'match') {
            return;
          }
          const addedMatches = ContentSearchProcessor.processLine(
            entry,
            cachedPathFilter,
            createCachedTarget,
            this.resultStore
          );
          if (addedMatches > 0) {
            totalMatches += addedMatches;
            this.session.recordMatch();
            if (!firstResultLogged) {
              firstResultLogged = true;
              this.logger.log(`search#${token} first result elapsed=${Date.now() - startedAt} ms`);
              this.session.startProgress('content');
            }
            this.session.scheduleResultPush('content');
            if (maxResults > 0 && this.resultStore.totalMatches() >= maxResults) {
              // 达到上限：关闭远端通道让 rg 收到 SIGPIPE 停止（exit 141 已被忽略），
              // 剩余已缓冲行由 truncated 标志丢弃。
              truncated = true;
              this.logger.log(`search#${token} reached maxResults=${maxResults}; closing remote stream`);
              this.session.closeActiveChannel();
            }
          }
        }
      });

      // 远端 rg 丢失（如 /tmp 被重启清理）时静默重传并重试一次；搜索本身不设墙钟超时，
      // 大结果搜索由用户切换/取消来终止，避免 30 秒默认超时截断长搜索。
      const result = await this.runSearchCommand(client, command, lineBuffer, token);
      if (!firstResultLogged) {
        this.session.startProgress('content');
      }
      await lineBuffer.flush();
      this.logger.log(`search#${token} stream lines=${parsedLines} skipped=${skippedLines} parseErrors=${parseErrors} stats=${JSON.stringify(lineBuffer.stats)}`);
      if (!this.session.isCurrent(token)) {
        return false;
      }

      const stderr = filterRipgrepStderr(result.stderr);
      if (stderr.ignoredPermissionDeniedCount > 0) {
        this.logger.log(`search#${token} ignored ${stderr.ignoredPermissionDeniedCount} ripgrep permission-denied diagnostics`);
      }

      if (result.code === 141) {
        this.logger.log(`search#${token} ignored ripgrep code=141 after stream close`);
        this.session.flushResults();
        if (!finalize) {
          return true;
        }
        this.session.stopProgress();
        this.session.postState({
          type: 'state',
          running: false,
          summary: this.buildSummary(Date.now() - startedAt, this.resultStore.totalMatches(), truncated),
          elapsedMs: Date.now() - startedAt
        });
        return true;
      }

      if (isIgnorableRipgrepFailure(result.code, result.stderr)) {
        this.logger.log(`search#${token} ignored ripgrep code=${result.code} with permission-denied diagnostics only`);
      } else if (result.code !== 0 && result.code !== 1) {
        this.logger.log(`search#${token} failed code=${result.code} stderr=${stderr.visibleStderr}`);
        this.session.stopProgress();
        this.session.postState({
          type: 'state',
          running: false,
          error: stderr.visibleStderr || `ripgrep exited with code ${result.code}.`
        });
        return false;
      }

      this.session.flushResults();
      if (!finalize) {
        return true;
      }
      this.session.stopProgress();

      const elapsedMs = Date.now() - startedAt;
      const summary = this.buildSummary(elapsedMs, this.resultStore.totalMatches(), truncated);
      this.session.postState({ type: 'state', running: false, summary, elapsedMs });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.log(`search#${token} exception: ${message}`);
      if (this.session.isCurrent(token)) {
        this.session.stopProgress();
        this.session.postState({ type: 'state', running: false, error: message });
      }
      return false;
    }
  }

  private createTarget(repository: ResolvedSearchRepository, remoteRelativePath: string) {
    return this.workspaceResolver.createWorkspaceTarget(repository, remoteRelativePath);
  }

  private async runSearchCommand(
    client: Client,
    command: string,
    lineBuffer: StreamingLineProcessor,
    token: number
  ) {
    const maxAttempts = 2;
    let lastResult: RemoteExecResult = { stdout: '', stderr: '', code: 127 };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await this.remoteExecutor.execStreamingWithExitCode(client, command, {
        trackAsActive: true,
        collectStdout: false,
        timeoutMs: 0,
        onStdout: (chunk) => lineBuffer.push(chunk)
      });
      lastResult = result;
      if (!isRemoteExecutableMissing(result)) {
        return result;
      }
      this.logger.log(`search#${token} remote rg missing (attempt ${attempt}); re-uploading silently`);
      this.remoteToolInstaller.invalidateRg();
      await this.remoteToolInstaller.ensureRg(client);
      if (!this.session.isCurrent(token)) {
        return result;
      }
    }
    return lastResult;
  }

  private buildSummary(elapsedMs: number, totalMatches: number, truncated = false): string {
    const fileCount = this.resultStore.size;
    if (totalMatches === 0) {
      return `No results (${elapsedMs} ms)`;
    }
    const suffix = truncated ? '+ (truncated)' : '';
    return `${fileCount} files, ${totalMatches}${suffix} results (${elapsedMs} ms)`;
  }
}
