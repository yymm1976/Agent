// src/name.js
// BUG：输出顺序应为 'Last, First'（文档约定），当前是 'First Last'。

function formatName(first, last) {
  return `${first} ${last}`;
}

module.exports = { formatName };
