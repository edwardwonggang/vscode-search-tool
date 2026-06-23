import type { SearchMatch } from '../core/types';

export type MatchSelectionRange = {
  lineIndex: number;
  startCharacter: number;
  endCharacter: number;
};

const NEARBY_LINE_SEARCH_RADIUS = 200;

export function resolveMatchSelection(
  lineCount: number,
  getLineText: (lineIndex: number) => string,
  match: Pick<SearchMatch, 'line' | 'column' | 'endColumn' | 'preview' | 'symbolName'>
): MatchSelectionRange {
  const safeLineCount = Math.max(1, lineCount);
  const requestedLine = clamp(match.line - 1, 0, safeLineCount - 1);
  const symbol = match.symbolName || getPreviewSymbol(match.preview, match.column, match.endColumn);
  const lineIndex = resolveLineIndex(safeLineCount, getLineText, requestedLine, match.preview, symbol);
  const lineText = getLineText(lineIndex);
  const startCharacter = findBestMatchColumn(lineText, match, symbol);
  const width = Math.max(1, symbol.length || match.endColumn - match.column);
  const endCharacter = Math.min(lineText.length, startCharacter + width);

  return {
    lineIndex,
    startCharacter,
    endCharacter: Math.max(startCharacter + 1, endCharacter)
  };
}

function resolveLineIndex(
  lineCount: number,
  getLineText: (lineIndex: number) => string,
  requestedLine: number,
  preview: string,
  symbol: string
): number {
  const previewText = preview.trim();
  if (lineMatches(getLineText(requestedLine), previewText, symbol)) {
    return requestedLine;
  }

  if (previewText) {
    const previewLine = findNearbyLine(lineCount, requestedLine, (lineIndex) =>
      lineMatchesPreview(getLineText(lineIndex), previewText)
    );
    if (previewLine !== undefined) {
      return previewLine;
    }
  }

  if (symbol) {
    const symbolLine = findNearbyLine(lineCount, requestedLine, (lineIndex) =>
      getLineText(lineIndex).includes(symbol)
    );
    if (symbolLine !== undefined) {
      return symbolLine;
    }
  }

  return requestedLine;
}

function findNearbyLine(
  lineCount: number,
  requestedLine: number,
  predicate: (lineIndex: number) => boolean
): number | undefined {
  if (predicate(requestedLine)) {
    return requestedLine;
  }
  const radius = Math.min(NEARBY_LINE_SEARCH_RADIUS, lineCount - 1);
  for (let offset = 1; offset <= radius; offset += 1) {
    const before = requestedLine - offset;
    if (before >= 0 && predicate(before)) {
      return before;
    }
    const after = requestedLine + offset;
    if (after < lineCount && predicate(after)) {
      return after;
    }
  }
  return undefined;
}

function lineMatches(lineText: string, previewText: string, symbol: string): boolean {
  return lineMatchesPreview(lineText, previewText) || (!!symbol && lineText.includes(symbol));
}

function lineMatchesPreview(lineText: string, previewText: string): boolean {
  if (!previewText) {
    return false;
  }
  const trimmed = lineText.trim();
  if (trimmed === previewText) {
    return true;
  }
  if (previewText.endsWith('...')) {
    const prefix = previewText.slice(0, -3).trim();
    return !!prefix && trimmed.startsWith(prefix);
  }
  return false;
}

function findBestMatchColumn(
  lineText: string,
  match: Pick<SearchMatch, 'column' | 'endColumn' | 'preview'>,
  symbol: string
): number {
  const requested = clamp(match.column - 1, 0, lineText.length);
  if (!symbol) {
    return requested;
  }
  if (lineText.slice(requested, requested + symbol.length) === symbol) {
    return requested;
  }

  const previewColumn = match.preview ? match.preview.indexOf(symbol) : -1;
  const previewLineMatchesDocument = !!match.preview && lineText.trim() === match.preview.trim();
  if (previewLineMatchesDocument && previewColumn >= 0) {
    return previewColumn;
  }

  const afterRequested = lineText.indexOf(symbol, requested);
  if (afterRequested >= 0) {
    return afterRequested;
  }
  const anyColumn = lineText.indexOf(symbol);
  if (anyColumn >= 0) {
    return anyColumn;
  }
  return requested;
}

function getPreviewSymbol(preview: string, column: number, endColumn: number): string {
  if (!preview) {
    return '';
  }
  const start = Math.max(0, column - 1);
  const end = Math.max(start, endColumn - 1);
  return preview.slice(start, end).trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
