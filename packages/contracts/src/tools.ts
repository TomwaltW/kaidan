// @kaidan/contracts — tools.ts（冻结）
// 设计取自 Headless 360 的教训：工具面要小而稳定；数字由确定性代码算，模型只负责解释与建议。
import { z } from "zod";
import { ErrorCode } from "./errors.js";
import {
  Actor, Activity, CalendarEvent, DateOnly, Id, IsoDateTime, Opportunity,
  OpportunityStage, RomObjectType, RomRecord, RomRef,
} from "./rom.js";
import { RomQuery, SchemaInfo, type RomAdapter } from "./adapter.js";
import { FieldDiff, type AuditLog, type ProposalService } from "./governance.js";
import { Task } from "./rom.js";

export const ToolName = z.enum([
  "crm_search",
  "crm_get",
  "crm_timeline",
  "pipeline_snapshot",
  "propose_update",
  "propose_create",
  "calendar_today",
  "schema_inspect",
]);
export type ToolName = z.infer<typeof ToolName>;

export const CrmSearchInput = RomQuery;
export const CrmSearchOutput = z.object({ items: z.array(RomRecord), nextCursor: z.string().optional() });

export const CrmGetInput = RomRef;
export const CrmGetOutput = z.object({ item: RomRecord.nullable() });

export const CrmTimelineInput = z.object({
  accountId: Id.optional(),
  opportunityId: Id.optional(), // 两者至少给一个，否则 VALIDATION
  limit: z.number().int().min(1).max(50).optional(), // 跟进记录每页条数，缺省 20，按 occurredAt 倒序
  cursor: z.string().optional(), // 跟进记录翻页：传上一页的 nextCursor
  tasksLimit: z.number().int().min(1).max(100).optional(), // 待办每页条数，缺省 50（= 第 2 轮的行为），按 dueDate 升序
  tasksCursor: z.string().optional(), // 待办翻页：传上一页的 tasksNextCursor
});
export const CrmTimelineOutput = z.object({
  activities: z.array(Activity),
  tasks: z.array(Task),
  nextCursor: z.string().optional(), // 还有更多跟进记录；没有下一页时不出现这个键
  tasksNextCursor: z.string().optional(), // 还有更多待办；没有下一页时不出现这个键
});

export const RiskReason = z.enum([
  "stale_activity", // 未关闭且 lastActivityAt 缺失或早于 now - staleDays
  "close_date_passed", // 未关闭且 expectedCloseDate < 今天
  "close_date_soon_no_next_step", // 未关闭、expectedCloseDate 在 [今天, 今天+soonDays] 且 nextStep 为空
  "stuck_in_stage", // 未关闭且 updatedAt 早于 now - stuckDays
  "missing_qualification", // stage ∈ {solution, negotiation} 且缺少任一 requiredQualificationKeys
]);
export type RiskReason = z.infer<typeof RiskReason>;

export const PipelineSnapshotInput = z.object({
  scope: z.enum(["me", "team"]), // team 仅 manager/admin；rep 传 team → PERMISSION_DENIED
  closingWithinDays: z.number().int().min(1).max(180).optional(), // 缺省 30
});
export const PipelineSnapshotOutput = z.object({
  asOf: IsoDateTime,
  scope: z.enum(["me", "team"]),
  /** 只统计未关闭阶段，顺序固定为 OPEN_STAGES */
  byStage: z.array(z.object({ stage: OpportunityStage, count: z.number().int(), amount: z.number() })),
  openAmount: z.number(),
  /** 未关闭且 expectedCloseDate ∈ [今天, 今天+closingWithinDays]，按 expectedCloseDate 升序，同日按 id 升序 */
  closingSoon: z.array(Opportunity),
  /** 至少命中一条风险规则的未关闭商机，按 id 升序；reasons 按 RiskReason 枚举顺序 */
  atRisk: z.array(z.object({ opportunityId: Id, name: z.string(), reasons: z.array(RiskReason) })),
});

export const ProposeUpdateInput = z.object({
  ref: RomRef,
  patch: z.record(z.string(), z.unknown()), // 只允许 WRITABLE_FIELDS[ref.type]
  reason: z.string().min(1).max(500),
});
export const ProposeCreateInput = z.object({
  objectType: RomObjectType,
  data: z.record(z.string(), z.unknown()), // 只允许 WRITABLE_FIELDS[objectType]
  reason: z.string().min(1).max(500),
});
export const ProposeOutput = z.object({
  proposalId: Id,
  status: z.literal("pending"),
  diff: z.array(FieldDiff),
  expiresAt: IsoDateTime,
});

export const CalendarTodayInput = z.object({ date: DateOnly.optional() }); // 缺省 = 今天（config.timezone）
export const CalendarTodayOutput = z.object({ events: z.array(CalendarEvent) });

export const SchemaInspectInput = z.object({});
export const SchemaInspectOutput = z.object({ schema: SchemaInfo });

export interface ToolContext {
  actor: Actor;
  traceId: string;
  now: Date;
  skill?: string;
  /** 本次调用所属技能的 allowed_tools；给了就由 registry 拦截越界调用（MCP 不给 = 不限技能边界） */
  allowedTools?: readonly ToolName[];
}

export interface ToolDef<I = unknown, O = unknown> {
  name: ToolName;
  description: string; // 中文，面向模型
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  readOnly: boolean;
  adminOnly?: boolean;
  handler(ctx: ToolContext, input: I): Promise<O>;
}

export type ToolInvokeResult =
  | { ok: true; output: unknown; ms: number }
  | { ok: false; error: { code: ErrorCode; message: string }; ms: number };

export interface ToolRegistry {
  list(filter?: { names?: readonly ToolName[] }): ToolDef[];
  get(name: ToolName): ToolDef | undefined;
  /**
   * 统一入口，永不抛出：
   * 未知工具/输入不合法 → VALIDATION；KaidanError → 对应 code；其他异常 → UPSTREAM。
   * ctx.allowedTools 存在且不含 name → VALIDATION（当前技能不允许调用工具 {name}），照常写 tool_call（errorCode: "VALIDATION"）；
   *   这一检查先于「未知工具」检查：技能外的未知工具名得到的也是这句文案（与第 2 轮 agent 侧的文案逐字一致）。
   * rawInput 为 string 时先按 JSON 解析（空串视为 {}）；解析失败 → VALIDATION（工具 {name} 的参数不是合法 JSON），照常写 tool_call。
   * 每次调用写一条 audit tool_call（data: {tool, ok, ms, errorCode?}）；
   * PERMISSION_DENIED 额外写一条 permission_denied。
   * 输出返回前：剔除所有 raw 字段；手机号只允许脱敏形态。
   */
  invoke(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolInvokeResult>;
}

export interface ContextProvider {
  /** date: YYYY-MM-DD（config.timezone）；只返回 ownerId = actor.userId 的日程 */
  calendarToday(actor: Actor, date: string): Promise<CalendarEvent[]>;
}

export interface RiskConfig {
  staleDays: number; // 14
  stuckDays: number; // 30
  soonDays: number; // 7
  requiredQualificationKeys: string[]; // ["pain","decision_maker","budget","timeline"]
}

export interface ToolDeps {
  adapter: RomAdapter;
  proposals: ProposalService;
  audit: AuditLog;
  context: ContextProvider;
  risk: RiskConfig;
  timezone: string; // "Asia/Shanghai"
  proposalTtlMinutes: number;
  clock?: () => Date;
}
