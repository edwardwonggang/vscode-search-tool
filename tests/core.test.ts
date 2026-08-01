import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_EXCLUDE_GLOBS, DEFAULT_INCLUDE_GLOBS, DEFAULT_REMOTE_PORT } from '../src/core/defaults';
import {
  createFileQueryMatcher,
  createResultPathFilter,
  matchSearchGlob,
  normalizeExcludeGlobForSearch,
  normalizeSearchPath,
  splitUserGlobs
} from '../src/core/glob';
import { parseCsvLine, parseTranslationCsv } from '../src/core/i18n';
import {
  buildRemoteHomePath,
  getRelativeRemotePath,
  inferRemotePathFromDrive,
  inferRemotePathFromUnc,
  inferRemoteWorkspacePath,
  isPosixAbsolutePath,
  normalizeLocalPath,
  normalizeRemotePath
} from '../src/core/paths';
import { normalizeSettings } from '../src/core/settings';
import { createProjectSettingsKey, SettingsStore, type SettingsStorage } from '../src/core/SettingsStore';
import { shellEscape } from '../src/core/shell';
import { createSearchPreview, escapeHtml, utf8ByteOffsetToUtf16Index } from '../src/core/text';
import type { SearchOptions, SearchSettings } from '../src/core/types';
import {
  buildChmodExecutableCommand,
  buildGitInsideWorkTreeCommand,
  buildGitTopCommand,
  buildExecutableVersionCommand,
  buildRemoteFileNameSearchCommand,
  buildMkdirCommand,
  buildRemoteCommand,
  buildRemoteFileExistsCommand
} from '../src/remote/commands';
import { getRemoteConnectionSignature } from '../src/remote/SshClientManager';
import { RemoteToolInstaller } from '../src/remote/RemoteToolInstaller';
import { parseTagLine } from '../src/definition/ctags';
import {
  TAG_INDEX_CTAGS_ARGS_KEY,
  buildCtagsRebuildCommand,
  createTagIndexMeta,
  decideTagIndexRefresh,
  getTagIndexPaths,
  parseTagIndexMeta
} from '../src/definition/TagIndex';
import { addContentSearchMatch } from '../src/search/ContentSearchResults';
import { populateFileSearchResults } from '../src/search/FileSearchService';
import { JsonLineBuffer } from '../src/search/JsonLineBuffer';
import { resolveMatchSelection } from '../src/search/MatchNavigation';
import { mergeResultItems } from '../src/search/WebviewMessageRouter';
import { buildContentSearchArgs, buildFileSearchArgs } from '../src/session/rgArgs';
import { filterRipgrepStderr, isIgnorableRipgrepFailure } from '../src/session/rgDiagnostics';
import { ContentSearchProcessor } from '../src/session/ContentSearchProcessor';
import { SearchSession } from '../src/session/SearchSession';
import { createRemoteGitRootKey } from '../src/session/RemoteGitRootGuard';
import { planSearchRequest } from '../src/session/SearchRequestPlan';
import { SearchResultStore } from '../src/search/SearchResultStore';
import { StreamingLineProcessor } from '../src/search/StreamingLineProcessor';
import { discoverGitRepositories, isDirectoryFileType, isGitFileMarkerText, type GitDiscoveryFs } from '../src/workspace/gitDiscovery';
import { joinFileWorkspaceFsPath, joinRemoteWorkspacePath } from '../src/workspace/uriPaths';

function baseOptions(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    query: 'needle',
    include: '',
    exclude: '',
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
    ...overrides
  };
}

function baseSettings(overrides: Partial<SearchSettings> = {}): SearchSettings {
  return {
    remoteHost: 'host',
    remotePort: 22,
    remoteUsername: 'alice',
    remotePassword: 'secret',
    remoteSearchPath: '/home/alice/project',
    includeGlobs: [],
    excludeGlobs: [],
    ...overrides
  };
}

function createMemorySettingsStorage(): SettingsStorage {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    }
  };
}

function createMemoryGitDiscoveryFs(paths: string[]): GitDiscoveryFs {
  const normalizedPaths = new Set(paths.map((entry) => normalizeSearchPath(entry)));
  return {
    async isGitRepository(relativePath) {
      const pathValue = normalizeSearchPath(relativePath);
      return normalizedPaths.has(pathValue ? `${pathValue}/.git` : '.git');
    },
    async readDirectory(relativePath) {
      const basePath = normalizeSearchPath(relativePath);
      const prefix = basePath ? `${basePath}/` : '';
      const names = new Set<string>();
      for (const pathValue of normalizedPaths) {
        if (!pathValue.startsWith(prefix)) {
          continue;
        }
        const remainder = pathValue.slice(prefix.length);
        const [name] = remainder.split('/');
        if (name) {
          names.add(name);
        }
      }
      return Array.from(names).map((name) => ({ name, isDirectory: true }));
    }
  };
}

test('normalizeSettings trims values, fixes invalid ports, and preserves defaults', () => {
  const settings = normalizeSettings({
    remoteHost: ' server ',
    remotePort: -1,
    remoteUsername: ' alice ',
    remotePassword: ' pass ',
    remoteSearchPath: ' /repo ',
    includeGlobs: [' *.ts ', '*.ts', ''],
    excludeGlobs: []
  });

  assert.equal(settings.remoteHost, 'server');
  assert.equal(settings.remotePort, DEFAULT_REMOTE_PORT);
  assert.equal(settings.remoteUsername, 'alice');
  assert.equal(settings.remotePassword, ' pass ');
  assert.equal(settings.remoteSearchPath, '/repo');
  assert.deepEqual(settings.includeGlobs, ['*.ts']);
  assert.deepEqual(settings.excludeGlobs, DEFAULT_EXCLUDE_GLOBS);
  assert.deepEqual(normalizeSettings(undefined).includeGlobs, DEFAULT_INCLUDE_GLOBS);
});

test('normalizeSettings keeps explicit remote path and drops the inferred display field', () => {
  const normalized = normalizeSettings({
    remoteHost: 'host',
    remotePort: 22,
    remoteUsername: 'alice',
    remotePassword: 'pw',
    remoteSearchPath: '/home/alice/project',
    inferredRemoteSearchPath: '/home/alice/other',
    includeGlobs: [],
    excludeGlobs: []
  });
  assert.equal(normalized.remoteSearchPath, '/home/alice/project');
  assert.equal('inferredRemoteSearchPath' in normalized, false);
});

test('search paths and globs match existing include and exclude behavior', () => {
  assert.equal(normalizeSearchPath('.\\src//main.ts/'), 'src/main.ts');
  assert.deepEqual(splitUserGlobs('src/**, *.ts, ,test/**'), ['src/**', '*.ts', 'test/**']);
  assert.equal(matchSearchGlob('src/app/main.ts', '**/*.ts'), true);
  assert.equal(matchSearchGlob('src/app/main.ts', 'src/app'), true);
  assert.equal(matchSearchGlob('src/app/main.ts', '*.js'), false);

  const filter = createResultPathFilter(
    baseOptions({ include: 'src/**,tests/**', exclude: '**/*.snap' }),
    baseSettings({ includeGlobs: ['**/*.ts'], excludeGlobs: ['**/node_modules/**'] })
  );
  assert.equal(filter('src/app/main.ts'), true);
  assert.equal(filter('tests/app/main.ts'), true);
  assert.equal(filter('src/app/main.snap'), false);
  assert.equal(filter('node_modules/pkg/index.ts'), false);
  assert.equal(filter('docs/readme.md'), false);

  const defaultFilter = createResultPathFilter(baseOptions(), normalizeSettings(undefined));
  assert.equal(defaultFilter('libs/platform/source.c'), true);
  assert.equal(defaultFilter('vendor/third_party/source.c'), true);
  assert.equal(defaultFilter('build/generated/source.c'), true);
  assert.equal(defaultFilter('lib/source.c'), true);
  assert.equal(defaultFilter('scripts/Makefile'), true);
  assert.equal(defaultFilter('tools/run'), true);
  assert.equal(defaultFilter('web/index.html'), true);
  assert.equal(defaultFilter('docs/readme.txt'), true);
  assert.equal(defaultFilter('node_modules/pkg/source.c'), false);
});

test('default excludes include node_modules', () => {
  assert.ok(DEFAULT_EXCLUDE_GLOBS.includes('**/node_modules/**'));
  const filter = createResultPathFilter(baseOptions(), normalizeSettings(undefined));
  assert.equal(filter('node_modules/pkg/source.c'), false);
  assert.equal(filter('lib/source.c'), true);
});

test('project settings keys normalize remote paths', () => {
  assert.equal(createProjectSettingsKey('/home/wanggang/aaa'), createProjectSettingsKey('/home/wanggang/aaa/'));
  assert.ok(createProjectSettingsKey('/home/wanggang/aaa').startsWith('ripgrepTool.projectSettings.'));
  assert.throws(() => createProjectSettingsKey(''));
});

test('settings store separates SSH globals from per-project settings', async () => {
  const store = new SettingsStore(createMemorySettingsStorage());
  await store.saveSshSettings({
    remoteHost: 'host',
    remotePort: 22,
    remoteUsername: 'wanggang',
    remotePassword: 'pw'
  });
  await store.saveProjectSettings('/home/wanggang/aaa', {
    remoteSearchPath: '/home/wanggang/aaa',
    includeGlobs: ['*.ts'],
    excludeGlobs: ['**/*.snap']
  });

  const ssh = store.getSshSettings();
  assert.equal(ssh.remoteHost, 'host');
  assert.equal(ssh.remoteUsername, 'wanggang');

  const project = store.getProjectSettings('/home/wanggang/aaa');
  assert.equal(project.remoteSearchPath, '/home/wanggang/aaa');
  assert.deepEqual(project.includeGlobs, ['*.ts']);
  assert.deepEqual(project.excludeGlobs, ['**/*.snap']);

  const other = store.getProjectSettings('/home/wanggang/bbb');
  assert.equal(other.remoteSearchPath, '');
  assert.deepEqual(other.includeGlobs, DEFAULT_INCLUDE_GLOBS);
  assert.ok(other.excludeGlobs.includes('**/node_modules/**'));
});

test('settings store falls back to legacy global settings', async () => {
  const storage = createMemorySettingsStorage();
  await storage.update('ripgrepTool.searchSettings', {
    remoteHost: 'legacy-host',
    remotePort: 2222,
    remoteUsername: 'legacy-user',
    remotePassword: 'legacy-pw',
    remoteSearchPath: '/home/legacy/project',
    includeGlobs: ['*.c'],
    excludeGlobs: ['**/*.o']
  });
  const store = new SettingsStore(storage);

  const ssh = store.getSshSettings();
  assert.equal(ssh.remoteHost, 'legacy-host');
  assert.equal(ssh.remotePort, 2222);

  const project = store.getProjectSettings('/home/legacy/project');
  assert.equal(project.remoteSearchPath, '/home/legacy/project');
  assert.deepEqual(project.includeGlobs, ['*.c']);
  assert.deepEqual(project.excludeGlobs, ['**/*.o']);
});

test('exclude directory globs are root-relative unless explicitly recursive', () => {
  assert.equal(normalizeExcludeGlobForSearch('power/'), 'power/**');
  assert.equal(normalizeExcludeGlobForSearch('**/power/**'), '**/power/**');
  assert.equal(normalizeExcludeGlobForSearch('**/*.zip'), '**/*.zip');

  const filter = createResultPathFilter(
    baseOptions({ exclude: 'power/,**/cache/**' }),
    baseSettings({ includeGlobs: [], excludeGlobs: ['fw/'] })
  );

  assert.equal(filter('power/main.c'), false);
  assert.equal(filter('src/power/main.c'), true);
  assert.equal(filter('fw/main.c'), false);
  assert.equal(filter('src/fw/main.c'), true);
  assert.equal(filter('src/cache/main.c'), false);
});

test('settings migration removes source-bearing directory excludes', () => {
  const settings = normalizeSettings(baseSettings({
    excludeGlobs: ['**/lib/**', '**/libs/**', 'vendor/**', '**/*.o']
  }));

  assert.deepEqual(settings.excludeGlobs, ['**/*.o']);
});

test('file query matcher handles paths, basenames, and case sensitivity', () => {
  assert.equal(createFileQueryMatcher('MAIN', false)('src/app/main.ts'), true);
  assert.equal(createFileQueryMatcher('MAIN', true)('src/app/main.ts'), false);
  assert.equal(createFileQueryMatcher('app/main', false)('src/app/main.ts'), true);
  assert.equal(createFileQueryMatcher('app', false)('src/app/main.ts'), false);
  assert.equal(createFileQueryMatcher('src', false)('src/app/main.ts'), false);
  assert.equal(createFileQueryMatcher('', true)('anything.ts'), true);
});

test('remote path inference maps supported Windows workspace forms', () => {
  assert.equal(inferRemotePathFromUnc('\\\\server\\bob\\repo\\trunk'), '/home/bob/repo/trunk');
  assert.equal(inferRemotePathFromDrive('D:\\src\\repo', 'alice'), '/home/alice/src/repo');
  assert.equal(inferRemoteWorkspacePath('D:\\src\\repo', 'alice'), '/home/alice/src/repo');
  assert.equal(buildRemoteHomePath('alice', 'src/repo'), '/home/alice/src/repo');
  assert.equal(buildRemoteHomePath('bad/user', 'src/repo'), undefined);
});

test('remote and local path helpers preserve boundary rules', () => {
  assert.equal(normalizeRemotePath('/home//alice/repo/'), '/home/alice/repo');
  assert.equal(getRelativeRemotePath('/home/alice/repo/src/a.ts', '/home/alice/repo'), 'src/a.ts');
  assert.equal(getRelativeRemotePath('/home/alice/repo2/src/a.ts', '/home/alice/repo'), undefined);
  assert.equal(isPosixAbsolutePath('\\home\\alice'), true);
  assert.equal(normalizeLocalPath('D:\\Repo\\Src\\'), 'd:/repo/src');
});

test('git repository discovery scans up to three levels and stops below discovered roots', async () => {
  const repositories = await discoverGitRepositories(createMemoryGitDiscoveryFs([
    'B/.git',
    'B/nested/ignored/.git',
    'group/C/.git',
    'one/two/three/.git',
    'one/two/three/four/.git'
  ]));

  assert.deepEqual(repositories.map((repository) => repository.workspaceRelativePath), [
    'B',
    'group/C',
    'one/two/three'
  ]);
});

test('git repository discovery ignores invalid parent markers and continues to child repositories', async () => {
  const repositories = await discoverGitRepositories({
    async isGitRepository(relativePath) {
      return ['components/mcs_components', 'mcs_dev/mcs'].includes(normalizeSearchPath(relativePath));
    },
    async readDirectory(relativePath) {
      const entries: Record<string, string[]> = {
        '': ['components', 'mcs_dev'],
        components: ['mcs_components'],
        mcs_dev: ['mcs']
      };
      return (entries[normalizeSearchPath(relativePath)] ?? []).map((name) => ({ name, isDirectory: true }));
    }
  });

  assert.deepEqual(repositories.map((repository) => repository.workspaceRelativePath), [
    'components/mcs_components',
    'mcs_dev/mcs'
  ]);
});

test('directory file type detection accepts symbolic-link directory flags', () => {
  const file = 1;
  const directory = 2;
  const symbolicLink = 64;

  assert.equal(isDirectoryFileType(directory, directory), true);
  assert.equal(isDirectoryFileType(directory | symbolicLink, directory), true);
  assert.equal(isDirectoryFileType(file | symbolicLink, directory), false);
});

test('git file marker text requires a gitdir pointer', () => {
  assert.equal(isGitFileMarkerText('gitdir: ../.git/worktrees/example\n'), true);
  assert.equal(isGitFileMarkerText('not a git marker'), false);
  assert.equal(isGitFileMarkerText(''), false);
});

test('CSV parsing supports quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsvLine('key,"Hello, world","He said ""hi"""'), ['key', 'Hello, world', 'He said "hi"']);
  assert.deepEqual(parseTranslationCsv('key,en,zh-CN\nhello,Hello,你好\nquoted,"A,B","甲,乙"\n'), [
    { key: 'hello', en: 'Hello', zhCN: '你好' },
    { key: 'quoted', en: 'A,B', zhCN: '甲,乙' }
  ]);
});

test('shell escaping, HTML escaping, and UTF-8 offsets are stable', () => {
  assert.equal(shellEscape("a'b"), "'a'\"'\"'b'");
  assert.equal(escapeHtml(`<a title="x">Tom's & Jerry</a>`), '&lt;a title=&quot;x&quot;&gt;Tom&#39;s &amp; Jerry&lt;/a&gt;');

  const text = 'a你😀z';
  assert.equal(utf8ByteOffsetToUtf16Index(text, 0), 0);
  assert.equal(utf8ByteOffsetToUtf16Index(text, Buffer.byteLength('a', 'utf8')), 1);
  assert.equal(utf8ByteOffsetToUtf16Index(text, Buffer.byteLength('a你', 'utf8')), 2);
  assert.equal(utf8ByteOffsetToUtf16Index(text, Buffer.byteLength('a你😀', 'utf8')), 4);
});

test('search previews keep payloads bounded around the match', () => {
  const longLine = `${'x'.repeat(200)}needle${'y'.repeat(300)}`;
  const preview = createSearchPreview(longLine, 200, 206);
  assert.equal(preview.includes('needle'), true);
  assert.equal(preview.length < longLine.length, true);
  assert.equal(preview.startsWith('...'), true);
  assert.equal(preview.endsWith('...'), true);
});

test('content and file search args preserve rg flag behavior', () => {
  const settings = baseSettings({
    includeGlobs: ['**/*.ts'],
    excludeGlobs: ['**/dist/**']
  });

  assert.deepEqual(
    buildContentSearchArgs(
      baseOptions({ query: 'hello world', exclude: '*.snap', caseSensitive: false, wholeWord: true, useRegex: false }),
      settings,
      { contextLines: 2, threads: 4 }
    ),
    [
      '--json',
      '--line-buffered',
      '--line-number',
      '--column',
      '--hidden',
      '--no-ignore-vcs',
      '--threads',
      '4',
      '--ignore-case',
      '--word-regexp',
      '--fixed-strings',
      '--context',
      '2',
      '--glob',
      '**/*.ts',
      '--glob',
      '!**/dist/**',
      '--glob',
      '!*.snap',
      'hello world',
      '.'
    ]
  );

  assert.deepEqual(
    buildFileSearchArgs(baseOptions({ include: 'src/**,tests/**', exclude: '*.snap' }), settings),
    [
      '--files',
      '--line-buffered',
      '--hidden',
      '--no-ignore-vcs',
      '--glob',
      '**/*.ts',
      '--glob',
      '!**/dist/**',
      '--glob',
      'src/**',
      '--glob',
      'tests/**',
      '--glob',
      '!*.snap'
    ]
  );

  assert.deepEqual(
    buildFileSearchArgs(
      baseOptions({ include: '', exclude: 'power/' }),
      baseSettings({ includeGlobs: [], excludeGlobs: ['fw/'] })
    ),
    [
      '--files',
      '--line-buffered',
      '--hidden',
      '--no-ignore-vcs',
      '--glob',
      '!fw/**',
      '--glob',
      '!power/**'
    ]
  );
});

test('RemoteToolInstaller rechecks remote rg and silently reuploads after remote temp loss', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ripgreptool-test-'));
  const localRgPath = path.join(tempDir, 'rg');
  await fs.writeFile(localRgPath, 'mock rg', 'utf8');

  let remoteHasRg = true;
  const commands: string[] = [];
  let uploads = 0;
  const installer = new RemoteToolInstaller({
    asAbsolutePath: () => localRgPath,
    executor: {
      exec: async (_client: unknown, command: string) => {
        commands.push(command);
        if (command.startsWith('chmod ')) {
          remoteHasRg = true;
        }
      },
      execWithExitCode: async (_client: unknown, command: string) => {
        commands.push(command);
        return {
          stdout: remoteHasRg ? 'ripgrep 14.1.0\n' : '',
          stderr: '',
          code: 0
        };
      },
      openSftp: async () => ({
        fastPut: (_local: string, _remote: string, _options: unknown, callback: (error?: Error) => void) => {
          uploads += 1;
          callback();
        },
        end: () => undefined
      })
    } as any,
    logger: {
      log: () => undefined,
      debug: () => undefined
    },
    bundledRgRelativePath: 'assets/bin/rg',
    remoteRgPath: '/tmp/ripgreptool-rg',
    bundledCtagsRelativePath: 'assets/bin/ctags',
    remoteCtagsPath: '/tmp/ripgreptool-ctags'
  });

  try {
    assert.equal(await installer.ensureRg({} as any), '/tmp/ripgreptool-rg');
    remoteHasRg = false;
    assert.equal(await installer.ensureRg({} as any), '/tmp/ripgreptool-rg');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(uploads, 1);
  assert.equal(commands.filter((command) => command.includes('--version')).length, 2);
});

test('search request planning keeps modes explicit and mutually exclusive', () => {
  assert.deepEqual(planSearchRequest(baseOptions({ query: '   ' })), { kind: 'empty' });
  assert.deepEqual(planSearchRequest(baseOptions({ query: 'needle' })), {
    kind: 'search',
    mode: 'content',
    query: 'needle',
    fileQuery: ''
  });
  assert.deepEqual(planSearchRequest(baseOptions({ query: 'needle', definitionMode: true })), {
    kind: 'search',
    mode: 'definition',
    query: 'needle',
    fileQuery: ''
  });
  assert.deepEqual(planSearchRequest(baseOptions({ query: 'needle', fileQuery: 'main.c', definitionMode: true })), {
    kind: 'search',
    mode: 'file',
    query: 'needle',
    fileQuery: 'main.c'
  });
});

test('remote command builders quote paths and args consistently', () => {
  assert.equal(
    buildRemoteCommand('/tmp/rg tool', "/home/alice/repo's", ['--json', 'a b', "don't"]),
    "cd '/home/alice/repo'\"'\"'s' && '/tmp/rg tool' '--json' 'a b' 'don'\"'\"'t'"
  );
  assert.equal(buildGitTopCommand('/repo'), "cd '/repo' && git rev-parse --show-toplevel");
  assert.equal(buildGitInsideWorkTreeCommand('/repo'), "cd '/repo' && git rev-parse --is-inside-work-tree");
  assert.equal(buildRemoteFileExistsCommand('/tmp/file'), "if test -f '/tmp/file'; then echo y; else echo n; fi");
  assert.equal(buildMkdirCommand('/tmp/dir'), "mkdir -p '/tmp/dir'");
  assert.equal(buildChmodExecutableCommand('/tmp/rg'), "chmod +x '/tmp/rg'");
  assert.equal(buildExecutableVersionCommand('/tmp/rg'), "'/tmp/rg' --version 2>/dev/null | head -n 1 || true");
  assert.equal(
    buildRemoteFileNameSearchCommand('/tmp/rg', '/repo', ['--files', '--hidden'], 'Main', false),
    "cd '/repo' && '/tmp/rg' '--files' '--hidden' | awk -v needle='Main' 'BEGIN { needle=tolower(needle) } { name=$0; sub(/^.*\\//, \"\", name); if (index(tolower(name), needle) > 0) print }'"
  );
});

test('ripgrep diagnostics ignore permission denied lines without hiding other failures', () => {
  const permissionDenied = 'rg: ./hvdcli/fsroot/src/nfs/opt/bluelib/etc/bluetooth/hcid.conf: Permission denied (os error 13)';

  assert.deepEqual(filterRipgrepStderr(`${permissionDenied}\n`), {
    visibleStderr: '',
    ignoredPermissionDeniedCount: 1,
    hasOnlyIgnoredDiagnostics: true
  });
  assert.equal(isIgnorableRipgrepFailure(2, `${permissionDenied}\n`), true);

  const mixed = filterRipgrepStderr(`${permissionDenied}\nrg: regex parse error:\n`);
  assert.equal(mixed.visibleStderr, 'rg: regex parse error:');
  assert.equal(mixed.ignoredPermissionDeniedCount, 1);
  assert.equal(mixed.hasOnlyIgnoredDiagnostics, false);
  assert.equal(isIgnorableRipgrepFailure(2, `${permissionDenied}\nrg: regex parse error:\n`), false);
});

test('remote connection signature changes only when SSH identity changes', () => {
  const first = getRemoteConnectionSignature(baseSettings({ remoteSearchPath: '/repo-a' }));
  const second = getRemoteConnectionSignature(baseSettings({ remoteSearchPath: '/repo-b' }));
  const third = getRemoteConnectionSignature(baseSettings({ remotePassword: 'different' }));

  assert.equal(first, second);
  assert.notEqual(first, third);
});

test('ctags tag lines parse symbol, path, line, and preview', () => {
  assert.deepEqual(parseTagLine('needle\tsrc/main.ts\t/^function needle()$/;"\tf\tline:42', 'needle', '/tmp'), {
    name: 'needle',
    remoteFileAbs: '/tmp/src/main.ts',
    line: 42,
    column: 10,
    endColumn: 16,
    preview: 'function needle()',
    kind: 'f'
  });

  assert.equal(parseTagLine('needle\t/home/alice/src/main.ts\t/^const needle = 1$/;"\tv\tline:7', 'needle', '/tmp'), null);

  assert.deepEqual(parseTagLine('needle\tsrc/main.ts\t/^  obj\\.needle = call\\(\\)$/;"\tm\tline:9', 'needle', '/tmp'), {
    name: 'needle',
    remoteFileAbs: '/tmp/src/main.ts',
    line: 9,
    column: 7,
    endColumn: 13,
    preview: '  obj.needle = call()',
    kind: 'm'
  });

  assert.equal(parseTagLine('needle\tsrc/main.h\t/^int needle(void);$/;"\tf\tline:3', 'needle', '/tmp'), null);
  assert.equal(parseTagLine('needle\tsrc/main.h\t/^extern int needle(void);$/;"\tf\tline:4', 'needle', '/tmp'), null);
  assert.equal(parseTagLine('other\tsrc/main.ts\t/^function other()$/;"\tf\tline:1', 'needle', '/tmp'), null);
  assert.equal(parseTagLine('broken line', 'needle', '/tmp'), null);
});

test('tag index refresh decisions use metadata without rebuilding missing tags in the background', () => {
  const meta = createTagIndexMeta({
    gitTop: '/repo',
    gitHead: 'abc',
    ctagsVersion: 'Universal Ctags 6.0',
    ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY
  }, 1000);

  assert.deepEqual(decideTagIndexRefresh({
    tagsExists: false,
    gitTop: '/repo',
    gitHead: 'abc',
    ctagsVersion: 'Universal Ctags 6.0',
    ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY,
    refreshIntervalMs: 1000,
    nowMs: 5000
  }), { refresh: false, reason: 'tags-missing' });

  assert.deepEqual(decideTagIndexRefresh({
    tagsExists: true,
    meta,
    gitTop: '/repo',
    gitHead: 'abc',
    ctagsVersion: 'Universal Ctags 6.0',
    ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY,
    refreshIntervalMs: 1000,
    nowMs: 1500
  }), { refresh: false, reason: 'fresh' });

  assert.deepEqual(decideTagIndexRefresh({
    tagsExists: true,
    meta,
    gitTop: '/repo',
    gitHead: 'def',
    ctagsVersion: 'Universal Ctags 6.0',
    ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY,
    refreshIntervalMs: 1000,
    nowMs: 1500
  }), { refresh: true, reason: 'git-head-changed' });

  assert.deepEqual(decideTagIndexRefresh({
    tagsExists: true,
    meta,
    gitTop: '/repo',
    gitHead: 'abc',
    ctagsVersion: 'Universal Ctags 6.0',
    ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY,
    refreshIntervalMs: 1000,
    nowMs: 2500
  }), { refresh: true, reason: 'refresh-interval' });
});

test('tag index metadata and rebuild command use tmp file then atomic replace', () => {
  const paths = getTagIndexPaths('/home/alice/repo');
  const meta = createTagIndexMeta({
    gitTop: '/home/alice/repo',
    gitHead: 'abc',
    ctagsVersion: 'Universal Ctags 6.0',
    ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY
  }, 1000);
  const command = buildCtagsRebuildCommand('/tmp/ctags', '/home/alice/repo', paths, meta);

  assert.equal(paths.tagsPath, '/home/alice/repo/tags');
  assert.equal(paths.tmpPath, '/home/alice/repo/tags.tmp');
  assert.equal(paths.metaPath, '/home/alice/repo/tags.meta.json');
  assert.equal(parseTagIndexMeta(JSON.stringify(meta))?.gitHead, 'abc');
  assert.equal(command.includes("-f '/home/alice/repo/tags.tmp'"), true);
  assert.equal(command.includes("mv -f '/home/alice/repo/tags.tmp' '/home/alice/repo/tags'"), true);
  assert.equal(command.includes("--exclude='tags'"), true);
  assert.equal(command.includes("--exclude='tags.tmp'"), true);
  assert.equal(command.includes("tags.meta.json"), true);
});

test('JsonLineBuffer emits complete JSON lines across chunks', () => {
  const entries: any[] = [];
  const buffer = new JsonLineBuffer((entry) => entries.push(entry));

  buffer.push('{"a":1}\n{"b"');
  buffer.push(':2}\n\n{"c":3}\n');

  assert.deepEqual(entries, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('StreamingLineProcessor processes large streams in bounded slices', async () => {
  const lines: string[] = [];
  const processor = new StreamingLineProcessor({
    maxLinesPerSlice: 2,
    maxSliceMs: 1000,
    onLine: (line) => lines.push(line)
  });

  processor.push('a\nb\nc\nd\n');
  await processor.flush();

  assert.deepEqual(lines, ['a', 'b', 'c', 'd']);
  assert.equal(processor.stats.processedLines, 4);
  assert.equal(processor.stats.yieldedSlices >= 1, true);
});

test('SearchResultStore groups, sorts, snapshots, and clears results', () => {
  const store = new SearchResultStore();
  store.addMatch('b', '/repo/b.ts', 'b.ts', {
    path: '/repo/b.ts',
    uri: 'file:///repo/b.ts',
    relativePath: 'b.ts',
    line: 2,
    column: 1,
    endColumn: 2,
    preview: 'b'
  });
  store.addMatch('a', '/repo/a.ts', 'a.ts', {
    path: '/repo/a.ts',
    uri: 'file:///repo/a.ts',
    relativePath: 'a.ts',
    line: 1,
    column: 1,
    endColumn: 2,
    preview: 'a'
  });

  assert.equal(store.size, 2);
  assert.equal(store.totalMatches(), 2);
  assert.deepEqual(store.snapshot('content').items.map((item) => item.relativePath), ['a.ts', 'b.ts']);

  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.totalMatches(), 0);
});

test('SearchResultStore consumes only changed result buckets', () => {
  const store = new SearchResultStore();
  store.addMatch('b', '/repo/b.ts', 'b.ts', {
    path: '/repo/b.ts',
    uri: 'file:///repo/b.ts',
    relativePath: 'b.ts',
    line: 2,
    column: 1,
    endColumn: 2,
    preview: 'b'
  });
  store.addMatch('a', '/repo/a.ts', 'a.ts', {
    path: '/repo/a.ts',
    uri: 'file:///repo/a.ts',
    relativePath: 'a.ts',
    line: 1,
    column: 1,
    endColumn: 2,
    preview: 'a'
  });

  assert.deepEqual(store.consumeChanged('content').items.map((item) => item.relativePath), ['a.ts', 'b.ts']);
  assert.deepEqual(store.consumeChanged('content').items, []);

  store.addMatch('b', '/repo/b.ts', 'b.ts', {
    path: '/repo/b.ts',
    uri: 'file:///repo/b.ts',
    relativePath: 'b.ts',
    line: 3,
    column: 1,
    endColumn: 2,
    preview: 'bb'
  });
  const changed = store.consumeChanged('content').items;
  assert.deepEqual(changed.map((item) => item.relativePath), ['b.ts']);
  assert.equal(changed[0].count, 2);
  assert.deepEqual(changed[0].matches.map((match) => match.preview), ['bb']);
});

test('SearchResultStore snapshots retain full results after incremental consumption', () => {
  const store = new SearchResultStore();
  store.addMatch('a', '/repo/a.ts', 'a.ts', {
    path: '/repo/a.ts',
    uri: 'file:///repo/a.ts',
    relativePath: 'a.ts',
    line: 1,
    column: 1,
    endColumn: 2,
    preview: 'a1'
  });
  store.consumeChanged('content');
  store.addMatch('a', '/repo/a.ts', 'a.ts', {
    path: '/repo/a.ts',
    uri: 'file:///repo/a.ts',
    relativePath: 'a.ts',
    line: 2,
    column: 1,
    endColumn: 2,
    preview: 'a2'
  });

  assert.deepEqual(store.consumeChanged('content').items[0].matches.map((match) => match.preview), ['a2']);
  assert.deepEqual(store.snapshot('content').items[0].matches.map((match) => match.preview), ['a1', 'a2']);
});

test('incremental webview result merge appends matches without losing earlier rows', () => {
  const first = [{
    path: '/repo/a.ts',
    relativePath: 'a.ts',
    count: 1,
    matches: [{
      path: '/repo/a.ts',
      uri: 'file:///repo/a.ts',
      relativePath: 'a.ts',
      line: 1,
      column: 1,
      endColumn: 2,
      preview: 'a1'
    }]
  }];
  const second = [{
    path: '/repo/a.ts',
    relativePath: 'a.ts',
    count: 2,
    matches: [
      first[0].matches[0],
      {
        path: '/repo/a.ts',
        uri: 'file:///repo/a.ts',
        relativePath: 'a.ts',
        line: 2,
        column: 1,
        endColumn: 2,
        preview: 'a2'
      }
    ]
  }];

  const merged = mergeResultItems(first, second);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 2);
  assert.deepEqual(merged[0].matches.map((match) => match.preview), ['a1', 'a2']);
});

test('SearchSession batches one result push with the requested mode', async () => {
  const store = new SearchResultStore();
  store.setFileResult('src/main.c', {
    path: 'file:///repo/src/main.c',
    relativePath: 'src/main.c',
    consumedMatchCount: 0,
    matches: []
  });
  const pushed: Array<{ mode: string; itemCount: number }> = [];
  const session = new SearchSession({
    refreshMs: 1,
    onStateChange: () => undefined,
    onResultsPush: (results) => pushed.push({ mode: results.mode, itemCount: results.items.length })
  }, store);

  session.scheduleResultPush('file');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(pushed, [{ mode: 'file', itemCount: 1 }]);
});

test('SearchSession scopes result and state messages to the active request id', async () => {
  const store = new SearchResultStore();
  const pushed: Array<{ requestId?: number; mode: string; itemCount: number }> = [];
  const states: Array<{ requestId?: number; summary?: string }> = [];
  const session = new SearchSession({
    refreshMs: 1,
    onStateChange: (state) => states.push({ requestId: state.requestId, summary: state.summary }),
    onResultsPush: (results) => pushed.push({
      requestId: results.requestId,
      mode: results.mode,
      itemCount: results.items.length
    })
  }, store);

  session.begin(42);
  store.setFileResult('src/main.c', {
    path: 'file:///repo/src/main.c',
    relativePath: 'src/main.c',
    consumedMatchCount: 0,
    matches: []
  });
  session.scheduleResultPush('file');
  session.postState({ type: 'state', running: true, summary: 'Searching' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(pushed, [{ requestId: 42, mode: 'file', itemCount: 1 }]);
  assert.deepEqual(states, [{ requestId: 42, summary: 'Searching' }]);
});

test('SearchSession posts dynamic progress counts while running', async () => {
  const store = new SearchResultStore();
  const states: Array<{ requestId?: number; running: boolean; fileCount?: number; matchCount?: number; elapsedMs?: number }> = [];
  const session = new SearchSession({
    refreshMs: 1,
    onStateChange: (state) => states.push({
      requestId: state.requestId,
      running: state.running,
      fileCount: state.fileCount,
      matchCount: state.matchCount,
      elapsedMs: state.elapsedMs
    }),
    onResultsPush: () => undefined
  }, store);

  session.begin(77);
  store.addMatch('src/main.c', '/repo/src/main.c', 'src/main.c', {
    path: '/repo/src/main.c',
    uri: 'file:///repo/src/main.c',
    relativePath: 'src/main.c',
    line: 4,
    column: 2,
    endColumn: 5,
    preview: 'int value;'
  });
  session.startProgress('content');
  await new Promise((resolve) => setTimeout(resolve, 20));
  session.stopProgress();

  assert.equal(states.some((state) =>
    state.requestId === 77 &&
    state.running &&
    state.fileCount === 1 &&
    state.matchCount === 1 &&
    typeof state.elapsedMs === 'number'
  ), true);
});

test('SearchSession ignores stale remote channel release from an old search', () => {
  let firstClosed = 0;
  let secondClosed = 0;
  const first = { close: () => { firstClosed += 1; } };
  const second = { close: () => { secondClosed += 1; } };
  const session = new SearchSession({
    refreshMs: 1,
    onStateChange: () => undefined,
    onResultsPush: () => undefined
  }, new SearchResultStore());

  session.setActiveChannel(first);
  session.setActiveChannel(second);
  session.setActiveChannel(undefined, first);
  session.cancelActiveSearch();

  assert.equal(firstClosed, 1);
  assert.equal(secondClosed, 1);
});

test('remote git root cache key ignores password and normalizes path', () => {
  const left = createRemoteGitRootKey(baseSettings({
    remotePassword: 'one',
    remoteSearchPath: '/repo'
  }), '/repo/');
  const right = createRemoteGitRootKey(baseSettings({
    remotePassword: 'two',
    remoteSearchPath: '/repo'
  }), '/repo');

  assert.equal(left, right);
});

test('match navigation resolves stale ctags lines near the requested line', () => {
  const lines = [
    'int unrelated(void);',
    '',
    'static int get_data(void)',
    '{',
    '  return 0;',
    '}'
  ];

  assert.deepEqual(resolveMatchSelection(lines.length, (line) => lines[line] ?? '', {
    line: 1,
    column: 12,
    endColumn: 20,
    preview: 'static int get_data(void)',
    symbolName: 'get_data'
  }), {
    lineIndex: 2,
    startCharacter: 11,
    endCharacter: 19
  });
});

test('workspace path helpers preserve file and remote workspace targets', () => {
  assert.equal(joinFileWorkspaceFsPath('D:\\repo', 'src/main.ts').endsWith('repo\\src\\main.ts'), true);
  assert.equal(joinRemoteWorkspacePath('/home/alice/repo/', 'src/main.ts'), '/home/alice/repo/src/main.ts');
  assert.equal(joinRemoteWorkspacePath('/home/alice/repo/', ''), '/home/alice/repo');
});

test('populateFileSearchResults filters stdout and creates file result matches', () => {
  const store = new SearchResultStore();
  const total = populateFileSearchResults({
    stdout: 'src\\main.ts\nsrc/helper.ts\nsrc/app/readme.txt\ndist/skip.ts\nREADME.md\n',
    fileQuery: 'main',
    options: baseOptions({ include: 'src/**', exclude: 'helper.ts' }),
    settings: baseSettings({ includeGlobs: ['**/*.ts'], excludeGlobs: ['**/dist/**'] }),
    resultStore: store,
    createTarget: (relativePath) => ({
      uri: { toString: () => `mock://${relativePath}` } as any,
      uriString: `mock://${relativePath}`,
      legacyPath: `/repo/${relativePath}`,
      relativePath
    })
  });

  assert.equal(total, 1);
  assert.equal(store.size, 1);
  assert.deepEqual(store.snapshot('file').items.map((item) => ({
    relativePath: item.relativePath,
    count: item.count,
    preview: item.matches[0]?.preview
  })), [
    { relativePath: 'src/main.ts', count: 1, preview: 'src/main.ts' }
  ]);
});

test('populateFileSearchResults matches only file names, not directory paths', () => {
  const store = new SearchResultStore();
  const total = populateFileSearchResults({
    stdout: 'src/main.ts\nsrc/app/helper.ts\nsrc/app/app.txt\n',
    fileQuery: 'app',
    options: baseOptions({ include: '', exclude: '' }),
    settings: baseSettings({ includeGlobs: [], excludeGlobs: [] }),
    resultStore: store,
    createTarget: (relativePath) => ({
      uri: { toString: () => `mock://${relativePath}` } as any,
      uriString: `mock://${relativePath}`,
      legacyPath: `/repo/${relativePath}`,
      relativePath
    })
  });

  assert.equal(total, 1);
  assert.deepEqual(store.snapshot('file').items.map((item) => item.relativePath), ['src/app/app.txt']);
});

test('addContentSearchMatch converts rg JSON match events into SearchMatch rows', () => {
  const store = new SearchResultStore();
  const line = 'a你bc';
  const added = addContentSearchMatch({
    entry: {
      type: 'match',
      data: {
        path: { text: 'src/main.ts' },
        lines: { text: `${line}\n` },
        line_number: 12,
        submatches: [{
          start: Buffer.byteLength('a', 'utf8'),
          end: Buffer.byteLength('a你', 'utf8')
        }]
      }
    },
    resultPathFilter: (relativePath) => relativePath.startsWith('src/'),
    resultStore: store,
    createTarget: (relativePath) => ({
      uri: { toString: () => `mock://${relativePath}` } as any,
      uriString: `mock://${relativePath}`,
      legacyPath: `/repo/${relativePath}`,
      relativePath
    })
  });

  assert.equal(added, 1);
  assert.deepEqual(store.snapshot('content').items[0]?.matches[0], {
    path: '/repo/src/main.ts',
    uri: 'mock://src/main.ts',
    relativePath: 'src/main.ts',
    line: 12,
    column: 2,
    endColumn: 3,
    preview: line,
    symbolName: '你'
  });

  assert.equal(addContentSearchMatch({
    entry: { type: 'summary' },
    resultPathFilter: () => true,
    resultStore: store,
    createTarget: () => {
      throw new Error('should not create target');
    }
  }), 0);
});

test('ContentSearchProcessor marks streamed content matches as changed for incremental pushes', () => {
  const store = new SearchResultStore();
  const added = ContentSearchProcessor.processLine({
    type: 'match',
    data: {
      path: { text: 'src/main.c' },
      lines: { text: 'int needle = 1;\n' },
      line_number: 7,
      submatches: [{ start: 4, end: 10 }]
    }
  }, () => true, (relativePath) => ({
    uriString: `mock://${relativePath}`,
    legacyPath: `/repo/${relativePath}`,
    relativePath
  }), store);

  const changed = store.consumeChanged('content');

  assert.equal(added, 1);
  assert.deepEqual(changed.items.map((item) => ({
    relativePath: item.relativePath,
    count: item.count,
    preview: item.matches[0]?.preview
  })), [
    { relativePath: 'src/main.c', count: 1, preview: 'int needle = 1;' }
  ]);
});

test('ContentSearchProcessor filters repo-relative paths while preserving workspace display paths', () => {
  const store = new SearchResultStore();
  const added = ContentSearchProcessor.processLine({
    type: 'match',
    data: {
      path: { text: 'src/main.c' },
      lines: { text: 'int needle = 1;\n' },
      line_number: 7,
      submatches: [{ start: 4, end: 10 }]
    }
  }, (relativePath) => relativePath === 'src/main.c', (relativePath) => ({
    uriString: `mock://B/${relativePath}`,
    legacyPath: `/workspace/B/${relativePath}`,
    relativePath: `B/${relativePath}`,
    repositoryRelativePath: relativePath
  }), store);

  const items = store.snapshot('content').items;

  assert.equal(added, 1);
  assert.equal(items[0]?.relativePath, 'B/src/main.c');
  assert.equal(items[0]?.matches[0]?.relativePath, 'B/src/main.c');
});
