// B2 团队视角（spec 2.2）：① 王经理 team 视角的数值 ② rep 请求 team 视角被拒。
import { afterEach, describe, expect, it } from "vitest";
import {
  WANG,
  ZHANG,
  actor,
  auditOf,
  countTypes,
  errorCode,
  okOutput,
  setup,
  teardown,
  toolMessage,
  type PipelineOut,
} from "./harness.js";

afterEach(teardown);

describe("B2 团队视角", () => {
  it("① 王经理 daily-brief：pipeline_snapshot {scope:team, closingWithinDays:30}", async () => {
    const h = await setup([
      { toolCalls: [{ name: "pipeline_snapshot", arguments: { scope: "team", closingWithinDays: 30 } }] },
      { content: "团队晨报（测试）" },
    ]);
    const wang = await actor(h, WANG);

    await h.app.agent.run({ actor: wang, text: "/晨报", skill: "daily-brief", channel: "schedule", traceId: "t-b2-1" });

    const snap = okOutput<PipelineOut>(toolMessage(h.provider, "pipeline_snapshot"));
    expect(snap.closingSoon.map((o) => o.id)).toEqual(["opp_2", "opp_1"]);
    expect(snap.atRisk.map((r) => r.opportunityId)).toEqual(["opp_1", "opp_3"]);
    expect(snap.atRisk.find((r) => r.opportunityId === "opp_3")?.reasons).toEqual([
      "stale_activity",
      "close_date_passed",
      "stuck_in_stage",
    ]);
    expect(snap.openAmount).toBe(860000);
  });

  it("② 张三（rep）daily-brief：pipeline_snapshot {scope:team} → PERMISSION_DENIED，审计 1 条 permission_denied", async () => {
    const h = await setup([
      { toolCalls: [{ name: "pipeline_snapshot", arguments: { scope: "team" } }] },
      { content: "你没有查看团队数据的权限（测试）" },
    ]);
    const zhang = await actor(h, ZHANG);

    await h.app.agent.run({ actor: zhang, text: "/晨报", skill: "daily-brief", channel: "schedule", traceId: "t-b2-2" });

    const msg = toolMessage(h.provider, "pipeline_snapshot");
    expect(msg.body.ok).toBe(false);
    expect(errorCode(msg)).toBe("PERMISSION_DENIED");
    expect(countTypes(await auditOf(h, { traceId: "t-b2-2" })).permission_denied).toBe(1);
  });
});
