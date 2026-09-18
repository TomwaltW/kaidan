// 飞书事件 / 回调载荷解析（纯函数）。
// 载荷形状以 @larksuiteoapi/node-sdk 1.74 的类型定义为准：
//  - im.message.receive_v1：IHandles["im.message.receive_v1"] 的参数（EventDispatcher 已把 header 与 event 展平）
//  - card.action.trigger：RawCardActionEvent（operator.open_id、action.value、context.open_message_id，顶层字段为兜底）
import type { CardAction, InboundMessage } from "@kaidan/contracts";

export interface MessageReceiveEvent {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key: string; id?: { open_id?: string }; name?: string }>;
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * im.message.receive_v1 → InboundMessage。
 * 只处理用户发来的文本消息（content 是 JSON 字符串 {"text":"..."}）；其他情况返回 null。
 * 群聊：mentionedBot = mentions 里有机器人自己的 open_id；机器人占位符去掉，其他人的占位符换成 @名字。
 */
export function parseMessageEvent(data: unknown, botOpenId: string | undefined): InboundMessage | null {
  if (!isRecord(data)) return null;
  const ev = data as MessageReceiveEvent;
  const m = ev.message;
  const senderOpenId = ev.sender?.sender_id?.open_id;
  if (!m || !m.message_id || !m.chat_id || !senderOpenId) return null;
  if (ev.sender?.sender_type !== undefined && ev.sender.sender_type !== "user") return null;
  if (m.message_type !== "text") return null;
  const chatType = m.chat_type === "p2p" ? "p2p" : m.chat_type === "group" ? "group" : null;
  if (!chatType) return null;

  let text = "";
  try {
    const parsed: unknown = JSON.parse(m.content ?? "");
    if (isRecord(parsed) && typeof parsed["text"] === "string") text = parsed["text"];
  } catch {
    return null;
  }

  let mentionedBot = false;
  for (const mention of m.mentions ?? []) {
    const isBot = botOpenId !== undefined && mention.id?.open_id === botOpenId;
    if (isBot) mentionedBot = true;
    text = text.split(mention.key).join(isBot ? " " : `@${mention.name ?? ""}`);
  }
  text = text.replace(/\s+/g, " ").trim();

  return {
    messageId: m.message_id,
    chatId: m.chat_id,
    chatType,
    senderOpenId,
    text,
    mentionedBot,
  };
}

export interface ParsedCardAction {
  action: CardAction;
  /** 被点击的卡片所在消息 id；用于以新卡片替换原卡片 */
  messageId?: string;
  chatId?: string;
}

/** card.action.trigger 回调 → CardAction。value 不是 ProposalButtonValue 形状时返回 null */
export function parseCardActionEvent(data: unknown): ParsedCardAction | null {
  if (!isRecord(data)) return null;
  const operator = isRecord(data["operator"]) ? data["operator"] : undefined;
  const operatorOpenId =
    (typeof operator?.["open_id"] === "string" ? operator["open_id"] : undefined) ??
    (typeof data["open_id"] === "string" ? data["open_id"] : undefined);
  const action = isRecord(data["action"]) ? data["action"] : undefined;
  let value: unknown = action?.["value"];
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!operatorOpenId || !isRecord(value)) return null;
  const kind = value["kaidan_action"];
  const proposalId = value["proposal_id"];
  if ((kind !== "approve" && kind !== "reject") || typeof proposalId !== "string" || proposalId === "") return null;

  const context = isRecord(data["context"]) ? data["context"] : undefined;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const messageId = str(context?.["open_message_id"]) ?? str(data["open_message_id"]);
  const chatId = str(context?.["open_chat_id"]) ?? str(data["open_chat_id"]);

  const out: ParsedCardAction = { action: { proposalId, action: kind, operatorOpenId } };
  if (messageId) out.messageId = messageId;
  if (chatId) out.chatId = chatId;
  return out;
}
