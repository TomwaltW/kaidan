// 载荷解析：im.message.receive_v1 → InboundMessage；card.action.trigger → CardAction。
// 样例载荷为 SDK EventDispatcher 展平后的形状（header 字段与 event 字段合并在顶层）。
import { describe, expect, it } from "vitest";
import { parseCardActionEvent, parseMessageEvent } from "../src/index.js";

const BOT = "ou_bot_kaidan";

function messageEvent(over: {
  chatType?: string;
  messageType?: string;
  content?: string;
  mentions?: { key: string; id: { open_id: string }; name: string }[];
  senderType?: string;
}) {
  return {
    schema: "2.0",
    event_id: "ev_abc",
    event_type: "im.message.receive_v1",
    create_time: "1789000000000",
    tenant_key: "tk_demo",
    app_id: "cli_demo",
    sender: {
      sender_id: { open_id: "ou_rep_zhang", union_id: "on_x", user_id: "u_x" },
      sender_type: over.senderType ?? "user",
      tenant_key: "tk_demo",
    },
    message: {
      message_id: "om_1",
      create_time: "1789000000000",
      chat_id: "oc_chat_1",
      chat_type: over.chatType ?? "p2p",
      message_type: over.messageType ?? "text",
      content: over.content ?? JSON.stringify({ text: "/晨报" }),
      ...(over.mentions ? { mentions: over.mentions } : {}),
    },
  };
}

describe("parseMessageEvent", () => {
  it("私聊文本：content 是 JSON 字符串，解析出 text", () => {
    const m = parseMessageEvent(messageEvent({ content: JSON.stringify({ text: "  /会后 今天拜访了客户 " }) }), BOT);
    expect(m).toEqual({
      messageId: "om_1",
      chatId: "oc_chat_1",
      chatType: "p2p",
      senderOpenId: "ou_rep_zhang",
      text: "/会后 今天拜访了客户",
      mentionedBot: false,
    });
  });

  it("群聊 @机器人：去掉机器人占位符，mentionedBot=true", () => {
    const m = parseMessageEvent(
      messageEvent({
        chatType: "group",
        content: JSON.stringify({ text: "@_user_1 /晨报" }),
        mentions: [{ key: "@_user_1", id: { open_id: BOT }, name: "开单助手" }],
      }),
      BOT,
    );
    expect(m?.chatType).toBe("group");
    expect(m?.mentionedBot).toBe(true);
    expect(m?.text).toBe("/晨报");
  });

  it("群聊 @的是别人：mentionedBot=false，别人的占位符换成 @名字", () => {
    const m = parseMessageEvent(
      messageEvent({
        chatType: "group",
        content: JSON.stringify({ text: "@_user_1 下午开会" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_rep_li" }, name: "李四" }],
      }),
      BOT,
    );
    expect(m?.mentionedBot).toBe(false);
    expect(m?.text).toBe("@李四 下午开会");
  });

  it("群聊同时 @机器人与别人：只去掉机器人", () => {
    const m = parseMessageEvent(
      messageEvent({
        chatType: "group",
        content: JSON.stringify({ text: "@_user_1 帮我看下 @_user_2 的商机" }),
        mentions: [
          { key: "@_user_1", id: { open_id: BOT }, name: "开单助手" },
          { key: "@_user_2", id: { open_id: "ou_rep_li" }, name: "李四" },
        ],
      }),
      BOT,
    );
    expect(m?.mentionedBot).toBe(true);
    expect(m?.text).toBe("帮我看下 @李四 的商机");
  });

  it("机器人 open_id 未知时不会误判为 @机器人", () => {
    const m = parseMessageEvent(
      messageEvent({
        chatType: "group",
        content: JSON.stringify({ text: "@_user_1 hi" }),
        mentions: [{ key: "@_user_1", id: { open_id: BOT }, name: "开单助手" }],
      }),
      undefined,
    );
    expect(m?.mentionedBot).toBe(false);
  });

  it("非文本消息、机器人发的消息、坏 JSON → null", () => {
    expect(parseMessageEvent(messageEvent({ messageType: "image", content: '{"image_key":"x"}' }), BOT)).toBeNull();
    expect(parseMessageEvent(messageEvent({ senderType: "app" }), BOT)).toBeNull();
    expect(parseMessageEvent(messageEvent({ content: "not json" }), BOT)).toBeNull();
    expect(parseMessageEvent({}, BOT)).toBeNull();
    expect(parseMessageEvent(null, BOT)).toBeNull();
  });
});

describe("parseCardActionEvent", () => {
  const v2 = (value: unknown) => ({
    schema: "2.0",
    event_type: "card.action.trigger",
    token: "c-xxx",
    operator: { open_id: "ou_rep_zhang", user_id: "u_x", union_id: "on_x" },
    action: { tag: "button", value },
    host: "im_message",
    context: { open_message_id: "om_card_1", open_chat_id: "oc_chat_1" },
  });

  it("card.action.trigger v2：取 action.value、operator.open_id、context.open_message_id", () => {
    const r = parseCardActionEvent(v2({ kaidan_action: "approve", proposal_id: "prop_1" }));
    expect(r).toEqual({
      action: { proposalId: "prop_1", action: "approve", operatorOpenId: "ou_rep_zhang" },
      messageId: "om_card_1",
      chatId: "oc_chat_1",
    });
  });

  it("reject 按钮；value 为 JSON 字符串也能解析", () => {
    const r = parseCardActionEvent(v2(JSON.stringify({ kaidan_action: "reject", proposal_id: "prop_2" })));
    expect(r?.action).toEqual({ proposalId: "prop_2", action: "reject", operatorOpenId: "ou_rep_zhang" });
  });

  it("旧形状兜底：顶层 open_id / open_message_id", () => {
    const r = parseCardActionEvent({
      open_id: "ou_rep_li",
      open_message_id: "om_old",
      action: { tag: "button", value: { kaidan_action: "approve", proposal_id: "prop_3" } },
    });
    expect(r?.action.operatorOpenId).toBe("ou_rep_li");
    expect(r?.messageId).toBe("om_old");
  });

  it("value 不是 ProposalButtonValue → null", () => {
    expect(parseCardActionEvent(v2({ kaidan_action: "delete", proposal_id: "p" }))).toBeNull();
    expect(parseCardActionEvent(v2({ kaidan_action: "approve" }))).toBeNull();
    expect(parseCardActionEvent(v2("not json"))).toBeNull();
    expect(parseCardActionEvent({ action: { value: { kaidan_action: "approve", proposal_id: "p" } } })).toBeNull();
  });
});
