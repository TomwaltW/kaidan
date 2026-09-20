// 三个处理器（handleMessage / handleCardAction / runScheduled），覆盖 e2e B6 的六种情形。
// fake agent 返回预设 AgentRunResult，fake governance 按契约规则审批，fake 飞书客户端只记录。
import { describe, expect, it } from "vitest";
import { ErrorCode, KaidanError, type InboundMessage } from "@kaidan/contracts";
import { createConfigIdentityResolver, createFeishuSurface } from "../src/index.js";
import {
  FakeAgent,
  FakeGovernance,
  LI,
  RecordingLarkClient,
  ZHANG,
  WANG,
  cardText,
  proposal,
  runResult,
  testConfig,
} from "./fakes.js";

function make(agent = new FakeAgent(), governance = new FakeGovernance()) {
  const config = testConfig();
  const client = new RecordingLarkClient();
  const surface = createFeishuSurface({
    agent,
    governance,
    identity: createConfigIdentityResolver(config),
    config,
    client,
  });
  return { surface, client, agent, governance };
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "om_1",
    chatId: "oc_p2p_zhang",
    chatType: "p2p",
    senderOpenId: ZHANG,
    text: "/会后 今天和华东精密开会，对方确认方案，要求周三前出报价",
    mentionedBot: false,
    ...over,
  };
}

describe("B6① 消息 → reply 卡 + proposal 卡", () => {
  it("私聊（mentionedBot=false 也处理）：先 reply 后 proposal，均发往 chatId", async () => {
    const p = proposal({ id: "prop_b6" });
    const agent = new FakeAgent([runResult({ skill: "post-meeting", reply: "已生成更新提案", proposals: [p] })]);
    const { surface, client } = make(agent);

    await surface.handleMessage(msg());

    expect(agent.runs).toHaveLength(1);
    expect(agent.runs[0]).toMatchObject({
      text: "/会后 今天和华东精密开会，对方确认方案，要求周三前出报价",
      channel: "feishu",
      traceId: "fs_om_1",
      actor: { userId: ZHANG, tenantId: "demo", roles: ["rep"] },
    });
    expect(agent.runs[0]?.skill).toBeUndefined(); // 路由交给 agent（命令前缀）
    expect(client.sent.map((s) => s.card.kind)).toEqual(["reply", "proposal"]);
    expect(client.sent.every((s) => s.to.chatId === "oc_p2p_zhang")).toBe(true);
    expect(cardText(client.sent[0]!.card)).toContain("已生成更新提案");
    expect(cardText(client.sent[0]!.card)).toContain("内容由 AI 生成 · 测试 scripted");
    const pc = cardText(client.sent[1]!.card);
    expect(pc).toContain("同意");
    expect(pc).toContain("拒绝");
    expect(pc).toContain('"kaidan_action":"approve"');
    expect(pc).toContain('"proposal_id":"prop_b6"');
  });

  it("多个提案各发一张 proposal 卡；页脚取 AgentRunResult.disclosure", async () => {
    const agent = new FakeAgent([
      runResult({
        proposals: [proposal({ id: "prop_a" }), proposal({ id: "prop_b" })],
        disclosure: { providerName: "DeepSeek", modelName: "deepseek-chat", filingNo: "X-1" },
      }),
    ]);
    const { surface, client } = make(agent);
    await surface.handleMessage(msg());
    expect(client.sent.map((s) => s.card.kind)).toEqual(["reply", "proposal", "proposal"]);
    expect(cardText(client.sent[0]!.card)).toContain("内容由 AI 生成 · DeepSeek deepseek-chat · 备案号 X-1");
    expect(cardText(client.sent[2]!.card)).toContain('"proposal_id":"prop_b"');
  });

  it("群聊 @机器人 → 正常处理", async () => {
    const agent = new FakeAgent([runResult({ reply: "群里的回复" })]);
    const { surface, client } = make(agent);
    await surface.handleMessage(msg({ chatType: "group", chatId: "oc_group", mentionedBot: true, text: "/晨报" }));
    expect(agent.runs).toHaveLength(1);
    expect(client.sent.map((s) => [s.card.kind, s.to.chatId])).toEqual([["reply", "oc_group"]]);
  });

  it("agent 抛错 → 回一张 notice，不抛出", async () => {
    const agent = new FakeAgent([
      () => {
        throw new Error("boom");
      },
    ]);
    const { surface, client } = make(agent);
    await surface.handleMessage(msg());
    expect(client.sent.map((s) => s.card.kind)).toEqual(["notice"]);
  });
});

describe("B6② ③ 卡片审批回调", () => {
  it("② 本人同意 → notice 含「已写入」，调用 approvals.approve", async () => {
    const gov = new FakeGovernance([proposal({ id: "prop_1" })]);
    const { surface, client } = make(undefined, gov);
    const notice = await surface.handleCardAction({ proposalId: "prop_1", action: "approve", operatorOpenId: ZHANG });
    expect(notice.kind).toBe("notice");
    expect(cardText(notice)).toContain("已写入");
    expect(gov.calls).toEqual([{ op: "approve", proposalId: "prop_1", by: ZHANG }]);
    expect(gov.store.get("prop_1")?.status).toBe("committed");
    expect(client.sent).toHaveLength(0); // 返回卡片，不另发
  });

  it("拒绝 → notice 含「已拒绝」", async () => {
    const gov = new FakeGovernance([proposal({ id: "prop_1" })]);
    const { surface } = make(undefined, gov);
    const notice = await surface.handleCardAction({ proposalId: "prop_1", action: "reject", operatorOpenId: ZHANG });
    expect(cardText(notice)).toContain("已拒绝");
    expect(gov.store.get("prop_1")?.status).toBe("rejected");
  });

  it("③ 李四审批张三的提案 → notice「你无权审批该提案」，提案仍 pending", async () => {
    const gov = new FakeGovernance([proposal({ id: "prop_1" })]);
    const { surface } = make(undefined, gov);
    const notice = await surface.handleCardAction({ proposalId: "prop_1", action: "approve", operatorOpenId: LI });
    expect(notice.kind).toBe("notice");
    expect(cardText(notice)).toContain("你无权审批该提案");
    expect(gov.store.get("prop_1")?.status).toBe("pending");
  });

  it("上级经理可审批下属提案", async () => {
    const gov = new FakeGovernance([proposal({ id: "prop_1" })]);
    const { surface } = make(undefined, gov);
    const notice = await surface.handleCardAction({ proposalId: "prop_1", action: "approve", operatorOpenId: WANG });
    expect(cardText(notice)).toContain("已写入");
  });

  it("EXPIRED / CONFLICT / INVALID_STATE / 非 KaidanError → 对应文案", async () => {
    const gov = new FakeGovernance([proposal({ id: "prop_1" })]);
    const { surface } = make(undefined, gov);
    const act = () => surface.handleCardAction({ proposalId: "prop_1", action: "approve", operatorOpenId: ZHANG });

    gov.failWith.set("prop_1", new KaidanError(ErrorCode.EXPIRED, "过期"));
    expect(cardText(await act())).toContain("提案已过期");
    gov.failWith.set("prop_1", new KaidanError(ErrorCode.CONFLICT, "冲突"));
    expect(cardText(await act())).toContain("记录已被他人修改，请重新生成");
    gov.failWith.set("prop_1", new KaidanError(ErrorCode.INVALID_STATE, "状态"));
    expect(cardText(await act())).toContain("已处理过");
    gov.failWith.set("prop_1", new Error("db down"));
    const n = await act();
    expect(n.kind).toBe("notice");
    expect(cardText(n)).toContain("操作失败");
  });

  it("未开通的操作者 → notice，不调用审批", async () => {
    const gov = new FakeGovernance([proposal({ id: "prop_1" })]);
    const { surface } = make(undefined, gov);
    const n = await surface.handleCardAction({ proposalId: "prop_1", action: "approve", operatorOpenId: "ou_x" });
    expect(cardText(n)).toContain("还没有开通");
    expect(gov.calls).toHaveLength(0);
  });
});

describe("B6④ ⑤ 过滤", () => {
  it("④ 群聊未 @机器人 → 不调用 agent，不发卡片", async () => {
    const agent = new FakeAgent([runResult()]);
    const { surface, client } = make(agent);
    await surface.handleMessage(
      msg({ chatType: "group", chatId: "oc_group_sales", text: "大家下午好，今天的周会改到四点", mentionedBot: false }),
    );
    expect(agent.runs).toHaveLength(0);
    expect(client.sent).toHaveLength(0);
  });

  it("⑤ 未开通用户私聊 → 恰 1 张 notice（还没有开通），不调用 agent", async () => {
    const agent = new FakeAgent([runResult()]);
    const { surface, client } = make(agent);
    await surface.handleMessage(msg({ senderOpenId: "ou_stranger", chatId: "oc_p2p_stranger", text: "你好" }));
    expect(agent.runs).toHaveLength(0);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.card.kind).toBe("notice");
    expect(client.sent[0]!.to).toEqual({ chatId: "oc_p2p_stranger" });
    expect(cardText(client.sent[0]!.card)).toContain("还没有开通");
  });

  it("未开通用户在群里 @机器人 → 同样回 notice", async () => {
    const { surface, client, agent } = make(new FakeAgent([runResult()]));
    await surface.handleMessage(msg({ senderOpenId: "ou_stranger", chatType: "group", mentionedBot: true }));
    expect(agent.runs).toHaveLength(0);
    expect(client.sent.map((s) => s.card.kind)).toEqual(["notice"]);
  });
});

describe("B6⑥ runScheduled", () => {
  it("daily_brief：对 scheduled 用户依次以 channel=schedule 运行 daily-brief，reply 卡私聊发往 openId", async () => {
    const agent = new FakeAgent([
      runResult({ skill: "daily-brief", reply: "晨报（测试）：张三" }),
      runResult({ skill: "daily-brief", reply: "晨报（测试）：李四" }),
    ]);
    const { surface, client } = make(agent);

    expect(await surface.runScheduled("daily_brief")).toEqual({ sent: 2, failed: 0 });
    expect(agent.runs.map((r) => [r.actor.userId, r.skill, r.channel])).toEqual([
      [ZHANG, "daily-brief", "schedule"],
      [LI, "daily-brief", "schedule"],
    ]);
    expect(client.sent.map((s) => [s.card.kind, s.to.openId])).toEqual([
      ["reply", ZHANG],
      ["reply", LI],
    ]);
    expect(cardText(client.sent[1]!.card)).toContain("晨报（测试）：李四");
  });

  it("weekly_review → weekly-review 技能", async () => {
    const agent = new FakeAgent([runResult(), runResult()]);
    const { surface } = make(agent);
    await surface.runScheduled("weekly_review");
    expect(agent.runs.map((r) => r.skill)).toEqual(["weekly-review", "weekly-review"]);
  });

  it("单个用户失败不影响其他用户（agent 抛错 / 发送失败 / stoppedBy=error）", async () => {
    const agent = new FakeAgent([
      () => {
        throw new Error("boom");
      },
      runResult(),
    ]);
    const { surface, client } = make(agent);
    expect(await surface.runScheduled("daily_brief")).toEqual({ sent: 1, failed: 1 });
    expect(client.sent.map((s) => s.to.openId)).toEqual([LI]);

    const agent2 = new FakeAgent([runResult(), runResult({ stoppedBy: "error", reply: "模型暂时不可用" })]);
    const s2 = make(agent2);
    s2.client.failFor.add(ZHANG);
    expect(await s2.surface.runScheduled("daily_brief")).toEqual({ sent: 0, failed: 2 });
    expect(s2.client.sent).toHaveLength(0);
  });
});

// 待办 #11（第 1 轮报告第 5 节）：出错时正文是系统消息、不是模型生成的内容 → reply 卡不带模型公示。
// 两个方向都要断言：只断言「不含」会被「卡片压根没发」蒙混过去。
describe("出错时的 reply 卡不公示模型", () => {
  const SYSTEM_REPLY = "模型服务配置有误，请联系管理员检查模型配置。";

  it("stoppedBy=error：卡片仍然发出（正文是系统消息），但不含「内容由 AI 生成」", async () => {
    const agent = new FakeAgent([runResult({ reply: SYSTEM_REPLY, stoppedBy: "error" })]);
    const { surface, client } = make(agent);

    await surface.handleMessage(msg({ text: "今天有什么安排" }));

    expect(client.sent.map((s) => s.card.kind)).toEqual(["reply"]);
    const text = cardText(client.sent[0]!.card);
    expect(text).toContain(SYSTEM_REPLY);
    expect(text).not.toContain("内容由 AI 生成");
    // 页脚整段（含分隔线）都不该留下
    expect(text).not.toContain("测试 scripted");
    expect(text).not.toContain('"hr"');
  });

  it("stoppedBy=final：卡片照旧带「内容由 AI 生成 · …」页脚", async () => {
    const agent = new FakeAgent([runResult({ reply: "今天有 1 个会议。", stoppedBy: "final" })]);
    const { surface, client } = make(agent);

    await surface.handleMessage(msg({ text: "今天有什么安排" }));

    expect(client.sent.map((s) => s.card.kind)).toEqual(["reply"]);
    const text = cardText(client.sent[0]!.card);
    expect(text).toContain("今天有 1 个会议。");
    expect(text).toContain("内容由 AI 生成 · 测试 scripted");
  });

  it("max_steps / budget 提前结束的正文仍是模型生成 → 页脚保留", async () => {
    for (const stoppedBy of ["max_steps", "budget"] as const) {
      const agent = new FakeAgent([runResult({ reply: `到上限了（${stoppedBy}）`, stoppedBy })]);
      const { surface, client } = make(agent);
      await surface.handleMessage(msg({ text: "今天有什么安排" }));
      expect(cardText(client.sent[0]!.card)).toContain("内容由 AI 生成 · 测试 scripted");
    }
  });
});
