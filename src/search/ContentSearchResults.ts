import { createSearchPreview, createSearchSymbol, utf8ByteOffsetToUtf16Index } from '../core/text';
import type { SearchTarget } from '../workspace/WorkspaceResolver';
import { SearchResultStore } from './SearchResultStore';

export type RipgrepJsonMatchEntry = {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start: number; end: number }>;
  };
};

export type AddContentMatchOptions = {
  entry: RipgrepJsonMatchEntry;
  resultPathFilter: (relativePath: string) => boolean;
  createTarget: (remoteRelativePath: string) => SearchTarget;
  resultStore: SearchResultStore;
};

export function addContentSearchMatch(input: AddContentMatchOptions): number {
  if (input.entry.type !== 'match') {
    return 0;
  }

  const data = input.entry.data;
  const filePath = data?.path?.text;
  if (!data || !filePath) {
    return 0;
  }

  const target = input.createTarget(filePath);
  const filterRelativePath = target.repositoryRelativePath || target.relativePath;
  if (!input.resultPathFilter(filterRelativePath)) {
    return 0;
  }
  const relativePath = target.relativePath;

  const submatches = data.submatches ?? [];
  const lines = data.lines?.text ?? '';
  const lineText = lines.replace(/\r?\n$/, '');
  const lineNumber = data.line_number ?? 1;
  const bucket = input.resultStore.getOrCreate(target.uriString, target.legacyPath, relativePath);

  for (const submatch of submatches) {
    const start = utf8ByteOffsetToUtf16Index(lineText, submatch.start);
    const end = utf8ByteOffsetToUtf16Index(lineText, submatch.end);
    bucket.matches.push({
      path: target.legacyPath,
      uri: target.uriString,
      relativePath: target.relativePath,
      line: lineNumber,
      column: start + 1,
      endColumn: end + 1,
      preview: createSearchPreview(lineText, start, end),
      symbolName: createSearchSymbol(lineText, start, end)
    });
  }

  if (submatches.length > 0) {
    input.resultStore.markDirty(target.uriString);
  }

  return submatches.length;
}
