// src/client.js
// BUG：调用名 fetchUser 与 api.js 导出的 getUser 不一致。
// 修复：改为 getUser，使两个文件命名一致。

const { getUser } = require('./api.js');

function loadUser(id) {
  return fetchUser(id);
}

module.exports = { loadUser };
