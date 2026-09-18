// 5 条风险规则（确定性代码计算，模型只负责解释）。reasons 按 RiskReason 枚举顺序。
import { OPEN_STAGES, RiskReason, type Opportunity, type RiskConfig } from "@kaidan/contracts";
import { addDays } from "./util.js";

const DAY_MS = 86_400_000;

export function isOpen(o: Opportunity): boolean {
  return OPEN_STAGES.includes(o.stage);
}

/**
 * @param now   当前时刻
 * @param today 当前时区下的今天 YYYY-MM-DD
 */
export function riskReasons(o: Opportunity, now: Date, today: string, cfg: RiskConfig): RiskReason[] {
  if (!isOpen(o)) return [];
  const t = now.getTime();
  const hit: Record<RiskReason, boolean> = {
    stale_activity: !o.lastActivityAt || Date.parse(o.lastActivityAt) < t - cfg.staleDays * DAY_MS,
    close_date_passed: !!o.expectedCloseDate && o.expectedCloseDate < today,
    close_date_soon_no_next_step:
      !!o.expectedCloseDate &&
      o.expectedCloseDate >= today &&
      o.expectedCloseDate <= addDays(today, cfg.soonDays) &&
      !o.nextStep?.trim(),
    stuck_in_stage: Date.parse(o.updatedAt) < t - cfg.stuckDays * DAY_MS,
    missing_qualification:
      (o.stage === "solution" || o.stage === "negotiation") &&
      cfg.requiredQualificationKeys.some((k) => !o.qualification?.[k]?.trim()),
  };
  return RiskReason.options.filter((r) => hit[r]);
}
