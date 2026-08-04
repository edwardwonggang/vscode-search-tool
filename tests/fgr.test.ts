import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchOptions, SearchSettings } from '../src/core/types';
import { SearchResultStore } from '../src/search/SearchResultStore';
import {
  buildFgrIndexCommand,
  buildFgrIndexExistsCommand,
  buildFgrSearchCommand,
  buildFgrStatsCommand,
  buildFgrUpdateCommand,
  getFgrIndexDir
} from '../src/index/fgrCommands';
import { planFgrContentSearch } from '../src/index/fgrArgs';
import { FgrContentProcessor, computeFgrColumn, parseFgrLine } from '../src/index/FgrContentProcessor';

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
    remoteUsername: 'user',
    remotePassword: 'pass',
    remoteSearchPath: '',
    includeGlobs: [],
    excludeGlobs: [],
    ...overrides
  };
}

test('planFgrContentSearch maps options to fgr args', () => {
  const plan = planFgrContentSearch(
    baseOptions({ caseSensitive: true, useRegex: true }),
    baseSettings(),
    0
  );
  assert.equal(plan.usable, true);
  if (plan.usable) {
    assert.ok(plan.args.includes('-n'));
    assert.ok(plan.args.includes('--no-ignore'));
    assert.ok(!plan.args.includes('-i'));
    assert.ok(!plan.args.includes('-F'));
  }
});

test('planFgrContentSearch does not pass include/exclude to fgr (unsupported in 0.3.1)', () => {
  const plan = planFgrContentSearch(
    baseOptions({ include: 'src/**', exclude: 'build/' }),
    baseSettings({ includeGlobs: ['media/**'], excludeGlobs: ['node_modules/**'] }),
    0
  );
  assert.equal(plan.usable, true);
  if (plan.usable) {
    assert.ok(!plan.args.includes('--include'));
    assert.ok(!plan.args.includes('--exclude'));
  }
});

test('planFgrContentSearch falls back to rg for whole-word and context lines', () => {
  const wholeWord = planFgrContentSearch(baseOptions({ wholeWord: true }), baseSettings(), 0);
  assert.equal(wholeWord.usable, false);

  const context = planFgrContentSearch(baseOptions(), baseSettings(), 2);
  assert.equal(context.usable, false);

  const ok = planFgrContentSearch(baseOptions({ wholeWord: false }), baseSettings(), 0);
  assert.equal(ok.usable, true);
});

test('parseFgrLine parses path:line:content and tolerates colons in content', () => {
  assert.deepEqual(parseFgrLine('/repo/a.c:12:int x = foo(); // a:b'), {
    path: '/repo/a.c',
    line: 12,
    content: 'int x = foo(); // a:b'
  });
  assert.deepEqual(parseFgrLine('/repo/a.c:3:'), { path: '/repo/a.c', line: 3, content: '' });
  assert.equal(parseFgrLine('no-colon-line'), null);
  assert.equal(parseFgrLine('/repo/a.c:abc:content'), null);
  assert.equal(parseFgrLine(':12:content'), null);
});

test('computeFgrColumn finds first match respecting case', () => {
  assert.equal(computeFgrColumn('int foo = 1;', 'foo', false), 5);
  assert.equal(computeFgrColumn('int FOO = 1;', 'foo', false), 5);
  assert.equal(computeFgrColumn('int FOO = 1;', 'foo', true), 1);
  assert.equal(computeFgrColumn('nothing here', 'zzz', false), 1);
});

test('fgr command builders quote paths and flags consistently', () => {
  const indexCmd = buildFgrIndexCommand('/tmp/fgr', '/home/u/proj');
  assert.ok(indexCmd.includes("cd '/home/u/proj'"));
  assert.ok(indexCmd.includes("'/tmp/fgr' index --no-ignore '/home/u/proj' --output '/home/u/proj/.fgr'"));

  const updateCmd = buildFgrUpdateCommand('/tmp/fgr', '/home/u/proj');
  assert.ok(updateCmd.includes("'/tmp/fgr' update --no-ignore '/home/u/proj' --index '/home/u/proj/.fgr'"));

  const statsCmd = buildFgrStatsCommand('/tmp/fgr', '/home/u/proj/.fgr');
  assert.ok(statsCmd.includes("'/tmp/fgr' stats --index '/home/u/proj/.fgr'"));

  const existsCmd = buildFgrIndexExistsCommand('/home/u/proj/.fgr');
  assert.ok(existsCmd.includes("if test -d '/home/u/proj/.fgr'"));
  assert.ok(existsCmd.includes('echo y'));

  const searchCmd = buildFgrSearchCommand('/tmp/fgr', '/home/u/proj', '/home/u/proj/.fgr', ['-n', '-F', '--exclude', '*.test.ts'], 'BMU_NUM');
  assert.ok(searchCmd.includes("cd '/home/u/proj'"));
  assert.ok(searchCmd.includes("'/tmp/fgr' '-n' '-F' '--exclude' '*.test.ts' 'BMU_NUM' . --index '/home/u/proj/.fgr'"));
  assert.equal(getFgrIndexDir('/home/u/proj'), '/home/u/proj/.fgr');
});

test('FgrContentProcessor stores filtered matches with approximate columns', () => {
  const store = new SearchResultStore();
  const filter = () => true;
  const remoteCwd = '/home/u/proj';
  const createTarget = (remoteAbsolutePath: string) => {
    const relativePath = remoteAbsolutePath.startsWith(`${remoteCwd}/`) ? remoteAbsolutePath.slice(remoteCwd.length + 1) : remoteAbsolutePath;
    return {
      uriString: `file://${remoteCwd}/${relativePath}`,
      legacyPath: `X:\\proj\\${relativePath.replace(/\//g, '\\')}`,
      relativePath,
      repositoryRelativePath: relativePath
    };
  };
  const createBlockedTarget = (remoteAbsolutePath: string) => {
    const relativePath = remoteAbsolutePath.startsWith(`${remoteCwd}/`) ? remoteAbsolutePath.slice(remoteCwd.length + 1) : remoteAbsolutePath;
    return {
      uriString: `file://${remoteCwd}/${relativePath}`,
      legacyPath: `X:\\proj\\${relativePath.replace(/\//g, '\\')}`,
      relativePath,
      repositoryRelativePath: relativePath
    };
  };

  const added = FgrContentProcessor.processLine(
    '/home/u/proj/src/a.c:7:  int BMU_NUM = 1; // x:y',
    'BMU_NUM',
    false,
    filter,
    createTarget,
    store
  );
  assert.equal(added, 1);
  const item = store.snapshot('content').items[0];
  assert.equal(item.relativePath, 'src/a.c');
  assert.equal(item.matches[0].line, 7);
  assert.equal(item.matches[0].column, 7);
  assert.ok(item.matches[0].preview.includes('BMU_NUM'));

  const blocked = FgrContentProcessor.processLine(
    '/home/u/proj/src/b.c:1:x',
    'x',
    false,
    () => false,
    createBlockedTarget,
    store
  );
  assert.equal(blocked, 0);
  assert.equal(store.size, 1);
});
