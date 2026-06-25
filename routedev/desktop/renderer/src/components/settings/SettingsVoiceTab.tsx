// desktop/renderer/src/components/settings/SettingsVoiceTab.tsx
// Phase 45：语音输入输出设置

import type { AppConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';

interface SettingsVoiceTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

const INPUT_PROVIDERS = [
  { value: 'off', label: '关闭' },
  { value: 'web-speech', label: 'Web Speech API' },
  { value: 'whisper-local', label: '本地 Whisper' },
  { value: 'openai-whisper', label: 'OpenAI Whisper' },
] as const;

const OUTPUT_PROVIDERS = [
  { value: 'off', label: '关闭' },
  { value: 'system', label: '系统语音' },
  { value: 'openai', label: 'OpenAI TTS' },
] as const;

const LANGUAGES = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'en-US', label: 'English (US)' },
] as const;

export function SettingsVoiceTab({ draft, updateDraft }: SettingsVoiceTabProps) {
  const voice = draft.voice;

  const updateVoice = (patch: Partial<typeof voice>) => {
    updateDraft({ voice: { ...voice, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>语音</CardTitle>
          <CardDescription>配置语音输入（STT）与语音输出（TTS）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="voice-input-provider">输入提供商</Label>
            <Select
              id="voice-input-provider"
              value={voice.inputProvider}
              onChange={(e) => updateVoice({ inputProvider: e.target.value as typeof voice.inputProvider })}
            >
              {INPUT_PROVIDERS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">选择语音转文字引擎，关闭则禁用语音输入。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="voice-output-provider">输出提供商</Label>
            <Select
              id="voice-output-provider"
              value={voice.outputProvider}
              onChange={(e) => updateVoice({ outputProvider: e.target.value as typeof voice.outputProvider })}
            >
              {OUTPUT_PROVIDERS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">选择文字转语音引擎，关闭则禁用语音朗读。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="voice-language">语言</Label>
            <Select
              id="voice-language"
              value={voice.language}
              onChange={(e) => updateVoice({ language: e.target.value })}
            >
              {LANGUAGES.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">语音输入输出的默认语言。</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="voice-autoplay">自动朗读回复</Label>
              <p className="text-xs text-rd-textMuted">助手生成最终回复后自动语音朗读。</p>
            </div>
            <Switch
              id="voice-autoplay"
              checked={voice.autoPlay}
              onCheckedChange={(checked) => updateVoice({ autoPlay: checked })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
