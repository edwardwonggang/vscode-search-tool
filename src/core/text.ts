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

/**
 * 批量计算一行文本中多个 UTF-8 字节偏移对应的 UTF-16 索引。
 * 相比逐偏移调用 utf8ByteOffsetToUtf16Index（每个偏移都从行首线性扫描），
 * 一次遍历即可得到全部结果；偏移落在多字节字符中间时返回该字符起始索引。
 * @param text 单行文本
 * @param byteOffsets 非负字节偏移数组，结果按入参顺序返回
 */
export function utf8ByteOffsetsToUtf16Indexes(text: string, byteOffsets: readonly number[]): number[] {
  if (byteOffsets.length === 0) {
    return [];
  }
  // 先按字节位置排序，一次线性扫描即可；结果按入参顺序回填，方便与 submatches 配对。
  const order = byteOffsets
    .map((offset, index) => ({ offset, index }))
    .sort((left, right) => left.offset - right.offset);
  const results = new Array<number>(byteOffsets.length);
  let utf8Bytes = 0;
  let utf16Index = 0;
  for (const item of order) {
    if (item.offset <= 0) {
      results[item.index] = 0;
      continue;
    }
    while (utf16Index < text.length && utf8Bytes < item.offset) {
      const codePoint = text.codePointAt(utf16Index);
      if (codePoint === undefined) {
        break;
      }
      const char = String.fromCodePoint(codePoint);
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (utf8Bytes + charBytes > item.offset) {
        // 偏移落在多字节字符中间：返回该字符起始索引（与逐偏移版本语义一致）。
        break;
      }
      utf8Bytes += charBytes;
      utf16Index += char.length;
    }
    results[item.index] = utf16Index;
  }
  return results;
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
