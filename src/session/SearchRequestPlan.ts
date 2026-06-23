import type { SearchOptions } from '../core/types';

export type SearchMode = 'content' | 'file' | 'definition';

export type SearchRequestPlan =
  | { kind: 'empty' }
  | {
      kind: 'search';
      mode: SearchMode;
      query: string;
      fileQuery: string;
    };

export function planSearchRequest(options: SearchOptions): SearchRequestPlan {
  const query = options.query.trim();
  const fileQuery = options.fileQuery?.trim() ?? '';
  if (!query && !fileQuery) {
    return { kind: 'empty' };
  }
  if (fileQuery) {
    return { kind: 'search', mode: 'file', query, fileQuery };
  }
  if (options.definitionMode === true) {
    return { kind: 'search', mode: 'definition', query, fileQuery };
  }
  return { kind: 'search', mode: 'content', query, fileQuery };
}
