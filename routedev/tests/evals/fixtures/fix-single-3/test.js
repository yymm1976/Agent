// fix-single-3 验证：修复后必须通过
const assert = require('node:assert');
const { filterAdults } = require('./src/adults.js');

assert.deepStrictEqual(filterAdults([17, 18, 19]), [18, 19], '18 岁应被包含');
assert.deepStrictEqual(filterAdults([10, 21]), [21]);
console.log('ok');
