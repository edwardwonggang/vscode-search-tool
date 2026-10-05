import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbolAtLine } from '../src/definition/symbolExtraction';

test('extractSymbolAtLine extracts a plain identifier', () => {
  assert.equal(extractSymbolAtLine('int foo(void) {', 4), 'foo');
  assert.equal(extractSymbolAtLine('  value = 1;', 3), 'value');
  assert.equal(extractSymbolAtLine('_internal', 4), '_internal');
  assert.equal(extractSymbolAtLine('return 42;', 3), 'return');
});

test('extractSymbolAtLine returns the rightmost identifier across scope/member operators', () => {
  assert.equal(extractSymbolAtLine('std::vector<int> v;', 11), 'vector');
  assert.equal(extractSymbolAtLine('obj->method()', 8), 'method');
  assert.equal(extractSymbolAtLine('obj.method()', 5), 'method');
  assert.equal(extractSymbolAtLine('ns::sub::func()', 11), 'func');
});

test('extractSymbolAtLine extracts C++ operator overload names', () => {
  // 光标位于 operator 后的符号主体上。
  assert.equal(extractSymbolAtLine('void operator<<(int)', 14), 'operator<<');
  assert.equal(extractSymbolAtLine('void operator()(int)', 13), 'operator()');
  assert.equal(extractSymbolAtLine('void operator[](int)', 13), 'operator[]');
  assert.equal(extractSymbolAtLine('bool operator==(const A&) const', 14), 'operator==');
});

test('extractSymbolAtLine returns null for non-symbol positions', () => {
  assert.equal(extractSymbolAtLine('', 0), null);
  assert.equal(extractSymbolAtLine('   ', 1), null);
  assert.equal(extractSymbolAtLine('1234', 0), null);
  assert.equal(extractSymbolAtLine('42 = x', 1), null);
  assert.equal(extractSymbolAtLine('x + y', 2), null);
});
