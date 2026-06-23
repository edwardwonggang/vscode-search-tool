import { createFileQueryMatcher, createResultPathFilter } from '../core/glob';
import type { SearchOptions, SearchSettings } from '../core/types';
import type { SearchTarget } from '../workspace/WorkspaceResolver';
import { SearchResultStore } from './SearchResultStore';

export type FileSearchTargetFactory = (relativePath: string) => SearchTarget;

export type PopulateFileSearchResultsOptions = {
  stdout: string;
  fileQuery: string;
  options: SearchOptions;
  settings: SearchSettings;
  createTarget: FileSearchTargetFactory;
  resultStore: SearchResultStore;
};

export function populateFileSearchResults(input: PopulateFileSearchResultsOptions): number {
  const resultPathFilter = createResultPathFilter(input.options, input.settings);
  const matcher = createFileQueryMatcher(input.fileQuery, input.options.caseSensitive);
  const lines = input.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  input.resultStore.clear();
  let totalFiles = 0;
  for (const remoteRelativePath of lines) {
    const relativePath = remoteRelativePath.replace(/\\/gu, '/');
    if (!resultPathFilter(relativePath) || !matcher(relativePath)) {
      continue;
    }
    const target = input.createTarget(relativePath);
    addFileSearchResult(input.resultStore, target);
    totalFiles += 1;
  }
  return totalFiles;
}

export function addFileSearchResult(resultStore: SearchResultStore, target: SearchTarget): void {
  const displayPath = target.relativePath;
  resultStore.setFileResult(target.uriString, {
    path: target.legacyPath,
    relativePath: displayPath,
    consumedMatchCount: 0,
    matches: [{
      path: target.legacyPath,
      uri: target.uriString,
      relativePath: target.relativePath,
      line: 1,
      column: 1,
      endColumn: 2,
      preview: displayPath
    }]
  });
}
