// src/app.js
// BUG：缺少 require('./greet.js')，greet 未定义。
// 修复：补上 require。

function sayHi(name) {
  return greet(name);
}

module.exports = { sayHi };
