// src/cache.js
// BUG：async 函数体里没有 return，getValue() 实际 resolve 为 undefined。
// 修复：补上 `return 42`。

async function getValue() {
  await new Promise((resolve) => setTimeout(resolve, 10));
  // 应 return 42
}

module.exports = { getValue };
