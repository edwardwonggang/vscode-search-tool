import type { Client, ConnectConfig } from 'ssh2';
import type { SearchSettings } from '../core/types';

const SSH_KEEPALIVE_INTERVAL_MS = 15000;
const SSH_KEEPALIVE_COUNT_MAX = 3;
// 扩展自有墙钟超时：ssh2 的 readyTimeout(20s) 只保证握手阶段；若事件循环卡顿或
// 协议边界使 readyTimeout 未触发，connect() 的 Promise 会永久 pending，in-flight
// 分支会一直 await 它，导致 UI 卡在 "Connecting to SSH..."。此超时兜底销毁连接并
// reject，让 getClient 清理后能重连。取 readyTimeout + 10s 裕量，避免误杀慢握手。
const SSH_CONNECT_WALLCLOCK_TIMEOUT_MS = 30000;

export type SshClientLogger = {
  log(message: string): void;
  debug(message: string): void;
};

export type SshClientManagerOptions = {
  /** 开启 SSH 传输压缩（zlib）。JSON 结果流冗余度高，慢链路上可显著减少传输时间。 */
  compress?: boolean;
  /**
   * 工作区标识符：用于区分不同 VSCode 窗口/工作区的连接。
   * 多开场景下，每个窗口应有独立的 SSH 连接，避免状态竞争。
   */
  workspaceId?: string;
};

export class SshClientManager {
  private activeClient?: Client;
  private connectionPromise?: Promise<Client>;
  private connectionSignature?: string;

  constructor(
    private readonly logger: SshClientLogger,
    private readonly options: SshClientManagerOptions = {}
  ) {}

  public get activeSignature(): string | undefined {
    return this.connectionSignature;
  }

  public hasReusableClient(settings: SearchSettings): boolean {
    return Boolean(this.activeClient && this.connectionSignature === getRemoteConnectionSignature(settings, this.options.workspaceId));
  }

  public async getClient(settings: SearchSettings): Promise<Client> {
    const signature = getRemoteConnectionSignature(settings, this.options.workspaceId);
    if (this.activeClient && this.connectionSignature === signature) {
      // 复用现有连接：ssh2 已配置 keepalive，且 connect 阶段注册的 end/close
      // 事件会在连接失效时清理 activeClient。复用前做一次零成本的本地 socket
      // 活性检查（远端 RST/FIN 已到达时本地 socket 会 destroyed/不可写），避免
      // 复用已死的连接后在 exec 上挂起；不做远端往返，慢链路上无额外开销。
      if (this.isClientAlive(this.activeClient)) {
        this.logger.log(`ssh reuse existing connection host=${settings.remoteHost}:${settings.remotePort} user=${settings.remoteUsername} workspace=${this.options.workspaceId || '<default>'}`);
        return this.activeClient;
      }
      this.close('reusing dead ssh connection, reconnecting');
    }
    if (this.connectionPromise && this.connectionSignature === signature) {
      this.logger.log(`ssh await in-flight connection host=${settings.remoteHost}:${settings.remotePort} user=${settings.remoteUsername} workspace=${this.options.workspaceId || '<default>'}`);
      return await this.connectionPromise;
    }

    this.close('ssh settings changed or new connection requested');
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

  /** 复用前零成本活性检查：本地 socket 已销毁/不可写说明连接已被远端或网络关闭
   *  （RST/FIN 已到达）。静默断连（服务器重启但 TCP 未拆）由 keepalive 兜底触发
   *  error 并清理，这里仅捕捉本地可判定的死连接，避免复用死 socket 后在 exec 挂起。 */
  private isClientAlive(client: Client): boolean {
    const sock = (client as unknown as { _sock?: { destroyed?: boolean; writable?: boolean } })._sock;
    return Boolean(sock && !sock.destroyed && sock.writable);
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
    if (this.options.compress) {
      // ssh2 的 algorithms.compress 优先协商 zlib；远端不支持时回退 none，不影响连接。
      connectConfig.algorithms = {
        compress: ['zlib@openssh.com', 'zlib', 'none']
      };
    }

    return await new Promise<Client>((resolve, reject) => {
      const client = new ssh2.Client();
      const progress = setInterval(() => {
        this.logger.log(`ssh connect waiting (${Date.now() - startedAt} ms) host=${settings.remoteHost}:${settings.remotePort}`);
      }, 5000);
      // 自有墙钟兜底：若 ssh2 因事件循环卡顿/协议边界未在 readyTimeout 内 settle，
      // 销毁连接并 reject，保证 connectionPromise 不会永久 pending。
      const wallClock = setTimeout(() => {
        finish(() => {
          try {
            client.destroy();
          } catch {
            // ignore destroy failures
          }
          reject(new Error(`SSH connect timed out after ${SSH_CONNECT_WALLCLOCK_TIMEOUT_MS} ms.`));
        });
      }, SSH_CONNECT_WALLCLOCK_TIMEOUT_MS);
      const finish = (callback: () => void): void => {
        clearInterval(progress);
        clearTimeout(wallClock);
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

export function getRemoteConnectionSignature(settings: SearchSettings, workspaceId?: string): string {
  // 方案 2：添加 workspaceId 到连接签名中，使不同 VSCode 窗口的连接相互独立
  // 这避免了多开场景下多个窗口共享同一个连接导致的状态竞争问题
  return JSON.stringify({
    host: settings.remoteHost,
    port: settings.remotePort,
    username: settings.remoteUsername,
    password: settings.remotePassword,
    workspaceId: workspaceId || 'default'
  });
}
