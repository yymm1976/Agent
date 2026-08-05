// src/math.js
// BUG：循环边界漏掉了 n，sumRange(5) 返回 10 而不是 15。
// 修复：把 `i < n` 改为 `i <= n`。

function sumRange(n) {
  let total = 0;
  for (let i = 1; i < n; i++) total += i;
  return total;
}

module.exports = { sumRange };
