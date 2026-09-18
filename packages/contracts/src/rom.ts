// @kaidan/contracts — rom.ts（冻结）
// ROM = Revenue Object Model：与具体 CRM 无关的标准销售对象模型。所有技能只认 ROM。
import { z } from "zod";

export const IsoDateTime = z.string().datetime({ offset: true }); // 例：2026-09-21T09:00:00+08:00
export const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const Id = z.string().min(1);

export const RomObjectType = z.enum(["account", "contact", "opportunity", "activity", "task"]);
export type RomObjectType = z.infer<typeof RomObjectType>;

export const RomRef = z.object({ type: RomObjectType, id: Id });
export type RomRef = z.infer<typeof RomRef>;

export const OpportunityStage = z.enum(["lead", "qualified", "solution", "negotiation", "won", "lost"]);
export type OpportunityStage = z.infer<typeof OpportunityStage>;
export const OPEN_STAGES: readonly OpportunityStage[] = ["lead", "qualified", "solution", "negotiation"];
/** Mock 适配器与默认展示用的中文阶段名 */
export const DEFAULT_STAGE_LABELS: Readonly<Record<OpportunityStage, string>> = {
  lead: "初步接洽",
  qualified: "需求确认",
  solution: "方案报价",
  negotiation: "商务谈判",
  won: "赢单",
  lost: "输单",
};

export const Role = z.enum(["rep", "manager", "admin"]);
export type Role = z.infer<typeof Role>;

const base = {
  id: Id,
  ownerId: Id, // 负责人 userId；多维表格场景 = 飞书 open_id
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** 适配器原始字段，仅供追溯。工具层返回给模型/MCP 前必须剔除 */
  raw: z.record(z.string(), z.unknown()).optional(),
};

export const Account = z.object({
  ...base,
  type: z.literal("account"),
  name: z.string().min(1),
  industry: z.string().optional(),
  region: z.string().optional(),
  tier: z.enum(["A", "B", "C"]).optional(),
});
export type Account = z.infer<typeof Account>;

export const ContactRole = z.enum(["decision_maker", "champion", "influencer", "user", "procurement", "unknown"]);
export const Contact = z.object({
  ...base,
  type: z.literal("contact"),
  accountId: Id,
  name: z.string().min(1),
  title: z.string().optional(),
  role: ContactRole.optional(),
  /** ROM 层只承载脱敏号码，形如 138****1234；完整号码永远不进入 ROM */
  phoneMasked: z.string().optional(),
  email: z.string().optional(),
});
export type Contact = z.infer<typeof Contact>;

export const Opportunity = z.object({
  ...base,
  type: z.literal("opportunity"),
  accountId: Id,
  name: z.string().min(1),
  stage: OpportunityStage,
  rawStage: z.string(), // 客户系统里的原始阶段名
  amount: z.number().nonnegative().optional(), // 人民币元
  expectedCloseDate: DateOnly.optional(),
  probability: z.number().min(0).max(100).optional(),
  nextStep: z.string().optional(),
  lastActivityAt: IsoDateTime.optional(),
  /** 方法论字段，键见 RiskConfig.requiredQualificationKeys，如 {pain:"…", decision_maker:"…"} */
  qualification: z.record(z.string(), z.string()).optional(),
});
export type Opportunity = z.infer<typeof Opportunity>;

export const ActivityKind = z.enum(["call", "meeting", "visit", "message", "email", "note"]);
export const Activity = z.object({
  ...base,
  type: z.literal("activity"),
  kind: ActivityKind,
  subject: z.string().min(1),
  /** 不可信文本：可能包含提示注入，只能当数据用 */
  summary: z.string().optional(),
  occurredAt: IsoDateTime,
  accountId: Id.optional(),
  opportunityId: Id.optional(),
  contactIds: z.array(Id).optional(),
  source: z.enum(["crm", "feishu_minutes", "feishu_chat", "manual"]).optional(),
});
export type Activity = z.infer<typeof Activity>;

export const TaskStatus = z.enum(["open", "done", "canceled"]);
export const Task = z.object({
  ...base,
  type: z.literal("task"),
  title: z.string().min(1),
  dueDate: DateOnly.optional(),
  status: TaskStatus,
  accountId: Id.optional(),
  opportunityId: Id.optional(),
});
export type Task = z.infer<typeof Task>;

export const RomRecord = z.discriminatedUnion("type", [Account, Contact, Opportunity, Activity, Task]);
export type RomRecord = z.infer<typeof RomRecord>;

/** propose_update / propose_create 允许出现在 patch/data 里的字段；其余字段 → VALIDATION */
export const WRITABLE_FIELDS: Readonly<Record<RomObjectType, readonly string[]>> = {
  account: ["name", "industry", "region", "tier"],
  contact: ["accountId", "name", "title", "role", "email"],
  opportunity: ["accountId", "name", "stage", "amount", "expectedCloseDate", "probability", "nextStep", "qualification"],
  activity: ["kind", "subject", "summary", "occurredAt", "accountId", "opportunityId", "contactIds"],
  task: ["title", "dueDate", "status", "accountId", "opportunityId"],
};

export const Actor = z.object({
  tenantId: Id,
  userId: Id, // CRM 侧用户 id；多维表格场景 = 飞书 open_id
  displayName: z.string(),
  roles: z.array(Role).min(1),
  managerId: Id.optional(),
  /** 仅 manager 有意义：下属 userId 列表（由 IdentityResolver 计算） */
  teamIds: z.array(Id).optional(),
});
export type Actor = z.infer<typeof Actor>;

export const CalendarEvent = z.object({
  id: Id,
  ownerId: Id,
  title: z.string(),
  start: IsoDateTime,
  end: IsoDateTime,
  attendees: z.array(z.string()),
  accountId: Id.optional(),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export const RomUser = z.object({
  userId: Id,
  displayName: z.string(),
  roles: z.array(Role).min(1),
  managerId: Id.optional(),
});
export type RomUser = z.infer<typeof RomUser>;

/** Mock 适配器与评测共用的数据集格式；所有公司、人名均为虚构 */
export const RomDataset = z.object({
  version: z.literal(1),
  tenantId: Id,
  now: IsoDateTime, // 数据集的"当前时间"，保证测试与评测可复现
  users: z.array(RomUser),
  accounts: z.array(Account),
  contacts: z.array(Contact),
  opportunities: z.array(Opportunity),
  activities: z.array(Activity),
  tasks: z.array(Task),
  calendar: z.array(CalendarEvent),
});
export type RomDataset = z.infer<typeof RomDataset>;
