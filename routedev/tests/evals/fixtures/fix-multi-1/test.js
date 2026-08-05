// fix-multi-1 验证：修复后必须通过
const assert = require('node:assert');
const { loadUser } = require('./src/client.js');

const user = loadUser(7);
assert.strictEqual(user.id, 7, 'id 应为 7');
assert.strictEqual(user.name, 'user-7', 'name 应为 user-7');
console.log('ok');
