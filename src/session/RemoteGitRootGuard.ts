import type { SearchSettings } from '../core/types';
import { normalizeRemotePath } from '../core/paths';
import { buildGitTopCommand } from '../remote/commands';
import type { ConnectionController } from './ConnectionController';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { TranslationService } from '../i18n/TranslationService';

export type RemoteGitRootGuardSession = {
  isCurrent(token: number): boolean;
};

export class RemoteGitRootGuard {
  private readonly verifiedKeys = new Set<string>();

  constructor(
    private readonly connectionController: ConnectionController,
    private readonly remoteExecutor: RemoteExecutor,
    private readonly translationService: TranslationService,
    private readonly session: RemoteGitRootGuardSession
  ) {}

  public clear(): void {
    this.verifiedKeys.clear();
  }

  public async ensureGitRoot(settings: SearchSettings, remoteCwd: string, token: number): Promise<void> {
    const key = createRemoteGitRootKey(settings, remoteCwd);
    if (this.verifiedKeys.has(key)) {
      return;
    }

    const client = await this.connectionController.getOrCreateClient(settings);
    if (!this.session.isCurrent(token)) {
      return;
    }

    const result = await this.remoteExecutor.execWithExitCode(client, buildGitTopCommand(remoteCwd));
    if (!this.session.isCurrent(token)) {
      return;
    }

    const top = result.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
    if (result.code !== 0 || !top || normalizeRemotePath(top) !== normalizeRemotePath(remoteCwd)) {
      throw new Error(await this.translationService.translate('git_root_required'));
    }

    this.verifiedKeys.add(key);
  }
}

export function createRemoteGitRootKey(settings: SearchSettings, remoteCwd: string): string {
  return JSON.stringify({
    host: settings.remoteHost,
    port: settings.remotePort,
    username: settings.remoteUsername,
    remoteCwd: normalizeRemotePath(remoteCwd)
  });
}
