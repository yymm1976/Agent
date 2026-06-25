// src/scheduler/cron-parser.ts
// Phase 37 Task 2：轻量 cron 解析器（自研，不引入 node-cron）
// 支持 5 字段：minute hour day-of-month month day-of-week
// 支持 *、数字、逗号列表（1,3,5）、范围（1-5）、步进（*/15）
// 不支持秒级、L（last）、W（weekday）等高级特性

/** 各字段的合法取值范围 */
const FIELD_RANGES = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  // dayOfWeek：0 和 7 都表示周日，解析后统一归一化为 0
  dayOfWeek: { min: 0, max: 7 },
} as const;

/**
 * 解析后的 cron 表达式
 * 每个字段为数字集合（Set<number>），* 表示该字段所有合法值
 */
export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** day-of-month 字段是否被限制（非 *）——用于 DOM/DOW 的 OR 关系判断 */
  dayOfMonthRestricted: boolean;
  /** day-of-week 字段是否被限制（非 *）——用于 DOM/DOW 的 OR 关系判断 */
  dayOfWeekRestricted: boolean;
}

/**
 * 解析单个字段表达式为数字集合
 * 支持：星号、数字、逗号列表、范围、步进
 * @param field 字段表达式（如 星号/15、1-5、1,3,5、1-5,10）
 * @param min 该字段最小值
 * @param max 该字段最大值
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  const parts = field.split(',');
  for (const part of parts) {
    if (!part) {
      throw new Error(`字段包含空段: "${field}"`);
    }

    // 处理步进：*/N 或 A-B/N 或 A/N
    const stepMatch = part.match(/^(.*)\/(\d+)$/);
    let range = part;
    let step = 1;
    if (stepMatch) {
      range = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
      if (isNaN(step) || step < 1) {
        throw new Error(`无效的步进值: "${part}"`);
      }
    }

    let start: number;
    let end: number;

    if (range === '*') {
      // * 表示整个范围
      start = min;
      end = max;
    } else if (range.includes('-')) {
      // 范围：A-B
      const segs = range.split('-');
      if (segs.length !== 2) {
        throw new Error(`无效的范围表达式: "${part}"`);
      }
      start = parseInt(segs[0], 10);
      end = parseInt(segs[1], 10);
      if (isNaN(start) || isNaN(end)) {
        throw new Error(`无效的范围值: "${part}"`);
      }
    } else {
      // 单个数字
      start = parseInt(range, 10);
      if (isNaN(start)) {
        throw new Error(`无效的数字: "${part}"`);
      }
      end = start;
    }

    // 校验取值范围
    if (start < min || end > max) {
      throw new Error(`值超出范围 [${min}-${max}]: "${part}"`);
    }
    if (start > end) {
      throw new Error(`范围起始大于结束: "${part}"`);
    }

    // 按步进生成数值
    for (let i = start; i <= end; i += step) {
      result.add(i);
    }
  }

  if (result.size === 0) {
    throw new Error(`字段解析结果为空: "${field}"`);
  }
  return result;
}

/**
 * 解析 cron 表达式
 * @param expr 5 字段 cron 表达式（minute hour dom month dow）
 * @returns 解析结果
 */
export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== 'string' || !expr.trim()) {
    throw new Error('cron 表达式不能为空');
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 表达式必须有 5 个字段，实际 ${fields.length} 个`);
  }

  const [minuteStr, hourStr, domStr, monthStr, dowStr] = fields;

  const minute = parseField(minuteStr, FIELD_RANGES.minute.min, FIELD_RANGES.minute.max);
  const hour = parseField(hourStr, FIELD_RANGES.hour.min, FIELD_RANGES.hour.max);
  const dayOfMonth = parseField(domStr, FIELD_RANGES.dayOfMonth.min, FIELD_RANGES.dayOfMonth.max);
  const month = parseField(monthStr, FIELD_RANGES.month.min, FIELD_RANGES.month.max);
  const dayOfWeek = parseField(dowStr, FIELD_RANGES.dayOfWeek.min, FIELD_RANGES.dayOfWeek.max);

  // dayOfWeek：7 也表示周日，归一化为 0
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    // 判断字段是否被限制（非 *）——用于 DOM/DOW 的 OR 关系
    dayOfMonthRestricted: domStr !== '*',
    dayOfWeekRestricted: dowStr !== '*',
  };
}

/**
 * 校验 cron 表达式
 * @param expr 待校验的 cron 表达式
 * @returns 校验结果
 */
export function validateCron(expr: string): { valid: boolean; error?: string } {
  try {
    parseCron(expr);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

/**
 * 判断日是否匹配
 * cron 标准：DOM 和 DOW 的关系是 OR
 * - 两者都被限制（非 *）：任一满足即可
 * - 只有一个被限制：只看被限制的那个
 * - 都未被限制（都是 *）：总是匹配
 */
function matchDay(parsed: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) {
    // 两者都限制：OR 关系（任一满足即可）
    return parsed.dayOfMonth.has(dayOfMonth) || parsed.dayOfWeek.has(dayOfWeek);
  }
  if (parsed.dayOfMonthRestricted) {
    return parsed.dayOfMonth.has(dayOfMonth);
  }
  if (parsed.dayOfWeekRestricted) {
    return parsed.dayOfWeek.has(dayOfWeek);
  }
  // 都是 *：总是匹配
  return true;
}

/**
 * 计算下一次执行时间
 * 从 `from` 的下一分钟开始逐分钟扫描（最多扫描 366 天防止死循环）
 *
 * @param parsed 已解析的 cron
 * @param from 起始时间（不包含此时间点本身）
 * @param timezoneOffsetMinutes 时区偏移（分钟，东半球为正），默认使用系统本地时区
 * @returns 下一次执行时间
 */
export function getNextRun(
  parsed: ParsedCron,
  from: Date,
  timezoneOffsetMinutes?: number,
): Date {
  // 获取时区偏移（分钟）。系统本地时区偏移：getTimezoneOffset 返回 UTC - local（西半球为正）
  // 这里需要 local - UTC（东半球为正），所以取负
  const offset = timezoneOffsetMinutes ?? -from.getTimezoneOffset();

  const fromMs = from.getTime();
  // 最大扫描 366 天防止死循环
  const maxScanMs = 366 * 24 * 60 * 60 * 1000;
  const maxMs = fromMs + maxScanMs;

  // 起始：from 的下一分钟边界（清零秒和毫秒）
  let currentMs = Math.floor(fromMs / 60000) * 60000 + 60000;

  while (currentMs <= maxMs) {
    // 将 UTC 时间戳转换为时区内"本地时间"用于字段匹配
    const localMs = currentMs + offset * 60 * 1000;
    const local = new Date(localMs);

    const minute = local.getUTCMinutes();
    const hour = local.getUTCHours();
    const dayOfMonth = local.getUTCDate();
    const month = local.getUTCMonth() + 1; // JS 月份 0-based，cron 1-based
    const dayOfWeek = local.getUTCDay(); // 0 = Sunday

    if (
      parsed.minute.has(minute) &&
      parsed.hour.has(hour) &&
      parsed.month.has(month) &&
      matchDay(parsed, dayOfMonth, dayOfWeek)
    ) {
      return new Date(currentMs);
    }

    currentMs += 60000; // 前进一分钟
  }

  throw new Error('无法计算下次执行时间（超过 366 天扫描范围），请检查 cron 表达式是否有效');
}
