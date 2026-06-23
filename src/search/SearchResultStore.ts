import type { SearchMatch } from '../core/types';

export type SearchFileResult = {
  path: string;
  relativePath: string;
  matches: SearchMatch[];
  consumedMatchCount: number;
};

export type SearchResultMode = 'content' | 'file';

export type SearchResultSnapshot = {
  type: 'results';
  mode: SearchResultMode;
  items: Array<{
    path: string;
    relativePath: string;
    count: number;
    matches: SearchMatch[];
  }>;
};

export type SearchResultItem = SearchResultSnapshot['items'][number];

export class SearchResultStore {
  private readonly cache = new Map<string, SearchFileResult>();
  private readonly dirtyKeys = new Set<string>();

  public clear(): void {
    this.cache.clear();
    this.dirtyKeys.clear();
  }

  public get size(): number {
    return this.cache.size;
  }

  public getOrCreate(key: string, path: string, relativePath: string): SearchFileResult {
    let bucket = this.cache.get(key);
    if (!bucket) {
      bucket = { path, relativePath, matches: [], consumedMatchCount: 0 };
      this.cache.set(key, bucket);
    }
    return bucket;
  }

  public setFileResult(key: string, result: SearchFileResult): void {
    this.cache.set(key, result);
    this.dirtyKeys.add(key);
  }

  public addMatch(key: string, path: string, relativePath: string, match: SearchMatch): void {
    this.getOrCreate(key, path, relativePath).matches.push(match);
    this.dirtyKeys.add(key);
  }

  public markDirty(key: string): void {
    if (this.cache.has(key)) {
      this.dirtyKeys.add(key);
    }
  }

  public totalMatches(): number {
    let total = 0;
    for (const result of this.cache.values()) {
      total += result.matches.length;
    }
    return total;
  }

  public snapshot(mode: SearchResultMode): SearchResultSnapshot {
    return {
      type: 'results',
      mode,
      items: Array.from(this.cache.values())
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .map((file) => ({
          path: file.path,
          relativePath: file.relativePath,
          count: file.matches.length,
          matches: file.matches
        }))
    };
  }

  public consumeChanged(mode: SearchResultMode): SearchResultSnapshot {
    const items: SearchResultItem[] = [];
    for (const key of this.dirtyKeys) {
      const file = this.cache.get(key);
      if (file) {
        items.push(toChangedResultItem(file));
      }
    }
    this.dirtyKeys.clear();
    items.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return { type: 'results', mode, items };
  }
}

function toResultItem(file: SearchFileResult): SearchResultItem {
  return {
    path: file.path,
    relativePath: file.relativePath,
    count: file.matches.length,
    matches: file.matches
  };
}

function toChangedResultItem(file: SearchFileResult): SearchResultItem {
  const matches = file.matches.slice(file.consumedMatchCount);
  file.consumedMatchCount = file.matches.length;
  return {
    path: file.path,
    relativePath: file.relativePath,
    count: file.matches.length,
    matches
  };
}
