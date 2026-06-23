import type { Client, ClientChannel, SFTPWrapper } from 'ssh2';

export type RemoteExecResult = {
  stdout: string;
  stderr: string;
  code: number | undefined;
};

export type RemoteStreamingExecOptions = {
  trackAsActive?: boolean;
  collectStdout?: boolean;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type RemoteExecutorLogger = {
  log(message: string): void;
  debug(message: string): void;
  summarize(text: string): string;
};

export type RemoteExecutorOptions = {
  logger: RemoteExecutorLogger;
  setActiveChannel?: (channel: ClientChannel | undefined, previous?: ClientChannel) => void;
};

const DEFAULT_REMOTE_EXEC_TIMEOUT_MS = 30000;

export class RemoteExecutor {
  constructor(private readonly options: RemoteExecutorOptions) {}

  public async openSftp(client: Client): Promise<SFTPWrapper> {
    const startedAt = Date.now();
    this.options.logger.log('sftp open start');
    return await new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error('Failed to open SFTP session: timed out after 30000 ms.'));
      }, 30000);
      client.sftp((error, sftp) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error || !sftp) {
          reject(new Error(`Failed to open SFTP session: ${error instanceof Error ? error.message : 'no SFTP handle'}`));
          return;
        }
        this.options.logger.log(`sftp open ready (${Date.now() - startedAt} ms)`);
        resolve(sftp);
      });
    });
  }

  public async exec(client: Client, command: string): Promise<void> {
    await this.execWithOutput(client, command);
  }

  public async execWithOutput(client: Client, command: string): Promise<RemoteExecResult> {
    const result = await this.execWithExitCode(client, command);
    if (result.code === 0 || result.code === undefined) {
      return result;
    }
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Remote command failed with exit code ${result.code}.`);
  }

  public async execWithExitCode(client: Client, command: string, trackAsActive = false): Promise<RemoteExecResult> {
    return await this.execStreamingWithExitCode(client, command, { trackAsActive });
  }

  public async execStreamingWithExitCode(
    client: Client,
    command: string,
    execOptions: RemoteStreamingExecOptions = {}
  ): Promise<RemoteExecResult> {
    this.options.logger.log(`remote exec start: ${this.options.logger.summarize(command)}`);
    const startedAt = Date.now();
    return await new Promise((resolve, reject) => {
      let settled = false;
      let activeStream: ClientChannel | undefined;
      const timeoutMs = Math.max(1, execOptions.timeoutMs ?? DEFAULT_REMOTE_EXEC_TIMEOUT_MS);
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        finish(() => {
          if (activeStream && execOptions.trackAsActive) {
            this.options.setActiveChannel?.(undefined, activeStream);
          }
          try {
            activeStream?.close();
          } catch {
            // ignore close failures after timeout
          }
          reject(new Error(`Remote command timed out after ${timeoutMs} ms.`));
        });
      }, timeoutMs);
      client.exec(command, (error, stream) => {
        if (error) {
          this.options.logger.log(`remote exec spawn error: ${error.message}`);
          finish(() => reject(error));
          return;
        }
        activeStream = stream;
        if (execOptions.trackAsActive) {
          this.options.setActiveChannel?.(stream);
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk: Buffer | string) => {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
          if (execOptions.collectStdout !== false) {
            stdout += text;
          }
          execOptions.onStdout?.(text);
        });
        stream.stderr.on('data', (chunk: Buffer | string) => {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
          stderr += text;
          execOptions.onStderr?.(text);
        });
        stream.on('close', (code: number | undefined | null) => {
          finish(() => {
            if (execOptions.trackAsActive) {
              this.options.setActiveChannel?.(undefined, stream);
            }
            this.options.logger.log(
              `remote exec done code=${code ?? 'unknown'} elapsed=${Date.now() - startedAt} ms stdout="${this.options.logger.summarize(stdout)}" stderr="${this.options.logger.summarize(stderr)}"`
            );
            resolve({ stdout, stderr, code: code == null ? undefined : code });
          });
        });
        stream.on('error', (streamError: Error) => {
          finish(() => {
            if (execOptions.trackAsActive) {
              this.options.setActiveChannel?.(undefined, stream);
            }
            reject(streamError);
          });
        });
      });
    });
  }
}
