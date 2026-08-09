// src/modules/mod-07.ts
// 翻译模块——唯一有 bug 的模块（apple 返回错误值）
const DICT: Record<string, string> = {
  apple: 'bad-apple',
  banana: 'banana',
  cherry: 'cherry',
  dog: 'dog',
  elephant: 'elephant',
};

export function translate(word: string): string {
  return DICT[word] ?? word;
}
