/**
 * 从光标所在行文本提取用于 ctags 定义搜索的符号名。
 *
 * 与 VSCode 内置 `getWordRangeAtPosition` 相比，这里额外支持：
 * - `::`、`->`、`.` 作用域/成员访问：返回最右侧标识符（如 `obj->method` -> `method`）。
 * - C++ 运算符重载：`operator<<` / `operator()` / `operator[]` 等返回完整 operator 名，
 *   而不是只取到 `operator` 或 `operator<`，从而能命中 ctags 中对应的重载定义。
 * 纯函数、不依赖 vscode API，便于单元测试。
 */

const IDENT_START = /[A-Za-z_$]/u;
const IDENT_PART = /[A-Za-z0-9_$]/u;
const OPERATOR_SYMBOLS = [
  '<<=',
  '>>=',
  '...',
  '->*',
  '<=>',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '->',
  '()',
  '[]',
  '~',
  '!',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '&',
  '|',
  '^',
  ','
].sort((a, b) => b.length - a.length);

function isIdentStart(ch: string): boolean {
  return IDENT_START.test(ch);
}

function isIdentPart(ch: string): boolean {
  return IDENT_PART.test(ch);
}

/** 从光标位置向左/右扩展得到一个 C/C++ 标识符；返回标识符与起始下标。 */
function readIdentifier(line: string, col: number): { ident: string; start: number; end: number } | null {
  let start = col;
  while (start > 0 && isIdentPart(line[start - 1])) {
    start -= 1;
  }
  let end = col;
  while (end < line.length && isIdentPart(line[end])) {
    end += 1;
  }
  const ident = line.slice(start, end);
  return ident && isIdentStart(ident[0]) ? { ident, start, end } : null;
}

/** 提取光标处的运算符重载名（如 `operator<<`）；非 operator 场景返回 null。 */
function readOperator(line: string, col: number): string | null {
  // 从 col 向左找 "operator" 关键字。
  const before = line.slice(0, col);
  const m = /operator(?=[^A-Za-z0-9_$]|$)/u.exec(before);
  if (!m) {
    return null;
  }
  const keywordStart = m.index;
  const opStart = m.index + 'operator'.length;
  // 运算符主体从关键字后开始，忽略可能的分隔空白。
  let i = opStart;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    i += 1;
  }
  // 读取符号主体。`()` / `[]` 作为重载符号整体（operator()/operator[]），
  // 其余符号读到空白、分号或参数列表起始 `(`/`[`（非空括号对）为止。
  let body = '';
  let j = i;
  while (j < line.length) {
    const ch = line[j];
    if (ch === ' ' || ch === '\t' || ch === ';') {
      break;
    }
    if (ch === '(') {
      if (line[j + 1] === ')') {
        body += '()';
        j += 2;
        break;
      }
      break;
    }
    if (ch === '[') {
      if (line[j + 1] === ']') {
        body += '[]';
        j += 2;
        break;
      }
      break;
    }
    body += ch;
    j += 1;
  }
  if (body.startsWith('operator')) {
    return null;
  }
  // 光标须落在 operator 关键字到符号主体结束之间，才视为该重载符号。
  if (col < keywordStart || col > j) {
    return null;
  }
  return body ? `operator${body}` : 'operator';
}

/**
 * 提取光标处的定义搜索符号名。col 为 0-based 字符位置。
 * 返回 null 表示该位置无可用符号。
 */
export function extractSymbolAtLine(line: string, col: number): string | null {
  if (!line) {
    return null;
  }
  const clamped = Math.max(0, Math.min(col, line.length));
  // 先尝试运算符重载（光标落在 operator 或其后）。
  const op = readOperator(line, clamped);
  if (op) {
    return op;
  }
  // 再尝试标识符。
  const ident = readIdentifier(line, clamped);
  if (!ident) {
    return null;
  }
  // 若光标落在标识符前导上（如限定名 `ns::foo` 的光标在 foo），返回最右标识符。
  return ident.ident;
}
