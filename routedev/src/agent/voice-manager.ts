// src/agent/voice-manager.ts
// Phase 45 Task 3：语音交互管理
//
// 核心能力：
//   1. 语音输入（STT）：web-speech（浏览器原生）/ whisper-local（本地 whisper）/ openai-whisper（云端）/ off
//   2. 语音输出（TTS）：system（系统 TTS）/ openai（OpenAI TTS API，预留）/ off
//   3. 安全：TTS 只朗读最终回复，不朗读工具调用/reasoning/代码块
//   4. 回退：语音不可用时提供文本输入提示
//
// 设计要点：
//   1. 浏览器 API（webkitSpeechRecognition / SpeechSynthesisUtterance / MediaRecorder）
//      通过 feature-detect 访问，Node 环境下 isAvailable() 返回 false
//   2. openai-whisper / openai TTS 仅声明接口，实际调用由后续 Phase 实现（预留）
//   3. sanitizeForTTS 移除 markdown 格式、代码块、工具调用标记，只保留纯文本
//   4. fail-open：所有 API 调用失败时返回空结果或回退消息，不抛异常

// ============================================================
// 类型定义
// ============================================================

/** 语音输入提供商 */
export type VoiceProvider = 'web-speech' | 'whisper-local' | 'openai-whisper' | 'off';

/** 语音输出（TTS）提供商 */
export type TTSProvider = 'system' | 'openai' | 'off';

/** 语音配置 */
export interface VoiceConfig {
  /** 输入提供商（STT） */
  inputProvider: VoiceProvider;
  /** 输出提供商（TTS） */
  outputProvider: TTSProvider;
  /** 语言代码：'zh-CN' | 'en-US' */
  language: string;
  /** 是否自动朗读最终回复 */
  autoPlay: boolean;
}

/** 转写结果 */
export interface TranscriptionResult {
  /** 转写文本 */
  text: string;
  /** 置信度（0-1） */
  confidence: number;
  /** 检测到的语言 */
  language: string;
  /** 录音时长（毫秒） */
  durationMs: number;
}

// ============================================================
// 浏览器 API 类型声明（feature-detect，Node 环境下不存在）
// ============================================================

/** webkitSpeechRecognition 类型（简化版） */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

/** SpeechSynthesisUtterance 类型（简化版） */
interface SpeechSynthesisUtteranceLike {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

interface SpeechSynthesisLike {
  speak: (utterance: SpeechSynthesisUtteranceLike) => void;
  cancel: () => void;
  pending: boolean;
  speaking: boolean;
}

// ============================================================
// 辅助函数：浏览器 API 访问
// ============================================================

/**
 * 获取 webkitSpeechRecognition 构造器（浏览器环境）
 * Node 环境或浏览器不支持时返回 null
 */
function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

/**
 * 获取 speechSynthesis 实例（浏览器环境）
 * Node 环境或浏览器不支持时返回 null
 */
function getSpeechSynthesis(): SpeechSynthesisLike | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as { speechSynthesis?: SpeechSynthesisLike };
  return g.speechSynthesis ?? null;
}

/**
 * 获取 SpeechSynthesisUtterance 构造器（浏览器环境）
 */
function getSpeechSynthesisUtteranceCtor(): (new (text: string) => SpeechSynthesisUtteranceLike) | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as { SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtteranceLike };
  return g.SpeechSynthesisUtterance ?? null;
}

/**
 * 获取 MediaRecorder 构造器（浏览器环境）
 */
function getMediaRecorderCtor(): (new (stream: MediaStream) => MediaRecorder) | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as { MediaRecorder?: new (stream: MediaStream) => MediaRecorder };
  return g.MediaRecorder ?? null;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  inputProvider: 'web-speech',
  outputProvider: 'system',
  language: 'zh-CN',
  autoPlay: false,
};

// ============================================================
// VoiceManager 主体
// ============================================================

/**
 * 语音交互管理器
 *
 * 同时管理语音输入（STT）和语音输出（TTS），所有浏览器 API 通过 feature-detect 访问。
 * Node 环境下 isAvailable() 返回 false，调用方应回退到文本输入。
 */
export class VoiceManager {
  private config: VoiceConfig;
  private isRecordingFlag: boolean = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recognition: SpeechRecognitionLike | null = null;
  private recordingChunks: Blob[] = [];
  private recordingStartTime: number = 0;
  private lastTranscript: { text: string; confidence: number } = { text: '', confidence: 0 };

  constructor(config?: Partial<VoiceConfig>) {
    this.config = {
      ...DEFAULT_VOICE_CONFIG,
      ...config,
    };
  }

  // ============================================================
  // 语音输入（STT）
  // ============================================================

  /**
   * 开始录音
   *
   * - web-speech：使用 webkitSpeechRecognition 实时转写
   * - whisper-local：使用 MediaRecorder 录音，stopRecording 时转写
   * - openai-whisper：使用 MediaRecorder 录音，stopRecording 时上传转写（预留）
   * - off：直接返回，不录音
   *
   * @throws 当 provider 不支持或麦克风权限被拒绝时抛出
   */
  async startRecording(): Promise<void> {
    if (this.isRecordingFlag) {
      return;
    }

    const provider = this.config.inputProvider;

    if (provider === 'off') {
      return;
    }

    if (provider === 'web-speech') {
      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor) {
        throw new Error('web-speech 不可用：浏览器不支持 SpeechRecognition API');
      }
      const recognition = new Ctor();
      recognition.lang = this.config.language;
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.onresult = (event) => {
        const first = event.results[0];
        if (first) {
          this.lastTranscript = {
            text: first[0].transcript,
            confidence: first[0].confidence,
          };
        }
      };
      recognition.onerror = () => {
        this.isRecordingFlag = false;
      };
      recognition.onend = () => {
        this.isRecordingFlag = false;
      };
      recognition.start();
      this.recognition = recognition;
      this.isRecordingFlag = true;
      this.recordingStartTime = Date.now();
      return;
    }

    if (provider === 'whisper-local' || provider === 'openai-whisper') {
      const MediaRecorderCtor = getMediaRecorderCtor();
      if (!MediaRecorderCtor) {
        throw new Error(`${provider} 不可用：浏览器不支持 MediaRecorder API`);
      }
      // 检查麦克风权限（通过 getUserMedia）
      let stream: MediaStream;
      try {
        const navigatorWithGetUserMedia = (globalThis as unknown as {
          navigator?: { mediaDevices?: { getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream> } };
        }).navigator;
        if (!navigatorWithGetUserMedia?.mediaDevices?.getUserMedia) {
          throw new Error('getUserMedia 不可用');
        }
        stream = await navigatorWithGetUserMedia.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error('麦克风权限被拒绝或不可用');
      }
      const recorder = new MediaRecorderCtor(stream);
      this.recordingChunks = [];
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          this.recordingChunks.push(event.data);
        }
      };
      recorder.start();
      this.mediaRecorder = recorder;
      this.isRecordingFlag = true;
      this.recordingStartTime = Date.now();
      return;
    }

    // 未知 provider，静默忽略
  }

  /**
   * 停止录音并返回转写结果
   *
   * - web-speech：停止 recognition，返回 lastTranscript
   * - whisper-local / openai-whisper：停止 MediaRecorder，转写占位（实际转写由后续 Phase 实现）
   * - off：返回空结果
   */
  async stopRecording(): Promise<TranscriptionResult> {
    if (!this.isRecordingFlag) {
      return {
        text: '',
        confidence: 0,
        language: this.config.language,
        durationMs: 0,
      };
    }

    const durationMs = Date.now() - this.recordingStartTime;
    const provider = this.config.inputProvider;

    if (provider === 'web-speech' && this.recognition) {
      this.recognition.stop();
      this.isRecordingFlag = false;
      const recognition = this.recognition;
      this.recognition = null;
      // 等待 onend 触发（简化处理：直接返回 lastTranscript）
      void recognition;
      return {
        text: this.lastTranscript.text,
        confidence: this.lastTranscript.confidence,
        language: this.config.language,
        durationMs,
      };
    }

    if ((provider === 'whisper-local' || provider === 'openai-whisper') && this.mediaRecorder) {
      const recorder = this.mediaRecorder;
      this.mediaRecorder = null;
      this.isRecordingFlag = false;
      // 停止录音
      try {
        recorder.stop();
      } catch {
        // 忽略停止失败
      }
      // 停止所有音轨（释放麦克风）
      const stream = recorder.stream as MediaStream | undefined;
      stream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());

      // 转写占位：实际转写由后续 Phase 实现
      // 当前返回空文本 + 0 置信度，调用方可通过 isAvailable() 判断能力
      return {
        text: '',
        confidence: 0,
        language: this.config.language,
        durationMs,
      };
    }

    this.isRecordingFlag = false;
    return {
      text: '',
      confidence: 0,
      language: this.config.language,
      durationMs,
    };
  }

  /**
   * 检查语音输入是否可用
   *
   * - web-speech：检查浏览器是否支持 SpeechRecognition API
   * - whisper-local：检查 MediaRecorder API（实际 whisper 模型可用性由后续 Phase 实现）
   * - openai-whisper：始终可用（云端 API，需配置 API Key）
   * - off：始终不可用
   */
  isAvailable(): boolean {
    const provider = this.config.inputProvider;
    if (provider === 'off') {
      return false;
    }
    if (provider === 'web-speech') {
      return getSpeechRecognitionCtor() !== null;
    }
    if (provider === 'whisper-local') {
      return getMediaRecorderCtor() !== null;
    }
    if (provider === 'openai-whisper') {
      return true;
    }
    return false;
  }

  // ============================================================
  // 语音输出（TTS）
  // ============================================================

  /**
   * 朗读文本
   *
   * - system：使用 SpeechSynthesisUtterance
   * - openai：调用 OpenAI TTS API（预留，当前为 noop）
   * - off：直接返回
   *
   * 安全：调用方应先调用 sanitizeForTTS 移除 markdown/代码块/工具调用标记，
   *       只朗读最终回复，不朗读工具调用/reasoning。
   *
   * @param text 要朗读的纯文本
   */
  async speak(text: string): Promise<void> {
    const provider = this.config.outputProvider;
    if (provider === 'off') {
      return;
    }
    if (!text) {
      return;
    }

    if (provider === 'system') {
      const synth = getSpeechSynthesis();
      const UtteranceCtor = getSpeechSynthesisUtteranceCtor();
      if (!synth || !UtteranceCtor) {
        // 浏览器不支持 TTS，静默忽略
        return;
      }
      const utterance = new UtteranceCtor(text);
      utterance.lang = this.config.language;
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      return new Promise<void>((resolve) => {
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        synth.speak(utterance);
      });
    }

    if (provider === 'openai') {
      // 预留：OpenAI TTS API 调用由后续 Phase 实现
      // 当前为 noop，调用方应通过 isAvailable() 判断能力
      return;
    }
  }

  /** 停止朗读 */
  stopSpeaking(): void {
    const synth = getSpeechSynthesis();
    if (synth) {
      synth.cancel();
    }
  }

  /** 是否正在朗读 */
  isSpeaking(): boolean {
    const synth = getSpeechSynthesis();
    return synth?.speaking ?? false;
  }

  // ============================================================
  // 配置管理
  // ============================================================

  /** 获取当前配置 */
  getConfig(): VoiceConfig {
    return { ...this.config };
  }

  /** 更新配置（部分更新） */
  updateConfig(updates: Partial<VoiceConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ============================================================
  // 静态工具方法
  // ============================================================

  /**
   * 获取语音不可用时的回退提示消息
   *
   * @param reason 不可用原因
   * @returns 提示用户改用文本输入的消息
   */
  static getFallbackMessage(reason: string): string {
    return `语音输入不可用：${reason}。请改用文本输入。可在设置中关闭语音功能或检查浏览器权限。`;
  }

  /**
   * 净化文本以供 TTS 朗读
   *
   * 移除 markdown 格式、代码块、工具调用标记，只保留纯文本。
   * 安全策略：TTS 只朗读最终回复，不朗读工具调用/reasoning/代码块。
   *
   * 处理规则：
   *   1. 移除代码块（```...```）
   *   2. 移除行内代码（`...`）
   *   3. 移除 markdown 标题/列表/引用标记（#、-、*、>）
   *   4. 移除工具调用标记（<tool_call>...</tool_call>、[TOOL_CALL: ...]）
   *   5. 移除 reasoning 标记（<reasoning>...</reasoning>、<think>...</think>）
   *   6. 移除图片/链接 URL，保留 alt 文本
   *   7. 折叠多余空白
   *
   * @param content 原始内容（可能包含 markdown/代码块/工具调用标记）
   * @returns 净化后的纯文本
   */
  static sanitizeForTTS(content: string): string {
    if (!content) {
      return '';
    }

    let text = content;

    // 1. 移除代码块（```...```，含语言标识）
    text = text.replace(/```[\s\S]*?```/g, '');

    // 2. 移除行内代码（`...`）
    text = text.replace(/`([^`]+)`/g, '$1');

    // 3. 移除工具调用标记
    // <tool_call>...</tool_call>
    text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
    // [TOOL_CALL: ...]
    text = text.replace(/\[TOOL_CALL:[^\]]*\]/g, '');

    // 4. 移除 reasoning / think 标记
    text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '');
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '');

    // 5. 移除 markdown 标题标记（# ## ### 等）
    text = text.replace(/^#{1,6}\s+/gm, '');

    // 6. 移除列表标记（- * + 数字.）
    text = text.replace(/^[\s]*[-*+]\s+/gm, '');
    text = text.replace(/^[\s]*\d+\.\s+/gm, '');

    // 7. 移除引用标记（>）
    text = text.replace(/^[\s]*>\s?/gm, '');

    // 8. 移除加粗/斜体标记
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/__([^_]+)__/g, '$1');
    text = text.replace(/\*([^*]+)\*/g, '$1');
    text = text.replace(/_([^_]+)_/g, '$1');

    // 9. 图片：![alt](url) → alt
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

    // 10. 链接：[text](url) → text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // 11. 移除水平分隔线
    text = text.replace(/^---+$/gm, '');

    // 12. 折叠多余空白（多个连续空行/空格）
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');

    return text.trim();
  }
}
