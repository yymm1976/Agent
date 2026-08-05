// src/lib/format.js
// 探索任务 fixture 模块 1
function toTitleCase(text) {
  return text.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

module.exports = { toTitleCase };
