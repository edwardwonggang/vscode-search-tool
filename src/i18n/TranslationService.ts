import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { parseTranslationCsv } from '../core/i18n';

export class TranslationService {
  private cache?: Record<string, string>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly csvRelativePath: string
  ) {}

  public async getTranslations(): Promise<Record<string, string>> {
    if (this.cache) {
      return this.cache;
    }

    const csvText = await fs.readFile(this.context.asAbsolutePath(this.csvRelativePath), 'utf8');
    const rows = parseTranslationCsv(csvText);
    const language = vscode.env.language.toLowerCase().startsWith('zh') ? 'zhCN' : 'en';
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = language === 'zhCN' ? row.zhCN : row.en;
    }
    this.cache = map;
    return map;
  }

  public async translate(key: string): Promise<string> {
    const map = await this.getTranslations();
    return map[key] || key;
  }

  public async format(key: string, values: Record<string, string | number>): Promise<string> {
    let text = await this.translate(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }
}
