import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';

// 前端结果渲染器是挂 window 的浏览器脚本，用 vm 在 Node 中加载后验证
// 文件级行模型（replace/merge/折叠/可见行收集）的正确性。
(globalThis as Record<string, unknown>).window = globalThis;
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => {
  callback();
  return 1;
};

type RendererRow = {
  type: 'file' | 'match';
  file?: { relativePath: string };
  match?: { line: number };
  top: number;
};

type TestRenderer = {
  replace(items: unknown[]): void;
  merge(items: unknown[]): void;
  rerender(): void;
  totalRowCount(): number;
  totalHeight: number;
  items: Array<{ relativePath: string }>;
  collectVisibleRows(start: number, end: number): {
    rows: RendererRow[];
    topSpacerHeight: number;
    renderedEnd: number;
  };
};

function loadRenderer(): { new (options: Record<string, unknown>): TestRenderer } {
  const code = fs.readFileSync('media/search-results-renderer.js', 'utf8');
  vm.runInThisContext(code);
  const ctor = (globalThis as Record<string, unknown>).RipgrepToolResultsRenderer;
  return ctor as { new (options: Record<string, unknown>): TestRenderer };
}

function createRenderer(Renderer: { new (options: Record<string, unknown>): TestRenderer }, collapsedFiles: Set<string>): TestRenderer {
  const resultsEl = {
    scrollTop: 0,
    clientHeight: 600,
    innerHTML: '',
    addEventListener() {},
    querySelector() {
      return { style: {} };
    }
  };
  return new Renderer({
    resultsEl,
    collapsedFiles,
    isWorkspaceOk: () => true,
    getWorkspaceMessage: () => '',
    getIsFileSearch: () => false,
    renderWorkspaceBlocked: () => {},
    renderEmpty: () => '<div class="empty"></div>',
    renderFileIcon: () => '',
    formatPreview: (preview: string) => preview,
    escapeHtml: (value: string) => String(value),
    persistState: () => {},
    trace: () => {},
    getChevronRight: () => '>',
    getChevronDown: () => 'v',
    afterRender: () => {}
  });
}

function makeItem(path: string, lines: number[]) {
  return {
    path,
    relativePath: path,
    count: lines.length,
    matches: lines.map((line) => ({ path, line, column: 1, endColumn: 2, preview: 'p' }))
  };
}

function rowLabels(rows: RendererRow[]): string[] {
  return rows.map((row) => (row.type === 'file' ? row.file?.relativePath ?? '' : `${row.file?.relativePath ?? ''}#${row.match?.line ?? 0}`));
}

test('renderer replace builds sorted file-level model', () => {
  const renderer = createRenderer(loadRenderer(), new Set());
  renderer.replace([makeItem('c.ts', [3, 4, 5]), makeItem('a.ts', [1, 2]), makeItem('b.ts', [1])]);

  assert.equal(renderer.totalRowCount(), 9);
  assert.equal(renderer.totalHeight, 9 * 22);
  assert.deepEqual(renderer.items.map((item) => item.relativePath), ['a.ts', 'b.ts', 'c.ts']);
});

test('renderer merge appends matches to existing files without full rebuild', () => {
  const renderer = createRenderer(loadRenderer(), new Set());
  renderer.replace([makeItem('a.ts', [1, 2]), makeItem('b.ts', [1]), makeItem('c.ts', [3, 4, 5])]);
  renderer.merge([makeItem('a.ts', [1, 2, 10, 11])]);

  assert.equal(renderer.totalRowCount(), 11);
  assert.equal(renderer.totalHeight, 11 * 22);
});

test('renderer merge with a new file rebuilds the model once', () => {
  const renderer = createRenderer(loadRenderer(), new Set());
  renderer.replace([makeItem('a.ts', [1, 2]), makeItem('b.ts', [1]), makeItem('c.ts', [3, 4, 5])]);
  renderer.merge([makeItem('d.ts', [7])]);

  assert.equal(renderer.totalRowCount(), 11);
  assert.equal(renderer.totalHeight, 11 * 22);
  assert.deepEqual(renderer.items.map((item) => item.relativePath), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
});

test('renderer collects visible rows with stable geometry and correct spacers', () => {
  const renderer = createRenderer(loadRenderer(), new Set());
  renderer.replace([makeItem('a.ts', [1, 2, 10, 11]), makeItem('b.ts', [1]), makeItem('c.ts', [3, 4, 5]), makeItem('d.ts', [7])]);

  const all = renderer.collectVisibleRows(0, 1000);
  assert.deepEqual(rowLabels(all.rows), [
    'a.ts', 'a.ts#1', 'a.ts#2', 'a.ts#10', 'a.ts#11',
    'b.ts', 'b.ts#1',
    'c.ts', 'c.ts#3', 'c.ts#4', 'c.ts#5',
    'd.ts', 'd.ts#7'
  ]);
  assert.deepEqual([all.topSpacerHeight, all.renderedEnd], [0, 13 * 22]);

  // 中间窗口：跳过 a.ts 匹配块末尾后应从 b.ts 文件头开始，spacer 从 110px 起。
  const mid = renderer.collectVisibleRows(5 * 22, 5 * 22 + 20);
  assert.deepEqual(rowLabels(mid.rows), ['b.ts']);
  assert.equal(mid.topSpacerHeight, 5 * 22);
});

test('renderer collapse hides match rows and expanded append keeps accumulated matches', () => {
  const collapsedFiles = new Set<string>();
  const renderer = createRenderer(loadRenderer(), collapsedFiles);
  renderer.replace([makeItem('a.ts', [1, 2]), makeItem('b.ts', [1]), makeItem('c.ts', [3, 4, 5])]);

  collapsedFiles.add('c.ts');
  renderer.rerender();
  assert.equal(renderer.totalRowCount(), 6);
  assert.equal(renderer.totalHeight, 6 * 22);

  renderer.merge([makeItem('c.ts', [3, 4, 5, 8, 9])]);
  assert.equal(renderer.totalRowCount(), 6);
  assert.equal(renderer.totalHeight, 6 * 22);

  collapsedFiles.delete('c.ts');
  renderer.rerender();
  assert.equal(renderer.totalRowCount(), 11);
  assert.equal(renderer.totalHeight, 11 * 22);
});
