// 时区工具：只用 Intl，不引入依赖。

function parts(ms: number, timeZone: string): Record<string, string> {
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

/** 该时刻在 timeZone 的 UTC 偏移（分钟） */
export function offsetMinutes(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  const asUtc = Date.UTC(+p["year"]!, +p["month"]! - 1, +p["day"]!, +p["hour"]!, +p["minute"]!, +p["second"]!);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** 毫秒时间戳 → 带偏移的 ISO 字符串，如 2026-09-21T09:00:00+08:00 */
export function toIsoInZone(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone);
  const off = offsetMinutes(ms, timeZone);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${p["year"]}-${p["month"]}-${p["day"]}T${p["hour"]}:${p["minute"]}:${p["second"]}${sign}${hh}:${mm}`;
}

/** 毫秒时间戳 → timeZone 下的日期 YYYY-MM-DD */
export function toDateInZone(ms: number, timeZone: string): string {
  return toIsoInZone(ms, timeZone).slice(0, 10);
}

/** YYYY-MM-DD（timeZone 的当天零点）→ 毫秒时间戳 */
export function dateToMs(date: string, timeZone: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  return guess - offsetMinutes(guess, timeZone) * 60000;
}
