import * as vscode from 'vscode';
import type { Client } from 'ssh2';
import type { SearchSettings } from '../core/types';
import type { ConnectionController } from '../session/ConnectionController';
import type { ResolvedSearchRepository, SearchRepository, WorkspaceResolver } from '../workspace/WorkspaceResolver';
import { normalizeRemotePath } from '../core/paths';
import type { TranslationService } from '../i18n/TranslationService';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import type { SessionLogger } from '../session/SessionLogger';
import {
  buildExecutableVersionCommand,
  buildGitInsideWorkTreeCommand,
  buildGitTopCommand,
  buildRemoteFileExistsCommand
} from '../remote/commands';
import {
  DEFAULT_TAG_AUTO_REFRESH_MINUTES,
  TAG_INDEX_CTAGS_ARGS_KEY,
  buildCtagsRebuildCommand,
  buildGitHeadCommand,
  buildReadTagIndexMetaCommand,
  createTagIndexMeta,
  decideTagIndexRefresh,
  getTagIndexPaths,
  parseTagIndexMeta
} from './TagIndex';

const AUTO_CHECK_MIN_MS = 5 * 60 * 1000;
const AUTO_BUILD_MIN_MS = DEFAULT_TAG_AUTO_REFRESH_MINUTES * 60 * 1000;
const AUTO_FAILURE_BACKOFF_MS = 15 * 60 * 1000;
const AUTO_BUILD_TIMEOUT_MS = 30 * 60 * 1000;

export class TagIndexAutoRefresh {
  private readonly nextCheckAt = new Map<string, number>();
  private readonly nextBuildAt = new Map<string, number>();
  private inFlight?: Promise<void>;

  constructor(
    private readonly connectionController: ConnectionController,
    private readonly workspaceResolver: WorkspaceResolver,
    private readonly translationService: TranslationService,
    private readonly remoteExecutor: RemoteExecutor,
    private readonly remoteToolInstaller: RemoteToolInstaller,
    private readonly logger: SessionLogger
  ) {}

  public refreshIfDue(
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder | undefined,
    repositories: SearchRepository[]
  ): void {
    if (!workspaceFolder || repositories.length === 0 || this.inFlight || !this.connectionController.isRemoteSearchConfigured(settings)) {
      return;
    }

    const key = this.createRefreshKey(settings, workspaceFolder, repositories);
    const now = Date.now();
    if ((this.nextCheckAt.get(key) ?? 0) > now) {
      return;
    }
    this.nextCheckAt.set(key, now + AUTO_CHECK_MIN_MS);

    const promise = this.refreshNow(settings, workspaceFolder, repositories, key, now)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.nextBuildAt.set(key, Date.now() + AUTO_FAILURE_BACKOFF_MS);
        this.logger.log(`tag auto-refresh failed: ${message}`);
      })
      .finally(() => {
        if (this.inFlight === promise) {
          this.inFlight = undefined;
        }
      });
    this.inFlight = promise;
  }

  private async refreshNow(
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    repositories: SearchRepository[],
    key: string,
    startedAt: number
  ): Promise<void> {
    const resolvedRepositories = await this.workspaceResolver.resolveSearchRepositories(
      settings,
      workspaceFolder,
      repositories,
      await this.translationService.translate('err_remote_search_path_required')
    );
    const client = await this.connectionController.getOrCreateClient(settings);
    for (const repository of resolvedRepositories) {
      await this.refreshRepository(client, repository, this.createRepositoryBuildKey(key, repository), startedAt);
    }
  }

  private async refreshRepository(
    client: Client,
    repository: ResolvedSearchRepository,
    buildKey: string,
    startedAt: number
  ): Promise<void> {
    const gitTop = await this.getRemoteGitTop(client, repository.remoteCwd);
    const paths = getTagIndexPaths(gitTop);
    const tagsExists = await this.remoteFileExists(client, paths.tagsPath);
    if (!tagsExists) {
      this.logger.log(`tag auto-refresh will build missing tags at ${paths.tagsPath}`);
    }

    const nextBuildAt = this.nextBuildAt.get(buildKey) ?? 0;
    const now = Date.now();
    if (nextBuildAt > now) {
      this.logger.debug(`tag auto-refresh skipped: build throttle ${Math.round((nextBuildAt - now) / 1000)}s gitTop=${gitTop}`);
      return;
    }

    const ctagsPath = await this.remoteToolInstaller.ensureCtags(
      client,
      await this.translationService.translate('err_ctags_missing')
    );
    const [gitHead, ctagsVersion, metaText] = await Promise.all([
      this.getGitHead(client, gitTop),
      this.getCtagsVersion(client, ctagsPath),
      this.readMeta(client, paths.metaPath)
    ]);
    const decision = decideTagIndexRefresh({
      tagsExists,
      meta: parseTagIndexMeta(metaText),
      gitTop,
      gitHead,
      ctagsVersion,
      ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY,
      refreshIntervalMs: AUTO_BUILD_MIN_MS,
      nowMs: now
    });
    if (!decision.refresh) {
      this.logger.debug(`tag auto-refresh skipped: ${decision.reason} gitTop=${gitTop}`);
      return;
    }

    this.logger.log(`tag auto-refresh start reason=${decision.reason} gitTop=${gitTop}`);
    const result = await this.remoteExecutor.execStreamingWithExitCode(
      client,
      buildCtagsRebuildCommand(
        ctagsPath,
        gitTop,
        paths,
        createTagIndexMeta({
          gitTop,
          gitHead,
          ctagsVersion,
          ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY
        })
      ),
      {
        collectStdout: false,
        timeoutMs: AUTO_BUILD_TIMEOUT_MS
      }
    );
    if (result.code !== 0 && result.code !== undefined) {
      throw new Error(result.stderr.trim() || `ctags exited with code ${result.code}`);
    }
    this.nextBuildAt.set(buildKey, Date.now() + AUTO_BUILD_MIN_MS);
    this.logger.log(`tag auto-refresh done elapsed=${Date.now() - startedAt} ms reason=${decision.reason} gitTop=${gitTop}`);
  }

  private async getRemoteGitTop(client: Client, remoteCwd: string): Promise<string> {
    const topResult = await this.remoteExecutor.execWithExitCode(client, buildGitTopCommand(remoteCwd));
    const top = topResult.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
    if (topResult.code !== 0 || !top || normalizeRemotePath(top) !== normalizeRemotePath(remoteCwd)) {
      throw new Error(await this.translationService.translate('err_not_git_workspace'));
    }
    const tree = await this.remoteExecutor.execWithExitCode(client, buildGitInsideWorkTreeCommand(remoteCwd));
    if (tree.stdout.trim() !== 'true') {
      throw new Error(await this.translationService.translate('err_not_git_workspace'));
    }
    return top;
  }

  private async remoteFileExists(client: Client, remotePath: string): Promise<boolean> {
    const result = await this.remoteExecutor.execWithExitCode(client, buildRemoteFileExistsCommand(remotePath));
    return result.stdout.trim() === 'y' && (result.code == null || result.code === 0);
  }

  private async getGitHead(client: Client, gitTop: string): Promise<string> {
    const result = await this.remoteExecutor.execWithExitCode(client, buildGitHeadCommand(gitTop));
    return result.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
  }

  private async getCtagsVersion(client: Client, ctagsPath: string): Promise<string> {
    const result = await this.remoteExecutor.execWithExitCode(client, buildExecutableVersionCommand(ctagsPath));
    return result.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
  }

  private async readMeta(client: Client, metaPath: string): Promise<string> {
    const result = await this.remoteExecutor.execWithExitCode(client, buildReadTagIndexMetaCommand(metaPath));
    return result.stdout;
  }

  private createRefreshKey(settings: SearchSettings, workspaceFolder: vscode.WorkspaceFolder, repositories: SearchRepository[]): string {
    return [
      settings.remoteHost,
      settings.remotePort,
      settings.remoteUsername,
      settings.remoteSearchPath,
      workspaceFolder.uri.toString(),
      repositories.map((repository) => repository.workspaceRelativePath).join(',')
    ].join('|');
  }

  private createRepositoryBuildKey(refreshKey: string, repository: ResolvedSearchRepository): string {
    return `${refreshKey}|${repository.remoteCwd}`;
  }
}
