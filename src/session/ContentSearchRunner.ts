import * as vscode from 'vscode';
import type { ContentSearchEntry } from './ContentSearchProcessor';
import type { SearchOptions, SearchSettings } from '../core/types';
import type { SearchResultStore } from '../search/SearchResultStore';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import type { WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { SessionLogger } from './SessionLogger';
import { ContentSearchProcessor } from './ContentSearchProcessor';
import { buildContentSearchArgs } from './rgArgs';
import { buildRemoteCommand } from '../remote/commands';
import { createResultPathFilter } from '../core/glob';
import type { SearchSession } from './SearchSession';
import type { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import type { ConnectionController } from './ConnectionController';
import { StreamingLineProcessor } from '../search/StreamingLineProcessor';
import { filterRipgrepStderr, isIgnorableRipgrepFailure } from './rgDiagnostics';

export type ContentSearchConfig = {
  contextLines: number;
  threads: number;
  resultRefreshMs: number;
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
    workspaceFolder: vscode.WorkspaceFolder,
    remoteCwd: string,
    messageRouter: WebviewMessageRouter
  ): Promise<void> {
    const startedAt = Date.now();
    let totalMatches = 0;
    const args = buildContentSearchArgs(options, settings, {
      contextLines: this.config.contextLines,
      threads: this.config.threads
    });
    const resultPathFilter = createResultPathFilter(options, settings);

    this.logger.log(`search#${token} start`);
    this.logger.log(`search#${token} mode=remote query="${options.query.trim()}"`);
    this.logger.log(`search#${token} requestId=${options.requestId ?? 'none'} trigger=${options.triggerSource ?? 'unknown'}`);
    this.logger.log(`search#${token} remote cwd="${remoteCwd}"`);
    this.session.postPhase('Connecting to SSH...');

    try {
      const client = await this.connectionController.getOrCreateClient(settings);
      if (!this.session.isCurrent(token)) {
        return;
      }
      this.session.postPhase('Checking remote ripgrep...');
      await this.remoteToolInstaller.ensureRg(client);

      const command = buildRemoteCommand(this.remoteToolInstaller.remoteRgPath, remoteCwd, args);
      this.logger.debug(`remote command=${command}`);
      this.session.postPhase('Starting ripgrep...');
      let firstResultLogged = false;

      let parsedLines = 0;
      let parseErrors = 0;
      const lineBuffer = new StreamingLineProcessor({
        shouldContinue: () => this.session.isCurrent(token),
        onLine: (line) => {
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
            resultPathFilter,
            (remoteRelativePath) => this.createTarget(workspaceFolder, remoteRelativePath),
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
          }
        }
      });

      const result = await this.remoteExecutor.execStreamingWithExitCode(client, command, {
        trackAsActive: true,
        collectStdout: false,
        onStdout: (chunk) => lineBuffer.push(chunk)
      });
      if (!firstResultLogged) {
        this.session.startProgress('content');
      }
      await lineBuffer.flush();
      this.logger.log(`search#${token} stream lines=${parsedLines} parseErrors=${parseErrors} stats=${JSON.stringify(lineBuffer.stats)}`);
      if (!this.session.isCurrent(token)) {
        return;
      }

      const stderr = filterRipgrepStderr(result.stderr);
      if (stderr.ignoredPermissionDeniedCount > 0) {
        this.logger.log(`search#${token} ignored ${stderr.ignoredPermissionDeniedCount} ripgrep permission-denied diagnostics`);
      }

      if (result.code === 141) {
        this.logger.log(`search#${token} ignored ripgrep code=141 after stream close`);
        this.session.flushResults();
        this.session.stopProgress();
        this.session.postState({
          type: 'state',
          running: false,
          summary: this.buildSummary(Date.now() - startedAt, totalMatches),
          elapsedMs: Date.now() - startedAt
        });
        return;
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
        return;
      }

      this.session.flushResults();
      this.session.stopProgress();

      const elapsedMs = Date.now() - startedAt;
      const summary = this.buildSummary(elapsedMs, totalMatches);
      this.session.postState({ type: 'state', running: false, summary, elapsedMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.log(`search#${token} exception: ${message}`);
      if (this.session.isCurrent(token)) {
        this.session.stopProgress();
        this.session.postState({ type: 'state', running: false, error: message });
      }
    }
  }

  private createTarget(workspaceFolder: vscode.WorkspaceFolder, remoteRelativePath: string) {
    return this.workspaceResolver.createWorkspaceTarget(workspaceFolder, remoteRelativePath);
  }

  private buildSummary(elapsedMs: number, totalMatches: number): string {
    const fileCount = this.resultStore.size;
    return totalMatches === 0
      ? `No results (${elapsedMs} ms)`
      : `${fileCount} files, ${totalMatches} results (${elapsedMs} ms)`;
  }
}
