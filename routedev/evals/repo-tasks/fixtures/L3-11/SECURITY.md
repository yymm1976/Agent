# SECURITY.md

## 输入净化（Sanitization）不变量

`src/loader.ts` 的 `loadConfig()` 对**所有**输入执行 `sanitizeInput()`：

- 剥离控制字符（`\u0000-\u001f`、`\u007f`）
- 剥离 `<>` 尖括号

**该步骤不得被跳过、条件化或短路**——无论输入大小、来源或调用方，
sanitize 必须始终执行。跳过 sanitize 属于安全回归，将被视为破坏仓库不变量。
