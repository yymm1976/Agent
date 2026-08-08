// tests/security/sandbox.test.ts
// CommandSandbox 单元测试
//
// 测试策略：
//   - validateCommand：危险命令 / 白名单 / 黑名单 / 工作目录限制
//   - execute：成功执行、超时 kill、输出超限 kill、命令被拒绝、env 隔离
//   - 跨平台：使用 node 作为测试命令（在 PATH 中可找到，shell:false）

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CommandSandbox,
  type SandboxOptions,
} from '../../src/security/sandbox.js';
import { auditPanel } from '../../src/security/audit-panel.js';

describe('CommandSandbox', () => {
  beforeEach(() => {
    // 每个测试前清空审计面板，避免事件累积影响断言
    auditPanel.clear();
  });

  // ============================================================
  // validateCommand — 静态校验
  // ============================================================
  describe('validateCommand', () => {
    it('允许普通命令（无任何限制）', () => {
      const result = CommandSandbox.validateCommand('node', {});
      expect(result.allowed).toBe(true);
    });

    it('拒绝空命令', () => {
      expect(CommandSandbox.validateCommand('', {}).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('   ', {}).allowed).toBe(false);
    });

    // ----------------------------------------------------------
    // 危险命令模式
    // ----------------------------------------------------------
    it('拒绝 rm -rf /（危险模式）', () => {
      const result = CommandSandbox.validateCommand('rm -rf /', {});
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('危险命令模式');
    });

    it('拒绝 rm -rf /*（危险模式）', () => {
      const result = CommandSandbox.validateCommand('rm -rf /*', {});
      expect(result.allowed).toBe(false);
    });

    it('拒绝 format C:（危险模式）', () => {
      const result = CommandSandbox.validateCommand('format C:', {});
      expect(result.allowed).toBe(false);
    });

    it('拒绝 mkfs.ext4 /dev/sda1（危险模式）', () => {
      const result = CommandSandbox.validateCommand('mkfs.ext4 /dev/sda1', {});
      expect(result.allowed).toBe(false);
    });

    it('拒绝 dd if=/dev/zero of=/dev/sda（危险模式）', () => {
      const result = CommandSandbox.validateCommand('dd if=/dev/zero of=/dev/sda', {});
      expect(result.allowed).toBe(false);
    });

    it('拒绝 shutdown / reboot / halt（危险模式）', () => {
      expect(CommandSandbox.validateCommand('shutdown', {}).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('reboot now', {}).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('halt', {}).allowed).toBe(false);
    });

    it('拒绝 fork bomb', () => {
      const result = CommandSandbox.validateCommand(':(){:|:&};:', {});
      expect(result.allowed).toBe(false);
    });

    // ----------------------------------------------------------
    // 白名单
    // ----------------------------------------------------------
    it('白名单非空时，命令必须在白名单中', () => {
      const opts: SandboxOptions = { allowedCommands: ['node', 'npm'] };
      expect(CommandSandbox.validateCommand('node', opts).allowed).toBe(true);
      expect(CommandSandbox.validateCommand('npm', opts).allowed).toBe(true);
      expect(CommandSandbox.validateCommand('python', opts).allowed).toBe(false);
    });

    it('白名单匹配 basename（/usr/bin/node 也算匹配 node）', () => {
      const opts: SandboxOptions = { allowedCommands: ['node'] };
      expect(CommandSandbox.validateCommand('/usr/bin/node', opts).allowed).toBe(true);
      // 字符串接口契约：含空格盘符路径需引号（与 shell 语义一致）；结构化接口支持裸路径
      expect(CommandSandbox.validateCommand('"C:\\Program Files\\nodejs\\node.exe"', opts).allowed).toBe(true);
    });

    it('白名单为空数组时全部允许', () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('anything', opts).allowed).toBe(true);
    });

    // ----------------------------------------------------------
    // 黑名单
    // ----------------------------------------------------------
    it('黑名单命中时拒绝', () => {
      const opts: SandboxOptions = { blockedCommands: ['rm', 'curl'] };
      expect(CommandSandbox.validateCommand('rm', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('curl', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('node', opts).allowed).toBe(true);
    });

    it('白名单与黑名单同时设置：白名单优先', () => {
      // node 在白名单且不在黑名单 → 允许
      // curl 不在白名单 → 拒绝
      // rm 在黑名单 → 拒绝（即使白名单未设置也拒绝）
      const opts: SandboxOptions = {
        allowedCommands: ['node', 'rm'],
        blockedCommands: ['rm'],
      };
      expect(CommandSandbox.validateCommand('node', opts).allowed).toBe(true);
      expect(CommandSandbox.validateCommand('rm', opts).allowed).toBe(false);
    });

    // ----------------------------------------------------------
    // 工作目录限制
    // ----------------------------------------------------------
    it('workingDirectoryRestriction 设置时，cwd 必须在允许列表内', () => {
      const opts: SandboxOptions = {
        cwd: '/safe/dir',
        workingDirectoryRestriction: ['/safe/dir', '/another/safe'],
      };
      expect(CommandSandbox.validateCommand('node', opts).allowed).toBe(true);
    });

    it('workingDirectoryRestriction 设置时，cwd 不在允许列表内应拒绝', () => {
      const opts: SandboxOptions = {
        cwd: '/etc',
        workingDirectoryRestriction: ['/safe/dir'],
      };
      const result = CommandSandbox.validateCommand('node', opts);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('工作目录');
    });

    it('workingDirectoryRestriction 允许子目录', () => {
      const opts: SandboxOptions = {
        cwd: '/safe/dir/subdir',
        workingDirectoryRestriction: ['/safe/dir'],
      };
      expect(CommandSandbox.validateCommand('node', opts).allowed).toBe(true);
    });

    it('workingDirectoryRestriction 不允许父目录逃逸', () => {
      const opts: SandboxOptions = {
        cwd: '/etc/passwd',
        workingDirectoryRestriction: ['/safe/dir'],
      };
      expect(CommandSandbox.validateCommand('node', opts).allowed).toBe(false);
    });
  });

  // ============================================================
  // execute — 实际执行
  // ============================================================
  describe('execute', () => {
    // ----------------------------------------------------------
    // 成功执行
    // ----------------------------------------------------------
    it('应成功执行 node -e 并收集 stdout', async () => {
      const sandbox = new CommandSandbox({
        timeout: 5000,
        maxOutputBytes: 1024,
      });
      const result = await sandbox.execute('node', ['-e', "console.log('hello sandbox')"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello sandbox');
      expect(result.timedOut).toBe(false);
      expect(result.outputTruncated).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('退出码应反映子进程退出状态', async () => {
      const sandbox = new CommandSandbox({ timeout: 5000 });
      const result = await sandbox.execute('node', ['-e', 'process.exit(7)']);
      expect(result.exitCode).toBe(7);
    });

    it('命令不存在时 exitCode 为 null 且 stderr 有错误信息', async () => {
      const sandbox = new CommandSandbox({ timeout: 5000 });
      const result = await sandbox.execute('this-command-does-not-exist-xyz', []);
      expect(result.exitCode).toBe(null);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    // ----------------------------------------------------------
    // 命令被拒绝
    // ----------------------------------------------------------
    it('命令被白名单拒绝时返回 exitCode=null 且 stderr 含原因', async () => {
      const sandbox = new CommandSandbox({
        timeout: 5000,
        allowedCommands: ['npm'],
      });
      const result = await sandbox.execute('node', ['-v']);
      expect(result.exitCode).toBe(null);
      expect(result.stderr).toContain('不在白名单中');
      expect(result.timedOut).toBe(false);
    });

    it('命令命中危险模式时返回 exitCode=null', async () => {
      const sandbox = new CommandSandbox({ timeout: 5000 });
      // 注意：实际不会执行 rm，因为 validateCommand 已拦截
      const result = await sandbox.execute('rm', ['-rf', '/']);
      expect(result.exitCode).toBe(null);
      expect(result.stderr).toContain('危险命令模式');
    });

    // ----------------------------------------------------------
    // 超时控制
    // ----------------------------------------------------------
    it('超时应 kill 进程并标记 timedOut', async () => {
      const sandbox = new CommandSandbox({
        timeout: 300, // 300ms 超时
        maxOutputBytes: 1024 * 1024,
      });
      // node 进程 sleep 5 秒，应被超时 kill
      const result = await sandbox.execute('node', ['-e', 'setTimeout(() => {}, 5000)']);

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(null);
      expect(result.durationMs).toBeGreaterThanOrEqual(280); // 至少等待了接近超时
      expect(result.durationMs).toBeLessThan(2000); // 不应等到 5 秒
    });

    // ----------------------------------------------------------
    // 输出超限
    // ----------------------------------------------------------
    it('stdout 超 maxOutputBytes 应 kill 进程并标记 outputTruncated', async () => {
      const sandbox = new CommandSandbox({
        timeout: 5000,
        maxOutputBytes: 100, // 极小限制
      });
      // 输出 1000 个字符，远超 100 字节限制
      const result = await sandbox.execute('node', ['-e', "process.stdout.write('x'.repeat(1000))"]);

      expect(result.outputTruncated).toBe(true);
      // stdout 应被截断
      expect(result.stdout.length).toBeLessThanOrEqual(100);
    });

    // ----------------------------------------------------------
    // 环境变量隔离
    // ----------------------------------------------------------
    it('应只传 env 中指定的变量 + PATH，不继承父进程环境', async () => {
      // 设置一个独特的父进程环境变量，子进程不应能看到
      const uniqueVar = `SANDBOX_TEST_VAR_${Date.now()}`;
      process.env[uniqueVar] = 'should-not-leak';

      try {
        const sandbox = new CommandSandbox({
          timeout: 5000,
          env: { NODE_ENV: 'test' },
        });
        // 子进程尝试打印该变量，应为 undefined
        const result = await sandbox.execute('node', [
          '-e',
          `console.log(typeof process.env.${uniqueVar})`,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('undefined');
      } finally {
        delete process.env[uniqueVar];
      }
    });

    it('env 中指定的变量应被子进程看到', async () => {
      const sandbox = new CommandSandbox({
        timeout: 5000,
        env: { MY_TEST_VAR: 'hello-from-parent' },
      });
      const result = await sandbox.execute('node', [
        '-e',
        "console.log(process.env.MY_TEST_VAR)",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello-from-parent');
    });

    // ----------------------------------------------------------
    // 工作目录
    // ----------------------------------------------------------
    it('应在指定 cwd 中执行命令', async () => {
      const sandbox = new CommandSandbox({
        timeout: 5000,
        cwd: os.tmpdir(),
      });
      // 打印当前工作目录，应为 os.tmpdir()
      const result = await sandbox.execute('node', ['-e', "console.log(process.cwd())"]);
      expect(result.exitCode).toBe(0);
      // 规范化比较（Windows 上 path.resolve 会处理大小写差异）
      const expected = path.resolve(os.tmpdir());
      const actual = path.resolve(result.stdout.trim());
      expect(actual).toBe(expected);
    });

    it('cwd 在 workingDirectoryRestriction 之外时拒绝执行', async () => {
      const sandbox = new CommandSandbox({
        timeout: 5000,
        cwd: os.tmpdir(),
        workingDirectoryRestriction: ['/definitely/not/allowed'],
      });
      const result = await sandbox.execute('node', ['-v']);
      expect(result.exitCode).toBe(null);
      expect(result.stderr).toContain('工作目录');
    });
  });

  // ============================================================
  // 审计面板接入
  // ============================================================
  describe('auditPanel 接入', () => {
    it('命令被拒绝时应记录 blocked 事件到 auditPanel', async () => {
      const sandbox = new CommandSandbox({
        timeout: 5000,
        allowedCommands: ['npm'],
      });
      await sandbox.execute('node', ['-v']);

      const events = auditPanel.getEvents({ source: 'sandbox', action: 'blocked' });
      expect(events.length).toBe(1);
      expect(events[0]!.target).toContain('node');
    });

    it('命令成功执行时应记录 allowed 事件到 auditPanel', async () => {
      const sandbox = new CommandSandbox({ timeout: 5000 });
      await sandbox.execute('node', ['-e', "console.log('ok')"]);

      const events = auditPanel.getEvents({ source: 'sandbox', action: 'allowed' });
      expect(events.length).toBe(1);
    });

    it('超时应记录 warned 事件到 auditPanel', async () => {
      const sandbox = new CommandSandbox({ timeout: 200 });
      await sandbox.execute('node', ['-e', 'setTimeout(() => {}, 5000)']);

      const events = auditPanel.getEvents({ source: 'sandbox', action: 'warned' });
      expect(events.length).toBe(1);
      expect(events[0]!.reason).toContain('超时');
    });
  });

  describe('P0 复审：参数伪装绕过（executable identity 与 semantics 分离）', () => {
    it('args 中的路径 basename 不得冒充 executable（/tmp/evil /tmp/node → REJECT）', async () => {
      const opts: SandboxOptions = { allowedCommands: ['node'] };
      const sandbox = new CommandSandbox(opts);
      const result = await sandbox.execute('/tmp/evil', ['/tmp/node']);
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('不在白名单中');
    });

    it('合法 Windows 路径 executable 仍被接受（C:\\Program Files\\nodejs\\node.exe → ACCEPT）', async () => {
      const opts: SandboxOptions = { allowedCommands: ['node'] };
      // 结构化入口：command 即完整 executable（路径含空格不需要 tokenize）
      const validation = CommandSandbox.validateExecution(
        'C:\\Program Files\\nodejs\\node.exe',
        [],
        opts,
      );
      expect(validation.allowed).toBe(true);
    });

    it('npm 白名单下 /tmp/not-npm + args 含 /usr/bin/npm → REJECT', async () => {
      const opts: SandboxOptions = { allowedCommands: ['npm'] };
      const sandbox = new CommandSandbox(opts);
      const result = await sandbox.execute('/tmp/not-npm', ['/usr/bin/npm']);
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('不在白名单中');
    });

    it('args 中多个伪造名（node/node.exe/C:\node.exe）全部 REJECT', async () => {
      const opts: SandboxOptions = { allowedCommands: ['node'] };
      const sandbox = new CommandSandbox(opts);
      for (const fake of ['node', 'node.exe', 'C:\\node.exe']) {
        const result = await sandbox.execute('/usr/bin/evil', [fake]);
        expect(result.exitCode).toBeNull();
        expect(result.stderr).toContain('不在白名单中');
      }
    });

    it('validateCommand 字符串接口同样拒绝 whole-basename 冒充', () => {
      const opts: SandboxOptions = { allowedCommands: ['node'] };
      expect(CommandSandbox.validateCommand('/tmp/evil /tmp/node', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('/usr/bin/node', opts).allowed).toBe(true);
    });
  });

  describe('第九轮 ExecutionPolicy V2：path-qualified 危险命令', () => {
    it('/sbin/shutdown -h now 与 shutdown -h now 等价拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] }; // 白名单空 = 全部允许，危险策略独立拦截
      expect(CommandSandbox.validateCommand('/sbin/shutdown -h now', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('shutdown -h now', opts).allowed).toBe(false);
    });

    it('/usr/bin/dd of=/dev/sda 与 dd 裸设备写入等价拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('/usr/bin/dd if=/dev/zero of=/dev/sda', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('dd if=/dev/zero of=/dev/sda', opts).allowed).toBe(false);
    });

    it('/sbin/mkfs.ext4 与 mkfs 等价拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('/sbin/mkfs.ext4 /dev/sda1', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('mkfs.xfs /dev/sda1', opts).allowed).toBe(false);
    });

    it('Windows C:\\Windows\\System32\\format.com C: 与 format 等价拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      const validation = CommandSandbox.validateExecution(
        'C:\\Windows\\System32\\format.com',
        ['C:'],
        opts,
      );
      expect(validation.allowed).toBe(false);
      expect(validation.reason).toContain('format');
    });

    it('shell 解释器 -c 执行任意命令为显式高风险类别（bash -c / powershell -Command）', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('bash -c "rm -rf /"', opts).allowed).toBe(false);
      const ps = CommandSandbox.validateExecution('powershell', ['-Command', 'Get-Process'], opts);
      expect(ps.allowed).toBe(false);
      expect(ps.reason).toContain('shell');
      // 裸解释器执行脚本（无 -c）不拦截（脚本内容风险由其他策略覆盖）
      expect(CommandSandbox.validateCommand('bash /opt/script.sh', opts).allowed).toBe(true);
    });

    it('fork bomb 仍由 regex defense-in-depth 拦截', () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand(':(){:|:&};:', opts).allowed).toBe(false);
    });
  });

  describe('A1 ExecutableIdentity V3：canonical 归一唯一权威', () => {
    it('normalizeExecutableIdentity 统一 .exe/.cmd/.bat/.com 扩展（含 .com 补齐）', async () => {
      const { normalizeExecutableIdentity } = await import('../../src/security/executable-identity.js');
      expect(normalizeExecutableIdentity('node.exe').canonicalName).toBe('node');
      expect(normalizeExecutableIdentity('npm.cmd').canonicalName).toBe('npm');
      expect(normalizeExecutableIdentity('cmd.exe').canonicalName).toBe('cmd');
      expect(normalizeExecutableIdentity('powershell.exe').canonicalName).toBe('powershell');
      expect(normalizeExecutableIdentity('format.com').canonicalName).toBe('format');
      expect(normalizeExecutableIdentity('C:\\Windows\\System32\\shutdown.exe').canonicalName).toBe('shutdown');
      expect(normalizeExecutableIdentity('/usr/bin/node').canonicalName).toBe('node');
    });

    it('OLD→FAIL 场景：shutdown.exe / cmd.exe -c / powershell.exe -Command 危险策略拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      // shutdown.exe（此前 regex ^shutdown 不匹配带 .exe 与路径前缀）
      expect(CommandSandbox.validateCommand('shutdown.exe -h now', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('C:\\Windows\\System32\\shutdown.exe -h now', opts).allowed).toBe(false);
      // cmd.exe /c（此前 shell 解释器判定只认 'cmd'）
      expect(CommandSandbox.validateCommand('cmd.exe /c echo hi', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('C:\\Windows\\System32\\cmd.exe /c echo hi', opts).allowed).toBe(false);
      // powershell.exe -Command
      expect(CommandSandbox.validateCommand('powershell.exe -Command Get-Process', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('pwsh.exe -Command Get-Process', opts).allowed).toBe(false);
    });

    it('format.com 归一为 format 后危险策略拒绝（此前 regex ^format 不匹配）', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('format.com C:', opts).allowed).toBe(false);
    });
  });

  describe('A2 rm 结构化 argv 策略', () => {
    it('combined short flags 与 separated flags 等价拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      // combined
      expect(CommandSandbox.validateCommand('rm -rf /', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('rm -fr /', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('rm -rfi /', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('rm -rvf /', opts).allowed).toBe(false);
      // separated
      expect(CommandSandbox.validateCommand('rm -r -f /', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('rm -f -r /', opts).allowed).toBe(false);
      // long
      expect(CommandSandbox.validateCommand('rm --recursive --force /', opts).allowed).toBe(false);
      // -- 终止符
      expect(CommandSandbox.validateCommand('rm -rf -- /', opts).allowed).toBe(false);
      // 路径限定
      expect(CommandSandbox.validateCommand('/bin/rm -r -f /', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('/usr/bin/rm --recursive --force /', opts).allowed).toBe(false);
    });

    it('target 归一化：/./、//、/x/.. 等价于根', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('rm -rf /.', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('rm -rf /./', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('rm -rf //', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('rm -rf /etc/..', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('rm -rf $HOME', opts).allowed).toBe(false);
    });

    it('无 recursive/force 时普通 rm 不拦截（非破坏性语义）', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('rm /tmp/old.txt', opts).allowed).toBe(true);
      expect(CommandSandbox.validateCommand('rm -i /tmp/old.txt', opts).allowed).toBe(true);
    });

    it('同类检查：dd/mkfs/format/del/shutdown 的 path-qualified 与 flag 分离均拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      // dd 裸设备（路径限定 + 参数 of=/dev/）
      expect(CommandSandbox.validateCommand('/usr/bin/dd if=/dev/zero of=/dev/sda', opts).allowed).toBe(false);
      // mkfs 路径限定
      expect(CommandSandbox.validateCommand('/sbin/mkfs.ext4 /dev/sda1', opts).allowed).toBe(false);
      // format.com 路径限定
      expect(CommandSandbox.validateCommand('C:\\Windows\\System32\\format.com C:', opts).allowed).toBe(false);
      // del /f /s /q 分离 flag
      expect(CommandSandbox.validateCommand('del /f /s /q C:\\evil', opts).allowed).toBe(false);
      // shutdown 路径限定
      expect(CommandSandbox.validateCommand('/sbin/shutdown -h now', opts).allowed).toBe(false);
    });
  });

  describe('P1-4 shell eval flag 规范化', () => {
    it('cmd /c 与 /C 大小写不敏感均拒绝（含路径限定）', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('cmd.exe /C echo hi', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('cmd /c echo hi', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('C:\\Windows\\System32\\cmd.exe /C echo hi', opts).allowed).toBe(false);
    });

    it('cmd /k 与 /K（保留窗口）同样拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('cmd /k echo hi', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('cmd.exe /K echo hi', opts).allowed).toBe(false);
    });

    it('powershell mixed-case -CoMmAnD 拒绝（含前缀缩写）', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('powershell.exe -CoMmAnD Get-Process', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('powershell -COMMAND Get-Process', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('powershell.exe -comm Get-Process', opts).allowed).toBe(false);
    });

    it('powershell -EncodedCommand 家族（-e/-en/-enc/合并参数）拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('powershell.exe -EncodedCommand AAAA', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('pwsh.exe -enc AAAA', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('powershell.exe -en:AAAA', opts).allowed).toBe(false);
    });

    it('路径限定 powershell 全路径同样拒绝', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -COMMAND x', opts).allowed).toBe(false);
    });

    it('裸解释器执行脚本（无 eval flag）不拦截', async () => {
      const opts: SandboxOptions = { allowedCommands: [] };
      expect(CommandSandbox.validateCommand('powershell.exe -File script.ps1', opts).allowed).toBe(true);
      expect(CommandSandbox.validateCommand('cmd.exe /d script.bat', opts).allowed).toBe(true);
    });
  });

  describe('F-013 policy operand identity（配置与 executable 同一 canonicalizer）', () => {
    it('blocked=[cmd.exe] + 路径限定 cmd.exe → BLOCK（扩展名配置不再被路径绕过）', async () => {
      const opts: SandboxOptions = { blockedCommands: ['cmd.exe'] };
      expect(CommandSandbox.validateCommand('cmd.exe /c echo hi', opts).allowed).toBe(false);
      expect(CommandSandbox.validateCommand('C:\\Windows\\System32\\cmd.exe /c echo hi', opts).allowed).toBe(false);
    });

    it('blocked=[node.exe] + 路径限定 node.exe → BLOCK', async () => {
      const opts: SandboxOptions = { blockedCommands: ['node.exe'] };
      expect(CommandSandbox.validateCommand('node.exe --version', opts).allowed).toBe(false);
      // 结构化入口（含空格路径不需要引号）
      const validation = CommandSandbox.validateExecution('C:\\Program Files\\nodejs\\node.exe', ['--version'], opts);
      expect(validation.allowed).toBe(false);
    });

    it('allowed=[node.exe] + 路径限定 node.exe → ALLOW', async () => {
      const opts: SandboxOptions = { allowedCommands: ['node.exe'] };
      const validation = CommandSandbox.validateExecution('C:\\Program Files\\nodejs\\node.exe', ['--version'], opts);
      expect(validation.allowed).toBe(true);
    });

    it('allowed=[node] + /tmp/evil + args 含 /usr/bin/node → 仍 BLOCK（参数不参与 identity）', async () => {
      const opts: SandboxOptions = { allowedCommands: ['node'] };
      const sandbox = new CommandSandbox(opts);
      const result = await sandbox.execute('/tmp/evil', ['/usr/bin/node']);
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('不在白名单中');
    });
  });
});
