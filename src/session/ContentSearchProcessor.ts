import { createSearchPreview, createSearchSymbol, utf8ByteOffsetToUtf16Index } from '../core/text';
import type { SearchResultStore } from '../search/SearchResultStore';

export type ContentSearchEntry = {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start: number; end: number }>;
  };
};

export class ContentSearchProcessor {
  public static processLine(
    entry: ContentSearchEntry,
    resultPathFilter: (relativePath: string) => boolean,
    createTarget: (remoteRelativePath: string) => { uriString: string; legacyPath: string; relativePath: string },
    resultStore: SearchResultStore
  ): number {
    if (entry.type !== 'match') {
      return 0;
    }

    const data = entry.data;
    const filePath = data?.path?.text;
    if (!data || !filePath) {
      return 0;
    }

    const target = createTarget(filePath);
    const relativePath = target.relativePath;
    if (!resultPathFilter(relativePath)) {
      return 0;
    }

    const submatches = data.submatches ?? [];
    const lines = data.lines?.text ?? '';
    const lineText = lines.replace(/\r?\n$/, '');
    const lineNumber = data.line_number ?? 1;
    const bucket = resultStore.getOrCreate(target.uriString, target.legacyPath, relativePath);

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
      resultStore.markDirty(target.uriString);
    }

    return submatches.length;
  }
}
