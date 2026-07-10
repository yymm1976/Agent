// desktop/main/index.ts
// Electron 主进程入口：负责窗口管理、生命周期、IPC 与核心引擎桥接

import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import type { Tray } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
import { AGENT_PROFILE_ROLES } from '../shared/ipc-types.js';
import { loadConfig } from '../../src/config/loader.js';
import { saveConfig } from './config-store.js';
import { RouteDevEngine } from './engine-bridge.js';
import { createSplash } from './splash.js';
import { createTray } from './tray.js';
import { initUpdater } from './updater.js';
import { listCatalog, searchCatalog } from './mcp-catalog.js';
// TD-08：IPC 参数统一校验工具
import { ipcGuard } from './ipc-guard.js';
// F-032：fail-open 降级日志
import { logger } from '../../src/utils/logger.js';

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
  // F-057/F-4.06 修复：使用异步 IO（fs.promises）避免同步文件操作阻塞主进程
  // 调用点（console-message / render-process-gone 等事件处理器）均为 fire-and-forget，无需 await
  const rendererLog = async (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    console.log(line.trim());
    try {
      // 检查大小并轮转
      try {
        const stats = await fs.promises.stat(rendererLogPath);
        if (stats.size > MAX_LOG_SIZE) {
          const backup = `${rendererLogPath}.old`;
          // F-3.01 修复：区分 ENOENT（备份不存在，正常）与其他错误
          try {
            await fs.promises.unlink(backup);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn('[rendererLog] 删除旧备份失败:', e);
            }
          }
          await fs.promises.rename(rendererLogPath, backup);
        }
      } catch {
        // 文件不存在，正常
      }
      await fs.promises.appendFile(rendererLogPath, line);
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
          `default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src ${connectSrc}`,
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
      shell.openExternal(url).catch(e => console.warn('[openExternal] 打开链接失败:', url, e));
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
      // G-004 修复：回调携带 requestId，前端在 confirm-tool 回传中带上以实现精准 resolve
      onToolConfirmRequest: (requestId, toolName, params) => {
        mainWindow?.webContents.send('chat:tool-confirm-request', { requestId, toolName, params });
      },
      onConfigReloaded: (cfg) => {
        // G-002 修复：推送前对敏感字段脱敏，防止明文 apiKey 泄露到渲染进程
        mainWindow?.webContents.send('config:reloaded', maskSensitiveConfig(cfg));
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
// TD-08：用 ipcGuard 统一参数校验
ipcMain.on('chat:send', (_event, rawPayload: unknown) => {
  let payload: ChatSendPayload;
  try {
    payload = ipcGuard.object<ChatSendPayload>({
      text: ipcGuard.string(100000),
    })(rawPayload);
  } catch (err) {
    sendChatStream({ type: 'error', error: err instanceof Error ? err.message : '无效的参数' });
    sendChatStream({ type: 'done' });
    return;
  }
  // I26 修复：输入验证——空消息直接反馈错误，不进入引擎
  if (payload.text.trim().length === 0) {
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
// G-004 修复：通过 requestId 精准 resolve 对应并发请求的工具确认 entry
ipcMain.on('chat:confirm-tool', (_event, payload: ToolConfirmPayload) => {
  if (!payload || typeof payload.approved !== 'boolean') {
    return;
  }
  // F-N026 修复：校验 requestId 为非空字符串且长度合理
  if (typeof payload.requestId !== 'string' || payload.requestId.length === 0 || payload.requestId.length > 128) {
    return;
  }
  engine?.resolveToolConfirm(payload.requestId, payload.approved, payload.payload);
});

// Phase 54：计划编辑响应（StepEditor 确认/取消后回传）
ipcMain.on('plan:edit-response', (_event, payload: import('../shared/ipc-types.js').PlanEditResponsePayload) => {
  if (!payload || typeof payload.requestId !== 'string' || payload.requestId.length === 0 || payload.requestId.length > 256) {
    return;
  }
  engine?.resolvePlanEdit(payload.requestId, payload.steps);
});

// Phase 71：Plan 修订历史读取 + 遗漏点检查
ipcMain.handle('plan:get-revisions', async (_event, goalId: string) => {
  // 从 .routedev/plan-revisions/<goalId>.jsonl 读取修订历史
  // 路径通过 config.plan.revisionHistoryPath 配置，默认 .routedev/plan-revisions/
  // 安全：校验 goalId 字符集，防止路径穿越（../ 注入）
  if (!goalId || typeof goalId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(goalId)) {
    return { ok: false, revisions: [] };
  }
  try {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    type PlanConfig = { plan?: { revisionHistoryPath?: string } };
    const cfg = (engine?.getConfig?.() ?? {}) as PlanConfig;
    const revisionDir = cfg.plan?.revisionHistoryPath
      ? path.resolve(cfg.plan.revisionHistoryPath)
      : path.join(process.cwd(), '.routedev', 'plan-revisions');
    const revisionFile = path.join(revisionDir, `${goalId}.jsonl`);
    const data = await fs.readFile(revisionFile, 'utf-8');
    // 安全：JSON.parse 后校验 revision shape（before/after/revisedAt），丢弃畸形记录
    const revisions = data.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((r): r is { before: unknown; after: unknown; revisedAt: string } =>
      r !== null && typeof r === 'object' &&
      'before' in r && 'after' in r && typeof r.revisedAt === 'string',
    );
    return { ok: true, revisions };
  } catch (error) {
    // 文件不存在或读取失败返回空（fail-open）
    logger.warn('plan revisions fail-open', { error: error instanceof Error ? error.message : String(error) });
    return { ok: true, revisions: [] };
  }
});

ipcMain.handle('plan:check-omissions', async (_event, goalId: string) => {
  // F-N026 修复：补 goalId 正则校验（参照 plan:get-revisions），防止路径穿越
  if (typeof goalId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(goalId)) {
    return { ok: false, error: 'Invalid goalId' };
  }
  // 通过 engine 触发遗漏点检查（LLM 调用，结果异步返回）
  // 实际 LLM 调用由 OmissionChecker 在主进程完成
  try {
    const result = await engine?.checkOmissions?.(goalId);
    return { ok: true, result: result ?? { omissions: [], summary: '检查未执行' } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ============================================================
// Phase 77 借鉴点 7：冷启动恢复 IPC——goal:list-resumable / goal:resume / goal:discard
// 数据流：renderer → IPC → engine-bridge.{listResumableGoals,resumeGoal,discardGoal}
// ============================================================

// 列出可恢复 goal（驱动 UI 提示条）
ipcMain.handle('goal:list-resumable', async (): Promise<import('../shared/ipc-types.js').ResumableGoalIpcInfo[]> => {
  try {
    return (await engine?.listResumableGoals?.()) ?? [];
  } catch (error) {
    // fail-open：任何异常返回空数组，不阻塞 UI
    logger.warn('goal:list-resumable fail-open', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
});

// 恢复指定 goal 的执行
// TD-08：用 ipcGuard 统一参数校验（goal:start 在本项目中由 chat:send 携 /goal 命令触发，
// 此处对最接近的 goal:resume 做参数校验重构）
ipcMain.handle('goal:resume', async (_event, rawGoalId: unknown): Promise<{ success: boolean; error?: string }> => {
  let goalId: string;
  try {
    goalId = ipcGuard.string(256)(rawGoalId);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '无效的 goalId' };
  }
  if (goalId.length === 0) {
    return { success: false, error: 'goalId 不能为空' };
  }
  try {
    return (await engine?.resumeGoal?.(goalId)) ?? { success: false, error: '引擎未初始化' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// 放弃（归档）指定 goal
ipcMain.handle('goal:discard', async (_event, goalId: string): Promise<{ success: boolean; error?: string }> => {
  if (!goalId || typeof goalId !== 'string' || goalId.length > 256) {
    return { success: false, error: '无效的 goalId' };
  }
  try {
    return (await engine?.discardGoal?.(goalId)) ?? { success: false, error: '引擎未初始化' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// 聊天：停止当前生成（中止进行中的 LLM 请求与 Agent Loop）
// G-004 修复：支持可选 requestId 精准中断指定请求；未传则中断全部（向后兼容）
ipcMain.on('chat:stop', (_event, payload?: { requestId?: string }) => {
  const requestId = payload?.requestId;
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128)) {
    return;
  }
  engine?.stopGeneration(requestId);
});

// 聊天：同步当前对话历史，避免切换/分支后后台仍沿用旧对话上下文
ipcMain.on('chat:sync-history', (_event, messages: import('../../src/router/types.js').LLMMessage[]) => {
  if (!Array.isArray(messages) || messages.length > 10000) {
    console.error('[chat:sync-history] 无效 messages');
    return;
  }
  engine?.syncConversationHistory(messages);
});

// ============================================================
// F-N010 修复：config:get 返回前对敏感字段脱敏
// 防止渲染进程（潜在 XSS）通过 config:get 获取完整 apiKey
// 注意：config:save 仍接收完整 key，不做脱敏
// ============================================================

/** 脱敏单个 API Key：保留首尾各 4 位，中间用 **** 替换；过短或空值返回脱敏占位 */
function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return key;
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/** G-001 修复：检测 API Key 是否为掩码值（包含 **** 占位符） */
function isMaskedApiKey(key: string | undefined): boolean {
  if (!key || typeof key !== 'string') return false;
  return key.includes('****');
}

/** 脱敏配置中的所有敏感 apiKey 字段（providers 数组 + llmProviders 快捷配置） */
function maskSensitiveConfig(config: import('../../src/config/schema.js').AppConfig): import('../../src/config/schema.js').AppConfig {
  const masked = { ...config };
  // 脱敏 providers 数组中的 apiKey
  if (Array.isArray(masked.providers)) {
    masked.providers = masked.providers.map(p => ({
      ...p,
      apiKey: maskApiKey(p.apiKey) ?? '',
    }));
  }
  // 脱敏 llmProviders 中的 apiKey（gemini/deepseek/qwen，ollama 无需 apiKey）
  if (masked.llmProviders) {
    const lp = { ...masked.llmProviders };
    if (lp.gemini) lp.gemini = { ...lp.gemini, apiKey: maskApiKey(lp.gemini.apiKey) ?? '' };
    if (lp.deepseek) lp.deepseek = { ...lp.deepseek, apiKey: maskApiKey(lp.deepseek.apiKey) ?? '' };
    if (lp.qwen) lp.qwen = { ...lp.qwen, apiKey: maskApiKey(lp.qwen.apiKey) ?? '' };
    masked.llmProviders = lp;
  }
  return masked;
}

// 配置：读取
ipcMain.handle('config:get', async (): Promise<import('../../src/config/schema.js').AppConfig> => {
  const config = loadConfig({ globalConfigPath: process.env.ROUTEDEV_CONFIG_PATH });
  // F-N010 修复：对敏感字段脱敏后再返回渲染进程，防止 apiKey 泄露
  return maskSensitiveConfig(config);
});

// 配置：保存
// TD-08：用 ipcGuard 统一参数校验（AppConfig 字段众多，此处用 object({}) 校验非空对象，
// passthrough 策略保留全部字段供 saveConfig 持久化）
ipcMain.handle('config:save', async (_event, rawConfig: unknown): Promise<ConfigSaveResult> => {
  let config: import('../../src/config/schema.js').AppConfig;
  try {
    config = ipcGuard.object<import('../../src/config/schema.js').AppConfig & Record<string, unknown>>({})(rawConfig) as import('../../src/config/schema.js').AppConfig;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '无效的参数' };
  }
  try {
    // G-001 修复：保存前检测掩码 apiKey，用磁盘真实值回填，防止掩码覆盖真实密钥
    // 渲染进程通过 config:get 拿到的是脱敏配置，若用户未修改 apiKey 直接保存，
    // 掩码值会覆盖真实密钥导致后续 LLM 调用失败
    const hasMaskedKey =
      (Array.isArray(config.providers) && config.providers.some(p => isMaskedApiKey(p.apiKey))) ||
      (config.llmProviders && (
        isMaskedApiKey(config.llmProviders.gemini?.apiKey) ||
        isMaskedApiKey(config.llmProviders.deepseek?.apiKey) ||
        isMaskedApiKey(config.llmProviders.qwen?.apiKey)
      ));
    if (hasMaskedKey) {
      const diskConfig = loadConfig({ globalConfigPath: process.env.ROUTEDEV_CONFIG_PATH });
      // 回填 providers 数组中的掩码 apiKey
      if (Array.isArray(config.providers) && Array.isArray(diskConfig.providers)) {
        config.providers = config.providers.map(p => {
          if (isMaskedApiKey(p.apiKey)) {
            const diskProvider = diskConfig.providers.find(d => d.id === p.id);
            if (diskProvider && !isMaskedApiKey(diskProvider.apiKey)) {
              return { ...p, apiKey: diskProvider.apiKey };
            }
          }
          return p;
        });
      }
      // 回填 llmProviders 中的掩码 apiKey
      if (config.llmProviders && diskConfig.llmProviders) {
        const lp = config.llmProviders;
        const dlp = diskConfig.llmProviders;
        if (isMaskedApiKey(lp.gemini?.apiKey) && !isMaskedApiKey(dlp.gemini?.apiKey)) {
          lp.gemini = { ...lp.gemini!, apiKey: dlp.gemini!.apiKey };
        }
        if (isMaskedApiKey(lp.deepseek?.apiKey) && !isMaskedApiKey(dlp.deepseek?.apiKey)) {
          lp.deepseek = { ...lp.deepseek!, apiKey: dlp.deepseek!.apiKey };
        }
        if (isMaskedApiKey(lp.qwen?.apiKey) && !isMaskedApiKey(dlp.qwen?.apiKey)) {
          lp.qwen = { ...lp.qwen!, apiKey: dlp.qwen!.apiKey };
        }
      }
    }
    await saveConfig(config);
    // 同步更新 engine 内部配置，确保自主度等设置实时生效
    engine?.updateConfig(config);
    // Grok F-011：updateConfig 仅更新内存 config，不重建 deps（LLM 客户端/分类器）。
    // 提示前端：provider/model 等结构性变更需调用 config:reload 才能真正生效。
    return { success: true, needsReload: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// 配置：重新加载
ipcMain.handle('config:reload', async (): Promise<import('../../src/config/schema.js').AppConfig> => {
  try {
    const cfg = loadConfig({ globalConfigPath: process.env.ROUTEDEV_CONFIG_PATH });
    await engine?.reloadConfig(cfg);
    // G-002 修复：返回前对敏感字段脱敏，防止明文 apiKey 泄露到渲染进程
    return maskSensitiveConfig(cfg);
  } catch (err) {
    console.error('[config:reload] 重载配置失败:', err);
    throw new Error(`重载配置失败: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// 命令执行（用于 GUI 中的快捷命令，如 /clear、/status 等）
ipcMain.handle('command:execute', async (_event, payload: CommandExecutePayload): Promise<unknown> => {
  if (!payload || typeof payload.text !== 'string' || payload.text.length === 0 || payload.text.length > 10000) {
    return { error: '无效的参数' };
  }
  return engine?.executeCommand(payload.text) ?? { error: '引擎未初始化' };
});

// IPC tool:execute 允许的工具白名单（仅设置页所需工具）
// TD-07：拒绝白名单外的工具，防止渲染进程被劫持后通过 IPC 调用任意工具
const IPC_TOOL_WHITELIST = new Set([
  'test_connection',
  'list_directory',
  'file_read',
]);

// 工具执行（用于设置页中的测试按钮等）
ipcMain.handle('tool:execute', async (_event, payload: ToolExecutePayload): Promise<unknown> => {
  // TD-07：白名单校验——非白名单工具直接拒绝
  if (!payload || typeof payload.name !== 'string' || payload.name.length === 0 || payload.name.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  if (!IPC_TOOL_WHITELIST.has(payload.name)) {
    console.warn(`[IPC] tool:execute 拒绝非白名单工具: ${payload.name}`);
    return { success: false, error: '该工具不允许通过 IPC 直接调用' };
  }
  // 安全：args 必须是对象（或 null/undefined），拒绝数组/原始值
  if (payload.args != null && (typeof payload.args !== 'object' || Array.isArray(payload.args))) {
    return { success: false, error: '无效的参数' };
  }
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
// F-N026 修复：补 category 类型与长度校验
ipcMain.handle('mcp:catalog:list', async (_event, category?: string): Promise<MCPCatalogResult> => {
  if (category !== undefined && (typeof category !== 'string' || category.length > 256)) {
    return { entries: [], total: 0 };
  }
  return listCatalog(category);
});

// 按关键词搜索目录
// G-020 修复：校验 query 为字符串且长度 <= 1000，防止超长输入耗尽资源
ipcMain.handle('mcp:catalog:search', async (_event, query: string): Promise<MCPCatalogResult> => {
  if (typeof query !== 'string' || query.length > 1000) {
    return { entries: [], total: 0 };
  }
  return searchCatalog(query);
});

// 一键安装：添加到配置 + 立即连接 + 持久化
// G-020 修复：校验 payload 为对象且含 catalogId 字段（字符串 <= 256）
ipcMain.handle('mcp:install', async (_event, payload: MCPInstallPayload): Promise<MCPInstallResult> => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  if (!payload || typeof payload !== 'object' ||
      typeof payload.catalogId !== 'string' || payload.catalogId.length === 0 || payload.catalogId.length > 256) {
    return { success: false, error: '无效的参数' };
  }
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
  if (typeof serverId !== 'string' || serverId.length === 0 || serverId.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.connectServer(serverId);
});

// 断开指定服务器
ipcMain.handle('mcp:disconnect', async (_event, serverId: string): Promise<MCPConnectionResult> => {
  if (typeof serverId !== 'string' || serverId.length === 0 || serverId.length > 256) {
    return { success: false, error: '无效的参数' };
  }
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
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) {
    return null;
  }
  return engine?.previewSkill(name) ?? null;
});

ipcMain.handle('skill:toggle', async (_event, payload: { name: string; enabled: boolean }) => {
  if (!payload || typeof payload.name !== 'string' || payload.name.length === 0 || payload.name.length > 256) {
    return false;
  }
  return engine?.toggleSkill(payload.name, payload.enabled) ?? false;
});

ipcMain.handle('skill:create', async (_event, rawPayload: unknown) => {
  // TD-08：用 ipcGuard 统一参数校验
  let payload: import('../shared/ipc-types.js').SkillCreatePayload;
  try {
    payload = ipcGuard.object<import('../shared/ipc-types.js').SkillCreatePayload>({
      name: ipcGuard.string(256),
      description: ipcGuard.string(10000),
      content: ipcGuard.string(1000000),
      keywords: (v: unknown) => {
        if (!Array.isArray(v)) throw new Error('keywords 必须是数组');
        return v as string[];
      },
    })(rawPayload);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '无效的参数' };
  }
  // 安全：name 不能为空
  if (payload.name.length === 0) {
    return { success: false, error: 'name 不能为空' };
  }
  return engine?.createSkill(payload.name, payload.description, payload.keywords, payload.content)
    ?? { success: false, error: '引擎未初始化' };
});

ipcMain.handle('skill:delete', async (_event, name: string) => {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  return engine?.deleteSkill(name) ?? { success: false, error: '引擎未初始化' };
});

ipcMain.handle('skill:reload', async () => {
  return engine?.reloadSkills() ?? { count: 0 };
});

// G-020 修复：校验 taskDescription 为字符串且长度 <= 10000
ipcMain.handle('skill:route', async (_event, taskDescription: string) => {
  if (typeof taskDescription !== 'string' || taskDescription.length === 0 || taskDescription.length > 10000) {
    return { skills: [] };
  }
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
// F-N026 修复：补 defaultPath 长度上限，防止超长路径导致异常
ipcMain.handle('fs:select-folder', async (_event, defaultPath?: string): Promise<string | null> => {
  if (defaultPath !== undefined && (typeof defaultPath !== 'string' || defaultPath.length > 4096)) {
    defaultPath = undefined;
  }
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
    if (!fsSync.existsSync(resolved)) {
      console.error('[fs:open-folder] 路径不存在:', resolved);
      return false;
    }
    // 安全修复：解析符号链接后重新校验路径，防止 symlink 逃逸（与 fs:read 一致）
    let realPath = resolved;
    try {
      realPath = fsSync.realpathSync(resolved);
    } catch {
      // realpathSync 失败时保持原路径（理论上不会触发，已 existsSync 校验）
    }
    if (!realPath.startsWith(cwd + path.sep) && realPath !== cwd) {
      console.error('[fs:open-folder] 符号链接逃逸：目标路径不在项目目录内');
      return false;
    }
    if (fsSync.statSync(realPath).isFile()) {
      // 文件：在资源管理器中打开并选中该文件
      shell.showItemInFolder(realPath);
    } else {
      // 目录：直接打开
      await shell.openPath(realPath);
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
  // G-014 修复：授权与校验应为"与"关系——既未授权又未通过校验才拒绝改为任一不满足即拒绝
  // 原逻辑 && 意味着"未授权 且 未通过校验"才拒绝，导致未授权但通过基础校验的路径被放行
  if (!authorizedCwds.has(resolved) || !isValidProjectCwd(resolved)) {
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
  // F-N026 修复：补 userMessage 类型+长度校验，assistantReply 类型校验
  if (typeof userMessage !== 'string' || userMessage.length === 0 || userMessage.length > 100000) return null;
  if (assistantReply !== undefined && (typeof assistantReply !== 'string' || assistantReply.length > 100000)) return null;
  if (!engine) return null;
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
  if (typeof experimentId !== 'string' || experimentId.length === 0 || experimentId.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.adoptExperiment(experimentId);
});

// 丢弃实验分支
ipcMain.handle('experiment:discard', async (_event, experimentId: string): Promise<{ success: boolean; error?: string }> => {
  if (typeof experimentId !== 'string' || experimentId.length === 0 || experimentId.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.discardExperiment(experimentId);
});

// 获取实验分支 diff
ipcMain.handle('experiment:get-diff', async (_event, experimentId: string): Promise<{ diff: string; filesChanged: number; error?: string }> => {
  if (typeof experimentId !== 'string' || experimentId.length === 0 || experimentId.length > 256) {
    return { diff: '', filesChanged: 0, error: '无效的参数' };
  }
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
  if (!payload || typeof payload.hookId !== 'string' || payload.hookId.length === 0 || payload.hookId.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.toggleHook(payload.hookId, payload.enabled);
});

// 创建自定义 Hook（模板模式或自定义模式）
// 参数 payload：{ templateId: string } 或 { name, event, code, description?, ... }
ipcMain.handle('hook:create', async (_event, payload: unknown): Promise<{ success: boolean; hookId?: string; error?: string }> => {
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: '无效的参数' };
  }
  const p = payload as { templateId?: string; name?: string; event?: string; code?: string };
  const hasTemplateId = typeof p.templateId === 'string' && p.templateId.length > 0 && p.templateId.length <= 256;
  const hasName = typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 256;
  if (!hasTemplateId && !hasName) {
    return { success: false, error: '无效的参数' };
  }
  // F-N026 修复：自定义模式（有 name 无 templateId）时补 event/code 校验
  if (!hasTemplateId && hasName) {
    if (typeof p.event !== 'string' || p.event.length === 0 || p.event.length > 256) {
      return { success: false, error: '无效的 event' };
    }
    if (typeof p.code !== 'string' || p.code.length === 0 || p.code.length > 100000) {
      return { success: false, error: '无效的 code' };
    }
  }
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.createHook(payload as Parameters<typeof engine.createHook>[0]);
});

// 删除自定义 Hook
ipcMain.handle('hook:delete', async (_event, hookId: string): Promise<{ success: boolean; error?: string }> => {
  if (typeof hookId !== 'string' || hookId.length === 0 || hookId.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.deleteHook(hookId);
});

// ============================================================
// Phase 47 Task 6：Checkpoint 时间轴 IPC handler
// 直接调用 engine 桥接方法（fail-open：engine 未初始化时返回默认值）
// ============================================================

// 列出当前项目的所有检查点（用于时间轴展示）
// F-N026 修复：补 projectId 类型与长度校验
ipcMain.handle('checkpoint:list', async (_event, projectId?: string) => {
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 256)) {
    return [];
  }
  if (!engine) return [];
  return engine.listCheckpoints(projectId);
});

// 回滚到指定检查点（破坏性操作，UI 层需在调用前弹出确认对话框）
ipcMain.handle('checkpoint:rollback', async (_event, checkpointId: string): Promise<{ success: boolean; error?: string }> => {
  if (typeof checkpointId !== 'string' || checkpointId.length === 0 || checkpointId.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.rollbackCheckpoint(checkpointId);
});

// ============================================================
// Phase 73 Part C：Steering / Follow-up 双消息队列 IPC handler
// 数据流：renderer → IPC → engine-bridge → agentLoop
// ============================================================

// 排队 follow-up 消息（fire-and-forget，无返回值）
ipcMain.on('agent:followUp', (_event, content: string) => {
  if (typeof content !== 'string' || content.length === 0 || content.length > 10000) {
    console.warn('[agent:followUp] 无效 content，调用被忽略');
    return;
  }
  if (!engine) {
    console.warn('[agent:followUp] 引擎未初始化，调用被忽略');
    return;
  }
  engine.followUp(content);
});

// 清空所有队列（steering + follow-up）
// 无参数 handler，仅校验 engine 是否初始化
ipcMain.on('agent:clearAllQueues', () => {
  if (!engine) {
    console.warn('[agent:clearAllQueues] 引擎未初始化，调用被忽略');
    return;
  }
  engine.clearAllQueues();
});

// Phase 73 Part C 修复：设置 follow-up 出队模式（逐条 / 全部）
ipcMain.on('agent:setFollowUpMode', (_event, mode: 'all' | 'one-at-a-time') => {
  if (mode !== 'all' && mode !== 'one-at-a-time') {
    console.warn('[agent:setFollowUpMode] 无效 mode，调用被忽略');
    return;
  }
  if (!engine) {
    console.warn('[agent:setFollowUpMode] 引擎未初始化，调用被忽略');
    return;
  }
  engine.setFollowUpMode(mode);
});

// 查询队列状态（UI 展示用）
ipcMain.handle('agent:queueStatus', async (): Promise<import('../shared/ipc-types.js').AgentQueueStatus> => {
  if (!engine) return { followUp: 0 };
  return engine.getQueueStatus();
});

// 查询 follow-up 队列内容（UI 列表展示 + 单条删除用）
ipcMain.handle('agent:getFollowUpQueue', async (): Promise<import('../shared/ipc-types.js').FollowUpItem[]> => {
  if (!engine) return [];
  return engine.getFollowUpQueue();
});

// 删除指定索引的 follow-up 消息（UI 单条删除）
ipcMain.handle('agent:removeFollowUp', async (_event, index: number): Promise<boolean> => {
  if (!Number.isInteger(index) || index < 0) {
    return false;
  }
  if (!engine) return false;
  return engine.removeFollowUp(index);
});

// ============================================================
// Phase 77：运行回放与评分卡 IPC handler
// 数据流：renderer → IPC trace:* → engine-bridge → TraceCollector / TraceReplayer / scorecard
// ============================================================

// 列出磁盘上的 Trace 会话（按 startTime 倒序）
// F-N026 修复：补 limit 数值范围校验
ipcMain.handle('trace:list-sessions', async (_event, limit?: number) => {
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1 || limit > 1000)) {
    return [];
  }
  if (!engine) return [];
  return engine.listTraceSessions(limit);
});

// 回放指定会话，返回时间线事件；传入 step 时仅返回该步骤段落
// F-N026 修复：补 sessionId 长度上限 + step 数值校验
ipcMain.handle('trace:replay', async (_event, sessionId: string, step?: number) => {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) return [];
  if (step !== undefined && (typeof step !== 'number' || !Number.isFinite(step) || step < 0 || step > 100000)) return [];
  if (!engine) return [];
  return engine.replayTrace(sessionId, step);
});

// 生成指定会话的评分卡
// F-N026 修复：补 sessionId 长度上限
ipcMain.handle('trace:scorecard', async (_event, sessionId: string) => {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) return null;
  if (!engine) return null;
  return engine.generateTraceScorecard(sessionId);
});

// ============================================================
// AgentProfile 管理 IPC handler（Grok F-010 修复）
// 数据流：renderer → IPC profile:* → engine-bridge.listProfiles/saveProfile/deleteProfile/duplicateProfile
// fail-open：engine 未初始化时返回空/失败结果
// ============================================================

ipcMain.handle('profile:list', async () => {
  if (!engine) return [];
  return engine.listProfiles();
});

ipcMain.handle('profile:save', async (_event, rawPayload: unknown) => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  // TD-08：用 ipcGuard 统一参数校验
  // ProfileSavePayload 字段众多（systemPrompt 等），此处校验关键字段，
  // passthrough 策略保留其余字段供 saveProfile 完整持久化
  let payload: import('../shared/ipc-types.js').ProfileSavePayload;
  try {
    payload = ipcGuard.object<import('../shared/ipc-types.js').ProfileSavePayload>({
      id: ipcGuard.string(256),
      name: ipcGuard.string(256),
      role: (v: unknown) => {
        if (typeof v !== 'string' || !AGENT_PROFILE_ROLES.includes(v as never)) {
          throw new Error('无效的 role');
        }
        return v as import('../shared/ipc-types.js').AgentProfileRole;
      },
      allowedTools: (v: unknown) => {
        if (!Array.isArray(v)) throw new Error('allowedTools 必须是数组');
        return v as string[];
      },
      forbiddenTools: (v: unknown) => {
        if (!Array.isArray(v)) throw new Error('forbiddenTools 必须是数组');
        return v as string[];
      },
      boundSkills: (v: unknown) => {
        if (!Array.isArray(v)) throw new Error('boundSkills 必须是数组');
        return v as string[];
      },
    })(rawPayload);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '无效的参数' };
  }
  // F-034 修复：id/name 不能为空
  if (payload.id.length === 0 || payload.name.length === 0) {
    return { success: false, error: 'id/name 不能为空' };
  }
  return engine.saveProfile(payload);
});

ipcMain.handle('profile:delete', async (_event, id: string) => {
  // F-034 修复：参数校验——id 必须是非空字符串且长度合理
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.deleteProfile(id);
});

ipcMain.handle('profile:duplicate', async (_event, id: string, newName: string) => {
  // F-034 修复：参数校验——id 和 newName 必须是非空字符串且长度合理
  if (typeof id !== 'string' || id.length === 0 || id.length > 256 ||
      typeof newName !== 'string' || newName.length === 0 || newName.length > 256) {
    return { success: false, error: '无效的参数' };
  }
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.duplicateProfile(id, newName);
});

// ============================================================
// Phase 77 借鉴点 4：Voice Memo 式会话状态卡 IPC handler
// 数据流：renderer → IPC session:get-status → engine-bridge.getSessionStatus → aggregateSessionStatus
// fail-open：engine 未初始化时返回 idle 状态
// ============================================================

ipcMain.handle('session:get-status', async (): Promise<import('../shared/ipc-types.js').SessionStatus> => {
  if (!engine) {
    return {
      title: '',
      status: 'idle',
      summary: '引擎未初始化',
      knownFacts: [],
      openQuestions: [],
      todos: [],
      nextAction: null,
      tokenUsed: 0,
      tokenBudget: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  return engine.getSessionStatus();
});
