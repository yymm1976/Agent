// src/adults.js
// BUG：`age > 18` 应为 `age >= 18`，18 岁应被包含。

function filterAdults(ages) {
  return ages.filter((age) => age > 18);
}

module.exports = { filterAdults };
