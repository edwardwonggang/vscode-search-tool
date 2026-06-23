import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const LOG_FILE_NAME = 'ripgreptool.log';
const MAX_LOG_FILE_BYTES = 1024 * 1024;
const LOG_TRIM_TARGET_BYTES = 768 * 1024;
const LOG_SNIPPET_MAX_CHARS = 500;

export class ExtensionLogger implements vscode.Disposable {
  private readonly outputChannel: vscode.OutputChannel;
  private logWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Ripgrep Tool');
    void this.getLogFilePath()
      .then((logPath) => {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] [log-file] ${logPath}`);
      })
      .catch(() => {
        // The normal log write path will report later filesystem failures.
      });
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }

  public log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.outputChannel.appendLine(line);
    this.enqueueLogWrite(`${line}\n`);
  }

  public debug(message: string): void {
    if (!this.isVerboseLoggingEnabled()) {
      return;
    }
    this.log(`[verbose] ${message}`);
  }

  public summarize(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }
    if (normalized.length <= LOG_SNIPPET_MAX_CHARS) {
      return normalized;
    }
    return `${normalized.slice(0, LOG_SNIPPET_MAX_CHARS)}...`;
  }

  public async getLogFilePath(): Promise<string> {
    const storageUri = this.context.globalStorageUri;
    const storagePath = storageUri.scheme === 'file' ? storageUri.fsPath : this.context.globalStoragePath;
    return path.join(storagePath, LOG_FILE_NAME);
  }

  private enqueueLogWrite(text: string): void {
    this.logWriteQueue = this.logWriteQueue
      .then(async () => {
        const logPath = await this.getLogFilePath();
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        await fs.appendFile(logPath, text, 'utf8');
        await this.trimLogFileIfNeeded(logPath);
      })
      .catch((error) => {
        this.outputChannel.appendLine(
          `[${new Date().toISOString()}] [log-file-error] ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  private async trimLogFileIfNeeded(logPath: string): Promise<void> {
    const stat = await fs.stat(logPath).catch(() => undefined);
    if (!stat || stat.size <= MAX_LOG_FILE_BYTES) {
      return;
    }

    const handle = await fs.open(logPath, 'r');
    try {
      const start = Math.max(0, stat.size - LOG_TRIM_TARGET_BYTES);
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let text = buffer.toString('utf8');
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0 && start > 0) {
        text = text.slice(firstNewline + 1);
      }
      await fs.writeFile(logPath, text, 'utf8');
    } finally {
      await handle.close();
    }
  }

  private isVerboseLoggingEnabled(): boolean {
    return vscode.workspace.getConfiguration('ripgrepTool').get<boolean>('verboseLogging', true);
  }
}
