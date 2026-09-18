// 飞书 API 频控重试（spec 3.3）：最多重试 3 次，指数退避 0.5s / 1s / 2s，仍失败 → RATE_LIMITED。
import { ErrorCode, KaidanError, isKaidanError } from "@kaidan/contracts";

export const RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000];

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 飞书频控错误码：99991400（应用频率限制，HTTP 400）、230020（消息发送频控）。
 * TODO(真机验证)：im 接口实际返回的频控码以线上为准。
 */
export const FEISHU_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([99991400, 230020]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 识别频控：KaidanError(RATE_LIMITED)；或 SDK/axios 抛出的 HTTP 429 / 频控错误码 */
export function isRateLimited(e: unknown): boolean {
  if (isKaidanError(e)) return e.code === ErrorCode.RATE_LIMITED;
  if (!isRecord(e)) return false;
  const res = e["response"];
  if (!isRecord(res)) return false;
  if (res["status"] === 429) return true;
  const data = res["data"];
  return isRecord(data) && typeof data["code"] === "number" && FEISHU_RATE_LIMIT_CODES.has(data["code"]);
}

export async function withRateLimitRetry<T>(what: string, fn: () => Promise<T>, sleep: Sleep = realSleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e)) throw e;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw new KaidanError(ErrorCode.RATE_LIMITED, `${what}：飞书频控，重试 ${RETRY_DELAYS_MS.length} 次后仍失败`, {
          retryable: true,
          cause: e,
        });
      }
      await sleep(delay);
    }
  }
}
