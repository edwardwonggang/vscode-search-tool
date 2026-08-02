import type { SearchMatch } from '../core/types';

/**
 * 定义跳转位置：uri 优先，legacyPath 兜底；行列号均为 1-based（与 ctags 一致）。
 */
export type DefinitionLocationData = {
  uri: string;
  legacyPath: string;
  line: number;
  column: number;
};

/**
 * 把定义搜索结果转换为定义跳转位置列表，并按 uri+行列去重。
 * 不依赖 vscode API，便于单元测试。
 */
export function buildDefinitionLocations(matches: SearchMatch[]): DefinitionLocationData[] {
  const seen = new Set<string>();
  const locations: DefinitionLocationData[] = [];
  for (const match of matches) {
    if (!match || (!match.uri && !match.path)) {
      continue;
    }
    const key = `${match.uri ?? match.path}|${match.line}|${match.column}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    locations.push({
      uri: match.uri ?? '',
      legacyPath: match.path,
      line: match.line,
      column: match.column
    });
  }
  return locations;
}
