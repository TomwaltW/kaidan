// 分级日志：一律写 stderr（硬规则 9），默认 info，详细模式 KAIDAN_LOG_LEVEL=debug。
// 只记元数据（open_id、message_id、提案 id、错误码），不记 CRM 正文与手机号（硬规则 5）。
import { isKaidanError } from "@kaidan/contracts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const LOG_LEVEL_ENV = "KAIDAN_LOG_LEVEL";

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 日志出口；缺省 console.error（= stderr）。测试注入数组收集。 */
export type LogSink = (...args: unknown[]) => void;

export interface Logger {
  readonly level: LogLevel;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v);
}

/** KAIDAN_LOG_LEVEL 取 debug/info/warn/error；缺失或不认识 → info */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env[LOG_LEVEL_ENV]?.trim().toLowerCase();
  return isLogLevel(raw) ? raw : DEFAULT_LOG_LEVEL;
}

/**
 * 错误 → 一行人话。
 * KaidanError 带上 code；普通 Error 用 name: message；其余原样字符串化。
 * 只有 debug 级别才附堆栈（默认不刷屏）。
 */
export function describeError(e: unknown, opts: { stack?: boolean } = {}): string {
  if (isKaidanError(e)) return `[${e.code}] ${e.message}`;
  if (e instanceof Error) {
    const head = `${e.name}: ${e.message}`;
    return opts.stack && e.stack ? `${head}\n${e.stack}` : head;
  }
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

function formatArg(a: unknown, level: LogLevel): string {
  if (typeof a === "string") return a;
  if (typeof a === "number" || typeof a === "boolean" || a === null || a === undefined) return String(a);
  return describeError(a, { stack: level === "debug" });
}

export interface LoggerOptions {
  sink?: LogSink;
  level?: LogLevel;
  env?: NodeJS.ProcessEnv;
  /** 行首标记，缺省 "[surface-feishu]" */
  prefix?: string;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? resolveLogLevel(opts.env);
  const sink: LogSink = opts.sink ?? ((...args: unknown[]) => console.error(...args));
  const prefix = opts.prefix ?? "[surface-feishu]";
  const emit = (at: LogLevel, args: unknown[]): void => {
    if (ORDER[at] < ORDER[level]) return;
    sink(`${prefix}[${at}] ${args.map((a) => formatArg(a, at)).join(" ")}`);
  };
  return {
    level,
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
  };
}

/** 飞书 SDK 自己的日志接到同一套级别上：SDK 的 info/debug/trace 归到 debug，默认不刷屏 */
export function createSdkLogger(logger: Logger): {
  error: LogSink;
  warn: LogSink;
  info: LogSink;
  debug: LogSink;
  trace: LogSink;
} {
  return {
    error: (...a) => logger.error("[lark]", ...a),
    warn: (...a) => logger.warn("[lark]", ...a),
    info: (...a) => logger.debug("[lark]", ...a),
    debug: (...a) => logger.debug("[lark]", ...a),
    trace: () => {},
  };
}
