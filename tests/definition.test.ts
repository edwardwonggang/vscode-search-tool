import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTagProbeCommand,
  parseTagProbe,
  TAG_PROBE_CD_FAIL_LINE
} from '../src/definition/tagProbe';
import {
  buildBoundedTagSearchCommand,
  escapeBreString
} from '../src/definition/tagSearch';

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

test('escapeBreString escapes only BRE special characters', () => {
  assert.equal(escapeBreString('a.b*c[d]^e$f\\g'), 'a\\.b\\*c\\[d\\]\\^e\\$f\\\\g');
  assert.equal(escapeBreString('plain_name'), 'plain_name');
});
