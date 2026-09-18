// pipeline_snapshot 数值（用 mini.json 复算 B1 / B2）与 5 条风险规则。
import { describe, expect, it } from "vitest";
import type { Opportunity, ToolContext } from "@kaidan/contracts";
import { createToolRegistry, riskReasons } from "../src/index.js";
import { ADMIN, LI, NOW, RISK, WANG, ZHANG, fixture, loadMini } from "./fakes.js";

interface Snap {
  asOf: string;
  scope: string;
  byStage: { stage: string; count: number; amount: number }[];
  openAmount: number;
  closingSoon: { id: string }[];
  atRisk: { opportunityId: string; name: string; reasons: string[] }[];
}

const ctx = (actor = ZHANG, traceId = "t"): ToolContext => ({ actor, traceId, now: NOW });

async function snapshot(actor: typeof ZHANG, input: object, f = fixture()) {
  const r = await createToolRegistry(f.deps).invoke(ctx(actor), "pipeline_snapshot", input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.output as Snap;
}

describe("pipeline_snapshot（mini.json 复算）", () => {
  it("B1 张三 scope=me：closingSoon / atRisk / openAmount / byStage", async () => {
    const s = await snapshot(ZHANG, { scope: "me", closingWithinDays: 30 });
    expect(s.closingSoon.map((o) => o.id)).toEqual(["opp_2", "opp_1"]);
    expect(s.atRisk).toEqual([
      { opportunityId: "opp_1", name: "华东精密-二期产线", reasons: ["stale_activity", "missing_qualification"] },
    ]);
    expect(s.openAmount).toBe(600000);
    expect(s.byStage).toEqual([
      { stage: "lead", count: 0, amount: 0 },
      { stage: "qualified", count: 0, amount: 0 },
      { stage: "solution", count: 1, amount: 480000 },
      { stage: "negotiation", count: 1, amount: 120000 },
    ]);
    expect(JSON.stringify(s)).not.toContain("opp_3");
    expect(s.asOf).toBe("2026-09-21T09:00:00+08:00");
    expect(s.scope).toBe("me");
  });

  it("B2 王经理 scope=team：closingSoon、atRisk（含 opp_3 三条原因）、openAmount=860000", async () => {
    const s = await snapshot(WANG, { scope: "team", closingWithinDays: 30 });
    expect(s.closingSoon.map((o) => o.id)).toEqual(["opp_2", "opp_1"]);
    expect(s.atRisk.map((r) => r.opportunityId)).toEqual(["opp_1", "opp_3"]);
    expect(s.atRisk[1]).toEqual({
      opportunityId: "opp_3",
      name: "南海外贸-CRM集成",
      reasons: ["stale_activity", "close_date_passed", "stuck_in_stage"],
    });
    expect(s.openAmount).toBe(860000);
    expect(s.byStage.find((b) => b.stage === "qualified")).toEqual({ stage: "qualified", count: 1, amount: 260000 });
  });

  it("王经理 scope=me 只算自己名下（为空）；管理员 team 看全部", async () => {
    const me = await snapshot(WANG, { scope: "me" });
    expect(me.openAmount).toBe(0);
    expect(me.byStage).toHaveLength(4);
    expect((await snapshot(ADMIN, { scope: "team" })).openAmount).toBe(860000);
  });

  it("B2② rep 传 team → PERMISSION_DENIED，写 permission_denied 审计", async () => {
    const f = fixture();
    const r = await createToolRegistry(f.deps).invoke(ctx(ZHANG, "t-b2"), "pipeline_snapshot", { scope: "team" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PERMISSION_DENIED");
    expect(f.audit.events.map((e) => e.type)).toEqual(["tool_call", "permission_denied"]);
    expect(f.audit.events[1]!.data).toEqual({ tool: "pipeline_snapshot" });
  });

  it("closingWithinDays 缺省 30；窗口收窄时只留窗口内的；已关闭阶段不计", async () => {
    expect((await snapshot(ZHANG, { scope: "me" })).closingSoon.map((o) => o.id)).toEqual(["opp_2", "opp_1"]);
    expect((await snapshot(ZHANG, { scope: "me", closingWithinDays: 5 })).closingSoon.map((o) => o.id)).toEqual(["opp_2"]);
    const ds = loadMini();
    ds.opportunities[1]!.stage = "won";
    const s = await snapshot(ZHANG, { scope: "me" }, fixture({ dataset: ds }));
    expect(s.openAmount).toBe(480000);
    expect(s.closingSoon.map((o) => o.id)).toEqual(["opp_1"]);
  });

  it("closingSoon 同日按 id 升序；缺失 amount 按 0 计", async () => {
    const ds = loadMini();
    const tmpl = ds.opportunities[0]!;
    ds.opportunities.push(
      { ...tmpl, id: "opp_9", expectedCloseDate: "2026-09-25", amount: undefined },
      { ...tmpl, id: "opp_0", expectedCloseDate: "2026-09-25" },
    );
    const s = await snapshot(ZHANG, { scope: "me" }, fixture({ dataset: ds }));
    expect(s.closingSoon.map((o) => o.id)).toEqual(["opp_0", "opp_2", "opp_9", "opp_1"]);
    expect(s.openAmount).toBe(600000 + 480000);
  });

  it("通过 adapter.search 翻页取全量（每页 100）", async () => {
    const ds = loadMini();
    const tmpl = ds.opportunities[1]!;
    for (let i = 0; i < 150; i++) ds.opportunities.push({ ...tmpl, id: `opp_x${String(i).padStart(3, "0")}`, amount: 1000 });
    const f = fixture({ dataset: ds });
    const s = await snapshot(ZHANG, { scope: "me" }, f);
    expect(s.byStage.find((b) => b.stage === "negotiation")?.count).toBe(151);
    expect(s.openAmount).toBe(600000 + 150000);
    expect(f.adapter.searchCalls).toHaveLength(2);
    expect(f.adapter.searchCalls[0]).toMatchObject({ type: "opportunity", limit: 100 });
  });

  it("「今天」按 deps.timezone 与 deps.clock 计算（UTC 前一天 20:00 = 上海当天 04:00）", async () => {
    const early = new Date("2026-09-20T20:00:00Z");
    const s = await snapshot(ZHANG, { scope: "me" }, fixture({ clock: () => early }));
    expect(s.asOf).toBe("2026-09-21T04:00:00+08:00");
    expect(s.closingSoon.map((o) => o.id)).toEqual(["opp_2", "opp_1"]);
  });

  it("李四的视角看不到张三的商机", async () => {
    const s = await snapshot(LI, { scope: "me" });
    expect(s.openAmount).toBe(260000);
    expect(s.atRisk.map((r) => r.opportunityId)).toEqual(["opp_3"]);
  });
});

describe("风险规则（正例 / 反例）", () => {
  const today = "2026-09-21";
  const opp = (o: Partial<Opportunity>): Opportunity => ({
    type: "opportunity",
    id: "o",
    accountId: "a",
    name: "测试商机",
    stage: "qualified",
    rawStage: "需求确认",
    ownerId: "u",
    createdAt: "2026-09-01T10:00:00+08:00",
    updatedAt: "2026-09-20T10:00:00+08:00",
    lastActivityAt: "2026-09-20T10:00:00+08:00",
    expectedCloseDate: "2026-12-31",
    nextStep: "下一步",
    ...o,
  });
  const r = (o: Partial<Opportunity>) => riskReasons(opp(o), NOW, today, RISK);

  it("基准商机无风险", () => {
    expect(r({})).toEqual([]);
  });
  it("stale_activity：缺失或早于 now-14 天 → 命中；恰在 14 天内 → 不命中", () => {
    expect(r({ lastActivityAt: undefined })).toEqual(["stale_activity"]);
    expect(r({ lastActivityAt: "2026-09-07T08:59:59+08:00" })).toEqual(["stale_activity"]);
    expect(r({ lastActivityAt: "2026-09-07T09:00:00+08:00" })).toEqual([]);
  });
  it("close_date_passed：早于今天 → 命中；等于今天 → 不命中", () => {
    expect(r({ expectedCloseDate: "2026-09-20" })).toEqual(["close_date_passed"]);
    expect(r({ expectedCloseDate: "2026-09-21", nextStep: "有" })).toEqual([]);
  });
  it("close_date_soon_no_next_step：[今天, 今天+7] 且 nextStep 为空 → 命中；有下一步或超出窗口 → 不命中", () => {
    expect(r({ expectedCloseDate: "2026-09-28", nextStep: "" })).toEqual(["close_date_soon_no_next_step"]);
    expect(r({ expectedCloseDate: "2026-09-21", nextStep: undefined })).toEqual(["close_date_soon_no_next_step"]);
    expect(r({ expectedCloseDate: "2026-09-28", nextStep: "  " })).toEqual(["close_date_soon_no_next_step"]);
    expect(r({ expectedCloseDate: "2026-09-29", nextStep: "" })).toEqual([]);
    expect(r({ expectedCloseDate: "2026-09-25", nextStep: "发合同" })).toEqual([]);
  });
  it("stuck_in_stage：updatedAt 早于 now-30 天 → 命中", () => {
    expect(r({ updatedAt: "2026-08-22T08:59:00+08:00" })).toEqual(["stuck_in_stage"]);
    expect(r({ updatedAt: "2026-08-22T09:00:00+08:00" })).toEqual([]);
  });
  it("missing_qualification：solution / negotiation 缺任一资格键 → 命中；其他阶段或四键齐全 → 不命中", () => {
    const full = { pain: "p", decision_maker: "d", budget: "b", timeline: "t" };
    expect(r({ stage: "solution" })).toEqual(["missing_qualification"]);
    expect(r({ stage: "negotiation", qualification: { ...full, budget: "" } })).toEqual(["missing_qualification"]);
    expect(r({ stage: "negotiation", qualification: full })).toEqual([]);
    expect(r({ stage: "lead" })).toEqual([]);
  });
  it("已关闭（won / lost）不评估；多条命中按枚举顺序", () => {
    expect(r({ stage: "won", lastActivityAt: undefined, expectedCloseDate: "2026-01-01" })).toEqual([]);
    expect(
      r({ stage: "solution", lastActivityAt: undefined, expectedCloseDate: "2026-09-01", updatedAt: "2026-01-01T00:00:00+08:00" }),
    ).toEqual(["stale_activity", "close_date_passed", "stuck_in_stage", "missing_qualification"]);
  });
});
