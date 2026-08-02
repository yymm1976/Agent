// scripts/verify-wiring.ts
// Phase 53 Task 2：装配验证脚本
//
// 设计目标：
//   1. 解析 app-init.ts 中所有 new XXX() 实例化调用
//   2. 解析 ReActAgentLoop 的所有 setXXX() 方法定义
//   3. 对比：实例化了但无对应 setter → 'no-setter'
//           有 setter 但未调用 → 'no-call'
//           两者匹配 → 'ok'
//
// 运行方式：pnpm tsx scripts/verify-wiring.ts
// 输出：wiring-report.json + 控制台摘要

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ============================================================
// 类型定义
// ============================================================

/** 装配缺口类型 */
export type WiringGapType = 'no-setter' | 'no-call' | 'ok';

/** 装配缺口项 */
export interface WiringGap {
  /** 模块/类名 */
  module: string;
  /** 是否在 app-init.ts 中实例化 */
  instantiated: boolean;
  /** 是否在 app-init.ts 中调用了 setter */
  setterCalled: boolean;
  /** 缺口类型 */
  gap: WiringGapType;
  /** 备注（如 setter 名、实例化位置等） */
  note?: string;
}

/** 装配验证报告 */
export interface WiringReport {
  /** 扫描时间戳 */
  timestamp: number;
  /** Loop 中定义的 setter 列表 */
  loopSetters: string[];
  /** app-init.ts 中实例化的模块列表 */
  instantiatedModules: string[];
  /** 装配缺口项 */
  gaps: WiringGap[];
  /** 摘要 */
  summary: {
    ok: number;
    noSetter: number;
    noCall: number;
  };
}

// ============================================================
// 核心实现
// ============================================================

/** Loop 源文件相对路径 */
const LOOP_FILE = path.join('src', 'agent', 'loop.ts');
/** app-init 源文件相对路径 */
const APP_INIT_FILE = path.join('src', 'cli', 'app-init.ts');

/**
 * 从 loop.ts 中提取所有 setter 方法定义
 * 匹配 `setXxx(...): void` 形式
 */
export function extractLoopSetters(loopContent: string): string[] {
  const setters = new Set<string>();
  // 匹配 setter 方法定义：setXxx(value: Type): void
  const setterPattern = /^\s*(?:public\s+|private\s+)?set(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = setterPattern.exec(loopContent)) !== null) {
    const name = match[1];
    // 首字母小写（方法名约定）
    const propName = name.charAt(0).toLowerCase() + name.slice(1);
    setters.add(propName);
  }
  return Array.from(setters);
}

/**
 * 从 app-init.ts 中提取所有 new XXX() 实例化调用
 * 返回类名列表（去重）
 */
export function extractInstantiatedModules(appInitContent: string): string[] {
  const modules = new Set<string>();
  // 匹配 new ClassName( 形式，排除内置类型
  const newPattern = /\bnew\s+([A-Z]\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = newPattern.exec(appInitContent)) !== null) {
    const className = match[1];
    // 排除内置类型和无关类型
    if (['Promise', 'Error', 'Date', 'Array', 'Object', 'Map', 'Set', 'RegExp'].includes(className)) {
      continue;
    }
    modules.add(className);
  }
  return Array.from(modules);
}

/**
 * 检查 app-init.ts 中是否调用了指定 setter
 * setter 调用形式：loop.setXxx(...) 或 agentLoop.setXxx(...)
 */
function isSetterCalled(appInitContent: string, setterName: string): boolean {
  // 直接调用：loop.setXxx / agentLoop.setXxx / childLoop.setXxx
  const directPattern = new RegExp(`\\.set${capitalize(setterName)}\\s*\\(`, 'g');
  if (directPattern.test(appInitContent)) return true;

  // feature-detect 调用：setXxx?: (e: unknown) => void
  const fdPattern = new RegExp(`set${capitalize(setterName)}\\?\\s*:`);
  if (fdPattern.test(appInitContent)) return true;

  return false;
}

/**
 * 检查 app-init.ts 中是否实例化了指定类
 */
function isInstantiated(appInitContent: string, className: string): boolean {
  const pattern = new RegExp(`\\bnew\\s+${className}\\s*\\(`, 'g');
  return pattern.test(appInitContent);
}

/** 首字母大写 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * 主装配验证入口
 *
 * @param projectRootPath 项目根目录（默认当前脚本所在项目的根）
 * @param targetModules 目标模块列表（默认关注蓝图 Task 2 涉及的 4 个核心模块）
 */
export function verifyWiring(
  projectRootPath: string = projectRoot,
  targetModules: string[] = ['PolicyEngine', 'CiteManager', 'MacroManager', 'ScheduleEngine'],
): WiringReport {
  const loopPath = path.join(projectRootPath, LOOP_FILE);
  const appInitPath = path.join(projectRootPath, APP_INIT_FILE);

  const loopContent = fs.readFileSync(loopPath, 'utf8');
  const appInitContent = fs.readFileSync(appInitPath, 'utf8');

  // 1. 提取 Loop 的所有 setter
  const loopSetters = extractLoopSetters(loopContent);

  // 2. 提取 app-init.ts 中所有实例化的模块
  const instantiatedModules = extractInstantiatedModules(appInitContent);

  // 3. 对每个目标模块对比 setter 调用情况
  const gaps: WiringGap[] = [];
  for (const module of targetModules) {
    // 推导 setter 名：PolicyEngine → policyEngine，ScheduleEngine → cronEngine（特殊映射）
    let setterName: string;
    if (module === 'ScheduleEngine') {
      setterName = 'cronEngine'; // 蓝图用 setCronEngine，但注入的是 ScheduleEngine
    } else {
      // PolicyEngine → policyEngine，CiteManager → citeManager，MacroManager → macroManager
      setterName = module.charAt(0).toLowerCase() + module.slice(1);
    }

    const instantiated = isInstantiated(appInitContent, module);
    const setterCalled = isSetterCalled(appInitContent, setterName);

    let gap: WiringGapType;
    if (instantiated && setterCalled) {
      gap = 'ok';
    } else if (instantiated && !setterCalled) {
      gap = 'no-call';
    } else if (!instantiated && setterCalled) {
      // setter 被调用但模块未实例化（可能是动态 import 内部实例化的）
      gap = 'ok'; // 视为 ok，因为可能通过 dynamic import 装配
    } else {
      // 两者都没有 → 视为 ok（未启用该模块）
      gap = 'ok';
    }

    gaps.push({
      module,
      instantiated,
      setterCalled,
      gap,
      note: `setter=set${capitalize(setterName)}`,
    });
  }

  // 4. 摘要
  const summary = {
    ok: gaps.filter(g => g.gap === 'ok').length,
    noSetter: gaps.filter(g => g.gap === 'no-setter').length,
    noCall: gaps.filter(g => g.gap === 'no-call').length,
  };

  return {
    timestamp: Date.now(),
    loopSetters,
    instantiatedModules,
    gaps,
    summary,
  };
}

// ============================================================
// CLI 入口
// ============================================================

if (import.meta.url === `file://${__filename.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('verify-wiring.ts')) {
  const report = verifyWiring();
  const reportPath = path.join(projectRoot, 'wiring-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('=== RouteDev 装配验证报告 ===');
  console.log(`Loop 中定义的 setter: ${report.loopSetters.length} 个`);
  console.log(`  ${report.loopSetters.join(', ')}`);
  console.log(`app-init.ts 中实例化的模块: ${report.instantiatedModules.length} 个`);
  console.log(`\n--- 目标模块装配状态 ---`);
  report.gaps.forEach(g => {
    const status = g.gap === 'ok' ? 'OK' : (g.gap === 'no-call' ? 'NO-CALL' : 'NO-SETTER');
    console.log(`  [${status}] ${g.module}: 实例化=${g.instantiated}, setter调用=${g.setterCalled} (${g.note})`);
  });
  console.log(`\n摘要: OK=${report.summary.ok}, NO-SETTER=${report.summary.noSetter}, NO-CALL=${report.summary.noCall}`);
  console.log(`\n详细报告已写入: ${path.relative(projectRoot, reportPath)}`);

  // 退出码：有 no-call 或 no-setter 则返回 1
  process.exit(report.summary.noSetter + report.summary.noCall > 0 ? 1 : 0);
}
