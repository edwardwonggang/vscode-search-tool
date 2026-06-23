import * as vscode from 'vscode';
import type { Client } from 'ssh2';
import type { SearchSettings } from '../core/types';
import type { SshClientManager } from '../remote/SshClientManager';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import type { WorkspaceResolver } from '../workspace/WorkspaceResolver';

export type ConnectionControllerLogger = {
  log(message: string): void;
  debug(message: string): void;
};

export type ConnectionCheckOptions = {
  workspaceResolver: WorkspaceResolver;
  getWorkspaceFolder: () => vscode.WorkspaceFolder | undefined;
};

export class ConnectionController {
  private options?: ConnectionCheckOptions;

  constructor(
    private readonly sshClientManager: SshClientManager,
    private readonly remoteExecutor: RemoteExecutor,
    private readonly remoteToolInstaller: RemoteToolInstaller,
    private readonly logger: ConnectionControllerLogger
  ) {}

  public setOptions(options: ConnectionCheckOptions): void {
    this.options = options;
  }

  public async getOrCreateClient(settings: SearchSettings): Promise<Client> {
    return await this.sshClientManager.getClient(settings);
  }

  public async checkConnection(
    settings: SearchSettings,
    onResult: (ok: boolean, message: string, cwd?: string) => void
  ): Promise<void> {
    const startedAt = Date.now();

    if (!this.isRemoteSearchConfigured(settings)) {
      onResult(false, 'Remote search is required. Configure SSH host, username, and password in Settings.');
      return;
    }

    try {
      const reused = this.sshClientManager.hasReusableClient(settings);
      const client = await this.getOrCreateClient(settings);

      let remoteCwd = '';
      if (this.options) {
        const workspaceFolder = this.options.getWorkspaceFolder();
        if (workspaceFolder) {
          try {
            remoteCwd = await this.options.workspaceResolver.resolveRemoteCwd(
              settings,
              workspaceFolder,
              'Remote search path required'
            );
          } catch {
            // cwd resolution failed, continue without it
          }
        }
      }

      const elapsedMs = Date.now() - startedAt;
      this.logger.log(`connect ok (${elapsedMs} ms) reused=${reused ? 'true' : 'false'}`);

      const baseMessage = reused
        ? `Connection reused (${elapsedMs} ms)`
        : `Connection ready (${elapsedMs} ms)`;
      const message = remoteCwd ? `${baseMessage} [${remoteCwd}]` : baseMessage;
      onResult(true, message, remoteCwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.log(`connection failed: ${message}`);
      onResult(false, message);
    }
  }

  public close(reason: string): void {
    this.sshClientManager.close(reason);
    this.remoteToolInstaller.clearCache();
  }

  public isRemoteSearchConfigured(settings: SearchSettings): boolean {
    return Boolean(settings.remoteHost && settings.remoteUsername && settings.remotePassword);
  }

  public hasReusableConnection(settings: SearchSettings): boolean {
    return this.sshClientManager.hasReusableClient(settings);
  }
}
