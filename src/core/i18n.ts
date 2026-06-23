import type { TranslationRow } from './types';

export function parseTranslationCsv(csvText: string): TranslationRow[] {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: TranslationRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const columns = parseCsvLine(lines[index]);
    if (columns.length < 3) {
      continue;
    }
    rows.push({
      key: columns[0],
      en: columns[1],
      zhCN: columns[2]
    });
  }
  return rows;
}

export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  result.push(current);
  return result;
}
