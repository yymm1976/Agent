// fix-single-1 验证：修复后必须通过
const assert = require('node:assert');
const { sumRange } = require('./src/math.js');

assert.strictEqual(sumRange(5), 15, 'sumRange(5) 应为 15');
assert.strictEqual(sumRange(1), 1, 'sumRange(1) 应为 1');
assert.strictEqual(sumRange(0), 0, 'sumRange(0) 应为 0');
console.log('ok');
