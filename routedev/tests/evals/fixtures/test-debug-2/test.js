// test-debug-2 验证：修复后必须通过（不要修改本文件）
const assert = require('node:assert');
const { getValue } = require('./src/cache.js');

(async () => {
  assert.strictEqual(await getValue(), 42, 'getValue() 应返回 42');
  console.log('ok');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
