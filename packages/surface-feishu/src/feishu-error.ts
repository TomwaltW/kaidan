// 飞书接口出错时，把能查的信息一次性打出来：哪个调用、哪类操作、code / msg / log_id。
// log_id 是找飞书技术支持时唯一认的线索，拿不到也要明确写「未返回」，不要静默。
//
// TODO(真机验证)：@larksuiteoapi/node-sdk 1.74 的响应拦截器只把 resp.data 交出来
// （lib/index.js 的 defaultHttpInstance.interceptors.response），响应头拿不到，
// 所以 log_id 只能从响应体里取（顶层 log_id / error.log_id）；HTTP 层抛错时才有
// e.response.headers 可读。真机上若发现飞书把 log_id 放在别的位置，补进 LOG_ID_PATHS。
import { describeError } from "./log.js";

/** 一次飞书调用的身份：call = SDK 方法 / 接口路径，op = 这次是哪类操作 */
export interface FeishuCall {
  call: string;
  op: string;
}

export const FEISHU_CALLS = {
  createMessage: { call: "im.v1.message.create", op: "回消息" },
  patchMessage: { call: "im.v1.message.patch", op: "换卡" },
  botInfo: { call: "bot/v3/info", op: "读机器人信息" },
} as const satisfies Record<string, FeishuCall>;

/** 取机器人信息失败时，错误消息统一以它开头，便于启动自述直接引用 */
export const BOT_INFO_FAILURE_PREFIX = "取不到机器人信息：";

/**
 * 已知错误码 → 人话 + 下一步。没见过的码不猜含义，原样打印 code + msg + log_id。
 *
 * 230020 有冲突，真机上要留意（见回执）：本仓库 retry.ts 把它当频控码退避重试，
 * 而派单给的说法是「机器人没在会话里 / 无权发消息」。两种说法只能有一种对，
 * 所以这里把两句都写进建议里，免得日志一边说「重试中」一边说「检查可用范围」。
 */
export const FEISHU_CODE_HINTS: ReadonlyMap<number, string> = new Map<number, string>([
  [99991400, "频控：稍后重试；短时间内发大量消息会触发"],
  [
    230020,
    "机器人没在会话里 / 无权发消息：检查应用可用范围与发布版本" +
      "（注意：本仓库当前把 230020 也当频控码退避重试，见 retry.ts 的 TODO，真机以实际表现为准）",
  ],
]);

export interface FeishuErrorInfo {
  code?: number;
  msg?: string;
  logId?: string;
  httpStatus?: number;
  /** FEISHU_CODE_HINTS 里查到的建议；没见过的码为 undefined */
  hint?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 响应体里 log_id 可能出现的位置（按优先级） */
function logIdOf(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const err = isRecord(body["error"]) ? body["error"] : undefined;
  const data = isRecord(body["data"]) ? body["data"] : undefined;
  return str(err?.["log_id"]) ?? str(body["log_id"]) ?? str(data?.["log_id"]);
}

/**
 * 从「飞书返回体」或「SDK/axios 抛出的错误」里抠出 code / msg / log_id。
 * 两种入参都支持：check() 拿到的是返回体，catch 拿到的是错误对象。
 */
export function extractFeishuError(v: unknown): FeishuErrorInfo {
  const info: FeishuErrorInfo = {};
  if (!isRecord(v)) return info;

  // ① 直接就是返回体
  let body: Record<string, unknown> | undefined = v;
  const res = isRecord(v["response"]) ? v["response"] : undefined;
  if (res) {
    // ② axios 错误：真正的返回体在 response.data，log_id 还可能在响应头里
    body = isRecord(res["data"]) ? res["data"] : undefined;
    info.httpStatus = num(res["status"]);
    const headers = isRecord(res["headers"]) ? res["headers"] : undefined;
    const fromHeader = str(headers?.["x-tt-logid"]) ?? str(headers?.["X-Tt-Logid"]);
    if (fromHeader) info.logId = fromHeader;
  }

  const code = num(body?.["code"]);
  if (code !== undefined) info.code = code;
  const msg = str(body?.["msg"]) ?? str(body?.["message"]);
  if (msg !== undefined) info.msg = msg;
  info.logId ??= logIdOf(body);

  // ③ KaidanError 把飞书码放在 details.code
  if (info.code === undefined) {
    const details = isRecord(v["details"]) ? v["details"] : undefined;
    const detailCode = num(details?.["code"]);
    if (detailCode !== undefined) info.code = detailCode;
  }

  if (info.code !== undefined) {
    const hint = FEISHU_CODE_HINTS.get(info.code);
    if (hint !== undefined) info.hint = hint;
  }
  return info;
}

const MISSING = "(未返回)";

/**
 * 一行排错日志：哪个调用、哪类操作、code、msg、log_id，已知码再跟一句建议。
 * 例：飞书调用失败：im.v1.message.create（回消息） code=230020 msg=bot not in chat log_id=2026… → 建议：…
 */
export function describeFeishuFailure(call: FeishuCall, v: unknown): string {
  const info = extractFeishuError(v);
  const parts = [
    `飞书调用失败：${call.call}（${call.op}）`,
    `code=${info.code ?? MISSING}`,
    `msg=${info.msg ?? MISSING}`,
    `log_id=${info.logId ?? MISSING}`,
  ];
  if (info.httpStatus !== undefined) parts.push(`http=${info.httpStatus}`);
  // code 都没有 → 多半是网络层错误，把原始错误带上，不然什么线索都没有
  if (info.code === undefined) parts.push(`原始错误=${describeError(v)}`);
  const line = parts.join(" ");
  return info.hint ? `${line} → 建议：${info.hint}` : line;
}
