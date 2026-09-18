// Oracle：从 RomDataset 直接复算 pipeline_snapshot 的期望值，规则与 contracts/tools.ts 注释一致。
// 评测任务的"标准答案"只从这里来，不经过被测的适配器与工具层。
import {
  OPEN_STAGES,
  RiskReason,
  type Opportunity,
  type OpportunityStage,
  type RiskConfig,
  type RomDataset,
  type Task,
} from "@kaidan/contracts";
import { DAY_MS, addDays, localDate } from "./time.js";

export const DEFAULT_RISK: RiskConfig = {
  staleDays: 14,
  stuckDays: 30,
  soonDays: 7,
  requiredQualificationKeys: ["pain", "decision_maker", "budget", "timeline"],
};
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_CLOSING_WITHIN_DAYS = 30;

export type Scope = "me" | "team";

export interface OracleOptions {
  risk?: RiskConfig;
  timezone?: string;
  /** 缺省 = dataset.now */
  now?: Date;
}

export interface Snapshot {
  asOf: string;
  scope: Scope;
  byStage: { stage: OpportunityStage; count: number; amount: number }[];
  openAmount: number;
  closingSoon: Opportunity[];
  atRisk: { opportunityId: string; name: string; reasons: RiskReason[] }[];
}

export class OracleScopeError extends Error {}

const isOpen = (o: Opportunity) => (OPEN_STAGES as readonly string[]).includes(o.stage);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 统计范围内的负责人集合：
 *  - me：只有自己
 *  - team：admin → 全部；manager → 自己 + 所有 managerId 指向他的用户；rep → 无权（抛 OracleScopeError）
 */
export function ownerSet(ds: RomDataset, userId: string, scope: Scope): Set<string> | "all" {
  const user = ds.users.find((u) => u.userId === userId);
  if (!user) throw new OracleScopeError(`数据集中没有用户 ${userId}`);
  if (scope === "me") return new Set([userId]);
  if (user.roles.includes("admin")) return "all";
  if (user.roles.includes("manager")) {
    return new Set([userId, ...ds.users.filter((u) => u.managerId === userId).map((u) => u.userId)]);
  }
  throw new OracleScopeError(`${userId} 无权查看团队视角`);
}

export function riskReasons(o: Opportunity, now: Date, today: string, risk: RiskConfig): RiskReason[] {
  if (!isOpen(o)) return [];
  const t = now.getTime();
  const hit: Record<RiskReason, boolean> = {
    stale_activity: !o.lastActivityAt || Date.parse(o.lastActivityAt) < t - risk.staleDays * DAY_MS,
    close_date_passed: o.expectedCloseDate !== undefined && o.expectedCloseDate < today,
    close_date_soon_no_next_step:
      o.expectedCloseDate !== undefined &&
      o.expectedCloseDate >= today &&
      o.expectedCloseDate <= addDays(today, risk.soonDays) &&
      !(o.nextStep ?? "").trim(),
    stuck_in_stage: Date.parse(o.updatedAt) < t - risk.stuckDays * DAY_MS,
    missing_qualification:
      (o.stage === "solution" || o.stage === "negotiation") &&
      risk.requiredQualificationKeys.some((k) => !(o.qualification?.[k] ?? "").trim()),
  };
  return RiskReason.options.filter((r) => hit[r]);
}

export function pipelineSnapshot(
  ds: RomDataset,
  userId: string,
  scope: Scope,
  closingWithinDays: number = DEFAULT_CLOSING_WITHIN_DAYS,
  opts: OracleOptions = {},
): Snapshot {
  const risk = opts.risk ?? DEFAULT_RISK;
  const now = opts.now ?? new Date(ds.now);
  const today = localDate(now, opts.timezone ?? DEFAULT_TIMEZONE);
  const owners = ownerSet(ds, userId, scope);
  const open = ds.opportunities
    .filter((o) => owners === "all" || owners.has(o.ownerId))
    .filter(isOpen)
    .sort(byId);

  const byStage = OPEN_STAGES.map((stage) => {
    const inStage = open.filter((o) => o.stage === stage);
    return { stage, count: inStage.length, amount: inStage.reduce((s, o) => s + (o.amount ?? 0), 0) };
  });
  const until = addDays(today, closingWithinDays);
  const closingSoon = open
    .filter((o) => o.expectedCloseDate !== undefined && o.expectedCloseDate >= today && o.expectedCloseDate <= until)
    .sort((a, b) => ((a.expectedCloseDate ?? "") < (b.expectedCloseDate ?? "") ? -1 : (a.expectedCloseDate ?? "") > (b.expectedCloseDate ?? "") ? 1 : byId(a, b)));
  const atRisk = open
    .map((o) => ({ opportunityId: o.id, name: o.name, reasons: riskReasons(o, now, today, risk) }))
    .filter((r) => r.reasons.length > 0);

  return {
    asOf: now.toISOString(),
    scope,
    byStage,
    openAmount: byStage.reduce((s, b) => s + b.amount, 0),
    closingSoon,
    atRisk,
  };
}

/** 某用户的未完成待办（status=open），可选只看已逾期 */
export function openTasks(ds: RomDataset, userId: string, opts: { overdueOnly?: boolean; timezone?: string } = {}): Task[] {
  const today = localDate(new Date(ds.now), opts.timezone ?? DEFAULT_TIMEZONE);
  return ds.tasks
    .filter((t) => t.ownerId === userId && t.status === "open")
    .filter((t) => !opts.overdueOnly || (t.dueDate !== undefined && t.dueDate < today))
    .sort(byId);
}

/** 某用户在某天（缺省 = 数据集当天）的日程，按开始时间升序 */
export function calendarOn(ds: RomDataset, userId: string, date?: string, timezone = DEFAULT_TIMEZONE) {
  const day = date ?? localDate(new Date(ds.now), timezone);
  return ds.calendar
    .filter((e) => e.ownerId === userId && localDate(new Date(e.start), timezone) === day)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
