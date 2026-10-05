import * as posixPath from 'path/posix';

export type ParsedTagLine = {
  name: string;
  remoteFileAbs: string;
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  kind?: string;
};

// 定义搜索接受的 ctags kind：函数/方法、宏、结构体、类、枚举、枚举成员、typedef、联合体。
// 'x' 表示外部/前置声明（如 `struct foo;`），结构体声明处也属于用户需要的定义搜索范围。
const DEFINITION_KINDS = new Set([
  'f', 'function',
  'm', 'method',
  'd', 'macro',
  's', 'struct',
  'c', 'class',
  'g', 'enum',
  'e', 'enumerator',
  't', 'typedef',
  'u', 'union',
  'v', 'variable',
  'x', 'extern'
]);

function isFunctionKind(kind: string | undefined): boolean {
  const normalized = kind?.toLowerCase();
  return normalized === 'f' || normalized === 'function' || normalized === 'm' || normalized === 'method';
}

export function parseTagLine(line: string, query: string, tagsBaseRemote: string): ParsedTagLine | null {
  const parts = line.split('\t');
  if (parts.length < 3) {
    return null;
  }
  const name = parts[0] ?? '';
  if (name !== query) {
    return null;
  }
  const fileRel = parts[1] ?? '';
  if (!fileRel) {
    return null;
  }
  const excmd = stripTagTerminator(parts[2] ?? '');
  const tagFields = parts.slice(3);
  const fields = tagFields.join('\t');
  const kind = parseTagKind(tagFields);
  if (!isDefinitionKind(kind)) {
    return null;
  }
  const lineNumMatch = /(?:^|\t)line:(\d+)(?:\t|$)/u.exec(fields);
  const parsedLine = lineNumMatch ? Number.parseInt(lineNumMatch[1] ?? '1', 10) : 1;
  const decodedPreview = decodeExCommandPreview(excmd);
  if (isFunctionKind(kind) && isLikelyDeclarationPreview(decodedPreview)) {
    return null;
  }
  // 列号必须基于完整解出的行内容计算：截断后的 preview 会丢掉符号导致列号错位。
  const symbolIndex = decodedPreview.indexOf(name);
  const column = symbolIndex >= 0 ? symbolIndex + 1 : 1;
  const preview = decodedPreview.length > 200 ? `${decodedPreview.slice(0, 200)}...` : decodedPreview;

  return {
    name,
    remoteFileAbs: fileRel.startsWith('/') ? fileRel : posixPath.resolve(tagsBaseRemote, fileRel),
    line: parsedLine,
    column,
    endColumn: column + Math.max(name.length, 1),
    preview,
    kind
  };
}

export function parseTagKind(fields: string[]): string | undefined {
  for (const field of fields) {
    const trimmed = field.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('kind:')) {
      return trimmed.slice('kind:'.length).trim().toLowerCase();
    }
    if (!trimmed.includes(':')) {
      return trimmed.toLowerCase();
    }
  }
  return undefined;
}

export function isDefinitionKind(kind: string | undefined): boolean {
  return kind !== undefined && DEFINITION_KINDS.has(kind.toLowerCase());
}

export function isLikelyDeclarationPreview(preview: string): boolean {
  const trimmed = preview.trim();
  if (!trimmed) {
    return false;
  }
  if (/[{=]/u.test(trimmed)) {
    return false;
  }
  if (/;\s*$/u.test(trimmed)) {
    return true;
  }
  if (/^(?:extern|typedef)\b/u.test(trimmed)) {
    return true;
  }
  return false;
}

function stripTagTerminator(value: string): string {
  return value.endsWith(';"') ? value.slice(0, -2) : value;
}

function decodeExCommandPreview(excmd: string): string {
  if (!excmd || /^\d+$/u.test(excmd)) {
    return '';
  }
  if (excmd.startsWith('/') || excmd.startsWith('?')) {
    return decodeSearchPattern(excmd);
  }
  return decodeTagEscapes(excmd);
}

function decodeSearchPattern(excmd: string): string {
  const delimiter = excmd[0];
  const end = findLastUnescaped(excmd, delimiter);
  const rawPattern = end > 0 ? excmd.slice(1, end) : excmd.slice(1);
  let pattern = rawPattern;
  if (pattern.startsWith('^')) {
    pattern = pattern.slice(1);
  }
  if (hasUnescapedTrailingDollar(pattern)) {
    pattern = pattern.slice(0, -1);
  }
  return decodeTagEscapes(pattern);
}

function findLastUnescaped(value: string, char: string): number {
  for (let i = value.length - 1; i > 0; i -= 1) {
    if (value[i] === char && !isEscaped(value, i)) {
      return i;
    }
  }
  return -1;
}

function hasUnescapedTrailingDollar(value: string): boolean {
  return value.endsWith('$') && !isEscaped(value, value.length - 1);
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function decodeTagEscapes(value: string): string {
  let decoded = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== '\\' || i === value.length - 1) {
      decoded += char;
      continue;
    }
    const next = value[i + 1];
    if (next === 'n') {
      decoded += '\n';
    } else if (next === 'r') {
      decoded += '\r';
    } else if (next === 't') {
      decoded += '\t';
    } else {
      decoded += next;
    }
    i += 1;
  }
  return decoded;
}
