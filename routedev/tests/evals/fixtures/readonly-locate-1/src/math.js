// src/math.js
// 只读定位任务 fixture：无 bug，只需回答。

/** 返回 1 到 n 的累加和（含 n） */
function sumRange(n) {
  let total = 0;
  for (let i = 1; i <= n; i++) total += i;
  return total;
}

module.exports = { sumRange };
