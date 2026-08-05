// src/a.js
// BUG：硬编码 10，应引用共享常量模块中的 DEFAULT_LIMIT。

function allowedA(items) {
  return items.slice(0, 10);
}

module.exports = { allowedA };
