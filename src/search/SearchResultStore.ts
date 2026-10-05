import type { SearchMatch } from '../core/types';
import { compareSearchFiles } from '../core/ranking';

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
  // 增量维护的匹配总数：进度定时器每 250ms 读一次，避免 O(文件数) 遍历。
  private matchTotal = 0;
  // 当前搜索结果关联的查询词：用于排序时“被查询符号定义优先”。
  private currentQuery = '';

  public clear(): void {
    this.cache.clear();
    this.dirtyKeys.clear();
    this.matchTotal = 0;
    this.currentQuery = '';
  }

  /** 设置当前查询词，供排序器做“被查询符号定义优先”判定；搜索开始时调用。 */
  public setQuery(query: string): void {
    this.currentQuery = String(query ?? '').trim();
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
    const previous = this.cache.get(key);
    this.matchTotal += result.matches.length - (previous?.matches.length ?? 0);
    this.cache.set(key, result);
    this.dirtyKeys.add(key);
  }

  public addMatch(key: string, path: string, relativePath: string, match: SearchMatch): void {
    this.getOrCreate(key, path, relativePath).matches.push(match);
    this.matchTotal += 1;
    this.dirtyKeys.add(key);
  }

  public markDirty(key: string): void {
    if (this.cache.has(key)) {
      this.dirtyKeys.add(key);
    }
  }

  /** 直接向 getOrCreate 返回的 bucket push 匹配后，调用方需上报追加数量以维持增量计数。 */
  public recordAppendedMatches(count: number): void {
    this.matchTotal += count;
  }

  public totalMatches(): number {
    return this.matchTotal;
  }

  public snapshot(mode: SearchResultMode): SearchResultSnapshot {
    return {
      type: 'results',
      mode,
      items: Array.from(this.cache.values())
        .sort((left, right) => compareSearchFiles(left, right, this.currentQuery))
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
    items.sort((left, right) => compareSearchFiles(left, right, this.currentQuery));
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
