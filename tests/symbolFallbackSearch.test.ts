import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSymbolFallbackSearchCommand } from '../src/definition/symbolFallbackSearch';

test('buildSymbolFallbackSearchCommand builds a fixed-string word search in the git root', () => {
  const cmd = buildSymbolFallbackSearchCommand('/tmp/rg', '/home/u/proj', 'myfunc');
  assert.ok(cmd.includes("cd '/home/u/proj'"));
  assert.ok(cmd.includes("'/tmp/rg'"));
  assert.ok(cmd.includes('--json'));
  assert.ok(cmd.includes('--word-regexp'));
  assert.ok(cmd.includes('--fixed-strings'));
  assert.ok(cmd.includes("'myfunc'"));
  assert.ok(cmd.includes("'.'"));
  // 跳过索引文件本身（参数被 shell 单引号包裹）
  assert.ok(cmd.includes("'--glob' '!tags'"));
  assert.ok(cmd.includes("'--glob' '!tags.meta.json'"));
});

test('buildSymbolFallbackSearchCommand includes threads when set', () => {
  const cmd = buildSymbolFallbackSearchCommand('/tmp/rg', '/repo', 'foo', 4);
  assert.ok(cmd.includes('--threads'));
  assert.ok(cmd.includes("'4'"));
});

test('buildSymbolFallbackSearchCommand escapes special query chars as literals', () => {
  // --fixed-strings 按字面处理，命令里符号名应被 shell 引用保护。
  const cmd = buildSymbolFallbackSearchCommand('/tmp/rg', '/repo', 'a.b*');
  assert.ok(cmd.includes("'a.b*'"));
});
