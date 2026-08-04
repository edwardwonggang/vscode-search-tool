import type { SearchMatch } from '../core/types';
import type { SearchResultStore } from '../search/SearchResultStore';

export type SearchSessionConfig = {
  refreshMs: number;
  onStateChange: (message: SearchStateMessage) => void;
  onResultsPush: (results: SearchResultSnapshot) => void;
};

export type SearchStateMessage = {
  type: 'state';
  requestId?: number;
  running: boolean;
  error?: string;
  summary?: string;
  elapsedMs?: number;
  fileCount?: number;
  matchCount?: number;
  ctagsInProgress?: boolean;
  // 阶段提示（如“Building search index...”）：前端应把它显示出来，避免被进度计时器覆盖。
  phase?: boolean;
};

export type SearchResultSnapshot = {
  type: 'results';
  requestId?: number;
  mode: 'content' | 'file';
  replace?: boolean;
  items: Array<{
    path: string;
    relativePath: string;
    count: number;
    matches: SearchMatch[];
  }>;
};

export class SearchSession {
  private token = 0;
  private activeRemoteChannel?: { close(): void };
  private refreshTimer?: NodeJS.Timeout;
  private pendingResultPush = false;
  private pendingResultMode: 'content' | 'file' = 'content';
  private lastResults: SearchResultSnapshot = { type: 'results', mode: 'content', items: [] };
  private lastState: SearchStateMessage = { type: 'state', running: false, summary: '' };

  private _pushCount = 0;
  private _lastPushAt?: number;
  private _firstResultAt?: number;
  private _startedAt = 0;
  private progressTimer?: NodeJS.Timeout;
  private progressMode: 'content' | 'file' = 'content';
  private activeRequestId?: number;

  constructor(
    private readonly config: SearchSessionConfig,
    private readonly resultStore: SearchResultStore
  ) {}

  public begin(requestId?: number): number {
    this.token += 1;
    this.cancelActiveSearch();
    this.resultStore.clear();
    this.lastResults = { type: 'results', mode: 'content', items: [] };
    this.pendingResultPush = false;
    this.pendingResultMode = 'content';
    this._pushCount = 0;
    this._lastPushAt = undefined;
    this._firstResultAt = undefined;
    this._startedAt = Date.now();
    this.stopProgressTimer();
    this.activeRequestId = requestId;
    return this.token;
  }

  public get currentToken(): number {
    return this.token;
  }

  public isCurrent(token: number): boolean {
    return token === this.token;
  }

  public setActiveChannel(channel: { close(): void } | undefined, previous?: { close(): void }): void {
    if (previous) {
      if (this.activeRemoteChannel === previous) {
        this.activeRemoteChannel = channel;
      }
      return;
    }
    if (this.activeRemoteChannel && this.activeRemoteChannel !== channel) {
      this.activeRemoteChannel.close();
    }
    this.activeRemoteChannel = channel;
  }

  public closeActiveChannel(): void {
    if (this.activeRemoteChannel) {
      this.activeRemoteChannel.close();
      this.activeRemoteChannel = undefined;
    }
  }

  public recordMatch(): void {
    if (this._firstResultAt === undefined) {
      this._firstResultAt = Date.now();
    }
  }

  public scheduleResultPush(mode: 'content' | 'file'): void {
    this.pendingResultPush = true;
    this.pendingResultMode = mode;
    if (this.refreshTimer) {
      return;
    }
    const delayMs = this._pushCount === 0 && this._lastPushAt === undefined ? 0 : this.config.refreshMs;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.pendingResultPush) {
        this._pushCount += 1;
        this._lastPushAt = Date.now();
        this.pushResults(this.pendingResultMode);
      }
    }, delayMs);
  }

  public flushResults(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.pendingResultPush) {
      this.pushResults(this.pendingResultMode);
    }
  }

  public pushResults(mode: 'content' | 'file' = 'content'): void {
    this.pendingResultPush = false;
    this.lastResults = {
      type: 'results',
      requestId: this.activeRequestId,
      mode,
      items: this.resultStore.consumeChanged(mode).items
    };
    this.config.onResultsPush(this.lastResults);
  }

  public pushSnapshot(mode: 'content' | 'file' = 'content'): void {
    this.pendingResultPush = false;
    this.lastResults = {
      type: 'results',
      requestId: this.activeRequestId,
      mode,
      replace: true,
      items: this.resultStore.snapshot(mode).items
    };
    this.config.onResultsPush(this.lastResults);
  }

  public postState(message: SearchStateMessage): void {
    const state = { ...message, requestId: message.requestId ?? this.activeRequestId };
    this.lastState = state;
    this.config.onStateChange(state);
  }

  public startProgress(mode: 'content' | 'file'): void {
    this.progressMode = mode;
    this.postProgress();
    if (this.progressTimer) {
      return;
    }
    this.progressTimer = setInterval(() => this.postProgress(), 250);
  }

  public postPhase(summary: string): void {
    this.postState({
      type: 'state',
      running: true,
      summary,
      phase: true,
      elapsedMs: this.elapsedMs,
      fileCount: this.resultStore.size,
      matchCount: this.resultStore.totalMatches()
    });
  }

  public stopProgress(): void {
    this.stopProgressTimer();
  }

  public get elapsedMs(): number {
    return Date.now() - this._startedAt;
  }

  public get firstResultElapsed(): number | undefined {
    return this._firstResultAt ? this._firstResultAt - this._startedAt : undefined;
  }

  public get lastPushElapsed(): number | undefined {
    return this._lastPushAt ? this._lastPushAt - this._startedAt : undefined;
  }

  public get pushCount(): number {
    return this._pushCount;
  }

  public get lastPushAt(): number | undefined {
    return this._lastPushAt;
  }

  public cancelActiveSearch(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.pendingResultPush = false;
    this.pendingResultMode = 'content';
    this.stopProgressTimer();
    if (this.activeRemoteChannel) {
      this.activeRemoteChannel.close();
      this.activeRemoteChannel = undefined;
    }
  }

  public dispose(): void {
    this.cancelActiveSearch();
  }

  private postProgress(): void {
    const fileCount = this.resultStore.size;
    const matchCount = this.resultStore.totalMatches();
    const elapsedMs = this.elapsedMs;
    this.postState({
      type: 'state',
      running: true,
      summary: this.formatProgressSummary(this.progressMode, fileCount, matchCount, elapsedMs),
      elapsedMs,
      fileCount,
      matchCount
    });
  }

  private formatProgressSummary(mode: 'content' | 'file', fileCount: number, matchCount: number, elapsedMs: number): string {
    if (mode === 'file') {
      return `${fileCount} files (${elapsedMs} ms)`;
    }
    return `${fileCount} files, ${matchCount} results (${elapsedMs} ms)`;
  }

  private stopProgressTimer(): void {
    if (!this.progressTimer) {
      return;
    }
    clearInterval(this.progressTimer);
    this.progressTimer = undefined;
  }
}
