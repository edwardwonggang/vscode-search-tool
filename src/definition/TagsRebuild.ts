import * as vscode from 'vscode';
import type { Client } from 'ssh2';
import { Utf8ChunkDecoder } from '../core/utf8';
import type { SearchSettings } from '../core/types';
import { normalizeRemotePath } from '../core/paths';
import type { TranslationService } from '../i18n/TranslationService';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import type { ResolvedSearchRepository, SearchRepository, WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { SessionLogger } from '../session/SessionLogger';
import { buildGitTopCommand, buildGitInsideWorkTreeCommand, buildExecutableVersionCommand } from '../remote/commands';
import type { SearchSession } from '../session/SearchSession';
import type { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import type { ConnectionController } from '../session/ConnectionController';
import {
  TAG_INDEX_CTAGS_ARGS_KEY,
  buildCtagsRebuildCommand,
  buildGitHeadCommand,
  createTagIndexMeta,
  getTagIndexPaths
} from './TagIndex';
const CTAGS_PROGRESS_REFRESH_MS = 500;

export class TagsRebuild {
  constructor(
    private readonly session: SearchSession,
    private readonly connectionController: ConnectionController,
    private readonly workspaceResolver: WorkspaceResolver,
    private readonly translationService: TranslationService,
    private readonly remoteExecutor: RemoteExecutor,
    private readonly remoteToolInstaller: RemoteToolInstaller,
    private readonly logger: SessionLogger
  ) {}

  public async execute(
    settings: SearchSettings,
    workspaceFolder: vscode.WorkspaceFolder,
    repositories: SearchRepository[],
    messageRouter: WebviewMessageRouter
  ): Promise<void> {
    if (!this.connectionController.isRemoteSearchConfigured(settings)) {
      messageRouter.postState({
        type: 'state',
        running: false,
        error: 'Remote search is required. Configure SSH host, username, and password in Settings.'
      });
      return;
    }

    const token = this.session.begin();
    this.session.cancelActiveSearch();
    messageRouter.postState({
      type: 'state',
      running: true,
      summary: await this.translationService.translate('rebuild_tags_start'),
      ctagsInProgress: false
    });

    let resolvedRepositories: ResolvedSearchRepository[];
    try {
      resolvedRepositories = await this.workspaceResolver.resolveSearchRepositories(
        settings,
        workspaceFolder,
        repositories,
        await this.translationService.translate('err_remote_search_path_required')
      );
    } catch (error) {
      messageRouter.postState({
        type: 'state',
        running: false,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    try {
      const client = await this.connectionController.getOrCreateClient(settings);
      if (!this.session.isCurrent(token)) {
        return;
      }
      await this.remoteToolInstaller.ensureRg(client);
      const ctagsPath = await this.remoteToolInstaller.ensureCtags(
        client,
        await this.translationService.translate('err_ctags_missing')
      );

      for (const repository of resolvedRepositories) {
        this.logger.log(`rebuild-tags#${token} repository="${repository.workspaceRelativePath || '.'}" cwd="${repository.remoteCwd}"`);
        const gitTop = await this.getRemoteGitTop(client, repository.remoteCwd, token);
        if (!this.session.isCurrent(token) || !gitTop) {
          return;
        }
        await this.runRemoteCtagsBuild(client, ctagsPath, gitTop, token, messageRouter);
        if (!this.session.isCurrent(token)) {
          return;
        }
      }
      messageRouter.postState({
        type: 'state',
        running: false,
        summary: await this.translationService.translate('rebuild_tags_done'),
        ctagsInProgress: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.session.isCurrent(token)) {
        messageRouter.postState({ type: 'state', running: false, error: message, ctagsInProgress: false });
      }
    }
  }

  private async getRemoteGitTop(client: Client, remoteCwd: string, token: number): Promise<string> {
    const cmd = buildGitTopCommand(remoteCwd);
    const r = await this.remoteExecutor.execWithExitCode(client, cmd);
    if (!this.session.isCurrent(token)) {
      return '';
    }
    if (r.code !== 0) {
      throw new Error(await this.translationService.translate('err_not_git_workspace'));
    }
    const top = r.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
    if (!top || normalizeRemotePath(top) !== normalizeRemotePath(remoteCwd)) {
      throw new Error(await this.translationService.translate('err_not_git_workspace'));
    }
    const tree = await this.remoteExecutor.execWithExitCode(client, buildGitInsideWorkTreeCommand(remoteCwd));
    if (!this.session.isCurrent(token)) {
      return '';
    }
    if (tree.stdout.trim() !== 'true') {
      throw new Error(await this.translationService.translate('err_not_git_workspace'));
    }
    return top;
  }

  private async runRemoteCtagsBuild(
    client: Client,
    ctagsPath: string,
    gitTop: string,
    token: number,
    messageRouter: WebviewMessageRouter
  ): Promise<void> {
    const buildSummary = await this.translationService.translate('ctags_building');
    const buildFailedMessage = await this.translationService.translate('ctags_build_failed');
    const buildDoneMessage = await this.translationService.translate('ctags_build_done');

    messageRouter.postState({ type: 'state', running: true, summary: buildSummary, ctagsInProgress: true });
    const tagIndexPaths = getTagIndexPaths(gitTop);
    const gitHead = await this.getGitHead(client, gitTop);
    const ctagsVersion = await this.getCtagsVersion(client, ctagsPath);
    const command = buildCtagsRebuildCommand(
      ctagsPath,
      gitTop,
      tagIndexPaths,
      createTagIndexMeta({
        gitTop,
        gitHead,
        ctagsVersion,
        ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY
      })
    );

    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        this.session.setActiveChannel(stream);
        let acc = '';
        let lastProgressAt = 0;

        // ctags 进度输出同样可能跨数据包切开多字节字符，使用跨 chunk 解码。
        const stdoutDecoder = new Utf8ChunkDecoder();
        const stderrDecoder = new Utf8ChunkDecoder();
        stream.on('data', (c: Buffer | string) => {
          acc += stdoutDecoder.write(c);
          if (!this.session.isCurrent(token)) {
            return;
          }
          const now = Date.now();
          if (now - lastProgressAt < CTAGS_PROGRESS_REFRESH_MS) {
            return;
          }
          lastProgressAt = now;
          const parts = acc.split(/\r?\n/u);
          const last = parts[Math.max(0, parts.length - 2)] || parts[0] || '';
          const tail = last.length > 90 ? last.slice(-90) : last;
          messageRouter.postState({
            type: 'state',
            running: true,
            ctagsInProgress: true,
            summary: tail.trim() ? `${buildSummary} - ${tail.trim()}` : buildSummary
          });
        });

        stream.stderr.on('data', (c: Buffer | string) => {
          acc += stderrDecoder.write(c);
        });

        stream.on('close', (code: number | undefined) => {
          this.session.setActiveChannel(undefined, stream);
          if (!this.session.isCurrent(token)) {
            resolve();
            return;
          }
          if (code !== 0 && code !== undefined) {
            const logText = acc.trim().slice(0, 500);
            reject(new Error(logText || buildFailedMessage));
          } else {
            messageRouter.postState({
              type: 'state',
              running: true,
              ctagsInProgress: false,
              summary: buildDoneMessage
            });
            resolve();
          }
        });

        stream.on('error', (e: Error) => {
          this.session.setActiveChannel(undefined, stream);
          reject(e);
        });
      });
    });
  }

  private async getGitHead(client: Client, gitTop: string): Promise<string> {
    const result = await this.remoteExecutor.execWithExitCode(client, buildGitHeadCommand(gitTop));
    return result.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
  }

  private async getCtagsVersion(client: Client, ctagsPath: string): Promise<string> {
    const result = await this.remoteExecutor.execWithExitCode(client, buildExecutableVersionCommand(ctagsPath));
    return result.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
  }
}
