export type WebviewMessage =
  | { type: 'bootstrap'; payload: BootstrapPayload }
  | { type: 'results'; payload: SearchResultPayload }
  | { type: 'state'; payload: StatePayload }
  | { type: 'settings'; payload: unknown }
  | { type: 'connectionResult'; payload: ConnectionResultPayload }
  | { type: 'gitRootRequired'; payload: GitRootRequiredPayload }
  | { type: 'focus' };

export type BootstrapPayload = {
  workspaceName: string;
  workspacePath: string;
  gitRootOk: boolean;
  gitError?: string;
  repositories?: Array<{
    name: string;
    relativePath: string;
    displayPath: string;
  }>;
  settings: unknown;
  translations: Record<string, string>;
  state: StatePayload;
  results: SearchResultPayload;
};

export type SearchResultPayload = {
  type: 'results';
  requestId?: number;
  mode: 'content' | 'file';
  replace?: boolean;
  items: Array<{
    path: string;
    relativePath: string;
    count: number;
    matches: Array<{
      path: string;
      uri?: string;
      relativePath?: string;
      line: number;
      column: number;
      endColumn: number;
      preview: string;
      symbolName?: string;
    }>;
  }>;
};

export type StatePayload = {
  type: 'state';
  requestId?: number;
  running: boolean;
  error?: string;
  summary?: string;
  elapsedMs?: number;
  ctagsInProgress?: boolean;
};

export type ConnectionResultPayload = {
  ok: boolean;
  message: string;
  cwd?: string;
};

export type GitRootRequiredPayload = {
  message: string;
  workspacePath: string;
};

export type WebviewMessageSender = {
  postMessage(message: unknown): void;
  show?(): void;
};

export class WebviewMessageRouter {
  private view?: WebviewMessageSender;
  private lastState: StatePayload = { type: 'state', running: false, summary: '' };
  private lastResults: SearchResultPayload = { type: 'results', mode: 'content', items: [] };

  public setView(view: { webview: WebviewMessageSender } | undefined): void {
    if (view) {
      this.view = view.webview;
    } else {
      this.view = undefined;
    }
  }

  public postResults(
    mode: 'content' | 'file',
    items: SearchResultPayload['items'],
    replace = true,
    requestId?: number
  ): void {
    if (replace) {
      this.lastResults = { type: 'results', requestId, mode, replace: true, items };
    } else {
      const merged = mergeResultItems(this.lastResults.mode === mode ? this.lastResults.items : [], items);
      this.lastResults = { type: 'results', requestId, mode, items: merged };
    }
    this.view?.postMessage({ type: 'results', payload: { type: 'results', requestId, mode, replace, items } });
  }

  public postState(state: StatePayload): void {
    this.lastState = state;
    this.view?.postMessage({ type: 'state', payload: state });
  }

  public postConnectionResult(result: ConnectionResultPayload): void {
    this.view?.postMessage({ type: 'connectionResult', payload: result });
  }

  public postGitRootRequired(message: string, workspacePath: string): void {
    this.view?.postMessage({
      type: 'gitRootRequired',
      payload: { message, workspacePath }
    });
  }

  public postBootstrap(payload: BootstrapPayload): void {
    this.view?.postMessage({ type: 'bootstrap', payload });
  }

  public postFocus(): void {
    this.view?.postMessage({ type: 'focus' });
    this.view?.show?.();
  }

  public focus(): void {
    this.view?.show?.();
  }

  public getState(): StatePayload {
    return this.lastState;
  }

  public getResults(): SearchResultPayload {
    return this.lastResults;
  }

  public postMessage(message: WebviewMessage): void {
    this.view?.postMessage(message);
  }
}

export function mergeResultItems(
  currentItems: SearchResultPayload['items'],
  changedItems: SearchResultPayload['items']
): SearchResultPayload['items'] {
  const byPath = new Map(currentItems.map((item) => [item.path, item]));
  for (const item of changedItems) {
    const existing = byPath.get(item.path);
    byPath.set(item.path, existing ? mergeResultItem(existing, item) : normalizeNewResultItem(item));
  }
  return Array.from(byPath.values()).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function mergeResultItem(
  existing: SearchResultPayload['items'][number],
  changed: SearchResultPayload['items'][number]
): SearchResultPayload['items'][number] {
  const matches = mergeMatches(existing.matches, changed.matches);
  return {
    ...existing,
    ...changed,
    count: matches.length,
    matches
  };
}

function normalizeNewResultItem(
  item: SearchResultPayload['items'][number]
): SearchResultPayload['items'][number] {
  return {
    ...item,
    count: Math.max(item.count, item.matches.length)
  };
}

function mergeMatches(
  currentMatches: SearchResultPayload['items'][number]['matches'],
  changedMatches: SearchResultPayload['items'][number]['matches']
): SearchResultPayload['items'][number]['matches'] {
  const seen = new Set<string>();
  const merged: SearchResultPayload['items'][number]['matches'] = [];
  for (const match of [...currentMatches, ...changedMatches]) {
    const key = [
      match.uri || match.path,
      match.relativePath || '',
      match.line,
      match.column,
      match.endColumn,
      match.symbolName || ''
    ].join('\u0001');
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(match);
    }
  }
  return merged;
}
