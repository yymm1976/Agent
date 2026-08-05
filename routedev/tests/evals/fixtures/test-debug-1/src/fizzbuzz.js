// src/fizzbuzz.js
// BUG：15 同时是 3 和 5 的倍数，应返回 'FizzBuzz'；当前先命中 3 的倍数分支。
// 修复：把 15 的倍数判断放在最前面。

function fizzbuzz(n) {
  if (n % 3 === 0) return 'Fizz';
  if (n % 5 === 0) return 'Buzz';
  return String(n);
}

module.exports = { fizzbuzz };
