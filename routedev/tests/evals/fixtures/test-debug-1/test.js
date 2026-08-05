// test-debug-1 验证：修复后必须通过（不要修改本文件）
const assert = require('node:assert');
const { fizzbuzz } = require('./src/fizzbuzz.js');

assert.strictEqual(fizzbuzz(3), 'Fizz');
assert.strictEqual(fizzbuzz(5), 'Buzz');
assert.strictEqual(fizzbuzz(15), 'FizzBuzz', '15 应为 FizzBuzz');
assert.strictEqual(fizzbuzz(7), '7');
console.log('ok');
