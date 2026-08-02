import * as vscode from 'vscode';
import type { SearchMatch } from '../core/types';
import { buildDefinitionLocations } from './definitionLocations';

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
    const locations = buildDefinitionLocations(matches).map((target) => {
      const uri = target.uri
        ? vscode.Uri.parse(target.uri, true)
        : vscode.Uri.file(target.legacyPath);
      return new vscode.Location(
        uri,
        new vscode.Position(Math.max(0, target.line - 1), Math.max(0, target.column - 1))
      );
    });
    return locations.length > 0 ? locations : null;
  }
}
