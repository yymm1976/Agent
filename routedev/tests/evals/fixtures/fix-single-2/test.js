// fix-single-2 验证：修复后必须通过
const assert = require('node:assert');
const { sayHi } = require('./src/app.js');

assert.strictEqual(sayHi('Ada'), 'Hello, Ada!');
console.log('ok');
