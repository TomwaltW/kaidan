// 飞书入口（spec 3.1 surface.ts 行为规则 + 3.2 第 8 条）。
// 三个处理器只依赖 SurfaceDeps；start() 才连飞书（长连接 + 定时任务）。
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
import {
  createLarkClient,
  createSdkClient,
  fetchBotOpenId,
  readFeishuCredentials,
  sdkImApi,
  stderrLogger,
} from "./lark-client.js";
import { parseCardActionEvent, parseMessageEvent } from "./parse.js";
import { realSleep, type Sleep } from "./retry.js";
import { createSchedules, type ScheduleKind, type ScheduleOptions } from "./schedule.js";

/** 长连接收到的原始事件交给这两个回调（载荷已由 SDK 的 EventDispatcher 展平） */
export interface FeishuEventHandlers {
  onMessage(data: unknown): Promise<void>;
  onCardAction(data: unknown): Promise<unknown>;
}

export interface FeishuConnection {
  botOpenId: string;
  /** 没有注入 client 时用它发送 */
  client: LarkClientLike;
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

/** 真实长连接：Client（发消息 / 取机器人信息）+ EventDispatcher + WSClient */
async function connectFeishu(deps: SurfaceDeps, handlers: FeishuEventHandlers, sleep: Sleep): Promise<FeishuConnection> {
  const cred = readFeishuCredentials(deps.config);
  const sdk = createSdkClient(cred);
  const botOpenId = await fetchBotOpenId(sdk);
  const dispatcher = new lark.EventDispatcher({ logger: stderrLogger }).register<{
    "card.action.trigger": (data: unknown) => Promise<unknown>;
  }>({
    "im.message.receive_v1": (data) => handlers.onMessage(data),
    "card.action.trigger": (data) => handlers.onCardAction(data),
  });
  const ws = new lark.WSClient({
    appId: cred.appId,
    appSecret: cred.appSecret,
    domain: cred.domain,
    logger: stderrLogger,
    loggerLevel: lark.LoggerLevel.info,
    autoReconnect: true,
  });
  await ws.start({ eventDispatcher: dispatcher });
  return {
    botOpenId,
    client: createLarkClient(sdkImApi(sdk), { sleep }),
    close: () => ws.close(),
  };
}

export function buildFeishuSurface(deps: SurfaceDeps, opts: FeishuSurfaceOptions = {}): Surface {
  const { agent, governance, identity, config } = deps;
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? ((...args: unknown[]) => console.error("[surface-feishu]", ...args));

  let connection: FeishuConnection | undefined;
  let lazyClient: LarkClientLike | undefined;
  let jobs: Cron[] = [];
  /** 飞书可能重复投递同一事件：按 message_id 去重（只保留最近 500 条） */
  const seen = new Set<string>();

  /** 注入的 client 优先；否则用长连接的；都没有时首次发送才读配置与密钥（缺失 → CONFIG） */
  function client(): LarkClientLike {
    if (deps.client) return deps.client;
    if (connection) return connection.client;
    lazyClient ??= createLarkClient(sdkImApi(createSdkClient(readFeishuCredentials(config))), { sleep });
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
      log(`未开通用户发来消息：open_id=${msg.senderOpenId}`);
      await send(to, buildNoticeCard(NOTICE_TEXT.notEnabled));
      return;
    }
    let result;
    try {
      result = await agent.run({ actor, text: msg.text, traceId: `fs_${msg.messageId}`, channel: "feishu" });
    } catch (e) {
      log("agent.run 失败", msg.messageId, e);
      await send(to, buildNoticeCard(NOTICE_TEXT.agentFailed));
      return;
    }
    await send(to, buildReplyCard(result.reply, result.disclosure));
    for (const p of result.proposals) await send(to, buildProposalCard(p, config.timezone));
  }

  async function handleCardAction(a: CardAction): Promise<OutboundCard> {
    const operator = await identity.resolveByOpenId(a.operatorOpenId);
    if (!operator) return buildNoticeCard(NOTICE_TEXT.notEnabled);
    try {
      if (a.action === "approve") {
        await governance.approvals.approve(a.proposalId, operator);
        return buildNoticeCard(NOTICE_TEXT.approved);
      }
      await governance.approvals.reject(a.proposalId, operator);
      return buildNoticeCard(NOTICE_TEXT.rejected);
    } catch (e) {
      if (!isKaidanError(e)) log("审批失败", a.proposalId, e);
      return buildNoticeCard(approvalErrorText(e));
    }
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
          log(`定时任务 ${kind} 未生成内容`, actor.userId, r.stoppedBy);
          failed++;
          continue;
        }
        const to = { openId: actor.userId };
        await send(to, buildReplyCard(r.reply, r.disclosure));
        for (const p of r.proposals) await send(to, buildProposalCard(p, config.timezone));
        sent++;
      } catch (e) {
        log(`定时任务 ${kind} 发送失败`, actor.userId, e);
        failed++;
      }
    }
    return { sent, failed };
  }

  const handlers: FeishuEventHandlers = {
    async onMessage(data) {
      const msg = parseMessageEvent(data, connection?.botOpenId);
      if (!msg) return;
      if (seen.has(msg.messageId)) return;
      seen.add(msg.messageId);
      if (seen.size > 500) seen.delete(seen.values().next().value as string);
      // 飞书要求 3 秒内确认事件：不等待 agent，直接返回
      void handleMessage(msg).catch((e: unknown) => log("处理消息失败", msg.messageId, e));
    },
    async onCardAction(data) {
      const parsed = parseCardActionEvent(data);
      if (!parsed) return undefined;
      // 处理结果以新卡片替换原卡片（im.v1.message.patch）；回调本身立即返回
      void (async () => {
        const card = await handleCardAction(parsed.action);
        if (parsed.messageId) await client().updateCard(parsed.messageId, card);
        else if (parsed.chatId) await send({ chatId: parsed.chatId }, card);
      })().catch((e: unknown) => log("处理卡片回调失败", parsed.action.proposalId, e));
      return undefined;
    },
  };

  return {
    handleMessage,
    handleCardAction,
    runScheduled,
    async start() {
      if (connection) return;
      connection = opts.connect ? await opts.connect(handlers) : await connectFeishu(deps, handlers, sleep);
      jobs = createSchedules(config, runScheduled, {
        onError: (kind, e) => log(`定时任务 ${kind} 出错`, e),
        nameSuffix: randomUUID().slice(0, 8),
        ...opts.schedule,
      });
      opts.onSchedules?.(jobs);
      log(`已连接飞书；定时任务 ${jobs.length} 个`);
    },
    async stop() {
      for (const j of jobs) j.stop();
      jobs = [];
      connection?.close();
      connection = undefined;
    },
  };
}

export const createFeishuSurface: CreateFeishuSurface = (deps) => buildFeishuSurface(deps);
