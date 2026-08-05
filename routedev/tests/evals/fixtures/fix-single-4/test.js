// fix-single-4 验证：修复后必须通过
const assert = require('node:assert');
const { formatName } = require('./src/name.js');

assert.strictEqual(formatName('Ada', 'Lovelace'), 'Lovelace, Ada', '格式应为 Last, First');
console.log('ok');
