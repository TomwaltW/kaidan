// @kaidan/contracts — surface.ts（冻结）
import type { Actor } from "./rom.js";
import type { AgentRuntime } from "./agent.js";
import type { Governance } from "./governance.js";
import type { KaidanConfig } from "./config.js";

export interface IdentityResolver {
  /** 不在 config.users 里 → null。manager 的 teamIds = 所有 managerOpenId 指向他的用户 */
  resolveByOpenId(openId: string): Promise<Actor | null>;
  /** config.users 中 scheduled=true 的用户 */
  listScheduled(): Promise<Actor[]>;
}

export interface InboundMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  text: string; // 已去掉 @机器人 的文本
  mentionedBot: boolean;
}

/** 审批卡片按钮 value 的固定形状（飞书回调里原样带回） */
export interface ProposalButtonValue {
  kaidan_action: "approve" | "reject";
  proposal_id: string;
}

export interface CardAction {
  proposalId: string;
  action: "approve" | "reject";
  operatorOpenId: string;
}

export interface OutboundCard {
  kind: "reply" | "proposal" | "notice";
  /** 飞书卡片 JSON（schema 2.0）；proposal 卡片必须含"同意""拒绝"两个按钮，value 为 ProposalButtonValue */
  json: Record<string, unknown>;
}

export interface LarkClientLike {
  sendCard(to: { chatId?: string; openId?: string }, card: OutboundCard): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: OutboundCard): Promise<void>;
}

/**
 * 行为规则：
 *  - 群聊里未 @机器人 → 忽略（不调用 agent，不发卡片）
 *  - 发送者不在 config.users → 回一张 notice 卡片"你还没有开通开单助手，请联系管理员"，不调用 agent
 *  - 正常消息 → agent.run → 先发 reply 卡片（正文 + 页脚模型公示），再为每个提案各发一张 proposal 卡片
 *  - reply 卡片页脚格式："内容由 AI 生成 · {providerName} {modelName}" + （有 filingNo 时）" · 备案号 {filingNo}"
 *  - handleCardAction：调用 approvals.approve/reject；成功返回 notice 卡片（approve 文案含"已写入"，reject 含"已拒绝"）；
 *    KaidanError 返回 notice 卡片说明原因（PERMISSION_DENIED→"你无权审批该提案"，EXPIRED→"提案已过期"，CONFLICT→"记录已被他人修改，请重新生成"）
 *  - runScheduled：对 identity.listScheduled() 的每个用户以 channel="schedule" 运行对应技能（daily_brief→daily-brief，weekly_review→weekly-review），
 *    私聊发送 reply 卡片；单个用户失败不影响其他用户
 */
export interface SurfaceHandlers {
  handleMessage(msg: InboundMessage): Promise<void>;
  handleCardAction(a: CardAction): Promise<OutboundCard>;
  runScheduled(kind: "daily_brief" | "weekly_review"): Promise<{ sent: number; failed: number }>;
}

export interface Surface extends SurfaceHandlers {
  /** 建立飞书长连接 + 启动定时任务 */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SurfaceDeps {
  agent: AgentRuntime;
  governance: Governance;
  identity: IdentityResolver;
  config: KaidanConfig;
  client?: LarkClientLike; // 测试注入 fake；缺省用 @larksuiteoapi/node-sdk 实现
}
