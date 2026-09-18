// @kaidan/contracts — errors.ts（冻结）
export const ErrorCode = {
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  CONFLICT: "CONFLICT", // 乐观并发：提交时记录已被他人修改
  RATE_LIMITED: "RATE_LIMITED",
  UPSTREAM: "UPSTREAM", // 飞书 / 模型等上游错误
  EXPIRED: "EXPIRED", // 提案过期
  INVALID_STATE: "INVALID_STATE", // 提案状态不允许该操作
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  CONFIG: "CONFIG",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class KaidanError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  constructor(
    code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "KaidanError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.details = opts?.details;
  }
}

export function isKaidanError(e: unknown): e is KaidanError {
  return e instanceof KaidanError;
}

/** T0 骨架里所有未实现的函数统一调用它 */
export function notImplemented(what: string): never {
  throw new KaidanError(ErrorCode.NOT_IMPLEMENTED, `${what} 尚未实现`);
}
