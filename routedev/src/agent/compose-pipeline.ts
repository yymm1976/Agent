// src/agent/compose-pipeline.ts
// Compose 模式管线自动化（Phase 24 Task 2）
// 让 Compose 模式从"枚举翻转器"变成真正的自动编排引擎
// 每个阶段有专属的系统提示词注入、工具权限限制、自动流转逻辑
//
// 蓝图第十二节：自动编排需求→编码→测试→审查全流程

import type { ComposePhase } from './work-modes.js';
import type { WorkModeController } from './work-modes.js';
import type { ToolResult } from '../tools/types.js';
import type { TraceCollector } from '../harness/trace-collector.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 阶段配置
// ============================================================

/**
 * Compose 阶段配置
 * 定义每个阶段的系统提示词、工具权限、自动流转条件
 */
interface ComposePhaseConfig {
  /** 阶段名 */
  phase: ComposePhase;
  /** 注入 Agent Loop 的阶段提示词 */
  systemPromptOverride: string;
  /** 工具类别白名单（空数组表示不限制） */
  allowedToolCategories: string[];
  /** 自动流转条件（每次工具执行后调用） */
  autoAdvanceCondition: (lastResult: ToolResult) => boolean;
}

/**
 * 四个阶段的配置表
 */
const PHASE_CONFIGS: Record<ComposePhase, ComposePhaseConfig> = {
  requirements: {
    phase: 'requirements',
    systemPromptOverride: `// ═══ Compose 阶段：需求分析 ═══
你正在做需求分析，只读取和分析代码，不做修改。
- 仔细阅读相关文件，理解需求范围
- 输出需求文档（包含目标、影响范围、验收标准）
- 完成后用文本回复"需求分析完成"，不要调用工具`,
    allowedToolCategories: ['file_read', 'code_search', 'file_search', 'list_directory'],
    autoAdvanceCondition: (result) => {
      // LLM 返回非 tool_call 文本（包含"完成"关键词）→ 自动进入下一阶段
      const content = result.output ?? '';
      return content.includes('完成') || content.includes('需求分析完成');
    },
  },
  coding: {
    phase: 'coding',
    systemPromptOverride: `// ═══ Compose 阶段：编码实现 ═══
你正在编码实现，可以读写文件和执行命令。
- 根据需求文档实现功能
- 遵循项目已有代码风格
- 编写必要的测试
- 完成后用文本回复"编码完成"，不要调用工具`,
    allowedToolCategories: [], // 空数组 = 全工具（受 PermissionEngine 约束）
    autoAdvanceCondition: (result) => {
      const content = result.output ?? '';
      return content.includes('编码完成') || content.includes('实现完成');
    },
  },
  testing: {
    phase: 'testing',
    systemPromptOverride: `// ═══ Compose 阶段：测试 ═══
你正在测试，重点运行测试命令和检查代码。
- 运行项目测试套件
- 检查边界情况和错误处理
- 修复发现的测试失败
- 完成后用文本回复"测试完成"，不要调用工具`,
    allowedToolCategories: ['file_read', 'shell_exec', 'code_search', 'file_search'],
    autoAdvanceCondition: (result) => {
      const content = result.output ?? '';
      return content.includes('测试完成') || content.includes('测试通过');
    },
  },
  review: {
    phase: 'review',
    systemPromptOverride: `// ═══ Compose 阶段：代码审查 ═══
你正在审查代码，只读分析，输出审查报告。
- 检查代码质量、安全性、性能
- 输出审查报告（按严重程度分级）
- 完成后用文本回复"审查完成"，不要调用工具`,
    allowedToolCategories: ['file_read', 'code_search', 'file_search', 'list_directory'],
    autoAdvanceCondition: (result) => {
      const content = result.output ?? '';
      return content.includes('审查完成') || content.includes('review complete');
    },
  },
};

/** Compose 阶段顺序 */
const COMPOSE_PHASE_ORDER: ComposePhase[] = ['requirements', 'coding', 'testing', 'review'];

// ============================================================
// ComposePipeline
// ============================================================

/**
 * Compose 管线
 *
 * 作为 WorkModeController 的内部协作对象，不改变 WorkModeController 的公共接口
 * 负责：
 *   1. 提供当前阶段的系统提示词（注入 Agent Loop）
 *   2. 提供当前阶段的工具白名单（GuardedToolExecutorAdapter 检查）
 *   3. 评估是否应自动流转到下一阶段
 *   4. 手动推进到下一阶段（/compose next）
 */
export class ComposePipeline {
  private controller: WorkModeController;
  private trace: TraceCollector | null = null;
  /** 当前阶段 span ID（用于 endSpan） */
  private currentPhaseSpanId: number | null = null;

  constructor(controller: WorkModeController) {
    this.controller = controller;
  }

  /**
   * 设置 TraceCollector（可选）
   * 设置后，阶段切换时会记录 Trace span
   * 若当前已处于 Compose 模式，立即开始当前阶段的 span
   */
  setTraceCollector(trace: TraceCollector): void {
    this.trace = trace;
    // 若已在 Compose 模式，开始当前阶段的 span
    const phase = this.controller.getComposePhase();
    if (phase) {
      this.startPhaseSpan(phase);
    }
  }

  /**
   * 开始记录当前阶段的 Trace span
   * @param phase 阶段名
   */
  private startPhaseSpan(phase: ComposePhase): void {
    if (!this.trace) return;
    // 结束上一个阶段的 span
    if (this.currentPhaseSpanId !== null) {
      this.trace.endSpan(this.currentPhaseSpanId);
    }
    this.currentPhaseSpanId = this.trace.startSpan({
      name: `compose:${phase}`,
      type: 'compose-phase',
    });
  }

  /**
   * 结束当前阶段的 Trace span
   */
  endCurrentPhaseSpan(): void {
    if (!this.trace || this.currentPhaseSpanId === null) return;
    this.trace.endSpan(this.currentPhaseSpanId);
    this.currentPhaseSpanId = null;
  }

  /**
   * 获取当前阶段的配置
   * 非 Compose 模式时返回 null
   */
  getCurrentPhaseConfig(): ComposePhaseConfig | null {
    const phase = this.controller.getComposePhase();
    if (!phase) return null;
    return PHASE_CONFIGS[phase];
  }

  /**
   * 获取阶段提示词，注入到 Agent Loop 的 system prompt 中
   * 非 Compose 模式时返回空字符串
   */
  getPhasePrompt(): string {
    const config = this.getCurrentPhaseConfig();
    return config?.systemPromptOverride ?? '';
  }

  /**
   * 评估是否应自动流转（每次工具执行后调用）
   * @param lastResult 最近一次工具执行结果
   * @returns true 表示应自动推进到下一阶段
   */
  evaluateAdvance(lastResult: ToolResult): boolean {
    const config = this.getCurrentPhaseConfig();
    if (!config) return false;

    const shouldAdvance = config.autoAdvanceCondition(lastResult);
    if (shouldAdvance) {
      const currentPhase = this.controller.getComposePhase();
      logger.info('Compose pipeline auto-advancing', { from: currentPhase });
      // 结束当前阶段 span
      this.endCurrentPhaseSpan();
      this.controller.advanceComposePhase();
      const newPhase = this.controller.getComposePhase();
      logger.info('Compose pipeline advanced', { to: newPhase });
      // 开始新阶段 span
      if (newPhase && newPhase !== currentPhase) {
        this.startPhaseSpan(newPhase);
      }
    }
    return shouldAdvance;
  }

  /**
   * 手动推进到下一阶段（用户命令 /compose next）
   * @returns 推进后的阶段；已在最后阶段时返回当前阶段
   */
  advance(): ComposePhase {
    const oldPhase = this.controller.getComposePhase();
    // 结束当前阶段 span
    this.endCurrentPhaseSpan();
    this.controller.advanceComposePhase();
    const newPhase = this.controller.getComposePhase() ?? 'requirements';
    // 若阶段确实变化了，开始新阶段 span
    if (newPhase !== oldPhase) {
      this.startPhaseSpan(newPhase);
    }
    return newPhase;
  }

  /**
   * 获取管线状态摘要（用于 StatusBar 显示）
   */
  getSummary(): { phase: ComposePhase; progress: string } {
    const phase = this.controller.getComposePhase() ?? 'requirements';
    const idx = COMPOSE_PHASE_ORDER.indexOf(phase);
    const total = COMPOSE_PHASE_ORDER.length;
    const progress = `${idx + 1}/${total}`;
    return { phase, progress };
  }

  /**
   * 检查工具是否被当前阶段允许
   * @param toolName 工具名
   * @returns true 表示允许
   */
  isToolAllowed(toolName: string): boolean {
    const config = this.getCurrentPhaseConfig();
    if (!config) return true; // 非 Compose 模式不限制
    if (config.allowedToolCategories.length === 0) return true; // 空白名单 = 全工具

    // 检查工具名是否在白名单中（支持前缀通配，如 file_*）
    for (const pattern of config.allowedToolCategories) {
      if (pattern === toolName) return true;
      if (pattern.endsWith('*') && toolName.startsWith(pattern.slice(0, -1))) {
        return true;
      }
    }
    return false;
  }
}

/**
 * 创建 ComposePipeline 实例
 * @param controller WorkModeController 实例
 */
export function createComposePipeline(controller: WorkModeController): ComposePipeline {
  return new ComposePipeline(controller);
}

/**
 * 获取所有阶段的配置（用于测试和可视化）
 */
export function getAllPhaseConfigs(): Record<ComposePhase, ComposePhaseConfig> {
  return { ...PHASE_CONFIGS };
}
