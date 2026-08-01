import * as vscode from 'vscode';
import type { SearchOptions, SearchSettings } from '../core/types';
import type { SearchResultStore } from '../search/SearchResultStore';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import type { ResolvedSearchRepository, WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { SessionLogger } from './SessionLogger';
import { addFileSearchResult } from '../search/FileSearchService';
import { buildFileSearchArgs } from './rgArgs';
import { buildRemoteFileNameSearchCommand } from '../remote/commands';
import { createFileQueryMatcher, createResultPathFilter } from '../core/glob';
import type { SearchSession } from './SearchSession';
import type { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import type { ConnectionController } from './ConnectionController';
import { StreamingLineProcessor } from '../search/StreamingLineProcessor';
import { filterRipgrepStderr, isIgnorableRipgrepFailure } from './rgDiagnostics';

export type FileSearchConfig = {
  resultRefreshMs: number;
};

export class FileSearchRunner {
  constructor(
    private readonly session: SearchSession,
    private readonly resultStore: SearchResultStore,
    private readonly connectionController: ConnectionController,
    private readonly workspaceResolver: WorkspaceResolver,
    private readonly remoteExecutor: RemoteExecutor,
    private readonly remoteToolInstaller: RemoteToolInstaller,
    private readonly logger: SessionLogger,
    private readonly config: FileSearchConfig
  ) {}

  public async execute(
    token: number,
    fileQuery: string,
    options: SearchOptions,
    settings: SearchSettings,
    repository: ResolvedSearchRepository,
    messageRouter: WebviewMessageRouter,
    finalize = true,
    searchStartedAt = Date.now()
  ): Promise<boolean> {
    const startedAt = searchStartedAt;
    const remoteCwd = repository.remoteCwd;
    this.logger.log(`file-search#${token} start`);
    this.logger.log(`file-search#${token} query="${fileQuery}"`);
    this.logger.log(`file-search#${token} requestId=${options.requestId ?? 'none'} trigger=${options.triggerSource ?? 'unknown'}`);
    this.logger.log(`file-search#${token} repository="${repository.workspaceRelativePath || '.'}" remote cwd="${remoteCwd}"`);
    this.session.postPhase('Connecting to SSH...');

    try {
      const client = await this.connectionController.getOrCreateClient(settings);
      if (!this.session.isCurrent(token)) {
        return false;
      }
      this.session.postPhase('Checking remote ripgrep...');
      await this.remoteToolInstaller.ensureRg(client);

      const args = buildFileSearchArgs(options, settings);
      const command = buildRemoteFileNameSearchCommand(
        this.remoteToolInstaller.remoteRgPath,
        remoteCwd,
        args,
        fileQuery,
        options.caseSensitive
      );
      this.logger.debug(`file-search command=${command}`);
      this.session.postPhase('Starting file search...');
      let firstResultLogged = false;

      const resultPathFilter = createResultPathFilter(options, settings);
      const matcher = createFileQueryMatcher(fileQuery, options.caseSensitive);
      const lineBuffer = new StreamingLineProcessor({
        shouldContinue: () => this.session.isCurrent(token),
        onLine: (remoteRelativePath) => {
          if (!this.session.isCurrent(token)) {
            return;
          }
          const relativePath = remoteRelativePath.replace(/\\/gu, '/').trim();
          if (!relativePath || !resultPathFilter(relativePath) || !matcher(relativePath)) {
            return;
          }
          const target = this.createTarget(repository, relativePath);
          addFileSearchResult(this.resultStore, target);
          this.session.recordMatch();
          if (!firstResultLogged) {
            firstResultLogged = true;
            this.logger.log(`file-search#${token} first result elapsed=${Date.now() - startedAt} ms`);
            this.session.startProgress('file');
          }
          this.session.scheduleResultPush('file');
        }
      });

      const result = await this.remoteExecutor.execStreamingWithExitCode(client, command, {
        trackAsActive: true,
        collectStdout: false,
        onStdout: (chunk) => lineBuffer.push(chunk)
      });
      if (!firstResultLogged) {
        this.session.startProgress('file');
      }
      await lineBuffer.flush();
      this.logger.log(`file-search#${token} stream stats=${JSON.stringify(lineBuffer.stats)}`);
      if (!this.session.isCurrent(token)) {
        return false;
      }

      const stderr = filterRipgrepStderr(result.stderr);
      if (stderr.ignoredPermissionDeniedCount > 0) {
        this.logger.log(`file-search#${token} ignored ${stderr.ignoredPermissionDeniedCount} ripgrep permission-denied diagnostics`);
      }

      if (result.code === 141) {
        this.logger.log(`file-search#${token} ignored ripgrep code=141 after stream close`);
        this.session.flushResults();
        if (!finalize) {
          return true;
        }
        this.session.stopProgress();
        const elapsedMs = Date.now() - startedAt;
        this.session.postState({ type: 'state', running: false, summary: this.buildSummary(elapsedMs), elapsedMs });
        return true;
      }

      if (isIgnorableRipgrepFailure(result.code, result.stderr)) {
        this.logger.log(`file-search#${token} ignored ripgrep code=${result.code} with permission-denied diagnostics only`);
      } else if (result.code !== 0 && result.code !== 1) {
        this.logger.log(`file-search#${token} failed code=${result.code}`);
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
      const summary = this.buildSummary(elapsedMs);
      this.session.postState({ type: 'state', running: false, summary, elapsedMs });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.log(`file-search#${token} exception: ${message}`);
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

  private buildSummary(elapsedMs: number): string {
    const totalFiles = this.resultStore.size;
    return totalFiles === 0
      ? `No files (${elapsedMs} ms)`
      : `${totalFiles} files (${elapsedMs} ms)`;
  }
}
