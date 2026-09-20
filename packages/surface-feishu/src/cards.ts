// 飞书卡片构建（spec 附录 D）：卡片 JSON 2.0，三类 —— reply / proposal / notice。
// 注意：按钮回调 value 必须是嵌套对象（ProposalButtonValue），不要预先 JSON.stringify。
import {
  DEFAULT_STAGE_LABELS,
  OpportunityStage,
  type ModelDisclosure,
  type OutboundCard,
  type Proposal,
  type ProposalButtonValue,
  type RomObjectType,
} from "@kaidan/contracts";

/** 固定文案（附录 D） */
export const NOTICE_TEXT = {
  approved: "已写入 CRM",
  rejected: "已拒绝",
  permissionDenied: "你无权审批该提案",
  expired: "提案已过期",
  conflict: "记录已被他人修改，请重新生成",
  notEnabled: "你还没有开通开单助手，请联系管理员",
  invalidState: "该提案已处理过，不能再次操作",
  notFound: "找不到该提案，可能已被清理",
  failed: "操作失败，请稍后重试",
  agentFailed: "处理出错了，请稍后重试",
} as const;

export const PROPOSAL_CARD_TITLE = "待确认的 CRM 更新";

/** reply 卡页脚："内容由 AI 生成 · {providerName} {modelName}"（有 filingNo 时追加 " · 备案号 {filingNo}"） */
export function disclosureFooter(d: ModelDisclosure): string {
  const base = `内容由 AI 生成 · ${d.providerName} ${d.modelName}`;
  return d.filingNo ? `${base} · 备案号 ${d.filingNo}` : base;
}

function card(elements: Record<string, unknown>[], header?: Record<string, unknown>): Record<string, unknown> {
  const json: Record<string, unknown> = {
    schema: "2.0",
    config: { update_multi: true },
  };
  if (header) json["header"] = header;
  json["body"] = { elements };
  return json;
}

export interface ReplyCardOptions {
  /** 缺省 true；为 false 时不加分隔线与模型公示页脚（正文不是模型生成的内容时用） */
  showDisclosure?: boolean;
}

export function buildReplyCard(
  reply: string,
  disclosure: ModelDisclosure,
  opts: ReplyCardOptions = {},
): OutboundCard {
  const text = reply.trim() === "" ? "（没有可展示的内容）" : reply;
  const elements: Record<string, unknown>[] = [{ tag: "markdown", content: text }];
  if (opts.showDisclosure !== false) {
    elements.push(
      { tag: "hr" },
      { tag: "markdown", content: disclosureFooter(disclosure), text_size: "notation", text_color: "grey" },
    );
  }
  return { kind: "reply", json: card(elements) };
}

export function buildNoticeCard(text: string): OutboundCard {
  return { kind: "notice", json: card([{ tag: "markdown", content: text }]) };
}

const OBJECT_LABELS: Readonly<Record<RomObjectType, string>> = {
  account: "客户",
  contact: "联系人",
  opportunity: "商机",
  activity: "活动",
  task: "任务",
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "名称",
  industry: "行业",
  region: "地区",
  tier: "等级",
  accountId: "所属客户",
  title: "标题/职位",
  role: "角色",
  email: "邮箱",
  stage: "阶段",
  amount: "金额（元）",
  expectedCloseDate: "预计成交日期",
  probability: "赢率（%）",
  nextStep: "下一步",
  qualification: "资格要素",
  kind: "类型",
  subject: "主题",
  summary: "摘要",
  occurredAt: "发生时间",
  opportunityId: "关联商机",
  contactIds: "联系人",
  dueDate: "截止日期",
  status: "状态",
};

function formatValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "（空）";
  if (field === "stage") {
    const parsed = OpportunityStage.safeParse(v);
    if (parsed.success) return DEFAULT_STAGE_LABELS[parsed.data];
  }
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** 过期时间按租户时区展示，如 2026-09-22 09:00 */
export function formatDateTime(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function button(label: string, type: "primary" | "danger", value: ProposalButtonValue): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

export function buildProposalCard(p: Proposal, timezone: string): OutboundCard {
  const target = p.kind === "update" ? (p.targetId ?? "（未知）") : "新建记录";
  const lines = [
    `**对象**：${OBJECT_LABELS[p.objectType]}`,
    `**目标**：${target}`,
    "**变更**：",
    ...p.diff.map(
      (d) => `- ${FIELD_LABELS[d.field] ?? d.field}：${formatValue(d.field, d.before)} → ${formatValue(d.field, d.after)}`,
    ),
    `**理由**：${p.reason}`,
    `**过期时间**：${formatDateTime(p.expiresAt, timezone)}`,
    "点「同意」后才会写入 CRM。",
  ];
  const approve: ProposalButtonValue = { kaidan_action: "approve", proposal_id: p.id };
  const reject: ProposalButtonValue = { kaidan_action: "reject", proposal_id: p.id };
  return {
    kind: "proposal",
    json: card(
      [
        { tag: "markdown", content: lines.join("\n") },
        {
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "default",
          columns: [
            { tag: "column", width: "auto", elements: [button("同意", "primary", approve)] },
            { tag: "column", width: "auto", elements: [button("拒绝", "danger", reject)] },
          ],
        },
      ],
      { title: { tag: "plain_text", content: PROPOSAL_CARD_TITLE }, template: "orange" },
    ),
  };
}
