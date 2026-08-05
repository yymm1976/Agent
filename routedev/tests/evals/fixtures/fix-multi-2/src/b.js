// src/b.js
// BUG：硬编码 5，应引用共享常量模块中的 STRICT_LIMIT。

function allowedB(items) {
  return items.slice(0, 5);
}

module.exports = { allowedB };
