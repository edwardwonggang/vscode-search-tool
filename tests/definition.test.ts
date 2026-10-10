import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTagProbeCommand,
  parseTagProbe,
  TAG_PROBE_CD_FAIL_LINE
} from '../src/definition/tagProbe';
import {
  buildBoundedTagSearchCommand,
  buildTagProbeAndSearchCommand,
  buildTagSearchCommand,
  escapeBreString
} from '../src/definition/tagSearch';
import {
  buildCtagsRebuildCommand,
  buildCtagsIncrementalCommand,
  buildSidxAndMetaShellBlock,
  createTagIndexMeta,
  getTagIndexPaths,
  TAG_INDEX_CTAGS_ARGS_KEY
} from '../src/definition/TagIndex';

test('buildTagProbeCommand folds git/rg/ctags/tags checks into one command', () => {
  const cmd = buildTagProbeCommand('/home/u/proj', '/tmp/rg', '/tmp/ctags');
  assert.ok(cmd.includes("cd '/home/u/proj'"));
  assert.ok(cmd.includes('git rev-parse --show-toplevel 2>/dev/null'));
  assert.ok(cmd.includes('git rev-parse --is-inside-work-tree 2>/dev/null'));
  assert.ok(cmd.includes('git -C "$top" rev-parse HEAD 2>/dev/null'));
  assert.ok(cmd.includes('test -f "$top/tags"'));
  assert.ok(cmd.includes("'/tmp/rg' --version 2>/dev/null"));
  assert.ok(cmd.includes("'/tmp/ctags' --version 2>/dev/null"));
  assert.ok(cmd.includes('PROBE:gitTop=%s'));
  assert.ok(cmd.includes(TAG_PROBE_CD_FAIL_LINE));
});

test('parseTagProbe parses all fields', () => {
  const output = [
    'PROBE:gitTop=/home/u/proj',
    'PROBE:insideWorkTree=true',
    'PROBE:rgVersion=ripgrep 14.1.0',
    'PROBE:ctagsVersion=Universal Ctags 6.2.0',
    'PROBE:tags=y',
    'PROBE:gitHead=abc123'
  ].join('\n');
  const parsed = parseTagProbe(output);
  assert.equal(parsed?.gitTop, '/home/u/proj');
  assert.equal(parsed?.insideWorkTree, 'true');
  assert.equal(parsed?.rgVersion, 'ripgrep 14.1.0');
  assert.equal(parsed?.ctagsVersion, 'Universal Ctags 6.2.0');
  assert.equal(parsed?.tagsExists, true);
  assert.equal(parsed?.gitHead, 'abc123');
});

test('parseTagProbe handles tags=n and missing git top', () => {
  const parsed = parseTagProbe([
    'PROBE:gitTop=/home/u/proj',
    'PROBE:insideWorkTree=true',
    'PROBE:tags=n'
  ].join('\n'));
  assert.equal(parsed?.tagsExists, false);

  const noGit = parseTagProbe('PROBE:insideWorkTree=false\n');
  assert.equal(noGit?.gitTop, '');
  assert.equal(noGit?.tagsExists, false);
});

test('parseTagProbe rejects empty output and cd failures', () => {
  assert.equal(parseTagProbe(''), undefined);
  assert.equal(parseTagProbe(TAG_PROBE_CD_FAIL_LINE), undefined);
});

test('buildBoundedTagSearchCommand anchors and bounds the scan', () => {
  const cmd = buildBoundedTagSearchCommand('/repo', 'tags', 'BMU_NUM');
  assert.ok(cmd.includes("cd '/repo'"));
  assert.ok(cmd.includes("grep -n -m1 '^BMU_NUM[[:space:]]' 'tags'"));
  assert.ok(cmd.includes('tail -n +$first'));
  assert.ok(cmd.includes("awk -F '\\t' -v n='BMU_NUM'"));
  assert.ok(cmd.includes("'$1==n{print;next}{exit}'"));
  // 不再全量扫描：不得出现 --pcre2 / --line-buffered / rg 调用。
  assert.ok(!cmd.includes('--pcre2'));
  assert.ok(!cmd.includes('--line-buffered'));
  assert.ok(!cmd.includes(' rg '));
});

test('buildBoundedTagSearchCommand escapes BRE metacharacters in queries', () => {
  const cmd = buildBoundedTagSearchCommand('/repo', 'tags', 'a.b*c');
  assert.ok(cmd.includes("'^a\\.b\\*c[[:space:]]'"));
});

test('buildTagSearchCommand prefers readtags binary search and falls back to bounded grep', () => {
  const cmd = buildTagSearchCommand('/repo', 'tags', 'BMU_NUM');
  assert.ok(cmd.includes("cd '/repo'"));
  assert.ok(cmd.includes("if command -v readtags >/dev/null 2>&1 && readtags --help 2>&1 | grep -q -e '--extension-fields'; then"));
  assert.ok(cmd.includes("out=$(readtags -E -ne -t '/repo/tags' - 'BMU_NUM' 2>/dev/null) || out=\"\""));
  assert.ok(cmd.includes("printf '%s\\n' \"$out\""));
  assert.ok(cmd.includes("grep -n -m1 '^BMU_NUM[[:space:]]' '/repo/tags'"));
  assert.ok(cmd.includes("awk -F '\\t' -v n='BMU_NUM'"));
  assert.ok(!cmd.includes(' rg '));
});

test('buildTagProbeAndSearchCommand fuses probe with readtags-first scan in one round trip', () => {
  const cmd = buildTagProbeAndSearchCommand('/home/u/proj', '/tmp/rg', '/tmp/ctags', 'BMU_NUM');
  assert.ok(cmd.includes("cd '/home/u/proj'"));
  assert.ok(cmd.includes('PROBE:gitTop=%s'));
  assert.ok(cmd.includes('if test "$tags" = y && test -n "$top"; then'));
  assert.ok(cmd.includes("readtags --help 2>&1 | grep -q -e '--extension-fields'"));
  assert.ok(cmd.includes("out=$(readtags -E -ne -t \"$top/tags\" - 'BMU_NUM' 2>/dev/null) || out=\"\""));
  assert.ok(cmd.includes("grep -n -m1 '^BMU_NUM[[:space:]]' \"$top/tags\""));
  assert.ok(!cmd.includes(' rg '));
});

test('escapeBreString escapes only BRE special characters', () => {
  assert.equal(escapeBreString('a.b*c[d]^e$f\\g'), 'a\\.b\\*c\\[d\\]\\^e\\$f\\\\g');
  assert.equal(escapeBreString('plain_name'), 'plain_name');
});

test('buildCtagsIncrementalCommand collects git changes and skips tags index files', () => {
  const paths = getTagIndexPaths('/repo');
  const meta = createTagIndexMeta({ gitTop: '/repo', gitHead: 'abc', ctagsVersion: 'Universal Ctags 6.2.1', ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY });
  const cmd = buildCtagsIncrementalCommand('/tmp/ctags', '/repo', paths, meta);
  assert.ok(cmd.includes("cd '/repo'"));
  assert.ok(cmd.includes('git status --porcelain'));
  assert.ok(cmd.includes("if test -z \"$changed\"; then echo 'CTAGS_INCREMENTAL:noop'; exit 0; fi"));
  assert.ok(cmd.includes("grep -q '^CTAGS_FULL$'"));
  // 局部单文件 ctags 必须用 --tag-relative=no（与全量路径基准一致），排除 tags* 索引文件
  assert.ok(cmd.includes('--tag-relative=no'));
  assert.ok(cmd.includes("--exclude='tags'"));
  assert.ok(cmd.includes("--exclude='tags.sidx*'"));
  // 合并 + 排序 + sidx + meta
  assert.ok(cmd.includes('NR==FNR { del[$0]=1'));
  assert.ok(cmd.includes('LC_ALL=C sort -k1,1'));
  assert.ok(cmd.includes('CTAGS_INCREMENTAL:ok'));
});

test('buildCtagsIncrementalCommand writes CTAGS_INCREMENTAL:full on too many changed files', () => {
  const paths = getTagIndexPaths('/repo');
  const meta = createTagIndexMeta({ gitTop: '/repo', gitHead: 'abc', ctagsVersion: 'Universal Ctags 6.2.1', ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY });
  const cmd = buildCtagsIncrementalCommand('/tmp/ctags', '/repo', paths, meta, 50);
  assert.ok(cmd.includes("if test \"$count\" -gt 50; then echo 'CTAGS_INCREMENTAL:full'; exit 0; fi"));
});

test('buildCtagsRebuildCommand joins with newlines so multi-line if blocks stay valid bash', () => {
  const paths = getTagIndexPaths('/repo');
  const meta = createTagIndexMeta({ gitTop: '/repo', gitHead: 'abc', ctagsVersion: 'Universal Ctags 6.2.1', ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY });
  const cmd = buildCtagsRebuildCommand('/tmp/ctags', '/repo', paths, meta);
  // 以 set -e 开头，任一失败立即退出
  assert.ok(cmd.startsWith('set -e\n'));
  // 用换行连接命令，避免 && 把多行 if/for 结构拼成 then && if 的语法错误
  assert.ok(!cmd.includes(' && if '));
  assert.ok(!cmd.includes('then &&'));
  assert.ok(cmd.includes('if command -v split >/dev/null 2>&1; then'));
  assert.ok(cmd.includes("mv -f \"$indexTmp\" '/repo/tags.sidx' || rm -f '/repo/tags.sidx'"));
  assert.ok(cmd.includes('metaTmp='));
});

test('buildSidxAndMetaShellBlock rebuilds sidx and writes meta atomically', () => {
  const paths = getTagIndexPaths('/repo');
  const meta = createTagIndexMeta({ gitTop: '/repo', gitHead: 'abc', ctagsVersion: 'Universal Ctags 6.2.1', ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY });
  const lines = buildSidxAndMetaShellBlock(paths, meta);
  const cmd = lines.join('\n');
  assert.ok(cmd.includes("split -b 1048576 -d -a 8 '/repo/tags'"));
  assert.ok(cmd.includes("mv -f \"$indexTmp\" '/repo/tags.sidx' || rm -f '/repo/tags.sidx'"));
  assert.ok(cmd.includes('metaTmp='));
  assert.ok(cmd.includes("mv -f \"$metaTmp\" '/repo/tags.meta.json'"));
});

test('sidx block-locate awk does not print the block twice on awk exit', () => {
  const cmd = buildTagProbeAndSearchCommand('/home/u/proj', '/tmp/rg', '/tmp/ctags', 'BMU_NUM');
  // awk 的 exit 会执行 END 块，必须用 printed 标志避免 block 号被打印两次，
  // 否则 $((block * 1048576)) 会因 "596 596" 报 bash 算术语法错误。
  assert.ok(cmd.includes('$2>q{print last; printed=1; exit} END{if(!printed && last!="")print last}'));
  assert.ok(cmd.includes('$2<=q{last=$1; next}'));
});
