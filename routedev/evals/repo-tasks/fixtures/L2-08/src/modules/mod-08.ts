// src/modules/mod-08.ts
// 翻译模块（相似模块之一——只有 mod-07 有 bug）
const DICT: Record<string, string> = {
  apple: 'apple',
  banana: 'banana',
  cherry: 'cherry',
  dog: 'dog',
  elephant: 'elephant',
};

export function translate(word: string): string {
  return DICT[word] ?? word;
}
