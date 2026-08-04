import { createSearchPreview, createSearchSymbol } from '../core/text';
import type { SearchResultStore } from '../search/SearchResultStore';

export type FgrContentLine = {
  path: string;
  line: number;
  content: string;
};

/**
 * 解析 fast-grep 的管道输出行 `<path>:<line>:<content>`。
 * 远端是 Linux 路径（无盘符冒号），content 中可能含冒号，故只切前两个冒号。
 */
export function parseFgrLine(line: string): FgrContentLine | null {
  if (!line) {
    return null;
  }
  const firstColon = line.indexOf(':');
  if (firstColon <= 0) {
    return null;
  }
  const rest = line.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon < 0) {
    return null;
  }
  const lineNumber = Number.parseInt(rest.slice(0, secondColon), 10);
  if (!Number.isFinite(lineNumber) || lineNumber < 1) {
    return null;
  }
  return {
    path: line.slice(0, firstColon),
    line: lineNumber,
    content: rest.slice(secondColon + 1)
  };
}

/** 用查询词在行文本中定位首个匹配列（1 基）。fgr 不输出列号，此为近似定位。 */
export function computeFgrColumn(content: string, query: string, caseSensitive: boolean): number {
  const needle = caseSensitive ? query : query.toLowerCase();
  const haystack = caseSensitive ? content : content.toLowerCase();
  const index = haystack.indexOf(needle);
  return index >= 0 ? index + 1 : 1;
}

export class FgrContentProcessor {
  public static processLine(
    line: string,
    query: string,
    caseSensitive: boolean,
    resultPathFilter: (relativePath: string) => boolean,
    createTarget: (remoteRelativePath: string) => {
      uriString: string;
      legacyPath: string;
      relativePath: string;
      repositoryRelativePath?: string;
    },
    resultStore: SearchResultStore
  ): number {
    const parsed = parseFgrLine(line);
    if (!parsed) {
      return 0;
    }
    const target = createTarget(parsed.path);
    const filterRelativePath = target.repositoryRelativePath ?? target.relativePath;
    if (!resultPathFilter(filterRelativePath)) {
      return 0;
    }
    const column = computeFgrColumn(parsed.content, query, caseSensitive);
    const matchEnd = column - 1 + Math.max(query.length, 1);
    const bucket = resultStore.getOrCreate(target.uriString, target.legacyPath, target.relativePath);
    bucket.matches.push({
      path: target.legacyPath,
      uri: target.uriString,
      relativePath: target.relativePath,
      line: parsed.line,
      column,
      endColumn: matchEnd + 1,
      preview: createSearchPreview(parsed.content, column - 1, matchEnd),
      symbolName: createSearchSymbol(parsed.content, column - 1, matchEnd)
    });
    resultStore.markDirty(target.uriString);
    return 1;
  }
}
