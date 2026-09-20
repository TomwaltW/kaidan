// serve 的启动自述：一眼看出连上了没有、连的是谁、还差什么没填。
// 字段名沿用 doctor 的说法（tenant / adapter / model / users），不另造一套。
import type { KaidanConfig, ModelDisclosure } from "@kaidan/contracts";
import { BOT_INFO_FAILURE_PREFIX } from "./feishu-error.js";
import type { LogLevel } from "./log.js";
import { LOG_LEVEL_ENV, describeError } from "./log.js";

/** 长连接订阅的事件与回调（与 deploy/README.md 1.2 节一致） */
export const SUBSCRIBED_EVENTS = "im.message.receive_v1（接收消息）、card.action.trigger（卡片回传交互）";

/**
 * 还没填的 open_id 占位符。
 * 派单点名的是 TODO_ 前缀；config/tenant.example.yaml 里实际用的是 ou_xxxx… / ou_yyyy… / ou_zzzz…，
 * 两种都算，免得用户照抄样例后启动时看不到提示。
 */
export function isPlaceholderOpenId(openId: string): boolean {
  const v = openId.trim();
  if (/^TODO[_-]/i.test(v)) return true;
  if (/^ou_(x+|y+|z+)$/i.test(v)) return true;
  return false;
}

export function placeholderOpenIds(config: KaidanConfig): string[] {
  return config.users.map((u) => u.openId).filter(isPlaceholderOpenId);
}

/** doctor 的 model 行：提供方 模型名（有备案号时追加） */
export function disclosureText(d: ModelDisclosure): string {
  return `${d.providerName} ${d.modelName}${d.filingNo ? ` · 备案号 ${d.filingNo}` : ""}`;
}

/** 机器人信息：拿到了 / 取失败（写明原因）/ 压根没走到那一步（写明卡在哪） */
export type BotInfo = { openId: string; name?: string } | { error: string } | { skipped: string };

export interface StartupBannerInput {
  config: KaidanConfig;
  bot: BotInfo;
  /** 长连接状态：已连接 / 正在建立… / 重连中 / 未建立 */
  connection: string;
  scheduleCount: number;
  logLevel: LogLevel;
}

/**
 * 取机器人信息失败的原因（供自述引用）。
 * fetchBotInfo 抛出的错误消息以 BOT_INFO_FAILURE_PREFIX 开头；别的错误返回 undefined。
 */
export function botFailureReason(e: unknown): string | undefined {
  const text = describeError(e);
  const at = text.indexOf(BOT_INFO_FAILURE_PREFIX);
  return at >= 0 ? text.slice(at + BOT_INFO_FAILURE_PREFIX.length) : undefined;
}

function botLine(bot: BotInfo): string {
  if ("error" in bot) return `bot: ${BOT_INFO_FAILURE_PREFIX}${bot.error}`;
  if ("skipped" in bot) return `bot: 未读取（${bot.skipped}）`;
  return `bot: ${bot.name ?? "（未返回名称）"}（open_id=${bot.openId}）`;
}

function usersLine(config: KaidanConfig): string {
  const todo = placeholderOpenIds(config);
  if (todo.length === 0) return `users: ${config.users.length}（open_id 都已填写）`;
  return (
    `users: ${config.users.length}，其中 ${todo.length} 个还是占位符 open_id，` +
    `请换成真实 open_id：${todo.join("、")}`
  );
}

function scheduleLine(config: KaidanConfig, count: number): string {
  const s = config.schedules;
  if (!s) return `定时任务: ${count}（配置里没有 schedules 段，不推晨报 / 周报）`;
  return `定时任务: ${count}（晨报 ${s.dailyBrief}；周报 ${s.weeklyReview}；时区 ${config.timezone}）`;
}

/** 启动自述，逐行返回（调用方决定写到哪个级别；一律 stderr） */
export function renderStartupBanner(input: StartupBannerInput): string[] {
  const { config } = input;
  return [
    "开单 serve 启动自述 ——",
    `tenant: ${config.tenantId}`,
    `adapter: ${config.adapter.kind}`,
    `model: ${disclosureText(config.llm.disclosure)}`,
    botLine(input.bot),
    `长连接: ${input.connection}`,
    `订阅: ${SUBSCRIBED_EVENTS}`,
    usersLine(config),
    scheduleLine(config, input.scheduleCount),
    `日志级别: ${input.logLevel}（详细日志：${LOG_LEVEL_ENV}=debug）`,
  ];
}
