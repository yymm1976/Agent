// tests/tools/security-bypass-regression.test.ts
// B-08：shell 防绕过 deny 优先回归矩阵
//
// 覆盖绕过向量：命令链接符、子 shell/命令替换、重定向、命令前缀/别名、大小写、路径转义。
// 原则：危险命令无论以何种变体出现都必须 denied；普通命令不得误拦。
import { describe, expect, it } from 'vitest';
import { checkBashSecurity } from '../../src/tools/security-enhanced.js';

const DENY_MATRIX: Array<{ command: string; note: string }> = [
  // ===== 链接符绕过 =====
  { command: 'ls; rm -rf /', note: '分号链接' },
  { command: 'echo ok && rm -rf /', note: '&& 链接' },
  { command: 'true || rm -rf /', note: '|| 链接' },
  { command: 'rm -rf / &', note: '后台执行' },
  { command: 'ls; rm -rf / --no-preserve-root', note: '链接+取消保护' },
  // ===== 子 shell / 命令替换绕过 =====
  { command: '$(rm -rf /)', note: '命令替换' },
  { command: '(rm -rf /)', note: '子 shell' },
  { command: 'echo $(rm -rf /)', note: '命令替换内嵌' },
  // ===== 重定向绕过 =====
  { command: 'rm -rf / >/dev/null 2>&1', note: '重定向不改变命令本质' },
  { command: 'rm -rf / | cat', note: '管道' },
  { command: 'rm -rf / 2>/dev/null', note: 'stderr 重定向' },
  // ===== 命令前缀/别名绕过 =====
  { command: 'command rm -rf /', note: 'command 前缀' },
  { command: 'env rm -rf /', note: 'env 前缀' },
  { command: '/bin/rm -rf /', note: '绝对路径' },
  { command: 'rm -rf / --no-preserve-root', note: '取消根保护标志' },
  // ===== 大小写绕过 =====
  { command: 'RM -RF /', note: '全大写' },
  { command: 'Rm -rF /', note: '混合大小写' },
  { command: 'rM -fr /', note: '混合大小写+标志重排' },
  // ===== 路径转义绕过 =====
  { command: 'rm -rf //', note: '双斜杠' },
  { command: 'rm -rf /./', note: '点路径' },
  { command: 'rm -rf /../', note: '上级路径' },
  { command: 'rm -rf /*', note: 'glob 根' },
  { command: 'rm -rf ~', note: '主目录' },
  { command: 'rm -rf $HOME', note: '环境变量' },
  { command: 'rm -rf ${HOME}', note: '花括号变量' },
  { command: 'rm -rf /tmp/../..', note: '深层跳转' },
];

const ALLOW_MATRIX: Array<{ command: string; note: string }> = [
  { command: 'ls -la', note: '普通列表' },
  { command: 'rm -rf ./tmp', note: '删除项目内临时目录' },
  { command: 'rm -f notes/old.md', note: '删除普通文件' },
  { command: 'git status && git log --oneline', note: 'git 只读链' },
  { command: 'cat config.json', note: '读文件' },
  { command: 'npm test', note: '跑测试' },
  { command: 'python script.py', note: 'python 脚本' },
];

describe('B-08 危险命令绕过矩阵（deny 优先）', () => {
  it.each(DENY_MATRIX)('应拒绝：$note（$command）', ({ command }) => {
    const result = checkBashSecurity(command);
    expect(result.allowed, `${command} 应被拒绝，实际原因: ${result.reason}`).toBe(false);
  });

  it.each(ALLOW_MATRIX)('不应误拦：$note（$command）', ({ command }) => {
    const result = checkBashSecurity(command);
    expect(result.allowed, `${command} 不应被拒绝: ${result.reason}`).toBe(true);
  });
});
