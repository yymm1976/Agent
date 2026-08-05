// src/lib/date.js
// 探索任务 fixture 模块 2
function today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { today };
