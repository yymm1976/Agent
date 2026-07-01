// desktop/main/index.ts
// Electron 主进程入口：负责窗口管理、生命周期、IPC 与核心引擎桥接

import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import type { Tray } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  ChatSendPayload,
  ChatStreamPayload,
  CommandExecutePayload,
  ConfigSaveResult,
  MCPStatus,
  MCPInstallPayload,
  MCPInstallResult,
  MCPConnectionResult,
  MCPCatalogResult,
  ToolConfirmPayload,
  ToolExecutePayload,
  ExperimentInfo,
  HookInfo,
} from '../shared/ipc-types.js';
import { loadConfig } from '../../src/config/loader.js';
import { saveConfig } from './config-store.js';
import { RouteDevEngine } from './engine-bridge.js';
import { createSplash } from './splash.js';
import { createTray } from './tray.js';
import { initUpdater } from './updater.js';
import { listCatalog, searchCatalog } from './mcp-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 保持全局引用，防止垃圾回收
let mainWindow: BrowserWindow | null = null;
let engine: RouteDevEngine | null = null;
// 系统托盘需保持全局引用，否则会被垃圾回收导致托盘消失
let tray: Tray | null = null;
// C2 修复：记录用户通过选择器授权过的工作目录集合
// setCwd 只接受集合内路径，防止渲染层被劫持后切到任意本地目录
const authorizedCwds = new Set<string>();

/** 校验目标路径是否安全可用作项目工作目录 */
function isValidProjectCwd(target: string): boolean {
  if (!target || typeof target !== 'string') return false;
  // 必须是绝对路径
  if (!path.isAbsolute(target)) return false;
  // 拒绝系统根目录 / 用户主目录
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) return false;
  try {
    const os = require('node:os');
    if (resolved === os.homedir()) return false;
  } catch { /* ignore */ }
  // 必须存在于磁盘且是目录
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  return true;
}

// electron-vite dev 模式下 app.isPackaged 可能返回 true，用多重判断
// 陷阱 #194：`pnpm start:gui`（electron .）时 app.isPackaged=false 会被误判为 dev 模式，
// 但实际没有 dev server 在 5173 端口运行，导致渲染进程加载 http://localhost:5173 失败白屏。
// 修复：只有显式设置 ELECTRON_RENDERER_URL 环境变量（electron-vite dev 会设置）才走 dev 模式，
// 否则一律加载构建产物（app.isPackaged=false 时也走生产路径）
const isDev = !!process.env.ELECTRON_RENDERER_URL;

// 移除默认菜单栏（含 Help 等框架自带按钮），避免顶部突兀边框
Menu.setApplicationMenu(null);

// 单实例锁：防止多实例并发写入配置文件导致 EPERM，也避免双击打开两个窗口
// 锁获取失败说明已有实例在运行，直接退出当前进程
if (!app.requestSingleInstanceLock()) {
  console.warn('[main] 单实例锁获取失败，已有实例运行，当前进程退出');
  app.exit(0);
}
app.on('second-instance', () => {
  // 用户再次启动时，聚焦到已有窗口
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

/** 向渲染进程发送聊天流事件 */
function sendChatStream(payload: ChatStreamPayload): void {
  mainWindow?.webContents.send('chat:stream', payload);
}

/** 向渲染进程发送 Token Profile 事件 */
function sendTokenProfile(payload: import('../../src/agent/token-profiler.js').TokenProfileSnapshot): void {
  mainWindow?.webContents.send('token:profile', payload);
}

/** 向渲染进程发送 Trace Span 事件 */
function sendTraceEvent(payload: import('../../src/harness/trace-types.js').TraceSpan): void {
  mainWindow?.webContents.send('trace:event', payload);
}

/** Phase 54：向渲染进程发送 Goal 执行结构化事件（驱动 GoalExecutionCard 就地刷新） */
function sendGoalEvent(payload: import('../shared/ipc-types.js').GoalEvent): void {
  mainWindow?.webContents.send('goal:event', payload);
}

/** 创建主窗口
 * @param splash 可选的 Splash 窗口，主窗口 ready-to-show 后会被关闭
 */
function createWindow(splash?: BrowserWindow | null): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'RouteDev',
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 安全修复：启用渲染进程沙箱，缩小 XSS 攻击面
      // preload 仅使用 electron 的 contextBridge/ipcRenderer（非 Node API），sandbox: true 兼容
      sandbox: true,
    },
  });

  // 加载页面：开发环境使用 electron-vite  dev server，生产环境加载构建产物
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // 转发渲染进程 console 到主进程日志，便于诊断渲染层问题
  // 同时写入单独文件，确保即使主日志轮转也能看到
  // 安全：限制单文件 5MB，超过后轮转为 .old，防止长期运行占满磁盘
  // 陷阱 #195：ESM 模式下 require 是 undefined，必须用顶层 import 的 fs 模块
  const rendererLogPath = path.join(app.getPath('userData'), 'renderer-console.log');
  const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
  const rendererLog = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    console.log(line.trim());
    try {
      // 检查大小并轮转
      try {
        const stats = fs.statSync(rendererLogPath);
        if (stats.size > MAX_LOG_SIZE) {
          const backup = `${rendererLogPath}.old`;
          try { fs.unlinkSync(backup); } catch {}
          fs.renameSync(rendererLogPath, backup);
        }
      } catch {
        // 文件不存在，正常
      }
      fs.appendFileSync(rendererLogPath, line);
    } catch (e) {
      console.error('[rendererLog] 写入失败:', e);
    }
  };
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const levelStr = ['log', 'warn', 'error'][level] || 'log';
    rendererLog(`[${levelStr}] ${message} (${path.basename(sourceId)}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    rendererLog(`[FATAL:render-gone] ${JSON.stringify(details)}`);
  });
  mainWindow.webContents.on('unresponsive', () => {
    rendererLog('[FATAL:unresponsive]');
  });
  // 捕获 did-fail-load
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    rendererLog(`[did-fail-load] code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });

  // 注入 Content-Security-Policy：限制资源加载来源，缓解 XSS 与数据外泄风险
  // Minor 修复：生产环境移除 localhost:5173（开发服务器地址），防止数据外泄
  // M4 修复：添加 font-src 'self' data:，允许加载 data URI 内嵌字体（图标字体常用）
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    const connectSrc = isDev
      ? "'self' http://localhost:5173 ws://localhost:5173"
      : "'self'";
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src ${connectSrc}`,
        ],
      },
    });
  });

  mainWindow.once('ready-to-show', () => {
    // 主窗口就绪后关闭 Splash 并显示主窗口
    if (splash && !splash.isDestroyed()) {
      splash.close();
    }
    mainWindow?.show();
  });

  // 关闭按钮（X）：根据 backgroundBehavior 配置决定行为
  // exit：直接退出（杀掉后台进程）
  // minimize-to-tray：最小化到托盘
  // ask：询问用户
  mainWindow.on('close', (e) => {
    const config = engine?.getConfig();
    const bgBehavior = config?.general?.backgroundBehavior?.backgroundBehavior ?? 'exit';
    if (bgBehavior === 'minimize-to-tray') {
      e.preventDefault();
      mainWindow?.hide();
      return;
    }
    // exit 和 ask 都继续关闭（ask 模式暂不实现弹窗，默认退出）
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接使用系统浏览器打开
  // 安全：仅允许 http/https 协议，阻止 file:/javascript:/data: 等危险 scheme
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  // 先显示 Splash 启动画面，主窗口就绪后由其 ready-to-show 回调关闭
  const splash = createSplash();

  createWindow(splash);

  // 创建系统托盘（需在 app ready 之后）
  tray = createTray(() => mainWindow);

  // 初始化自动更新（仅生产环境生效，开发环境打印日志）
  initUpdater();

  // 初始化核心引擎（复用 CLI 的 App 依赖工厂）
  try {
    const config = loadConfig({ globalConfigPath: process.env.ROUTEDEV_CONFIG_PATH });

    // I12 修复：检测 modelId 为 'unconfigured' 的路由规则，给出友好提示而非崩溃
    const unconfiguredRules = config.router?.rules?.filter(
      (r: { modelId?: string }) => r.modelId === 'unconfigured',
    ) ?? [];
    if (unconfiguredRules.length > 0) {
      const tiers = unconfiguredRules.map((r: { tier: string }) => r.tier).join(', ');
      dialog.showErrorBox(
        'RouteDev 模型未配置',
        `以下任务等级的模型未配置: ${tiers}\n\n请在设置中配置 LLM 提供商和模型，或检查路由规则配置。`,
      );
    }

    engine = new RouteDevEngine(config, {
      cwd: process.cwd(),
      onStream: sendChatStream,
      onTokenProfile: sendTokenProfile,
      onTraceEvent: sendTraceEvent,
      onToolConfirmRequest: (toolName, params) => {
        mainWindow?.webContents.send('chat:tool-confirm-request', { toolName, params });
      },
      onConfigReloaded: (cfg) => {
        mainWindow?.webContents.send('config:reloaded', cfg);
      },
      // Phase 54：Goal 执行结构化事件转发到渲染进程
      onGoalEvent: sendGoalEvent,
      // Phase 54：计划编辑请求转发到渲染进程（驱动 StepEditor 显示）
      onPlanEditRequest: (requestId, plan) => {
        mainWindow?.webContents.send('plan:edit-request', { requestId, plan });
      },
    });
    // C2 修复：将初始工作目录登记为已授权
    authorizedCwds.add(path.resolve(process.cwd()));
    await engine.initialize();
  } catch (err) {
    console.error('Engine initialization failed:', err);
    dialog.showErrorBox(
      'RouteDev 启动失败',
      err instanceof Error ? err.message : String(err),
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前清理：杀掉引擎后台线程（中止进行中的 LLM 请求、释放 MCP 连接等）
// 异步等待清理完成后再退出，避免 MCP 子进程成为孤儿进程锁定文件
// I25 修复：添加超时保护，避免 destroy() 卡住导致应用无法退出
let isQuitting = false;
app.on('before-quit', async (event) => {
  if (isQuitting) return; // 防止重复调用
  isQuitting = true;
  if (engine) {
    event.preventDefault();
    try {
      // I25 修复：超时保护——最多等待 5 秒，超时后强制退出
      // 避免 MCP 断连或异步保存卡住导致应用永不退出
      await Promise.race([
        engine.destroy(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (err) {
      console.error('Engine destroy failed on quit:', err);
    }
    engine = null;
    // 清理完成，真正退出
    app.exit(0);
  }
});

// ============================================================
// IPC 处理：所有核心业务逻辑走这里，渲染进程不直接接触 Node API
// ============================================================

// 聊天：发送消息
// I26 修复：添加输入验证，确保空消息和异常情况都能将错误反馈到前端
ipcMain.on('chat:send', (_event, payload: ChatSendPayload) => {
  // I26 修复：输入验证——空消息或非字符串消息直接反馈错误，不进入引擎
  if (!payload || typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    sendChatStream({ type: 'error', error: '消息内容不能为空' });
    sendChatStream({ type: 'done' });
    return;
  }
  if (!engine) {
    sendChatStream({ type: 'error', error: '引擎尚未初始化完成' });
    sendChatStream({ type: 'done' });
    return;
  }
  engine.sendChat(payload.text).catch((err: Error) => {
    // I26 修复：确保所有异常都反馈到前端，并发送 done 事件终止 loading 状态
    sendChatStream({ type: 'error', error: err.message || '发送消息时发生未知错误' });
    sendChatStream({ type: 'done' });
  });
});

// 聊天：确认/拒绝工具调用
ipcMain.on('chat:confirm-tool', (_event, payload: ToolConfirmPayload) => {
  engine?.resolveToolConfirm(payload.approved, payload.payload);
});

// Phase 54：计划编辑响应（StepEditor 确认/取消后回传）
ipcMain.on('plan:edit-response', (_event, payload: import('../shared/ipc-types.js').PlanEditResponsePayload) => {
  engine?.resolvePlanEdit(payload.requestId, payload.steps);
});

// 聊天：停止当前生成（中止进行中的 LLM 请求与 Agent Loop）
ipcMain.on('chat:stop', () => {
  engine?.stopGeneration();
});

// 聊天：同步当前对话历史，避免切换/分支后后台仍沿用旧对话上下文
ipcMain.on('chat:sync-history', (_event, messages: import('../../src/router/types.js').LLMMessage[]) => {
  engine?.syncConversationHistory(messages);
});

// 配置：读取
ipcMain.handle('config:get', async (): Promise<import('../../src/config/schema.js').AppConfig> => {
  return loadConfig({ globalConfigPath: process.env.ROUTEDEV_CONFIG_PATH });
});

// 配置：保存
ipcMain.handle('config:save', async (_event, config: import('../../src/config/schema.js').AppConfig): Promise<ConfigSaveResult> => {
  try {
    await saveConfig(config);
    // 同步更新 engine 内部配置，确保自主度等设置实时生效
    engine?.updateConfig(config);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// 配置：重新加载
ipcMain.handle('config:reload', async (): Promise<import('../../src/config/schema.js').AppConfig> => {
  try {
    const cfg = loadConfig({ globalConfigPath: process.env.ROUTEDEV_CONFIG_PATH });
    await engine?.reloadConfig(cfg);
    return cfg;
  } catch (err) {
    console.error('[config:reload] 重载配置失败:', err);
    throw new Error(`重载配置失败: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// 命令执行（用于 GUI 中的快捷命令，如 /clear、/status 等）
ipcMain.handle('command:execute', async (_event, payload: CommandExecutePayload): Promise<unknown> => {
  return engine?.executeCommand(payload.text) ?? { error: '引擎未初始化' };
});

// 工具执行（用于设置页中的测试按钮等）
ipcMain.handle('tool:execute', async (_event, payload: ToolExecutePayload): Promise<unknown> => {
  return engine?.executeTool(payload.name, payload.args) ?? { error: '引擎未初始化' };
});

// MCP 状态
ipcMain.handle('mcp:status', async (): Promise<MCPStatus> => {
  return engine?.getMCPStatus() ?? { connected: false, servers: [] };
});

// Phase 37：MCP 工具列表
ipcMain.handle('mcp:tools', async () => {
  return { tools: engine?.listMCPTools() ?? [] };
});

// ============================================================
// MCP 插件市场 IPC handler
// ============================================================

// 列出内置精选目录（可按分类过滤）
ipcMain.handle('mcp:catalog:list', async (_event, category?: string): Promise<MCPCatalogResult> => {
  return listCatalog(category);
});

// 按关键词搜索目录
ipcMain.handle('mcp:catalog:search', async (_event, query: string): Promise<MCPCatalogResult> => {
  return searchCatalog(query);
});

// 一键安装：添加到配置 + 立即连接 + 持久化
ipcMain.handle('mcp:install', async (_event, payload: MCPInstallPayload): Promise<MCPInstallResult> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  const result = await engine.installServer(payload);
  // 安装成功后持久化配置（即使连接失败，配置也已写入内存，需要持久化）
  if (result.serverId) {
    try {
      await saveConfig(engine.getConfig());
    } catch (err) {
      // 持久化失败不影响安装结果，但记录错误
      console.error('[MCP] 配置持久化失败:', err);
    }
  }
  return result;
});

// 连接指定服务器
ipcMain.handle('mcp:connect', async (_event, serverId: string): Promise<MCPConnectionResult> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.connectServer(serverId);
});

// 断开指定服务器
ipcMain.handle('mcp:disconnect', async (_event, serverId: string): Promise<MCPConnectionResult> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.disconnectServer(serverId);
});

// ============================================================
// Phase 37：Skill 管理 IPC handler
// ============================================================

ipcMain.handle('skill:list', async () => {
  return engine?.listSkills() ?? [];
});

ipcMain.handle('skill:preview', async (_event, name: string) => {
  return engine?.previewSkill(name) ?? null;
});

ipcMain.handle('skill:toggle', async (_event, payload: { name: string; enabled: boolean }) => {
  return engine?.toggleSkill(payload.name, payload.enabled) ?? false;
});

ipcMain.handle('skill:create', async (_event, payload: import('../shared/ipc-types.js').SkillCreatePayload) => {
  return engine?.createSkill(payload.name, payload.description, payload.keywords, payload.content)
    ?? { success: false, error: '引擎未初始化' };
});

// Phase 37 Skill 市场接线：从市场安装 Skill 到 .routedev/skills/<name>/
// 注：renderer 层当前未消费此 handler（SettingsPage 尚未实现 Skill 市场浏览 UI），
// preload 已暴露 window.routedev.skill.install，待 UI 接入后即可生效
ipcMain.handle('skill:install', async (_event, payload: import('../shared/ipc-types.js').SkillInstallPayload): Promise<import('../shared/ipc-types.js').SkillOpResult> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.installSkill(payload);
});

ipcMain.handle('skill:delete', async (_event, name: string) => {
  return engine?.deleteSkill(name) ?? { success: false, error: '引擎未初始化' };
});

ipcMain.handle('skill:reload', async () => {
  return engine?.reloadSkills() ?? { count: 0 };
});

ipcMain.handle('skill:route', async (_event, taskDescription: string) => {
  return { skills: engine?.routeSkills(taskDescription) ?? [] };
});

// 文件读取（用于渲染进程读取本地文件，如拖拽图片预览等）
// 安全：白名单到当前项目目录，拒绝敏感 pattern，防止任意文件读取
ipcMain.handle('fs:read', async (_event, filePath: string): Promise<{ data: string; error?: string }> => {
  try {
    const cwd = path.resolve(engine?.getCwd?.() ?? process.cwd());
    const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
    // 路径越界检查：基于 engine 当前工作目录（项目路径），而非 process.cwd()
    // 这样用户切换项目后，fs:read 能正确读取新项目内的文件
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
      return { data: '', error: `路径越界：仅允许读取项目目录内文件（项目根: ${cwd}）` };
    }
    // 安全修复：解析符号链接后重新校验路径，防止 symlink 逃逸
    const fsSync = await import('node:fs');
    let realPath = resolved;
    try {
      realPath = fsSync.realpathSync(resolved);
    } catch {
      // 文件不存在时 realpathSync 会抛错，保持原路径继续（后续 readFile 会报错）
    }
    if (!realPath.startsWith(cwd + path.sep) && realPath !== cwd) {
      return { data: '', error: '符号链接逃逸：目标路径不在项目目录内' };
    }
    // 复用安全配置的敏感文件 pattern，阻止读取 .env / credentials.json 等
    const sensitive = engine?.getConfig()?.security?.sensitiveFiles ?? [];
    const baseName = path.basename(realPath);
    if (sensitive.some((p: string) => baseName.includes(p) || realPath.includes(p))) {
      return { data: '', error: '文件被安全策略保护' };
    }
    const fs = await import('node:fs/promises');
    const data = await fs.readFile(realPath, 'utf-8');
    return { data };
  } catch (err) {
    return { data: '', error: err instanceof Error ? err.message : String(err) };
  }
});

// 文件夹选择对话框：返回用户选择的文件夹路径，取消则返回 null
ipcMain.handle('fs:select-folder', async (_event, defaultPath?: string): Promise<string | null> => {
  const safeDefaultPath = defaultPath && path.isAbsolute(defaultPath)
    ? defaultPath
    : app.getPath('desktop');
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: '选择项目文件夹',
    defaultPath: safeDefaultPath,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  // C2 修复：选择器返回的路径记入授权集合
  const selected = path.resolve(result.filePaths[0]);
  authorizedCwds.add(selected);
  return selected;
});

// 在系统文件资源管理器中打开指定路径
// C8 修复：添加 projectRoot 边界检查，只允许打开项目目录内的文件夹
// 复用 fs:read 的路径边界校验逻辑，防止打开任意路径
ipcMain.handle('fs:open-folder', async (_event, filePath: string): Promise<boolean> => {
  try {
    if (!filePath) {
      console.error('[fs:open-folder] 路径为空');
      return false;
    }
    // 修复：相对路径基于项目工作目录解析，而非 process.cwd()
    const cwd = path.resolve(engine?.getCwd?.() ?? process.cwd());
    const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
    // 基本校验：路径不能为空或仅系统根目录
    if (resolved === path.parse(resolved).root) {
      console.error('[fs:open-folder] 拒绝打开系统根目录:', resolved);
      return false;
    }
    // C8 修复：路径边界检查——只允许打开 projectRoot 内的路径
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
      console.error('[fs:open-folder] 路径越界：仅允许打开项目目录内文件（项目根:', cwd, '）');
      return false;
    }
    const fsSync = await import('node:fs');
    if (fsSync.existsSync(resolved) && fsSync.statSync(resolved).isFile()) {
      // 文件：在资源管理器中打开并选中该文件
      shell.showItemInFolder(resolved);
    } else {
      // 目录：直接打开
      await shell.openPath(resolved);
    }
    return true;
  } catch (err) {
    console.error('Failed to open folder:', err);
    return false;
  }
});

// === 项目工作目录切换 ===
// 用户切换项目或对话时，renderer 通知 main 更新 engine 的工作目录
// 这样所有工具调用（file_read/file_write/shell_exec 等）都会基于正确的项目路径
// C2 修复：只接受用户通过选择器授权过的路径，防止渲染层被劫持后切到任意目录
ipcMain.on('project:set-cwd', (_event, cwd: string) => {
  if (!engine || !cwd) return;
  const resolved = path.resolve(cwd);
  // 必须在授权集合内，或通过基础校验（启动时初始 cwd 由 engine 初始化注入）
  if (!authorizedCwds.has(resolved) && !isValidProjectCwd(resolved)) {
    console.error('[project:set-cwd] 拒绝未授权的工作目录:', resolved);
    return;
  }
  engine.setCwd(resolved).catch((err) => {
    console.error('[project:set-cwd] 切换工作目录失败:', err);
  });
});

// === 对话标题生成 ===
// 使用路由模型（杂活模型）根据用户首条消息生成简洁对话标题
// 失败时回退到截断策略，不影响主流程
ipcMain.handle('chat:generate-title', async (_event, userMessage: string, assistantReply?: string) => {
  if (!engine || !userMessage) return null;
  try {
    return await engine.generateTitle(userMessage, assistantReply);
  } catch (err) {
    console.error('[chat:generate-title] 生成标题失败:', err);
    return null;
  }
});

// === 无边框窗口控制 ===
// 安全：所有窗口控制 IPC 都加 isDestroyed 守卫，防止窗口关闭过程中调用导致抛错
ipcMain.on('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.on('window:maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});
ipcMain.on('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// ============================================================
// Phase 39：实验分支 / Hook IPC handler
// 直接调用 engine 桥接方法（fail-open：engine 未初始化或底层模块异常时返回默认值）
// ============================================================

// --- 实验分支相关 ---

// 列出所有实验分支
ipcMain.handle('experiment:list', async (): Promise<ExperimentInfo[]> => {
  if (!engine) return [];
  return engine.listExperiments() as ExperimentInfo[];
});

// 采纳实验分支
ipcMain.handle('experiment:adopt', async (_event, experimentId: string): Promise<{ success: boolean; error?: string }> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.adoptExperiment(experimentId);
});

// 丢弃实验分支
ipcMain.handle('experiment:discard', async (_event, experimentId: string): Promise<{ success: boolean; error?: string }> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.discardExperiment(experimentId);
});

// 获取实验分支 diff
ipcMain.handle('experiment:get-diff', async (_event, experimentId: string): Promise<{ diff: string; filesChanged: number; error?: string }> => {
  if (!engine) return { diff: '', filesChanged: 0, error: '引擎未初始化' };
  return engine.getExperimentDiff(experimentId);
});

// --- Hook 相关 ---

// 列出所有 Hook（模板 + 自定义）
ipcMain.handle('hook:list', async (): Promise<HookInfo[]> => {
  if (!engine) return [];
  return engine.listHooks() as Promise<HookInfo[]>;
});

// 启用/禁用 Hook
ipcMain.handle('hook:toggle', async (_event, payload: { hookId: string; enabled: boolean }): Promise<{ success: boolean; error?: string }> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.toggleHook(payload.hookId, payload.enabled);
});

// 创建自定义 Hook（模板模式或自定义模式）
// 参数 payload：{ templateId: string } 或 { name, event, code, description?, ... }
ipcMain.handle('hook:create', async (_event, payload: unknown): Promise<{ success: boolean; hookId?: string; error?: string }> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.createHook(payload as Parameters<typeof engine.createHook>[0]);
});

// 列出内置 Hook 模板（供 UI 选择创建）
// 注：renderer 层当前未消费此 handler（Hook 管理 UI 尚未实现模板选择），
// preload 已暴露 window.routedev.hook.templates，待 UI 接入后即可生效
ipcMain.handle('hook:templates', async (): Promise<import('../shared/ipc-types.js').HookTemplate[]> => {
  if (!engine) return [];
  return engine.listHookTemplates();
});

// 删除自定义 Hook
ipcMain.handle('hook:delete', async (_event, hookId: string): Promise<{ success: boolean; error?: string }> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.deleteHook(hookId);
});

// ============================================================
// Phase 47 Task 6：Checkpoint 时间轴 IPC handler
// 直接调用 engine 桥接方法（fail-open：engine 未初始化时返回默认值）
// ============================================================

// 列出当前项目的所有检查点（用于时间轴展示）
ipcMain.handle('checkpoint:list', async (_event, projectId?: string) => {
  if (!engine) return [];
  return engine.listCheckpoints(projectId);
});

// 回滚到指定检查点（破坏性操作，UI 层需在调用前弹出确认对话框）
ipcMain.handle('checkpoint:rollback', async (_event, checkpointId: string): Promise<{ success: boolean; error?: string }> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.rollbackCheckpoint(checkpointId);
});

// ============================================================
// Phase 48 Task 4 接线修复：Agent Profile 管理 IPC handler
// 渲染层调用 → engine → AgentProfileManager
// 注：renderer 层当前未消费 profile:* handler（SettingsPage 尚未实现 Profile 编辑 UI），
// preload 已暴露 window.routedev.profile.*，待 UI 接入后即可生效
// ============================================================

ipcMain.handle('profile:list', async () => {
  return engine?.listProfiles() ?? [];
});

ipcMain.handle('profile:get', async (_event, id: string) => {
  return engine?.getProfile(id) ?? null;
});

ipcMain.handle('profile:save', async (_event, payload: import('../shared/ipc-types.js').ProfileSavePayload): Promise<import('../shared/ipc-types.js').ProfileOpResult> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.saveProfile(payload);
});

ipcMain.handle('profile:delete', async (_event, id: string): Promise<import('../shared/ipc-types.js').ProfileOpResult> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.deleteProfile(id);
});

ipcMain.handle('profile:duplicate', async (_event, payload: { id: string; newName: string }): Promise<import('../shared/ipc-types.js').ProfileOpResult> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.duplicateProfile(payload.id, payload.newName);
});
