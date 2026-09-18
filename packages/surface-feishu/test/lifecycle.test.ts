// start / stop、长连接事件接线、定时任务注册（不真的等时间）、配置缺失 → CONFIG。
import type { Cron } from "croner";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, isKaidanError } from "@kaidan/contracts";
import {
  buildFeishuSurface,
  createConfigIdentityResolver,
  createFeishuSurface,
  createSchedules,
  readFeishuCredentials,
  type FeishuEventHandlers,
} from "../src/index.js";
import {
  FakeAgent,
  FakeGovernance,
  LI,
  RecordingLarkClient,
  ZHANG,
  cardText,
  flush,
  proposal,
  runResult,
  testConfig,
} from "./fakes.js";

const BOT = "ou_bot_kaidan";
const SCHEDULES = { dailyBrief: "30 8 * * 1-5", weeklyReview: "0 17 * * 5" };

async function expectCode(p: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  let err: unknown;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(isKaidanError(err), String(err)).toBe(true);
  expect((err as { code: string }).code).toBe(code);
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

function started(opts: { agent?: FakeAgent; governance?: FakeGovernance; schedules?: boolean } = {}) {
  const config = testConfig(opts.schedules ? { schedules: SCHEDULES } : {});
  const client = new RecordingLarkClient();
  const connClient = new RecordingLarkClient();
  let handlers: FeishuEventHandlers | undefined;
  let closed = 0;
  let jobs: Cron[] = [];
  const surface = buildFeishuSurface(
    {
      agent: opts.agent ?? new FakeAgent(),
      governance: opts.governance ?? new FakeGovernance(),
      identity: createConfigIdentityResolver(config),
      config,
      client,
    },
    {
      connect: async (h) => {
        handlers = h;
        return { botOpenId: BOT, client: connClient, close: () => void closed++ };
      },
      schedule: { paused: true },
      onSchedules: (j) => (jobs = j),
      log: () => {},
    },
  );
  stops.push(() => surface.stop());
  return {
    surface,
    client,
    handlers: () => handlers!,
    closed: () => closed,
    jobs: () => jobs,
  };
}

function groupEvent(messageId: string, text: string, mentionBot: boolean) {
  return {
    event_type: "im.message.receive_v1",
    sender: { sender_id: { open_id: ZHANG }, sender_type: "user" },
    message: {
      message_id: messageId,
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: mentionBot ? `@_user_1 ${text}` : text }),
      mentions: mentionBot ? [{ key: "@_user_1", id: { open_id: BOT }, name: "开单助手" }] : [],
    },
  };
}

describe("start / 长连接接线", () => {
  it("im.message.receive_v1：用 start 时取得的机器人 open_id 解析 @，交给 handleMessage；重复投递去重", async () => {
    const agent = new FakeAgent([runResult({ reply: "收到" })]);
    const s = started({ agent });
    await s.surface.start();

    await s.handlers().onMessage(groupEvent("om_g1", "/晨报", true));
    await s.handlers().onMessage(groupEvent("om_g1", "/晨报", true)); // 飞书重复投递
    await s.handlers().onMessage(groupEvent("om_g2", "闲聊", false)); // 未 @ → 忽略
    await flush();

    expect(agent.runs.map((r) => r.text)).toEqual(["/晨报"]);
    expect(s.client.sent.map((x) => [x.card.kind, x.to.chatId])).toEqual([["reply", "oc_group"]]);
  });

  it("card.action.trigger：审批结果以新卡片替换原卡片（updateCard 原 message_id）", async () => {
    const gov = new FakeGovernance([proposal({ id: "prop_1" })]);
    const s = started({ governance: gov });
    await s.surface.start();

    const ret = await s.handlers().onCardAction({
      event_type: "card.action.trigger",
      operator: { open_id: ZHANG },
      action: { tag: "button", value: { kaidan_action: "approve", proposal_id: "prop_1" } },
      context: { open_message_id: "om_card_1", open_chat_id: "oc_p2p" },
    });
    await flush();

    expect(ret).toBeUndefined();
    expect(gov.calls).toEqual([{ op: "approve", proposalId: "prop_1", by: ZHANG }]);
    expect(s.client.updated).toHaveLength(1);
    expect(s.client.updated[0]!.messageId).toBe("om_card_1");
    expect(cardText(s.client.updated[0]!.card)).toContain("已写入");
  });

  it("无关的卡片回调被忽略", async () => {
    const gov = new FakeGovernance();
    const s = started({ governance: gov });
    await s.surface.start();
    await s.handlers().onCardAction({ operator: { open_id: ZHANG }, action: { value: { foo: 1 } } });
    await flush();
    expect(gov.calls).toHaveLength(0);
    expect(s.client.updated).toHaveLength(0);
  });

  it("stop 关闭长连接；重复 start 不重复连接；未 start 时 stop 安全", async () => {
    const s = started();
    await s.surface.stop();
    await s.surface.start();
    await s.surface.start();
    await s.surface.stop();
    expect(s.closed()).toBe(1);
  });
});

describe("定时任务", () => {
  it("createSchedules：按 config.schedules 注册晨报 / 周报，时区 = config.timezone", () => {
    const config = testConfig({ schedules: SCHEDULES });
    const jobs = createSchedules(config, async () => {}, { paused: true });
    try {
      expect(jobs.map((j) => j.getPattern())).toEqual(["30 8 * * 1-5", "0 17 * * 5"]);
      // 2026-09-19 是周六：下一次晨报 = 周一 09-21 08:30（UTC+8），周报 = 周五 09-25 17:00
      const from = new Date("2026-09-19T12:00:00+08:00");
      expect(jobs[0]!.nextRun(from)?.toISOString()).toBe("2026-09-21T00:30:00.000Z");
      expect(jobs[1]!.nextRun(from)?.toISOString()).toBe("2026-09-25T09:00:00.000Z");
    } finally {
      jobs.forEach((j) => j.stop());
    }
  });

  it("触发 cron 回调 → runScheduled(kind)（直接 trigger，不等时间）", async () => {
    const kinds: string[] = [];
    const jobs = createSchedules(testConfig({ schedules: SCHEDULES }), async (k) => void kinds.push(k), {
      paused: true,
    });
    try {
      await jobs[0]!.trigger();
      await jobs[1]!.trigger();
      expect(kinds).toEqual(["daily_brief", "weekly_review"]);
    } finally {
      jobs.forEach((j) => j.stop());
    }
  });

  it("没有 schedules → 不注册任务", () => {
    expect(createSchedules(testConfig(), async () => {})).toEqual([]);
  });

  it("start() 注册的定时任务触发后给 scheduled 用户发晨报；stop() 停止任务", async () => {
    const agent = new FakeAgent([runResult(), runResult()]);
    const s = started({ agent, schedules: true });
    await s.surface.start();
    const jobs = s.jobs();
    expect(jobs.map((j) => j.getPattern())).toEqual(["30 8 * * 1-5", "0 17 * * 5"]);
    expect(jobs.every((j) => j.name?.startsWith("kaidan:"))).toBe(true);
    await jobs[0]!.trigger();
    expect(s.client.sent.map((x) => x.to.openId)).toEqual([ZHANG, LI]);
    await s.surface.stop();
    expect(jobs.map((j) => j.isStopped())).toEqual([true, true]);
  });
});

describe("配置与密钥", () => {
  it("构造时不读配置 / 密钥；没有 feishu 配置时 start() → CONFIG", async () => {
    const config = testConfig();
    const surface = createFeishuSurface({
      agent: new FakeAgent(),
      governance: new FakeGovernance(),
      identity: createConfigIdentityResolver(config),
      config,
    });
    await expectCode(surface.start(), ErrorCode.CONFIG);
  });

  it("未注入 client 且无 feishu 配置：首次发送 → CONFIG", async () => {
    const config = testConfig();
    const surface = createFeishuSurface({
      agent: new FakeAgent(),
      governance: new FakeGovernance(),
      identity: createConfigIdentityResolver(config),
      config,
    });
    await expectCode(
      surface.handleMessage({
        messageId: "om_x",
        chatId: "oc_x",
        chatType: "p2p",
        senderOpenId: "ou_stranger",
        text: "hi",
        mentionedBot: false,
      }),
      ErrorCode.CONFIG,
    );
  });

  it("readFeishuCredentials：缺环境变量 → CONFIG，齐全时返回凭证", () => {
    const config = testConfig({ feishu: { appIdEnv: "FS_ID", appSecretEnv: "FS_SECRET", domain: "feishu" } });
    return Promise.all([
      expectCode(() => readFeishuCredentials(config, {}), ErrorCode.CONFIG),
      expectCode(() => readFeishuCredentials(config, { FS_ID: "cli_x" }), ErrorCode.CONFIG),
    ]).then(() => {
      const c = readFeishuCredentials(config, { FS_ID: "cli_x", FS_SECRET: "s" });
      expect(c.appId).toBe("cli_x");
      expect(c.appSecret).toBe("s");
    });
  });
});
