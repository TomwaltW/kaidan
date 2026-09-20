// @kaidan/surface-feishu —— 飞书入口：长连接、消息、卡片、审批回调、定时任务、身份解析。
// 冻结导出（spec 3.2）：createFeishuSurface、createConfigIdentityResolver；其余为包内可复用的辅助。
export { createConfigIdentityResolver } from "./identity.js";
export {
  approvalErrorText,
  buildFeishuSurface,
  cardActionOutcome,
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
export { createLarkClient, fetchBotInfo, readFeishuCredentials, type BotInfo, type LarkImApi } from "./lark-client.js";
export { createSchedules, type ScheduleKind } from "./schedule.js";
export { RETRY_DELAYS_MS, isRateLimited, withRateLimitRetry } from "./retry.js";
// 真机排错用：分级日志、飞书错误码翻译、长连接状态、启动自述
export {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  LOG_LEVEL_ENV,
  createLogger,
  createSdkLogger,
  describeError,
  isLogLevel,
  resolveLogLevel,
  type LogLevel,
  type LogSink,
  type Logger,
} from "./log.js";
export {
  BOT_INFO_FAILURE_PREFIX,
  FEISHU_CALLS,
  FEISHU_CODE_HINTS,
  describeFeishuFailure,
  extractFeishuError,
  type FeishuCall,
  type FeishuErrorInfo,
} from "./feishu-error.js";
export {
  APP_ID_PATTERN,
  WS_READY_TIMEOUT_MS,
  checkAppIdFormat,
  createConnectionWatch,
  wsStateText,
  type ConnectionWatch,
  type TimerApi,
  type WsStatusHooks,
} from "./connection.js";
export {
  SUBSCRIBED_EVENTS,
  botFailureReason,
  disclosureText,
  isPlaceholderOpenId,
  placeholderOpenIds,
  renderStartupBanner,
  type BotInfo as StartupBotInfo,
  type StartupBannerInput,
} from "./startup.js";
