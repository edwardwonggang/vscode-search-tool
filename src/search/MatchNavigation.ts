import type { SearchMatch } from '../core/types';

export type MatchSelectionRange = {
  lineIndex: number;
  startCharacter: number;
  endCharacter: number;
};

const NEARBY_LINE_SEARCH_RADIUS = 200;
// 定义跳转整词回退的半径：ctags 行号漂移通常在数行内，收紧半径避免跳到更远的引用/调用处。
const DEFINITION_WORD_RADIUS = 40;

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
    if (isDefinition) {
      // 定义跳转优先找“像定义”的附近行（符号后随 ( { = : 等声明形态），
      // 避免 ctags 行号漂移后落到更近的引用/调用处。
      const defLine = findNearbyLine(lineCount, requestedLine, (lineIndex) =>
        looksLikeDefinitionLine(getLineText(lineIndex), symbol)
      );
      if (defLine !== undefined) {
        return defLine;
      }
    }
    // 回退：非定义搜索（全文/内容）保持原半径找“包含符号”的行；定义跳转在无
    // “定义形态”命中时缩小半径找整词出现，避免跳到远端引用。
    const radius = isDefinition ? DEFINITION_WORD_RADIUS : NEARBY_LINE_SEARCH_RADIUS;
    const symbolLine = findNearbyLine(
      lineCount,
      requestedLine,
      (lineIndex) =>
        isDefinition ? containsWord(getLineText(lineIndex), symbol) : getLineText(lineIndex).includes(symbol),
      radius
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
  predicate: (lineIndex: number) => boolean,
  radiusLimit = NEARBY_LINE_SEARCH_RADIUS
): number | undefined {
  if (predicate(requestedLine)) {
    return requestedLine;
  }
  const radius = Math.min(radiusLimit, lineCount - 1);
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

/**
 * 判断一行文本是否像“符号的定义/声明”而非引用。定义跳转行回退时优先命中此形态，
 * 避免 ctags 行号漂移后落到更近的调用/成员访问等引用处。
 */
function looksLikeDefinitionLine(lineText: string, symbol: string): boolean {
  const text = lineText.trim();
  if (!text || !symbol) {
    return false;
  }
  const idx = indexOfWord(text, symbol, 0);
  if (idx < 0) {
    return false;
  }
  // 成员访问（. / ->）、作用域（::）、调用后括号（)）多为引用形态，不作定义候选。
  const before = text[idx - 1] ?? '';
  if (before === '.' || before === '>' || before === ':' || before === ')') {
    return false;
  }
  const tail = text.slice(idx + symbol.length).trimStart();
  return (
    tail === '' ||
    /^[({=;:]/.test(tail) ||
    /^[A-Za-z_$][\w$]*\s*[({=:]/.test(tail) ||
    idx === 0 ||
    /^(?:#\s*define|class|struct|enum|interface|typedef|using|template|def|fn|func|function|static|extern|const|auto|var|let)\b/.test(text)
  );
}

function lineMatches(lineText: string, previewText: string, symbol: string, isDefinition: boolean): boolean {  return (
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
  return !/[\p{L}\p{N}_$]/u.test(text[index] ?? '');
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
