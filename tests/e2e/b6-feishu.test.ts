// B6 飞书入口（spec 2.2）：消息 → 卡片、卡片审批回调、群聊过滤、未开通用户、定时晨报。飞书客户端为记录型 fake。
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptStep } from "@kaidan/contracts";
import {
  LI,
  TENANT,
  ZHANG,
  actor,
  auditOf,
  cardText,
  opportunity,
  postMeetingScript,
  proposeUpdate,
  setup,
  teardown,
} from "./harness.js";

afterEach(teardown);

describe("B6 飞书入口", () => {
  it("① 张三私聊 /会后 → reply 卡 + proposal 卡；② 张三在卡片上同意 → notice 已写入", async () => {
    const h = await setup(postMeetingScript());

    await h.app.surface.handleMessage({
      messageId: "om_b6_1",
      chatId: "oc_p2p_zhang",
      chatType: "p2p",
      senderOpenId: ZHANG,
      text: "/会后 今天和华东精密开会，对方确认方案，要求周三前出报价",
      mentionedBot: false,
    });

    const pending = await h.app.governance.proposals.listPending(TENANT, ZHANG);
    expect(pending).toHaveLength(1);
    const pid = pending[0]!.id;

    // fake 依次收到 2 张卡：reply（带模型公示页脚）→ proposal（同意 / 拒绝按钮，value 带提案 id）
    expect(h.lark.sent.map((s) => s.card.kind)).toEqual(["reply", "proposal"]);
    expect(cardText(h.lark.sent[0]!.card)).toContain("内容由 AI 生成 · 测试 scripted");
    const proposalCard = cardText(h.lark.sent[1]!.card);
    expect(proposalCard).toContain("同意");
    expect(proposalCard).toContain("拒绝");
    expect(proposalCard).toContain('"kaidan_action":"approve"');
    expect(proposalCard).toContain(`"proposal_id":"${pid}"`);

    // 按命令路由到 post-meeting
    const invoked = await auditOf(h, { type: "skill_invoked" });
    expect(invoked.map((e) => e.data["skill"])).toEqual(["post-meeting"]);

    // ② 同意 → notice 含"已写入"，CRM 已更新
    const notice = await h.app.surface.handleCardAction({ proposalId: pid, action: "approve", operatorOpenId: ZHANG });
    expect(notice.kind).toBe("notice");
    expect(cardText(notice)).toContain("已写入");
    expect(opportunity(h, "opp_1").stage).toBe("negotiation");
  });

  it("③ 李四对张三的提案点同意 → notice：你无权审批该提案", async () => {
    const h = await setup();
    const zhang = await actor(h, ZHANG);
    const pid = await proposeUpdate(h, zhang, "opp_2", { nextStep: "法务已回复，准备签约" });

    const notice = await h.app.surface.handleCardAction({ proposalId: pid, action: "approve", operatorOpenId: LI });
    expect(notice.kind).toBe("notice");
    expect(cardText(notice)).toContain("你无权审批该提案");
  });

  it("④ 群聊里没有 @ 机器人的消息 → 不发卡片、不调用模型", async () => {
    const h = await setup([{ content: "不应该被调用" }]);
    const requestsBefore = h.provider.requests.length;

    await h.app.surface.handleMessage({
      messageId: "om_b6_4",
      chatId: "oc_group_sales",
      chatType: "group",
      senderOpenId: ZHANG,
      text: "大家下午好，今天的周会改到四点",
      mentionedBot: false,
    });

    expect(h.lark.sent).toHaveLength(0);
    expect(h.provider.requests.length).toBe(requestsBefore);
  });

  it("⑤ 未开通的用户私聊 → 恰 1 张 notice（还没有开通），不调用模型", async () => {
    const h = await setup([{ content: "不应该被调用" }]);

    await h.app.surface.handleMessage({
      messageId: "om_b6_5",
      chatId: "oc_p2p_stranger",
      chatType: "p2p",
      senderOpenId: "ou_stranger",
      text: "你好，帮我看看今天的日程",
      mentionedBot: false,
    });

    expect(h.lark.sent).toHaveLength(1);
    expect(h.lark.sent[0]!.card.kind).toBe("notice");
    expect(cardText(h.lark.sent[0]!.card)).toContain("还没有开通");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("⑥ runScheduled(daily_brief)：两位 scheduled 用户各收到 1 张 reply 卡", async () => {
    const brief = (who: string): ScriptStep[] => [
      { toolCalls: [{ name: "calendar_today", arguments: {} }] },
      { content: `晨报（测试）：${who}` },
    ];
    const h = await setup([...brief("张三"), ...brief("李四")]);

    const r = await h.app.surface.runScheduled("daily_brief");

    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(h.lark.sent.map((s) => [s.card.kind, s.to.openId])).toEqual([
      ["reply", ZHANG],
      ["reply", LI],
    ]);
  });
});
