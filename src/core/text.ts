export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function utf8ByteOffsetToUtf16Index(text: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }

  let utf8Bytes = 0;
  let utf16Index = 0;
  while (utf16Index < text.length && utf8Bytes < byteOffset) {
    const codePoint = text.codePointAt(utf16Index);
    if (codePoint === undefined) {
      break;
    }

    const char = String.fromCodePoint(codePoint);
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (utf8Bytes + charBytes > byteOffset) {
      return utf16Index;
    }

    utf8Bytes += charBytes;
    utf16Index += char.length;
  }

  return utf16Index;
}

const SEARCH_PREVIEW_BEFORE_CHARS = 80;
const SEARCH_PREVIEW_AFTER_CHARS = 160;
const SEARCH_SYMBOL_MAX_CHARS = 256;

export function createSearchPreview(lineText: string, matchStart: number, matchEnd: number): string {
  const safeStart = clamp(matchStart, 0, lineText.length);
  const safeEnd = clamp(Math.max(matchEnd, safeStart), safeStart, lineText.length);
  const previewStart = Math.max(0, safeStart - SEARCH_PREVIEW_BEFORE_CHARS);
  const previewEnd = Math.min(lineText.length, safeEnd + SEARCH_PREVIEW_AFTER_CHARS);
  const prefix = previewStart > 0 ? '...' : '';
  const suffix = previewEnd < lineText.length ? '...' : '';
  return `${prefix}${lineText.slice(previewStart, previewEnd)}${suffix}`;
}

export function createSearchSymbol(lineText: string, matchStart: number, matchEnd: number): string | undefined {
  const safeStart = clamp(matchStart, 0, lineText.length);
  const safeEnd = clamp(Math.max(matchEnd, safeStart), safeStart, lineText.length);
  const symbol = lineText.slice(safeStart, safeEnd);
  return symbol.length > 0 && symbol.length <= SEARCH_SYMBOL_MAX_CHARS ? symbol : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
