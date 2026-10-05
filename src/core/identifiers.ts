/**
 * 标识符（identifier）解析与查询辅助。
 *
 * 借鉴 semble 的 tokens.py（camelCase/snake_case 子 token 拆分）与 boosting.py
 * （符号查询判定 _SYMBOL_QUERY_RE）：把复合标识符拆成子 token 便于部分匹配召回，
 * 并区分“符号查询”与“自然语言查询”。本文件只提供纯函数，无副作用。
 */

// 匹配单个标识符：字母/下划线开头，后续字母数字下划线。
const IDENTIFIER_TOKEN_RE = /[a-zA-Z_][a-zA-Z0-9_]*/g;
// camelCase / PascalCase 边界拆分：HandlerStack → Handler/Stack；
// getHTTPResponse → get/HTTP/Response；XMLParser → XML/Parser。
const CAMEL_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;

/**
 * 把单个标识符拆成子 token（含原词小写）。snake_case 按下划线拆分，
 * camelCase/PascalCase 按大小写边界拆分；单一 token 只返回原词小写。
 * 例：HandlerStack → [handlerstack, handler, stack]；my_func → [my_func, my, func]。
 */
export function splitIdentifier(token: string): string[] {
  const lower = String(token).toLowerCase();
  const parts: string[] = [];
  if (token.includes("_")) {
    for (const part of lower.split("_")) {
      if (part) {
        parts.push(part);
      }
    }
  } else {
    for (const match of String(token).matchAll(CAMEL_RE)) {
      parts.push(match[0].toLowerCase());
    }
  }
  if (parts.length >= 2) {
    return Array.from(new Set([lower, ...parts]));
  }
  return [lower];
}

/**
 * 从文本中提取标识符并展开为子 token 列表（全部小写、去重、保序）。
 */
export function tokenizeIdentifiers(text: string): string[] {
  const result: string[] = [];
  for (const match of String(text).matchAll(IDENTIFIER_TOKEN_RE)) {
    for (const part of splitIdentifier(match[0])) {
      if (!result.includes(part)) {
        result.push(part);
      }
    }
  }
  return result;
}

// 符号查询判定（借鉴 semble _SYMBOL_QUERY_RE）：命名空间限定（::/\\/->/.）、
// 下划线开头、含大写或下划线、或大写开头，都视为符号查询；纯小写普通词视为自然语言。
const SYMBOL_QUERY_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\\|->|\.)[A-Za-z_][A-Za-z0-9_]*)+|_[A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9]*[A-Z_][A-Za-z0-9_]*|[A-Z][A-Za-z0-9]*)$/;

/**
 * 判断查询是否像“符号查询”（裸符号或命名空间限定的标识符），用于在精确符号匹配
 * 与模糊/自然语言匹配之间切换策略。
 */
export function isSymbolQuery(query: string): boolean {
  return SYMBOL_QUERY_RE.test(String(query).trim());
}

/**
 * 生成一个标识符查询的可能变体（用于定义搜索精确失败后的重查）：原样、全小写、
 * 首字母大写、以及 camelCase/snake_case 拆出的子 token。去重、保序、过滤空串。
 */
export function identifierVariants(query: string): string[] {
  const trimmed = String(query).trim();
  if (!trimmed) {
    return [];
  }
  const variants: string[] = [];
  const push = (value: string) => {
    if (value && !variants.includes(value)) {
      variants.push(value);
    }
  };
  push(trimmed);
  push(trimmed.toLowerCase());
  push(trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
  for (const part of splitIdentifier(trimmed)) {
    push(part);
    push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return variants;
}
