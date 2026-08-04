export type StreamingLineProcessorStats = {
  pushedChunks: number;
  processedLines: number;
  yieldedSlices: number;
  maxBufferedChars: number;
  oversizedLines: number;
};

export type StreamingLineProcessorOptions = {
  onLine: (line: string) => void;
  shouldContinue?: () => boolean;
  maxLinesPerSlice?: number;
  maxSliceMs?: number;
  maxLineChars?: number;
};

const DEFAULT_MAX_LINES_PER_SLICE = 250;
const DEFAULT_MAX_SLICE_MS = 8;
// 单行缓冲上限：防止远端单行超大文本（如超长压缩/生成文件）撑爆内存；超限行整行跳过并计数。
const DEFAULT_MAX_LINE_CHARS = 4 * 1024 * 1024;

export class StreamingLineProcessor {
  private readonly chunks: string[] = [];
  private buffer = '';
  private timer?: NodeJS.Timeout;
  private processing = false;
  private flushing = false;
  private readonly idleResolvers: Array<() => void> = [];
  private readonly maxLinesPerSlice: number;
  private readonly maxSliceMs: number;
  private readonly maxLineChars: number;
  private readonly shouldContinue: () => boolean;
  private oversizedLineActive = false;
  private readonly _stats: StreamingLineProcessorStats = {
    pushedChunks: 0,
    processedLines: 0,
    yieldedSlices: 0,
    maxBufferedChars: 0,
    oversizedLines: 0
  };

  constructor(private readonly options: StreamingLineProcessorOptions) {
    this.maxLinesPerSlice = Math.max(1, options.maxLinesPerSlice ?? DEFAULT_MAX_LINES_PER_SLICE);
    this.maxSliceMs = Math.max(1, options.maxSliceMs ?? DEFAULT_MAX_SLICE_MS);
    this.maxLineChars = Math.max(1, options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS);
    this.shouldContinue = options.shouldContinue ?? (() => true);
  }

  public get stats(): StreamingLineProcessorStats {
    return { ...this._stats };
  }

  public push(text: string): void {
    if (!text || !this.shouldContinue()) {
      this.clear();
      return;
    }
    this.chunks.push(text);
    this._stats.pushedChunks += 1;
    this.schedule();
  }

  public async flush(): Promise<void> {
    this.flushing = true;
    this.schedule();
    if (this.isIdle()) {
      return;
    }
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private schedule(): void {
    if (this.timer || this.processing) {
      return;
    }
    this.timer = setTimeout(() => this.processSlice(), 0);
  }

  private processSlice(): void {
    this.timer = undefined;
    if (!this.shouldContinue()) {
      this.clear();
      this.resolveIdle();
      return;
    }

    this.processing = true;
    const startedAt = Date.now();
    let linesThisSlice = 0;

    while (this.shouldContinue()) {
      const line = this.takeLine();
      if (line === undefined) {
        break;
      }
      if (line) {
        this.options.onLine(line);
        this._stats.processedLines += 1;
      }
      linesThisSlice += 1;
      if (linesThisSlice >= this.maxLinesPerSlice || Date.now() - startedAt >= this.maxSliceMs) {
        this._stats.yieldedSlices += 1;
        break;
      }
    }

    this.processing = false;
    if (!this.shouldContinue()) {
      this.clear();
      this.resolveIdle();
      return;
    }
    if (this.hasWork()) {
      this.schedule();
    } else {
      this.resolveIdle();
    }
  }

  private takeLine(): string | undefined {
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (this.oversizedLineActive) {
          this.oversizedLineActive = false;
          this._stats.oversizedLines += 1;
          continue;
        }
        return line;
      }
      if (this.chunks.length) {
        const chunk = this.chunks.shift() as string;
        if (this.oversizedLineActive) {
          // 已处于超长行内：只保留换行之后的片段，丢弃其余内容以限制内存。
          const chunkNewlineIndex = chunk.indexOf('\n');
          if (chunkNewlineIndex >= 0) {
            this.buffer = chunk.slice(chunkNewlineIndex + 1);
            this.oversizedLineActive = false;
            this._stats.oversizedLines += 1;
          }
          continue;
        }
        if (this.buffer.length + chunk.length > this.maxLineChars) {
          // 当前累积的整行已超过上限：丢弃并跳到下一个换行。
          this.buffer = '';
          this.oversizedLineActive = true;
          const chunkNewlineIndex = chunk.indexOf('\n');
          if (chunkNewlineIndex >= 0) {
            this.buffer = chunk.slice(chunkNewlineIndex + 1);
            this.oversizedLineActive = false;
            this._stats.oversizedLines += 1;
          }
          continue;
        }
        this.buffer += chunk;
        this._stats.maxBufferedChars = Math.max(this._stats.maxBufferedChars, this.buffer.length);
        continue;
      }
      if (this.flushing) {
        if (this.oversizedLineActive) {
          this.oversizedLineActive = false;
          this._stats.oversizedLines += 1;
        }
        if (this.buffer.length) {
          const line = this.buffer.trim();
          this.buffer = '';
          return line;
        }
      }
      return undefined;
    }
  }

  private hasWork(): boolean {
    return this.chunks.length > 0 || this.buffer.length > 0;
  }

  private isIdle(): boolean {
    return !this.timer && !this.processing && !this.hasWork();
  }

  private clear(): void {
    this.chunks.length = 0;
    this.buffer = '';
    this.oversizedLineActive = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.processing = false;
  }

  private resolveIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }
}
