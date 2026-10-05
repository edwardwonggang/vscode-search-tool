import * as vscode from 'vscode';
import type { Client } from 'ssh2';
import type { SearchOptions, SearchSettings } from '../core/types';
import { createFileQueryMatcher, createResultPathFilter } from '../core/glob';
import { buildFileSearchArgs } from '../session/rgArgs';
import { buildRemoteFileNameSearchCommand } from '../remote/commands';
import {
  filterRipgrepStderr,
  isIgnorableRipgrepFailure,
  isRemoteExecutableMissing
} from '../session/rgDiagnostics';
import { StreamingLineProcessor } from './StreamingLineProcessor';
import type { ConnectionController } from '../session/ConnectionController';
import type { WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { RemoteExecutor, RemoteExecResult } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';

export type QuickFileEntry = {
  label: string;
  description: string;
  uri?: vscode.Uri;
  relativePath?: string;
};

export type QuickFileSearchResult = {
  entries: QuickFileEntry[];
  error?: string;
};

export type QuickFileSearchLogger = {
  log(message: string): void;
  debug(message: string): void;
};

export type QuickFileSearchDeps = {
  connectionController: ConnectionController;
  workspaceResolver: WorkspaceResolver;
  remoteExecutor: RemoteExecutor;
  remoteToolInstaller: RemoteToolInstaller;
  logger: QuickFileSearchLogger;
};

/** 快速文件搜索展示上限：够用且避免网络盘大仓库全量堆积内存。 */
const MAX_QUICK_FILES = 200;

function emptySearchOptions(fileQuery: string): SearchOptions {
  return {
    query: '',
    fileQuery,
    include: '',
    exclude: '',
    caseSensitive: false,
    wholeWord: false,
    useRegex: false
  };
}

/**
 * 基于远端 ripgrep 的文件名搜索，供 Ctrl+P 快速打开复用。
 * 与侧栏文件搜索共用同一套 rg 命令与路径过滤，但结果直接回给调用方，
 * 不经过 webview 结果存储。
 */
export class QuickFileSearch {
  constructor(private readonly deps: QuickFileSearchDeps) {}

  public async searchFiles(
    query: string,
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<QuickFileSearchResult> {
    try {
      const client = await this.deps.connectionController.getOrCreateClient(settings);
      await this.deps.remoteToolInstaller.ensureRg(client);
      const repository = await this.deps.workspaceResolver.resolveWorkspaceSearchRoot(
        settings,
        workspaceFolder,
        'Remote search path required'
      );
      const options = emptySearchOptions(query);
      const args = buildFileSearchArgs(options, settings);
      const command = buildRemoteFileNameSearchCommand(
        this.deps.remoteToolInstaller.remoteRgPath,
        repository.remoteCwd,
        args,
        query,
        options.caseSensitive
      );
      this.deps.logger.debug(`quick-file-search command=${command}`);

      const entries: QuickFileEntry[] = [];
      const pathFilter = createResultPathFilter(options, settings);
      const matcher = createFileQueryMatcher(query, options.caseSensitive);
      const lineBuffer = new StreamingLineProcessor({
        shouldContinue: () => entries.length < MAX_QUICK_FILES,
        onLine: (remoteRelativePath) => {
          const relativePath = remoteRelativePath.replace(/\\/gu, '/').trim();
          if (!relativePath || !pathFilter(relativePath) || !matcher(relativePath)) {
            return;
          }
          const target = this.deps.workspaceResolver.createWorkspaceTarget(repository, relativePath);
          entries.push({
            label: relativePath.slice(relativePath.lastIndexOf('/') + 1) || relativePath,
            description: relativePath,
            uri: target.uri,
            relativePath
          });
        }
      });

      const result = await this.execCommand(client, command, lineBuffer);
      await lineBuffer.flush();
      const stderr = filterRipgrepStderr(result.stderr);
      if (result.code !== 0 && result.code !== 1 && !isIgnorableRipgrepFailure(result.code, result.stderr)) {
        return { entries: [], error: stderr.visibleStderr || `ripgrep exited with code ${result.code}.` };
      }
      return { entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { entries: [], error: message };
    }
  }

  private async execCommand(
    client: Client,
    command: string,
    lineBuffer: StreamingLineProcessor
  ): Promise<RemoteExecResult> {
    const maxAttempts = 2;
    let lastResult: RemoteExecResult = { stdout: '', stderr: '', code: 127 };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await this.deps.remoteExecutor.execStreamingWithExitCode(client, command, {
        trackAsActive: true,
        collectStdout: false,
        timeoutMs: 0,
        onStdout: (chunk) => lineBuffer.push(chunk)
      });
      lastResult = result;
      if (!isRemoteExecutableMissing(result)) {
        return result;
      }
      this.deps.logger.log(`quick-file-search remote rg missing (attempt ${attempt}); re-uploading silently`);
      this.deps.remoteToolInstaller.invalidateRg();
      await this.deps.remoteToolInstaller.ensureRg(client);
    }
    return lastResult;
  }
}
