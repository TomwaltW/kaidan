// 真实的 LarkClientLike：消息发送 im.v1.message.create，卡片更新 im.v1.message.patch（spec 附录 D）。
// SDK 调用封装在 LarkImApi 这个小接口后面，测试用 fake 实现，不联网。
// 任何一次调用失败（返回 code≠0 或直接抛错）都先打一行排错日志：调用名、操作类型、code、msg、log_id。
import * as lark from "@larksuiteoapi/node-sdk";
import { ErrorCode, KaidanError, type KaidanConfig, type LarkClientLike, type OutboundCard } from "@kaidan/contracts";
import {
  BOT_INFO_FAILURE_PREFIX,
  FEISHU_CALLS,
  describeFeishuFailure,
  extractFeishuError,
  type FeishuCall,
} from "./feishu-error.js";
import { createLogger, createSdkLogger, type Logger } from "./log.js";
import { FEISHU_RATE_LIMIT_CODES, realSleep, withRateLimitRetry, type Sleep } from "./retry.js";

export interface LarkApiResult {
  code?: number | undefined;
  msg?: string | undefined;
  data?: { message_id?: string | undefined } | undefined;
}

/** 与 SDK 的 client.im.v1.message.{create,patch} 同形的最小接口 */
export interface LarkImApi {
  createMessage(payload: {
    data: { receive_id: string; msg_type: string; content: string; uuid?: string };
    params: { receive_id_type: "open_id" | "chat_id" };
  }): Promise<LarkApiResult>;
  patchMessage(payload: { data: { content: string }; path: { message_id: string } }): Promise<LarkApiResult>;
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain: lark.Domain;
}

/** 读取 config.feishu 与环境变量里的应用凭证；缺失 → CONFIG（只在 start() 或首次真实发送时调用） */
export function readFeishuCredentials(config: KaidanConfig, env: NodeJS.ProcessEnv = process.env): FeishuCredentials {
  const f = config.feishu;
  if (!f) throw new KaidanError(ErrorCode.CONFIG, "配置缺少 feishu 段（appIdEnv / appSecretEnv / domain），无法连接飞书");
  const appId = env[f.appIdEnv];
  const appSecret = env[f.appSecretEnv];
  if (!appId) throw new KaidanError(ErrorCode.CONFIG, `缺少环境变量 ${f.appIdEnv}（feishu.appIdEnv）`);
  if (!appSecret) throw new KaidanError(ErrorCode.CONFIG, `缺少环境变量 ${f.appSecretEnv}（feishu.appSecretEnv）`);
  return { appId, appSecret, domain: f.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu };
}

export function createSdkClient(cred: FeishuCredentials, logger: Logger = createLogger()): lark.Client {
  return new lark.Client({
    appId: cred.appId,
    appSecret: cred.appSecret,
    domain: cred.domain,
    appType: lark.AppType.SelfBuild,
    logger: createSdkLogger(logger),
  });
}

export function sdkImApi(client: lark.Client): LarkImApi {
  return {
    createMessage: (payload) => client.im.v1.message.create(payload),
    patchMessage: (payload) => client.im.v1.message.patch(payload),
  };
}

export interface BotInfo {
  openId: string;
  name?: string;
}

/**
 * 机器人自身信息：GET /open-apis/bot/v3/info → { code, msg, bot: { open_id, app_name } }（TODO(真机验证)）。
 * 失败时抛出的消息统一以 BOT_INFO_FAILURE_PREFIX 开头，启动自述照抄它，不静默跳过。
 */
export async function fetchBotInfo(client: lark.Client, logger: Logger = createLogger()): Promise<BotInfo> {
  const fail = (reason: string, cause?: unknown): KaidanError => {
    const text = `${BOT_INFO_FAILURE_PREFIX}${reason}`;
    logger.error(text);
    return new KaidanError(ErrorCode.UPSTREAM, text, cause === undefined ? {} : { cause });
  };

  let r: unknown;
  try {
    r = await client.request({ url: "/open-apis/bot/v3/info", method: "GET" });
  } catch (e) {
    throw fail(describeFeishuFailure(FEISHU_CALLS.botInfo, e), e);
  }

  // 权限没开、应用没发版之类的错误是 code≠0 的正常响应，要把 code / msg / log_id 一起报出来
  const info = extractFeishuError(r);
  if (info.code !== undefined && info.code !== 0) {
    throw fail(describeFeishuFailure(FEISHU_CALLS.botInfo, r));
  }

  const bot = typeof r === "object" && r !== null ? (r as { bot?: Record<string, unknown> }).bot : undefined;
  const openId = bot?.["open_id"];
  if (typeof openId !== "string" || openId === "") {
    throw fail(`${FEISHU_CALLS.botInfo.call} 返回里没有 bot.open_id（机器人能力可能没开启，或应用还没发版）`);
  }
  const name = bot?.["app_name"];
  return typeof name === "string" && name !== "" ? { openId, name } : { openId };
}

function check(what: string, r: LarkApiResult): LarkApiResult {
  const code = r.code ?? 0;
  if (code === 0) return r;
  if (FEISHU_RATE_LIMIT_CODES.has(code)) {
    throw new KaidanError(ErrorCode.RATE_LIMITED, `${what}：飞书频控（${code}）`, { retryable: true });
  }
  throw new KaidanError(ErrorCode.UPSTREAM, `${what}失败：飞书返回 ${code} ${r.msg ?? ""}`.trim(), {
    details: { code },
  });
}

/**
 * 跑一次调用并在失败时打一行排错日志，然后把原始错误原样抛出去
 * —— withRateLimitRetry 要靠原始形状（axios 的 response.status / data.code）判断是不是频控。
 * 频控重试时每次失败各打一行，真机上能直接看出重试了几次。
 */
async function attempt(
  call: FeishuCall,
  what: string,
  logger: Logger,
  fn: () => Promise<LarkApiResult>,
): Promise<LarkApiResult> {
  let r: LarkApiResult;
  try {
    r = await fn();
  } catch (e) {
    logger.error(describeFeishuFailure(call, e));
    throw e;
  }
  if ((r.code ?? 0) !== 0) logger.error(describeFeishuFailure(call, r));
  return check(what, r);
}

export function createLarkClient(api: LarkImApi, opts: { sleep?: Sleep; logger?: Logger } = {}): LarkClientLike {
  const sleep = opts.sleep ?? realSleep;
  const logger = opts.logger ?? createLogger();
  return {
    async sendCard(to, card: OutboundCard) {
      const target = to.chatId
        ? { receive_id: to.chatId, receive_id_type: "chat_id" as const }
        : to.openId
          ? { receive_id: to.openId, receive_id_type: "open_id" as const }
          : undefined;
      if (!target) throw new KaidanError(ErrorCode.VALIDATION, "发送卡片需要 chatId 或 openId");
      const r = await withRateLimitRetry(
        "发送卡片",
        () =>
          attempt(FEISHU_CALLS.createMessage, "发送卡片", logger, () =>
            api.createMessage({
              data: { receive_id: target.receive_id, msg_type: "interactive", content: JSON.stringify(card.json) },
              params: { receive_id_type: target.receive_id_type },
            }),
          ),
        sleep,
      );
      const messageId = r.data?.message_id;
      if (!messageId) throw new KaidanError(ErrorCode.UPSTREAM, "发送卡片失败：飞书未返回 message_id");
      logger.debug(`已发送卡片：kind=${card.kind} message_id=${messageId}`);
      return { messageId };
    },
    async updateCard(messageId, card) {
      await withRateLimitRetry(
        "更新卡片",
        () =>
          attempt(FEISHU_CALLS.patchMessage, "更新卡片", logger, () =>
            api.patchMessage({ data: { content: JSON.stringify(card.json) }, path: { message_id: messageId } }),
          ),
        sleep,
      );
      logger.debug(`已换卡：kind=${card.kind} message_id=${messageId}`);
    },
  };
}
