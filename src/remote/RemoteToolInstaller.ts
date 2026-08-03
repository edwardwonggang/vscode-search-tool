import { promises as fs } from 'fs';
import * as path from 'path';
import * as posixPath from 'path/posix';
import type { Client } from 'ssh2';
import {
  buildChmodExecutableCommand,
  buildExecutableVersionCommand,
  buildMkdirCommand
} from './commands';
import type { RemoteExecutor } from './RemoteExecutor';
import { shellEscape } from '../core/shell';

export type RemoteToolInstallerLogger = {
  log(message: string): void;
  debug(message: string): void;
};

export type RemoteToolInstallerOptions = {
  asAbsolutePath(relativePath: string): string;
  executor: RemoteExecutor;
  logger: RemoteToolInstallerLogger;
  bundledRgRelativePath: string;
  remoteRgPath: string;
  bundledCtagsRelativePath: string;
  remoteCtagsPath: string;
};

export class RemoteToolInstaller {
  private remoteRgInstallPromise?: Promise<string>;

  constructor(private readonly options: RemoteToolInstallerOptions) {}

  public get remoteRgPath(): string {
    return this.options.remoteRgPath;
  }

  public get remoteCtagsPath(): string {
    return this.options.remoteCtagsPath;
  }

  public clearCache(): void {
    this.remoteRgInstallPromise = undefined;
  }

  public async ensureRg(client: Client, knownVersion?: string): Promise<string> {
    const remoteRgPath = this.options.remoteRgPath;
    const localRgPath = this.options.asAbsolutePath(this.options.bundledRgRelativePath);
    const localRgStat = await fs.stat(localRgPath);
    const bundledSignature = `${remoteRgPath}|${localRgStat.size}|${localRgStat.mtimeMs}`;
    // 定义搜索的合并探针已确认远端 rg 存在时，跳过 --version 往返。
    if (knownVersion) {
      this.options.logger.debug(`remote rg already present: ${knownVersion}`);
      return remoteRgPath;
    }
    const existingVersion = await this.getRemoteExecutableVersion(client, remoteRgPath);
    if (existingVersion) {
      this.options.logger.debug(`remote rg already present: ${existingVersion}`);
      return remoteRgPath;
    }
    if (this.remoteRgInstallPromise) {
      return await this.remoteRgInstallPromise;
    }

    const installPromise = this.installRg(client, localRgPath, remoteRgPath, bundledSignature);
    this.remoteRgInstallPromise = installPromise;
    try {
      return await installPromise;
    } finally {
      if (this.remoteRgInstallPromise === installPromise) {
        this.remoteRgInstallPromise = undefined;
      }
    }
  }

  public async ensureCtags(client: Client, missingMessage: string, knownVersion?: string): Promise<string> {
    // 定义搜索的合并探针已确认远端 ctags 存在时，跳过 --version 往返。
    if (knownVersion) {
      this.options.logger.debug(`remote ctags already present: ${knownVersion}`);
      return this.options.remoteCtagsPath;
    }
    const localCtags = this.options.asAbsolutePath(this.options.bundledCtagsRelativePath);
    try {
      await fs.access(localCtags);
      await this.uploadBundledCtags(client, this.options.remoteCtagsPath, localCtags);
      return this.options.remoteCtagsPath;
    } catch {
      this.options.logger.log('bundled ctags not found; using ctags on remote PATH');
    }
    const r = await this.options.executor.execWithExitCode(
      client,
      'command -v ctags 2>/dev/null || command -v universal-ctags 2>/dev/null || true'
    );
    const ctags = r.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
    if (!ctags) {
      throw new Error(missingMessage);
    }
    return ctags;
  }

  private async uploadBundledCtags(
    client: Client,
    remoteCtagsPath: string,
    localCtagsPath: string
  ): Promise<void> {
    this.options.logger.log(`checking remote ctags at ${remoteCtagsPath}`);
    const have = await this.getRemoteExecutableVersion(client, remoteCtagsPath);
    if (have) {
      this.options.logger.log('remote ctags already present');
      return;
    }
    await this.options.executor.exec(client, buildMkdirCommand(posixPath.dirname(remoteCtagsPath)));
    await this.uploadFile(client, localCtagsPath, remoteCtagsPath);
    await this.options.executor.exec(client, buildChmodExecutableCommand(remoteCtagsPath));
  }

  private async installRg(
    client: Client,
    localRgPath: string,
    remoteRgPath: string,
    bundledSignature: string
  ): Promise<string> {
    this.options.logger.debug(`installing bundled rg ${bundledSignature} from ${localRgPath}`);
    this.options.logger.log(`creating remote directory for rg: ${posixPath.dirname(remoteRgPath)}`);
    await this.options.executor.exec(client, buildMkdirCommand(posixPath.dirname(remoteRgPath)));
    this.options.logger.log('opening sftp session');
    await this.uploadFile(client, localRgPath, remoteRgPath);
    this.options.logger.log('sftp upload finished');
    this.options.logger.log('setting executable bit on remote rg');
    await this.options.executor.exec(client, buildChmodExecutableCommand(remoteRgPath));
    this.options.logger.log('remote rg ready');
    return remoteRgPath;
  }

  private async getRemoteExecutableVersion(client: Client, remotePath: string): Promise<string | undefined> {
    try {
      const r = await this.options.executor.execWithExitCode(
        client,
        buildExecutableVersionCommand(remotePath)
      );
      return r.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async uploadFile(client: Client, localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.options.executor.openSftp(client);
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, {}, (error) => {
          if (error) {
            reject(new Error(`SFTP upload failed from ${localPath} to ${remotePath}: ${error.message}`));
          } else {
            resolve();
          }
        });
      });
    } finally {
      sftp.end();
    }
  }
}

export function bundledLinuxRgPath(): string {
  return path.join('assets', 'bin', 'ripgrep-14.1.0-x86_64-unknown-linux-musl', 'rg');
}
