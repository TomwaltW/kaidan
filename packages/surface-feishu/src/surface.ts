// 飞书入口（spec 3.1 surface.ts 行为规则 + 3.2 第 8 条）。
// 三个处理器只依赖 SurfaceDeps；start() 才连飞书（长连接 + 定时任务）。
// 本文件里的日志只为真机排错，一律写 stderr，且只记元数据（open_id / message_id / 提案 id / 错误码），
// 不记消息正文、CRM 正文与手机号（硬规则 5、9）。
import { randomUUID } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import type { Cron } from "croner";
import {
  ErrorCode,
  isKaidanError,
  type CardAction,
  type CreateFeishuSurface,
  type InboundMessage,
  type LarkClientLike,
  type OutboundCard,
  type SkillName,
  type Surface,
  type SurfaceDeps,
} from "@kaidan/contracts";
import { NOTICE_TEXT, buildNoticeCard, buildProposalCard, buildReplyCard } from "./cards.js";
import { checkAppIdFormat, createConnectionWatch, wsStateText } from "./connection.js";
import {
  createLarkClient,
  createSdkClient,
  fetchBotInfo,
  readFeishuCredentials,
  sdkImApi,
} from "./lark-client.js";
import { createLogger, createSdkLogger, describeError, type LogLevel, type Logger } from "./log.js";
import { parseCardActionEvent, parseMessageEvent } from "./parse.js";
import { realSleep, type Sleep } from "./retry.js";
import { createSchedules, type ScheduleKind, type ScheduleOptions } from "./schedule.js";
import { botFailureReason, renderStartupBanner, type BotInfo } from "./startup.js";

/** 长连接收到的原始事件交给这两个回调（载荷已由 SDK 的 EventDispatcher 展平） */
export interface FeishuEventHandlers {
  onMessage(data: unknown): Promise<void>;
  onCardAction(data: unknown): Promise<unknown>;
}

export interface FeishuConnection {
  botOpenId: string;
  /** 机器人名称（bot/v3/info 的 app_name），拿不到就不填 */
  botName?: string;
  /** botOpenId 为空时说明原因，启动自述会原样写出来 */
  botInfoError?: string;
  /** 没有注入 client 时用它发送 */
  client: LarkClientLike;
  /** 长连接当前状态的中文说法（真实连接用 WSClient.getConnectionStatus()） */
  status?: () => string;
  close(): void;
}

export interface FeishuSurfaceOptions {
  /** 频控退避用；测试注入不等待的 sleep */
  sleep?: Sleep;
  /** 替换真实的飞书长连接（测试用）；缺省用 @larksuiteoapi/node-sdk 的 WSClient + EventDispatcher */
  connect?: (handlers: FeishuEventHandlers) => Promise<FeishuConnection>;
  schedule?: ScheduleOptions;
  /** start() 注册完定时任务后回调（测试用） */
  onSchedules?: (jobs: Cron[]) => void;
  /** 日志一律写 stderr */
  log?: (...args: unknown[]) => void;
  /** 缺省读环境变量 KAIDAN_LOG_LEVEL，再缺省 info */
  logLevel?: LogLevel;
}

const SCHEDULE_SKILL: Readonly<Record<ScheduleKind, { skill: SkillName; text: string }>> = {
  daily_brief: { skill: "daily-brief", text: "/晨报" },
  weekly_review: { skill: "weekly-review", text: "/周报" },
};

/** 审批出错 → notice 文案（附录 D） */
export function approvalErrorText(e: unknown): string {
  if (!isKaidanError(e)) return NOTICE_TEXT.failed;
  switch (e.code) {
    case ErrorCode.PERMISSION_DENIED:
      return NOTICE_TEXT.permissionDenied;
    case ErrorCode.EXPIRED:
      return NOTICE_TEXT.expired;
    case ErrorCode.CONFLICT:
      return NOTICE_TEXT.conflict;
    case ErrorCode.INVALID_STATE:
      return NOTICE_TEXT.invalidState;
    case ErrorCode.NOT_FOUND:
      return NOTICE_TEXT.notFound;
    default:
      return `${NOTICE_TEXT.failed}（${e.message}）`;
  }
}

/** 卡片回调的处理结果，只用于日志：不含任何 CRM 正文 */
export function cardActionOutcome(e: unknown): string {
  return isKaidanError(e) ? `错误 ${e.code}` : "错误 UNKNOWN";
}

/** 真实长连接：Client（发消息 / 取机器人信息）+ EventDispatcher + WSClient */
async function connectFeishu(
  deps: SurfaceDeps,
  handlers: FeishuEventHandlers,
  sleep: Sleep,
  logger: Logger,
): Promise<FeishuConnection> {
  const cred = readFeishuCredentials(deps.config);
  checkAppIdFormat(cred.appId, logger);
  const sdk = createSdkClient(cred, logger);
  const bot = await fetchBotInfo(sdk, logger);
  const watch = createConnectionWatch(logger);
  const sdkLogger = createSdkLogger(logger);
  const dispatcher = new lark.EventDispatcher({ logger: sdkLogger }).register<{
    "card.action.trigger": (data: unknown) => Promise<unknown>;
  }>({
    "im.message.receive_v1": (data) => handlers.onMessage(data),
    "card.action.trigger": (data) => handlers.onCardAction(data),
  });
  const ws = new lark.WSClient({
    appId: cred.appId,
    appSecret: cred.appSecret,
    domain: cred.domain,
    logger: sdkLogger,
    loggerLevel: lark.LoggerLevel.info,
    autoReconnect: true,
    onReady: watch.onReady,
    onError: watch.onError,
    onReconnecting: watch.onReconnecting,
    onReconnected: watch.onReconnected,
  });
  await ws.start({ eventDispatcher: dispatcher });
  watch.armReadyWatchdog();
  const connection: FeishuConnection = {
    botOpenId: bot.openId,
    client: createLarkClient(sdkImApi(sdk), { sleep, logger }),
    status: () => wsStateText(ws.getConnectionStatus().state),
    close: () => {
      watch.disarm();
      ws.close();
    },
  };
  if (bot.name !== undefined) connection.botName = bot.name;
  return connection;
}

export function buildFeishuSurface(deps: SurfaceDeps, opts: FeishuSurfaceOptions = {}): Surface {
  const { agent, governance, identity, config } = deps;
  const sleep = opts.sleep ?? realSleep;
  const logger = createLogger(
    opts.logLevel === undefined ? { sink: opts.log } : { sink: opts.log, level: opts.logLevel },
  );

  let connection: FeishuConnection | undefined;
  let lazyClient: LarkClientLike | undefined;
  let jobs: Cron[] = [];
  /** 飞书可能重复投递同一事件：按 message_id 去重（只保留最近 500 条） */
  const seen = new Set<string>();

  /** 注入的 client 优先；否则用长连接的；都没有时首次发送才读配置与密钥（缺失 → CONFIG） */
  function client(): LarkClientLike {
    if (deps.client) return deps.client;
    if (connection) return connection.client;
    lazyClient ??= createLarkClient(sdkImApi(createSdkClient(readFeishuCredentials(config), logger)), {
      sleep,
      logger,
    });
    return lazyClient;
  }

  async function send(to: { chatId?: string; openId?: string }, card: OutboundCard): Promise<void> {
    await client().sendCard(to, card);
  }

  async function handleMessage(msg: InboundMessage): Promise<void> {
    if (msg.chatType === "group" && !msg.mentionedBot) return;
    const to = { chatId: msg.chatId };
    const actor = await identity.resolveByOpenId(msg.senderOpenId);
    if (!actor) {
      // 方便管理员把新用户加进 config.users（只记 open_id，不记消息正文）
      logger.info(`未开通用户发来消息：open_id=${msg.senderOpenId}`);
      await send(to, buildNoticeCard(NOTICE_TEXT.notEnabled));
      return;
    }
    let result;
    try {
      result = await agent.run({ actor, text: msg.text, traceId: `fs_${msg.messageId}`, channel: "feishu" });
    } catch (e) {
      logger.error("agent.run 失败", msg.messageId, e);
      await send(to, buildNoticeCard(NOTICE_TEXT.agentFailed));
      return;
    }
    // stoppedBy="error" 时正文是系统提示（例如「模型服务配置有误…」）、并非模型生成 → 不加公示页脚（CLI 同此规则）
    await send(to, buildReplyCard(result.reply, result.disclosure, { showDisclosure: result.stoppedBy !== "error" }));
    for (const p of result.proposals) await send(to, buildProposalCard(p, config.timezone));
    logger.debug(
      `消息处理完成：message_id=${msg.messageId} 技能=${result.skill} 提案=${result.proposals.length} 结束于=${result.stoppedBy}`,
    );
  }

  /** handleCardAction 的实现；额外返回一句只含元数据的处理结果，供回调链路的日志用 */
  async function decideCardAction(a: CardAction): Promise<{ card: OutboundCard; outcome: string }> {
    const operator = await identity.resolveByOpenId(a.operatorOpenId);
    if (!operator) return { card: buildNoticeCard(NOTICE_TEXT.notEnabled), outcome: "未开通用户" };
    try {
      if (a.action === "approve") {
        await governance.approvals.approve(a.proposalId, operator);
        return { card: buildNoticeCard(NOTICE_TEXT.approved), outcome: "committed" };
      }
      await governance.approvals.reject(a.proposalId, operator);
      return { card: buildNoticeCard(NOTICE_TEXT.rejected), outcome: "rejected" };
    } catch (e) {
      if (!isKaidanError(e)) logger.error("审批失败", a.proposalId, e);
      return { card: buildNoticeCard(approvalErrorText(e)), outcome: cardActionOutcome(e) };
    }
  }

  async function handleCardAction(a: CardAction): Promise<OutboundCard> {
    return (await decideCardAction(a)).card;
  }

  async function runScheduled(kind: ScheduleKind): Promise<{ sent: number; failed: number }> {
    const { skill, text } = SCHEDULE_SKILL[kind];
    let sent = 0;
    let failed = 0;
    // 逐个顺序执行：单个用户失败不影响其他用户
    for (const actor of await identity.listScheduled()) {
      try {
        const r = await agent.run({
          actor,
          text,
          skill,
          channel: "schedule",
          traceId: `sched_${kind}_${actor.userId}_${randomUUID()}`,
        });
        if (r.stoppedBy === "error" || r.stoppedBy === "forbidden") {
          logger.warn(`定时任务 ${kind} 未生成内容`, actor.userId, r.stoppedBy);
          failed++;
          continue;
        }
        const to = { openId: actor.userId };
        await send(to, buildReplyCard(r.reply, r.disclosure));
        for (const p of r.proposals) await send(to, buildProposalCard(p, config.timezone));
        sent++;
      } catch (e) {
        logger.error(`定时任务 ${kind} 发送失败`, actor.userId, e);
        failed++;
      }
    }
    logger.info(`定时任务 ${kind} 完成：送达 ${sent} 人，失败 ${failed} 人`);
    return { sent, failed };
  }

  const handlers: FeishuEventHandlers = {
    async onMessage(data) {
      const msg = parseMessageEvent(data, connection?.botOpenId);
      if (!msg) {
        logger.debug("im.message.receive_v1：不是用户发来的文本消息，已忽略");
        return;
      }
      if (seen.has(msg.messageId)) {
        logger.debug(`im.message.receive_v1：重复投递，已忽略 message_id=${msg.messageId}`);
        return;
      }
      seen.add(msg.messageId);
      if (seen.size > 500) seen.delete(seen.values().next().value as string);
      // 只记元数据与文本长度，绝不记消息正文
      logger.debug(
        `收到消息：message_id=${msg.messageId} chat_type=${msg.chatType} sender=${msg.senderOpenId} @机器人=${msg.mentionedBot} 文本长度=${msg.text.length}`,
      );
      // 飞书要求 3 秒内确认事件：不等待 agent，直接返回
      void handleMessage(msg).catch((e: unknown) => logger.error("处理消息失败", msg.messageId, e));
    },
    async onCardAction(data) {
      const parsed = parseCardActionEvent(data);
      if (!parsed) {
        // 真机上按钮 value 形状不对时最容易卡在这里：只打顶层字段名，不打载荷内容
        logger.warn(
          `card.action.trigger：载荷解析不出审批动作（按钮 value 应为 {kaidan_action, proposal_id}），顶层字段：${topLevelKeys(data)}`,
        );
        return undefined;
      }
      const a = parsed.action;
      logger.info(
        `card.action.trigger：动作=${a.action} 提案=${a.proposalId} 操作人=${a.operatorOpenId} 原卡=${parsed.messageId ?? "(未带 open_message_id)"}`,
      );
      // 处理结果以新卡片替换原卡片（im.v1.message.patch）；回调本身立即返回
      void (async () => {
        const { card, outcome } = await decideCardAction(a);
        logger.info(`card.action.trigger 处理完成：提案=${a.proposalId} 结果=${outcome}`);
        if (parsed.messageId) await client().updateCard(parsed.messageId, card);
        else if (parsed.chatId) await send({ chatId: parsed.chatId }, card);
        else logger.warn(`card.action.trigger：回调既没带 open_message_id 也没带 open_chat_id，无法回卡 提案=${a.proposalId}`);
      })().catch((e: unknown) => logger.error("处理卡片回调失败", a.proposalId, e));
      return undefined;
    },
  };

  function bannerBot(): BotInfo {
    if (!connection || connection.botOpenId === "") {
      return { error: connection?.botInfoError ?? "长连接没有返回机器人 open_id" };
    }
    return connection.botName === undefined
      ? { openId: connection.botOpenId }
      : { openId: connection.botOpenId, name: connection.botName };
  }

  return {
    handleMessage,
    handleCardAction,
    runScheduled,
    async start() {
      if (connection) return;
      try {
        connection = opts.connect ? await opts.connect(handlers) : await connectFeishu(deps, handlers, sleep, logger);
      } catch (e) {
        // 连不上也要把自述打出来：至少能看出租户、模型、users 有没有填对，以及卡在哪一步
        const reason = botFailureReason(e);
        const bot: BotInfo =
          reason !== undefined ? { error: reason } : { skipped: `长连接未建立：${describeError(e)}` };
        for (const line of renderStartupBanner({
          config,
          bot,
          connection: "未建立",
          scheduleCount: 0,
          logLevel: logger.level,
        })) {
          logger.error(line);
        }
        throw e;
      }
      jobs = createSchedules(config, runScheduled, {
        onError: (kind, e) => logger.error(`定时任务 ${kind} 出错`, e),
        nameSuffix: randomUUID().slice(0, 8),
        ...opts.schedule,
      });
      opts.onSchedules?.(jobs);
      for (const line of renderStartupBanner({
        config,
        bot: bannerBot(),
        connection: connection.status?.() ?? "已建立",
        scheduleCount: jobs.length,
        logLevel: logger.level,
      })) {
        logger.info(line);
      }
    },
    async stop() {
      for (const j of jobs) j.stop();
      jobs = [];
      connection?.close();
      connection = undefined;
      logger.info("已停止：长连接与定时任务都已收干净");
    },
  };
}

function topLevelKeys(data: unknown): string {
  if (typeof data !== "object" || data === null) return `(${typeof data})`;
  const keys = Object.keys(data as Record<string, unknown>);
  return keys.length > 0 ? keys.join(",") : "(无)";
}

export const createFeishuSurface: CreateFeishuSurface = (deps) => buildFeishuSurface(deps);
