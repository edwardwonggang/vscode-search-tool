import * as vscode from 'vscode';
import type { SearchMatch } from '../core/types';
import { buildDefinitionLocations } from './definitionLocations';
import { resolveMatchSelection } from '../search/MatchNavigation';

/**
 * 定义查找回调：按符号名执行远端 ctags 定义搜索。
 */
export type DefinitionLookup = (
  symbol: string,
  onPhase?: (phase: string) => void
) => Promise<SearchMatch[]>;

/**
 * VS Code 定义提供器：让内置 Ctrl+点击 / F12 走本扩展的远端 ctags 定义搜索。
 * 内置 Ctrl+点击 由编辑器鼠标手势直接触发，不走 keybinding 服务，
 * 只有注册 DefinitionProvider 才能接管该入口。
 */
export class RipgrepDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly lookup: DefinitionLookup) {}

  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[] | null> {
    if (token.isCancellationRequested) {
      return null;
    }
    const range = document.getWordRangeAtPosition(position);
    const symbol = range ? document.getText(range).trim() : '';
    if (!range || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(symbol)) {
      return null;
    }

    const matches = await this.lookup(symbol);
    if (token.isCancellationRequested) {
      return null;
    }
    const locations: vscode.Location[] = [];
    for (const target of buildDefinitionLocations(matches)) {
      const uri = target.uri
        ? vscode.Uri.parse(target.uri, true)
        : vscode.Uri.file(target.legacyPath);
      let position = new vscode.Position(Math.max(0, target.line - 1), Math.max(0, target.column - 1));
      try {
        // 用目标文件实际内容校正行列：ctags 索引可能因本地/远端不同步或长行
        // 产生行列偏移，读取已打开（或即将打开）的文档做精确对齐。
        const targetDocument = await vscode.workspace.openTextDocument(uri);
        const range = resolveMatchSelection(
          targetDocument.lineCount,
          (lineIndex) => targetDocument.lineAt(lineIndex).text,
          {
            line: target.line,
            column: target.column,
            endColumn: target.endColumn,
            preview: target.preview,
            symbolName: target.symbolName
          }
        );
        position = new vscode.Position(range.lineIndex, range.startCharacter);
      } catch {
        // 目标文件在本地不可读时回退到 ctags 原始行列。
      }
      locations.push(new vscode.Location(uri, position));
    }
    return locations.length > 0 ? locations : null;
  }
}
