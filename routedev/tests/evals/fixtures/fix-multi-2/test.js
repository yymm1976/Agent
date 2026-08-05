// fix-multi-2 验证：行为正确 + 两个模块都必须引用 limits 模块
const assert = require('node:assert');
const fs = require('node:fs');
const { allowedA } = require('./src/a.js');
const { allowedB } = require('./src/b.js');

const items = Array.from({ length: 12 }, (_, i) => i);
assert.strictEqual(allowedA(items).length, 10, 'a 应限制 10 个');
assert.strictEqual(allowedB(items).length, 5, 'b 应限制 5 个');

const aSrc = fs.readFileSync('./src/a.js', 'utf8');
const bSrc = fs.readFileSync('./src/b.js', 'utf8');
assert.ok(aSrc.includes('shared/limits'), 'a.js 必须 require 共享常量模块');
assert.ok(bSrc.includes('shared/limits'), 'b.js 必须 require 共享常量模块');
console.log('ok');
