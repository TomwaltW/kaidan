// 真实的 LarkClientLike：消息发送 im.v1.message.create，卡片更新 im.v1.message.patch（spec 附录 D）。
// SDK 调用封装在 LarkImApi 这个小接口后面，测试用 fake 实现，不联网。
import * as lark from "@larksuiteoapi/node-sdk";
import { ErrorCode, KaidanError, type KaidanConfig, type LarkClientLike, type OutboundCard } from "@kaidan/contracts";
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

export function createSdkClient(cred: FeishuCredentials): lark.Client {
  return new lark.Client({
    appId: cred.appId,
    appSecret: cred.appSecret,
    domain: cred.domain,
    appType: lark.AppType.SelfBuild,
    logger: stderrLogger,
  });
}

export function sdkImApi(client: lark.Client): LarkImApi {
  return {
    createMessage: (payload) => client.im.v1.message.create(payload),
    patchMessage: (payload) => client.im.v1.message.patch(payload),
  };
}

/** 机器人自身 open_id：GET /open-apis/bot/v3/info → { bot: { open_id } }（TODO(真机验证)） */
export async function fetchBotOpenId(client: lark.Client): Promise<string> {
  const r: unknown = await client.request({ url: "/open-apis/bot/v3/info", method: "GET" });
  const bot = typeof r === "object" && r !== null ? (r as { bot?: { open_id?: unknown } }).bot : undefined;
  if (typeof bot?.open_id !== "string" || bot.open_id === "") {
    throw new KaidanError(ErrorCode.UPSTREAM, "获取机器人信息失败：/open-apis/bot/v3/info 未返回 open_id");
  }
  return bot.open_id;
}

/** SDK 日志统一写 stderr（MCP stdio 等场景下 stdout 只能留给协议消息） */
export const stderrLogger = {
  error: (...msg: unknown[]) => console.error("[lark]", ...msg),
  warn: (...msg: unknown[]) => console.error("[lark]", ...msg),
  info: (...msg: unknown[]) => console.error("[lark]", ...msg),
  debug: () => {},
  trace: () => {},
};

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

export function createLarkClient(api: LarkImApi, opts: { sleep?: Sleep } = {}): LarkClientLike {
  const sleep = opts.sleep ?? realSleep;
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
        async () =>
          check(
            "发送卡片",
            await api.createMessage({
              data: { receive_id: target.receive_id, msg_type: "interactive", content: JSON.stringify(card.json) },
              params: { receive_id_type: target.receive_id_type },
            }),
          ),
        sleep,
      );
      const messageId = r.data?.message_id;
      if (!messageId) throw new KaidanError(ErrorCode.UPSTREAM, "发送卡片失败：飞书未返回 message_id");
      return { messageId };
    },
    async updateCard(messageId, card) {
      await withRateLimitRetry(
        "更新卡片",
        async () =>
          check(
            "更新卡片",
            await api.patchMessage({ data: { content: JSON.stringify(card.json) }, path: { message_id: messageId } }),
          ),
        sleep,
      );
    },
  };
}
