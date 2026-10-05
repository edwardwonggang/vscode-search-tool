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
  const isDefinition = !!match.symbolName;
  const lineIndex = resolveLineIndex(safeLineCount, getLineText, requestedLine, match.preview, symbol, isDefinition);
  const lineText = getLineText(lineIndex);
  const startCharacter = findBestMatchColumn(lineText, match, symbol, isDefinition);
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
  symbol: string,
  isDefinition: boolean
): number {
  const previewText = preview.trim();
  if (lineMatches(getLineText(requestedLine), previewText, symbol, isDefinition)) {
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
    // 定义跳转优先找“整词出现”的附近行，避免 ctags 行号漂移后落在引用处或子串处。
    const symbolLine = findNearbyLine(lineCount, requestedLine, (lineIndex) =>
      isDefinition
        ? containsWord(getLineText(lineIndex), symbol)
        : getLineText(lineIndex).includes(symbol)
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

function lineMatches(lineText: string, previewText: string, symbol: string, isDefinition: boolean): boolean {
  return (
    lineMatchesPreview(lineText, previewText) ||
    (!!symbol && (isDefinition ? containsWord(lineText, symbol) : lineText.includes(symbol)))
  );
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
  symbol: string,
  isDefinition: boolean
): number {
  const requested = clamp(match.column - 1, 0, lineText.length);
  if (!symbol) {
    return requested;
  }
  if (isDefinition) {
    const wholeWordAtRequested = containsWordAt(lineText, symbol, requested);
    if (wholeWordAtRequested) {
      return requested;
    }
  } else if (lineText.slice(requested, requested + symbol.length) === symbol) {
    return requested;
  }

  const previewColumn = match.preview ? match.preview.indexOf(symbol) : -1;
  const previewLineMatchesDocument = !!match.preview && lineText.trim() === match.preview.trim();
  if (previewLineMatchesDocument && previewColumn >= 0) {
    return previewColumn;
  }

  const afterRequested = isDefinition
    ? indexOfWord(lineText, symbol, requested)
    : lineText.indexOf(symbol, requested);
  if (afterRequested >= 0) {
    return afterRequested;
  }
  const anyColumn = isDefinition ? indexOfWord(lineText, symbol, 0) : lineText.indexOf(symbol);
  if (anyColumn >= 0) {
    return anyColumn;
  }
  return requested;
}

function containsWord(text: string, word: string): boolean {
  return indexOfWord(text, word, 0) >= 0;
}

function containsWordAt(text: string, word: string, index: number): boolean {
  if (!word || index < 0 || index + word.length > text.length) {
    return false;
  }
  if (text.slice(index, index + word.length) !== word) {
    return false;
  }
  return isWordBoundary(text, index - 1) && isWordBoundary(text, index + word.length);
}

function indexOfWord(text: string, word: string, fromIndex: number): number {
  if (!word) {
    return -1;
  }
  let index = text.indexOf(word, Math.max(0, fromIndex));
  while (index >= 0) {
    if (isWordBoundary(text, index - 1) && isWordBoundary(text, index + word.length)) {
      return index;
    }
    index = text.indexOf(word, index + 1);
  }
  return -1;
}

function isWordBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return true;
  }
  return !/[A-Za-z0-9_]/u.test(text[index] ?? '');
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
