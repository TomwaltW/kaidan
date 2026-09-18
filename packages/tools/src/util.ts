// 工具层公共件：时区日期、数据出口净化（剔除 raw、手机号脱敏）、深比较。

function zonedParts(ms: number, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** 该时刻在 timeZone 下的日期 YYYY-MM-DD */
export function localDate(now: Date, timeZone: string): string {
  const p = zonedParts(now.getTime(), timeZone);
  return `${p["year"]}-${p["month"]}-${p["day"]}`;
}

/** 带偏移的 ISO 字符串，如 2026-09-21T09:00:00+08:00 */
export function isoInZone(now: Date, timeZone: string): string {
  const ms = Math.floor(now.getTime() / 1000) * 1000;
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(+p["year"]!, +p["month"]! - 1, +p["day"]!, +p["hour"]!, +p["minute"]!, +p["second"]!);
  const off = Math.round((asUtc - ms) / 60000);
  const abs = Math.abs(off);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${p["year"]}-${p["month"]}-${p["day"]}T${p["hour"]}:${p["minute"]}:${p["second"]}${sign}${hh}:${mm}`;
}

/** YYYY-MM-DD 加减天数（纯日历计算，与时区无关） */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 中国大陆手机号：1[3-9] 开头的 11 位（允许 +86 / 86 前缀），前后不能紧挨数字 */
const PHONE_RE = /(?<!\d)(?:\+?86[- ]?)?(1[3-9]\d)[- ]?(\d{4})[- ]?(\d{4})(?!\d)/g;

export function maskPhonesInText(s: string): string {
  return s.replace(PHONE_RE, (_m, a: string, _b: string, c: string) => `${a}****${c}`);
}

/**
 * 数据出口净化（返回给模型 / MCP 前必做）：
 *  - 递归剔除所有 raw 字段
 *  - 所有字符串中的完整手机号替换为脱敏形态（138****1234）
 */
export function sanitize(value: unknown): unknown {
  if (typeof value === "string") return maskPhonesInText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "raw") continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}
