// @kaidan/surface-feishu —— 飞书入口：长连接、消息、卡片、审批回调、定时任务、身份解析。
// 冻结导出（spec 3.2）：createFeishuSurface、createConfigIdentityResolver；其余为包内可复用的辅助。
export { createConfigIdentityResolver } from "./identity.js";
export {
  approvalErrorText,
  buildFeishuSurface,
  createFeishuSurface,
  type FeishuConnection,
  type FeishuEventHandlers,
  type FeishuSurfaceOptions,
} from "./surface.js";
export {
  NOTICE_TEXT,
  PROPOSAL_CARD_TITLE,
  buildNoticeCard,
  buildProposalCard,
  buildReplyCard,
  disclosureFooter,
  type ReplyCardOptions,
} from "./cards.js";
export { parseCardActionEvent, parseMessageEvent, type ParsedCardAction } from "./parse.js";
export { createLarkClient, readFeishuCredentials, type LarkImApi } from "./lark-client.js";
export { createSchedules, type ScheduleKind } from "./schedule.js";
export { RETRY_DELAYS_MS, isRateLimited, withRateLimitRetry } from "./retry.js";
