import * as vscode from 'vscode';
import type { Client } from 'ssh2';
import * as posixPath from 'path/posix';
import type { SearchSettings } from '../core/types';
import type { TranslationService } from '../i18n/TranslationService';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import type { WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { SessionLogger } from '../session/SessionLogger';
import { buildGitTopCommand, buildGitInsideWorkTreeCommand } from '../remote/commands';
import { shellEscape } from '../core/shell';
import type { SearchSession } from '../session/SearchSession';
import type { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import type { ConnectionController } from '../session/ConnectionController';

const TAGS_FILE_NAME = 'tags';
const CTAGS_EXCLUDE_PATTERNS = [
  '*.a',
  '*.bin',
  '*.bmp',
  '*.bz2',
  '*.dll',
  '*.elf',
  '*.exe',
  '*.gif',
  '*.gz',
  '*.hex',
  '*.iso',
  '*.jpg',
  '*.jpeg',
  '*.lib',
  '*.o',
  '*.obj',
  '*.pdf',
  '*.png',
  '*.so',
  '*.tar',
  '*.tgz',
  '*.zip',
  '*.7z'
] as const;
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

    let remoteCwd: string;
    try {
      remoteCwd = await this.workspaceResolver.resolveRemoteCwd(
        settings,
        workspaceFolder,
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
      const gitTop = await this.getRemoteGitTop(client, remoteCwd, token);
      if (!this.session.isCurrent(token) || !gitTop) {
        return;
      }
      const tagsPath = posixPath.join(posixPath.dirname(gitTop), TAGS_FILE_NAME);
      await this.runRemoteCtagsBuild(client, ctagsPath, gitTop, tagsPath, token, messageRouter);
      if (!this.session.isCurrent(token)) {
        return;
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
    if (!top) {
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
    tagsPath: string,
    token: number,
    messageRouter: WebviewMessageRouter
  ): Promise<void> {
    const buildSummary = await this.translationService.translate('ctags_building');
    const buildFailedMessage = await this.translationService.translate('ctags_build_failed');
    const buildDoneMessage = await this.translationService.translate('ctags_build_done');

    messageRouter.postState({ type: 'state', running: true, summary: buildSummary, ctagsInProgress: true });
    const excludes = CTAGS_EXCLUDE_PATTERNS.map((pattern) => `--exclude=${shellEscape(pattern)}`).join(' ');
    const command = `cd ${shellEscape(gitTop)} && ${shellEscape(ctagsPath)} -R -f ${shellEscape(tagsPath)} --tag-relative=yes --fields=+n ${excludes} .`;

    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        this.session.setActiveChannel(stream);
        let acc = '';
        let lastProgressAt = 0;

        stream.on('data', (c: Buffer | string) => {
          acc += Buffer.isBuffer(c) ? c.toString('utf8') : c;
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
          acc += Buffer.isBuffer(c) ? c.toString('utf8') : c;
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
}
