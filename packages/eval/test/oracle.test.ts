// oracle 用 mini.json（tests/e2e/fixtures，只读）复算 spec B1 / B2 的全部数值。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RomDataset } from "@kaidan/contracts";
import { OracleScopeError, calendarOn, openTasks, pipelineSnapshot, riskReasons, DEFAULT_RISK } from "../src/oracle.js";
import { addDays, localDate } from "../src/time.js";

const MINI_PATH = fileURLToPath(new URL("../../../tests/e2e/fixtures/mini.json", import.meta.url));
const mini = (): RomDataset => RomDataset.parse(JSON.parse(readFileSync(MINI_PATH, "utf8")));

describe("oracle × mini.json：B1（张三 scope=me）", () => {
  const s = pipelineSnapshot(mini(), "ou_rep_zhang", "me", 30);

  it("closingSoon 依次为 opp_2、opp_1", () => {
    expect(s.closingSoon.map((o) => o.id)).toEqual(["opp_2", "opp_1"]);
  });

  it("atRisk 恰为 opp_1 [stale_activity, missing_qualification]", () => {
    expect(s.atRisk).toEqual([
      { opportunityId: "opp_1", name: "华东精密-二期产线", reasons: ["stale_activity", "missing_qualification"] },
    ]);
  });

  it("openAmount=600000，byStage 4 项且 solution / negotiation 数值正确，不含 opp_3", () => {
    expect(s.openAmount).toBe(600000);
    expect(s.byStage).toEqual([
      { stage: "lead", count: 0, amount: 0 },
      { stage: "qualified", count: 0, amount: 0 },
      { stage: "solution", count: 1, amount: 480000 },
      { stage: "negotiation", count: 1, amount: 120000 },
    ]);
    expect(JSON.stringify(s)).not.toContain("opp_3");
  });

  it("日程只有 ev_1；待办 task_1", () => {
    expect(calendarOn(mini(), "ou_rep_zhang").map((e) => e.id)).toEqual(["ev_1"]);
    expect(openTasks(mini(), "ou_rep_zhang").map((t) => t.id)).toEqual(["task_1"]);
  });
});

describe("oracle × mini.json：B2（团队视角）", () => {
  it("王经理 team：closingSoon [opp_2, opp_1]；atRisk [opp_1, opp_3]；openAmount=860000", () => {
    const s = pipelineSnapshot(mini(), "ou_mgr_wang", "team", 30);
    expect(s.closingSoon.map((o) => o.id)).toEqual(["opp_2", "opp_1"]);
    expect(s.atRisk.map((r) => r.opportunityId)).toEqual(["opp_1", "opp_3"]);
    expect(s.atRisk[1]?.reasons).toEqual(["stale_activity", "close_date_passed", "stuck_in_stage"]);
    expect(s.openAmount).toBe(860000);
  });

  it("销售张三 team → 无权（OracleScopeError）；admin team 看全部", () => {
    expect(() => pipelineSnapshot(mini(), "ou_rep_zhang", "team")).toThrow(OracleScopeError);
    expect(pipelineSnapshot(mini(), "ou_admin", "team").openAmount).toBe(860000);
    expect(pipelineSnapshot(mini(), "ou_admin", "me").openAmount).toBe(0);
  });
});

describe("风险规则边界", () => {
  const ds = mini();
  const opp1 = ds.opportunities.find((o) => o.id === "opp_1")!;
  const now = new Date(ds.now);
  const today = "2026-09-21";

  it("close_date_soon_no_next_step 用 soonDays（7 天）而不是 closingWithinDays", () => {
    expect(riskReasons(opp1, now, today, DEFAULT_RISK)).not.toContain("close_date_soon_no_next_step");
    const soon = { ...opp1, expectedCloseDate: "2026-09-28" };
    expect(riskReasons(soon, now, today, DEFAULT_RISK)).toContain("close_date_soon_no_next_step");
    expect(riskReasons({ ...soon, nextStep: "发报价" }, now, today, DEFAULT_RISK)).not.toContain("close_date_soon_no_next_step");
  });

  it("stuck_in_stage：updatedAt 早于 now-30 天才算；已关闭商机不算风险", () => {
    expect(riskReasons(opp1, now, today, DEFAULT_RISK)).not.toContain("stuck_in_stage");
    expect(riskReasons({ ...opp1, updatedAt: "2026-08-21T08:59:00+08:00" }, now, today, DEFAULT_RISK)).toContain("stuck_in_stage");
    expect(riskReasons({ ...opp1, stage: "won" }, now, today, DEFAULT_RISK)).toEqual([]);
  });

  it("qualification 值为空白也算缺失；lastActivityAt 缺失算 stale", () => {
    const q = { pain: "a", decision_maker: "b", budget: " ", timeline: "d" };
    const { lastActivityAt: _drop, ...noActivity } = opp1;
    void _drop;
    const r = riskReasons({ ...noActivity, qualification: q }, now, today, DEFAULT_RISK);
    expect(r).toEqual(["stale_activity", "missing_qualification"]);
  });

  it("「今天」按 Asia/Shanghai 计算（UTC 前一天晚上 = 上海当天）", () => {
    expect(localDate(new Date("2026-09-20T17:30:00Z"), "Asia/Shanghai")).toBe("2026-09-21");
    expect(addDays("2026-09-28", 5)).toBe("2026-10-03");
  });
});
