import type { Client, ConnectConfig } from 'ssh2';
import type { SearchSettings } from '../core/types';

const SSH_KEEPALIVE_INTERVAL_MS = 15000;
const SSH_KEEPALIVE_COUNT_MAX = 3;

export type SshClientLogger = {
  log(message: string): void;
  debug(message: string): void;
};

export class SshClientManager {
  private activeClient?: Client;
  private connectionPromise?: Promise<Client>;
  private connectionSignature?: string;

  constructor(private readonly logger: SshClientLogger) {}

  public get activeSignature(): string | undefined {
    return this.connectionSignature;
  }

  public hasReusableClient(settings: SearchSettings): boolean {
    return Boolean(this.activeClient && this.connectionSignature === getRemoteConnectionSignature(settings));
  }

  public async getClient(settings: SearchSettings): Promise<Client> {
    const signature = getRemoteConnectionSignature(settings);
    if (this.activeClient && this.connectionSignature === signature) {
      this.logger.log(`ssh reuse existing connection host=${settings.remoteHost}:${settings.remotePort} user=${settings.remoteUsername}`);
      return this.activeClient;
    }
    if (this.connectionPromise && this.connectionSignature === signature) {
      this.logger.log(`ssh await in-flight connection host=${settings.remoteHost}:${settings.remotePort} user=${settings.remoteUsername}`);
      return await this.connectionPromise;
    }

    this.close('ssh settings changed');
    this.connectionSignature = signature;
    const connectionPromise = this.connect(settings)
      .then((client) => {
        if (this.connectionPromise !== connectionPromise || this.connectionSignature !== signature) {
          client.end();
          throw new Error('SSH connection was replaced.');
        }
        this.activeClient = client;
        client.once('end', () => {
          this.logger.debug('ssh connection ended by remote');
          this.clear(client, signature);
        });
        client.once('close', () => {
          this.logger.debug('ssh connection closed');
          this.clear(client, signature);
        });
        client.on('error', (error) => {
          this.logger.debug(`ssh connection error: ${error.message}`);
          this.clear(client, signature);
        });
        return client;
      })
      .catch((error) => {
        if (this.connectionPromise === connectionPromise) {
          this.clear();
        }
        throw error;
      });
    this.connectionPromise = connectionPromise;
    return await connectionPromise;
  }

  public close(reason: string): void {
    const client = this.activeClient;
    this.activeClient = undefined;
    this.connectionPromise = undefined;
    this.connectionSignature = undefined;
    if (!client) {
      return;
    }
    this.logger.debug(`ssh connection closing: ${reason}`);
    try {
      client.end();
    } catch {
      // ignore close failures
    }
  }

  private clear(client?: Client, signature?: string): void {
    if (signature && this.connectionSignature !== signature) {
      return;
    }
    if (client && this.activeClient && this.activeClient !== client) {
      return;
    }
    this.activeClient = undefined;
    this.connectionPromise = undefined;
    this.connectionSignature = undefined;
  }

  private async connect(settings: SearchSettings): Promise<Client> {
    this.logger.debug(
      `ssh connect start host=${settings.remoteHost || '<empty>'}:${settings.remotePort} user=${settings.remoteUsername || '<empty>'}`
    );
    const startedAt = Date.now();
    const ssh2 = await import('ssh2');
    const connectConfig: ConnectConfig = {
      host: settings.remoteHost,
      port: settings.remotePort,
      username: settings.remoteUsername,
      password: settings.remotePassword,
      readyTimeout: 20000,
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX
    };

    return await new Promise<Client>((resolve, reject) => {
      const client = new ssh2.Client();
      const progress = setInterval(() => {
        this.logger.log(`ssh connect waiting (${Date.now() - startedAt} ms) host=${settings.remoteHost}:${settings.remotePort}`);
      }, 5000);
      const finish = (callback: () => void): void => {
        clearInterval(progress);
        callback();
      };
      client.on('ready', () => {
        finish(() => {
          this.logger.log(`ssh connect ready (${Date.now() - startedAt} ms)`);
          resolve(client);
        });
      });
      client.on('error', (error) => {
        finish(() => {
          this.logger.log(`ssh connect error: ${error.message}`);
          reject(error);
        });
      });
      client.connect(connectConfig);
    });
  }
}

export function getRemoteConnectionSignature(settings: SearchSettings): string {
  return JSON.stringify({
    host: settings.remoteHost,
    port: settings.remotePort,
    username: settings.remoteUsername,
    password: settings.remotePassword
  });
}
